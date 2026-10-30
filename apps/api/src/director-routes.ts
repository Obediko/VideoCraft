import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { applyTimelineOperations, parseTimelineOperations, type ProjectRevision, type TranscriptSegment, type UUID } from "@videocraft/domain";
import type { AssetRepository, ProjectRepository, RevisionRepository } from "@videocraft/application";
import type { ObjectStorage } from "@videocraft/storage";
import { RuleDirector, briefHints, checkEdit, effectOperations, parseMediaSignals, planOperations, sanitizePlan, type CheckIssue, type Director, type DirectorInput, type DirectorPlan, type MediaSignals } from "@videocraft/director";
import { findCandidates } from "@videocraft/strategies";
import { composeMusicAsset } from "./music-routes.js";

export interface DirectorRouteDependencies {
  projects: ProjectRepository; assets: AssetRepository; revisions: RevisionRepository; storage: ObjectStorage;
  transcripts: { listForAsset(assetId: UUID): Promise<TranscriptSegment[]> };
  director: Director;
  saveRevision(input: { projectId: UUID; createdBy: UUID; timeline: ProjectRevision["timeline"]; acceptedProposalIds: UUID[]; tailoring?: NonNullable<ProjectRevision["tailoring"]> }): Promise<ProjectRevision>;
  authenticate(request: FastifyRequest): Promise<{ userId: UUID } | null>;
  authorize: { canAccess(principal: { userId: UUID }, projectId: UUID, role: "viewer" | "editor"): Promise<boolean> };
  clock(): string;
  ffmpeg?: string;
  /** Looks up the best free stock match for a few words, without importing it (to show it in a suggestion). */
  previewStock?(query: string, kind: "video" | "photo" | "gif", orientation?: "portrait" | "landscape" | "square"): Promise<{ provider: "pexels" | "pixabay" | "giphy"; id: string; thumbUrl: string; credit?: string } | undefined>;
  /** Imports one stock item the creator saw in a suggestion. */
  importStock?(projectId: UUID, provider: "pexels" | "pixabay" | "giphy", kind: "video" | "photo" | "gif", id: string): Promise<{ id: UUID }>;
  /** Finds and imports a free stock video, photo or GIF for a few words (absent without stock keys). */
  findStock?(projectId: UUID, query: string, kind: "video" | "photo" | "gif", orientation?: "portrait" | "landscape" | "square"): Promise<{ id: UUID } | undefined>;
  /** Reads text aloud as an audio asset (absent without the OpenAI key). */
  speak?(projectId: UUID, text: string): Promise<{ id: UUID; durationUs?: number }>;
}

/** Plans a whole edit from the person's own description (AI director, or rules without a key), then applies the accepted parts. */
export function registerDirectorRoutes(server: FastifyInstance, dependencies: DirectorRouteDependencies): void {
  const context = contextOf(dependencies);
  const directorInput = (ctx: NonNullable<Awaited<ReturnType<typeof context>>>, brief: string, request: FastifyRequest) => directorInputFor(dependencies, ctx, brief, request);
  registerCheckRoutes(server, dependencies, context);

  server.post("/v1/projects/:projectId/director/plan", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } } as never, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await context(request, reply);
    if (!ctx) return reply;
    const brief = typeof ctx.body.brief === "string" ? ctx.body.brief.trim().slice(0, 2000) : "";
    if (brief.length < 3) return error(reply, 400, "invalid_request", "Describe what the video is about and what you want");
    const plan = await dependencies.director.plan(await directorInput(ctx, brief, request));
    if (plan.source === "rules" && plan.note?.includes("unavailable")) {
      request.log.warn({ requestId: request.id, projectId: ctx.projectId, reason: plan.note.slice(0, 300), stage: "director_plan" }, "AI director fell back to rules");
    }
    return { plan: await withStockPreviews(plan, dependencies, orientationOf(ctx.revision)) };
  });

  // A change to the current edit in the person's own words ("make it shorter", "warmer look").
  server.post("/v1/projects/:projectId/director/ask", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } } as never, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await context(request, reply);
    if (!ctx) return reply;
    const instruction = typeof ctx.body.instruction === "string" ? ctx.body.instruction.trim().slice(0, 500) : "";
    if (instruction.length < 3) return error(reply, 400, "invalid_request", "Say what you would like to change");
    const brief = ctx.revision.tailoring?.intent ?? "";
    const timeline = ctx.revision.timeline;
    const words = ctx.transcript.flatMap((segment) => segment.words);
    const pieces = timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).sort((a, b) => a.timelineStartUs - b.timelineStartUs).filter((c) => c.assetId === ctx.main.id);
    const overlays = timeline.tracks.filter((t) => t.kind === "overlay").flatMap((t) => t.clips);
    const music = timeline.tracks.find((t) => t.kind === "audio")?.clips.find((c) => c.transform?.role === "music");
    const current = {
      pieces: pieces.map((c) => ({ startS: c.sourceStartUs / 1e6, endS: c.sourceEndUs / 1e6, text: words.filter((w) => w.startUs >= c.sourceStartUs - 50_000 && w.endUs <= c.sourceEndUs + 50_000).map((w) => w.text).join(" ") })),
      graphics: overlays.filter((c) => c.transform?.role === "graphic").map((c) => String(c.transform?.kind) + ": " + String(c.transform?.text)),
      look: String(pieces[0]?.transform?.look ?? "none"),
      music: music ? "yes, at " + String(music.transform?.volumeDb ?? -20) + " dB" : "none",
      seconds: pieces.reduce((sum, c) => sum + c.sourceEndUs - c.sourceStartUs, 0) / 1e6,
      extras: summariseExtras(timeline),
    };
    const playheadS = typeof ctx.body.playheadS === "number" && Number.isFinite(ctx.body.playheadS) && ctx.body.playheadS >= 0 ? ctx.body.playheadS : undefined;
    const input = { ...(await directorInput(ctx, brief || instruction, request)), instruction, current, ...(playheadS !== undefined ? { playheadS } : {}) };
    const plan = dependencies.director.ask ? await dependencies.director.ask(input) : await new RuleDirector().ask(input);
    if (plan.source === "rules" && plan.note?.includes("unavailable")) {
      request.log.warn({ requestId: request.id, projectId: ctx.projectId, reason: plan.note.slice(0, 300), stage: "director_ask" }, "AI director fell back to rules");
    }
    return { plan: await withStockPreviews(plan, dependencies, orientationOf(ctx.revision)) };
  });

  server.post("/v1/projects/:projectId/director/apply", async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await context(request, reply);
    if (!ctx) return reply;
    const project = await dependencies.projects.get(ctx.projectId);
    if (project && project.revision !== ctx.revision.revision) return error(reply, 409, "revision_conflict", "Revision " + project.revision + " is newer; reload before applying");
    if (!Array.isArray(ctx.body.accepted) || !ctx.body.accepted.every((id) => typeof id === "string")) return error(reply, 400, "invalid_request", "accepted must list suggestion ids");
    const incoming = (ctx.body.plan ?? {}) as DirectorPlan;
    // The plan comes back from the browser, so it is validated again against this project's bounds.
    const plan = sanitizePlan(incoming, { brief: "", durationS: ctx.durationS, frame: { width: 0, height: 0 }, transcript: [], candidates: [], frames: [], assets: ctx.others }, incoming.source === "ai" ? "ai" : "rules");
    const accepted = new Set(ctx.body.accepted as string[]);
    const words = ctx.transcript.flatMap((segment) => segment.words);
    const ops = planOperations(plan, accepted, { timeline: ctx.revision.timeline, assetId: ctx.main.id, words });
    let timeline = applyTimelineOperations(ctx.revision.timeline, ops);
    // Looks, zooms, transitions and sound effects refer to the clips of the new cut, so they come second.
    const effects = effectOperations(plan, accepted, timeline, ctx.main.id);
    if (effects.length) timeline = applyTimelineOperations(timeline, effects);
    const musicSuggestion = plan.suggestions.find((s) => s.kind === "music" && accepted.has(s.id));
    let music: { description: string } | undefined;
    if (musicSuggestion && musicSuggestion.kind === "music") {
      const clips = timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).sort((a, b) => a.timelineStartUs - b.timelineStartUs);
      const lengthUs = clips.reduce((sum, clip) => sum + clip.sourceEndUs - clip.sourceStartUs, 0);
      if (lengthUs >= 3_000_000) {
        const composed = await composeMusicAsset({ projectId: ctx.projectId, mood: musicSuggestion.mood, lengthUs, accentsS: clips.slice(1).map((c) => c.timelineStartUs / 1e6), seed: Math.floor(Math.random() * 1e9) }, dependencies);
        timeline = applyTimelineOperations(timeline, [{ type: "set-music", assetId: composed.asset.id, volumeDb: -20, duck: true }]);
        music = { description: composed.music.description };
      }
    }
    // Free stock cutaways and typed voice-overs need the network, so they are made here, after the cut.
    const notes: string[] = [];
    const kept = timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).filter((c) => c.assetId === ctx.main.id);
    const anchorAt = (atS: number) => { const at = Math.round(atS * 1e6); if (kept.some((c) => at >= c.sourceStartUs && at < c.sourceEndUs)) return at; const near = [...kept].sort((a, b) => Math.abs(a.sourceStartUs - at) - Math.abs(b.sourceStartUs - at))[0]; return near ? near.sourceStartUs + 100_000 : at; };
    const frame = ctx.revision.tailoring?.channel === "youtube" ? "landscape" : "portrait";
    for (const s of plan.suggestions.filter((x) => accepted.has(x.id))) {
      try {
        if (s.kind === "stock") {
          // The exact item shown in the suggestion when there was one; otherwise the best match now.
          const asset = s.pick && dependencies.importStock ? await dependencies.importStock(ctx.projectId, s.pick.provider, s.assetKind, s.pick.id).catch(() => undefined)
            : dependencies.findStock ? await dependencies.findStock(ctx.projectId, s.query, s.assetKind, s.mode === "pip" ? "landscape" : frame) : undefined;
          if (!dependencies.findStock && !dependencies.importStock) { notes.push("Stock search is not set up on the server, so \"" + s.query + "\" was skipped."); continue; }
          if (!asset) { notes.push("No free stock matched \"" + s.query + "\"."); continue; }
          timeline = applyTimelineOperations(timeline, [{ type: "add-broll", assetId: asset.id, anchorAssetId: ctx.main.id, anchorSourceUs: anchorAt(s.atS), durationUs: Math.round(s.durationS * 1e6), mode: s.mode }]);
        } else if (s.kind === "voiceover") {
          if (!dependencies.speak) { notes.push("Typed voice-overs need the OpenAI key; record yours in Audio → Voice-over."); continue; }
          const asset = await dependencies.speak(ctx.projectId, s.text);
          timeline = applyTimelineOperations(timeline, [{ type: "add-voiceover", assetId: asset.id, anchorAssetId: ctx.main.id, anchorSourceUs: anchorAt(s.atS), durationUs: Math.max(200_000, asset.durationUs ?? 3_000_000) }]);
        }
      } catch (caught) { notes.push((s.kind === "stock" ? "Stock \"" + s.query + "\"" : "The voice-over") + " could not be added: " + (caught instanceof Error ? caught.message : "error").slice(0, 120)); }
    }
    const revision = await dependencies.saveRevision({
      projectId: ctx.projectId, createdBy: ctx.principal.userId, timeline, acceptedProposalIds: ctx.revision.acceptedProposalIds,
      tailoring: ctx.body.keepTailoring === true && ctx.revision.tailoring ? ctx.revision.tailoring : { intent: plan.profile.intent, audience: plan.profile.audience, channel: plan.profile.channel, ...(plan.profile.tone ? { tone: plan.profile.tone } : {}), targetDurationUs: plan.profile.targetSeconds * 1_000_000, constraints: [] },
    });
    const platform = plan.suggestions.find((s) => s.kind === "platform" && accepted.has(s.id));
    return reply.code(201).send({ revision, ...(platform && platform.kind === "platform" ? { platform: platform.platform } : {}), ...(music ? { music } : {}), ...(notes.length ? { notes } : {}) });
  });
}

function orientationOf(revision: ProjectRevision): "portrait" | "landscape" { return revision.tailoring?.channel === "youtube" ? "landscape" : "portrait"; }

/** Finds the stock item for each stock suggestion so the creator sees a thumbnail and credit before applying. */
async function withStockPreviews(plan: DirectorPlan, dependencies: DirectorRouteDependencies, orientation: "portrait" | "landscape"): Promise<DirectorPlan> {
  if (!dependencies.previewStock || !plan.suggestions.some((s) => s.kind === "stock")) return plan;
  const suggestions = await Promise.all(plan.suggestions.map(async (s) => {
    if (s.kind !== "stock" || s.pick) return s;
    const pick = await dependencies.previewStock!(s.query, s.assetKind, s.mode === "pip" ? "landscape" : orientation).catch(() => undefined);
    return pick ? { ...s, pick } : s;
  }));
  // A stock idea with nothing found is dropped rather than offered empty.
  return { ...plan, suggestions: suggestions.filter((s) => s.kind !== "stock" || s.pick) };
}

/** The rest of the edit in a line, for the director: levels, effects, cutaways, captions, background. */
function summariseExtras(timeline: ProjectRevision["timeline"]): string {
  const audio = timeline.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips);
  const overlays = timeline.tracks.filter((t) => t.kind === "overlay").flatMap((t) => t.clips);
  const video = timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
  const sfx = audio.filter((c) => c.transform?.role === "sfx"); const vo = audio.filter((c) => c.transform?.role === "voiceover");
  const captions = timeline.tracks.filter((t) => t.kind === "caption").flatMap((t) => t.clips).length;
  const backgrounds = [...new Set(video.map((c) => String(c.transform?.background ?? "none")))];
  return [
    "Sound effects: " + (sfx.length ? sfx.length + " at " + String(sfx[0]!.transform?.volumeDb ?? -18) + " dB" : "none"),
    "Voice-overs: " + (vo.length ? vo.length : "none"),
    "Cutaways: " + (overlays.filter((c) => c.transform?.role === "broll").length || "none"),
    "Progress bar: " + (overlays.some((c) => c.transform?.role === "progress") ? "yes" : "no"),
    "Captions: " + (captions ? captions + " cues" : "none"),
    "Background: " + backgrounds.join(", "),
    "Zooms: " + (video.some((c) => c.transform?.zoom) ? "yes" : "none") + "; transitions: " + (video.some((c) => c.transform?.transitionIn || c.transform?.transitionOut) ? "yes" : "none"),
  ].join("\n");
}

function contextOf(dependencies: DirectorRouteDependencies) {
  return async (request: FastifyRequest, reply: FastifyReply) => {

    const principal = await dependencies.authenticate(request);
    if (!principal) { error(reply, 401, "unauthorized", "Authentication required"); return null; }
    const { projectId } = request.params as { projectId?: string };
    if (!projectId || !(await dependencies.authorize.canAccess(principal, projectId, "editor"))) { error(reply, 403, "forbidden", "Project access denied"); return null; }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) { error(reply, 400, "invalid_request", "revision must be a positive integer"); return null; }
    const revision = await dependencies.revisions.get(projectId, body.revision as number);
    if (!revision) { error(reply, 404, "not_found", "Revision not found"); return null; }
    const mainClip = revision.timeline.tracks.find((track) => track.kind === "video")?.clips[0];
    const assets = await dependencies.assets.listForProject(projectId);
    const main = assets.find((asset) => asset.id === mainClip?.assetId);
    if (!mainClip || !main) { error(reply, 400, "invalid_request", "Add your video to the timeline first"); return null; }
    const transcript = await dependencies.transcripts.listForAsset(main.id);
    if (!transcript.length) { error(reply, 409, "transcript_required", "Transcribe the video first so the director can hear what is said"); return null; }
    const durationS = (main.durationUs ?? Math.max(...transcript.map((s) => s.endUs))) / 1_000_000;
    const others = assets.filter((asset) => asset.id !== main.id && (asset.kind === "image" || asset.kind === "video")).map((asset) => ({ id: asset.id, kind: asset.kind as "image" | "video", name: String(asset.metadata.filename ?? asset.kind).slice(0, 80) }));
    return { principal, projectId, body, revision, main, transcript, durationS, others };
  };
}

/** Edit check: rules (cuts, pauses, text, music, captions, black/frozen picture) plus an AI second look when available. */
export function registerCheckRoutes(server: FastifyInstance, dependencies: DirectorRouteDependencies, context: ReturnType<typeof contextOf>): void {
  server.post("/v1/projects/:projectId/director/check", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } } as never, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await context(request, reply);
    if (!ctx) return reply;
    const timeline = ctx.revision.timeline;
    const words = ctx.transcript.flatMap((segment) => segment.words);
    const pieces = timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).sort((a, b) => a.timelineStartUs - b.timelineStartUs);
    const mine = pieces.filter((c) => c.assetId === ctx.main.id);
    const platform = typeof ctx.body.platform === "string" ? ctx.body.platform : "tiktok";
    const target = ctx.revision.tailoring?.targetDurationUs ? Math.round(ctx.revision.tailoring.targetDurationUs / 1e6) : undefined;
    const overlays = timeline.tracks.filter((t) => t.kind === "overlay").flatMap((t) => t.clips);
    const graphics = overlays.filter((c) => c.transform?.role === "graphic").sort((a, b) => a.timelineStartUs - b.timelineStartUs);
    // Source moments worth looking at: each piece's first second and each graphic, labelled with their place in the edit.
    const looks = [
      ...mine.slice(0, 8).map((c, i) => ({ sourceS: c.sourceStartUs / 1e6 + Math.min(0.8, (c.sourceEndUs - c.sourceStartUs) / 2e6), atS: c.timelineStartUs / 1e6, label: "Start of piece #" + i })),
      ...graphics.slice(0, 4).map((g, i) => ({ sourceS: Number(g.transform?.anchorSourceUs ?? 0) / 1e6 + 0.5, atS: g.timelineStartUs / 1e6, label: "Under on-screen text #" + i })),
    ];
    const brief = typeof ctx.body.brief === "string" && ctx.body.brief.trim() ? ctx.body.brief.trim().slice(0, 2000) : ctx.revision.tailoring?.intent ?? "";
    let media: MediaSignals | undefined; let frames: Array<{ atS: number; label: string; jpegBase64: string }> = [];
    await withSource(dependencies, ctx.main.storageKey, async (input, directory) => {
      media = await scanPicture(dependencies, input, mine.map((c) => ({ startUs: c.sourceStartUs, endUs: c.sourceEndUs }))).catch((caught) => { request.log.warn({ err: caught }, "Picture scan failed"); return undefined; });
      if (dependencies.director.review) {
        const shots = await framesAt(dependencies, input, directory, looks.map((l) => l.sourceS)).catch(() => []);
        frames = shots.map((shot, i) => ({ atS: looks[i]!.atS, label: looks[i]!.label, jpegBase64: shot.jpegBase64 }));
      }
    }).catch((caught) => request.log.warn({ err: caught }, "Could not open the source for the check"));
    const issues: CheckIssue[] = checkEdit({ timeline, assetId: ctx.main.id, words, sourceDurationUs: ctx.main.durationUs ?? Math.round(ctx.durationS * 1e6), platform, ...(target ? { targetSeconds: target } : {}), ...(media ? { media } : {}) });
    let note: string | undefined; let ai = false;
    if (dependencies.director.review) {
      const textOf = (startUs: number, endUs: number) => words.filter((w) => w.startUs >= startUs - 50_000 && w.endUs <= endUs + 50_000).map((w) => w.text).join(" ");
      const music = timeline.tracks.find((t) => t.kind === "audio")?.clips.find((c) => c.transform?.role === "music");
      const musicAsset = music ? (await dependencies.assets.listForProject(ctx.projectId)).find((a) => a.id === music.assetId) : undefined;
      try {
        const reviewed = await dependencies.director.review({
          brief, platform, frames,
          pieces: pieces.map((c) => ({ clipId: c.id, startS: c.timelineStartUs / 1e6, endS: c.timelineEndUs / 1e6, text: c.assetId === ctx.main.id ? textOf(c.sourceStartUs, c.sourceEndUs) : "(other footage)" })),
          graphics: graphics.map((g) => ({ clipId: g.id, kind: String(g.transform?.kind ?? "title"), text: String(g.transform?.text ?? ""), atS: g.timelineStartUs / 1e6, durationS: (g.timelineEndUs - g.timelineStartUs) / 1e6 })),
          cutaways: overlays.filter((c) => c.transform?.role === "broll").map((c) => ({ atS: c.timelineStartUs / 1e6, durationS: (c.timelineEndUs - c.timelineStartUs) / 1e6, name: ctx.others.find((o) => o.id === c.assetId)?.name ?? "media" })),
          ...(musicAsset ? { music: String(musicAsset.metadata.description ?? musicAsset.metadata.mood ?? musicAsset.metadata.filename ?? "music") } : {}),
        });
        issues.push(...reviewed); ai = true;
      } catch (caught) { note = "The AI second look was unavailable (" + (caught instanceof Error ? caught.message : "error").slice(0, 160) + "); these are the built-in checks."; }
    }
    const order = { fix: 0, warn: 1, info: 2 } as const;
    issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.atS ?? 1e9) - (b.atS ?? 1e9));
    return { issues, ai, scanned: Boolean(media), ...(note ? { note } : {}) };
  });

  server.post("/v1/projects/:projectId/director/fix", async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await context(request, reply);
    if (!ctx) return reply;
    const project = await dependencies.projects.get(ctx.projectId);
    if (project && project.revision !== ctx.revision.revision) return error(reply, 409, "revision_conflict", "Revision " + project.revision + " is newer; check again before fixing");
    const fixes = Array.isArray(ctx.body.fixes) ? (ctx.body.fixes as Array<{ title?: unknown; atS?: unknown; operations?: unknown }>).slice(0, 30) : [];
    if (fixes.length === 0) return error(reply, 400, "invalid_request", "fixes must list at least one fix");
    const owned = new Map((await dependencies.assets.listForProject(ctx.projectId)).map((asset) => [asset.id, asset.kind]));
    // Later moments first, so fixing one moment does not move the others; whole-video fixes last.
    const ordered = [...fixes].sort((a, b) => (typeof b.atS === "number" ? b.atS : -1) - (typeof a.atS === "number" ? a.atS : -1));
    let timeline = ctx.revision.timeline; const applied: string[] = []; const skipped: string[] = [];
    const original = new Map(ctx.revision.timeline.tracks.flatMap((t) => t.clips).map((c) => [c.id, c]));
    // Each fix was worked out against the checked revision; a trim moves only the edge it changed, so several fixes to one piece add up.
    const rebase = (ops: ReturnType<typeof parseTimelineOperations>) => ops.map((op) => {
      if (op.type !== "trim-clip") return op;
      const before = original.get(op.clipId); const now = timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === op.clipId);
      if (!before || !now) return op;
      return { ...op, sourceStartUs: op.sourceStartUs !== before.sourceStartUs ? op.sourceStartUs : now.sourceStartUs, sourceEndUs: op.sourceEndUs !== before.sourceEndUs ? op.sourceEndUs : now.sourceEndUs };
    });
    for (const fix of ordered) {
      const title = typeof fix.title === "string" ? fix.title.slice(0, 140) : "fix";
      try {
        const ops = parseTimelineOperations(fix.operations);
        for (const op of ops) {
          if (op.type === "insert-clip" && owned.get(op.assetId) !== "video") throw new Error("foreign asset");
          if ((op.type === "add-graphic" || op.type === "add-broll" || op.type === "add-caption-cue") && owned.get("anchorAssetId" in op ? op.anchorAssetId : op.assetId) !== "video") throw new Error("foreign asset");
          if (op.type === "add-broll" && !["video", "image"].includes(owned.get(op.assetId) ?? "")) throw new Error("foreign asset");
          if (op.type === "set-music" && !["audio", "video"].includes(owned.get(op.assetId) ?? "")) throw new Error("foreign asset");
        }
        const rebased = rebase(ops);
        timeline = applyTimelineOperations(timeline, rebased); applied.push(title);
      } catch (caught) { request.log.info({ err: caught, fix: title }, "Fix skipped"); skipped.push(title); }
    }
    if (applied.length === 0) return error(reply, 409, "fixes_not_applicable", "None of the fixes still apply to this revision; run the check again");
    const revision = await dependencies.saveRevision({ projectId: ctx.projectId, createdBy: ctx.principal.userId, timeline, acceptedProposalIds: ctx.revision.acceptedProposalIds, ...(ctx.revision.tailoring ? { tailoring: ctx.revision.tailoring } : {}) });
    return reply.code(201).send({ revision, applied, skipped });
  });
}

/** What the director sees: the description, the timed transcript, strong candidate moments, frames and other media. */
async function directorInputFor(dependencies: DirectorRouteDependencies, ctx: NonNullable<Awaited<ReturnType<ReturnType<typeof contextOf>>>>, brief: string, request: FastifyRequest): Promise<DirectorInput> {
  const hints = briefHints(brief);
  const profile = { intent: brief, audience: "", channel: hints.channel, ...(hints.targetSeconds ? { targetDurationUs: hints.targetSeconds * 1_000_000 } : {}), constraints: [] };
  // Distinct strong windows, so the director chooses among real, complete moments.
  const candidates: DirectorInput["candidates"] = [];
  for (const candidate of findCandidates(ctx.transcript, profile)) {
    if (candidates.length >= 16) break;
    const overlaps = candidates.some((c) => Math.min(c.endS, candidate.endUs / 1e6) - Math.max(c.startS, candidate.startUs / 1e6) > 0.5 * Math.min(c.endS - c.startS, (candidate.endUs - candidate.startUs) / 1e6));
    if (!overlaps) candidates.push({ id: "m" + (candidates.length + 1), startS: candidate.startUs / 1e6, endS: candidate.endUs / 1e6, text: candidate.text, score: candidate.score });
  }
  const frames = await sampleFrames(dependencies, ctx.main.storageKey, ctx.durationS, 8).catch((caught) => { request.log.warn({ err: caught }, "Frame sampling failed; planning from words only"); return []; });
  return {
    brief, durationS: ctx.durationS, frame: { width: Number(ctx.main.metadata.width) || 1080, height: Number(ctx.main.metadata.height) || 1920 },
    transcript: ctx.transcript.map((s) => ({ startS: s.startUs / 1e6, endS: s.endUs / 1e6, text: s.text })), candidates, frames, assets: ctx.others,
  };
}

/** Runs `work` with a local path to the stored source (downloaded to a temp folder on object storage). */
async function withSource<T>(dependencies: DirectorRouteDependencies, storageKey: string, work: (path: string, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "videocraft-frames-"));
  try {
    const input = dependencies.storage.downloadToFile ? join(directory, "input.media") : dependencies.storage.resolve(storageKey);
    if (dependencies.storage.downloadToFile) await dependencies.storage.downloadToFile(storageKey, input);
    return await work(input, directory);
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}

/** Small JPEG stills at the given source times (for the AI to look at). */
async function framesAt(dependencies: DirectorRouteDependencies, input: string, directory: string, times: number[]): Promise<Array<{ atS: number; jpegBase64: string }>> {
  const frames: Array<{ atS: number; jpegBase64: string }> = [];
  for (const [i, atS] of times.entries()) {
    const out = join(directory, "f" + i + ".jpg");
    await run(dependencies.ffmpeg ?? "ffmpeg", ["-v", "error", "-y", "-ss", Math.max(0, atS).toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale='min(512,iw)':-2", "-q:v", "6", out]);
    frames.push({ atS, jpegBase64: (await readFile(out)).toString("base64") });
  }
  return frames;
}

/** JPEG stills spread across the video (small, for the director to look at). */
async function sampleFrames(dependencies: DirectorRouteDependencies, storageKey: string, durationS: number, count: number): Promise<DirectorInput["frames"]> {
  return withSource(dependencies, storageKey, (input, directory) => framesAt(dependencies, input, directory, Array.from({ length: count }, (_, i) => Math.max(0, (durationS * (i + 0.5)) / count))));
}

/** Black and frozen picture inside the kept ranges (low-res scan, a few seconds of work per minute of footage). */
async function scanPicture(dependencies: DirectorRouteDependencies, input: string, ranges: Array<{ startUs: number; endUs: number }>): Promise<MediaSignals> {
  const out: MediaSignals = { black: [], frozen: [] };
  for (const range of ranges.slice(0, 40)) {
    const stderr = await run(dependencies.ffmpeg ?? "ffmpeg", ["-v", "info", "-hide_banner", "-nostats", "-ss", (range.startUs / 1e6).toFixed(3), "-t", ((range.endUs - range.startUs) / 1e6).toFixed(3), "-i", input, "-an", "-vf", "fps=6,scale=320:-2,blackdetect=d=0.4:pix_th=0.12,freezedetect=n=-65dB:d=2.5", "-f", "null", "-"]);
    const found = parseMediaSignals(stderr, range.startUs);
    out.black.push(...found.black); out.frozen.push(...found.frozen);
  }
  return out;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (c) => { stderr += String(c); if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stderr) : reject(new Error("ffmpeg failed: " + stderr.slice(-300))); });
  });
}
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
