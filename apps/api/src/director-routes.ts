import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { applyTimelineOperations, type ProjectRevision, type TranscriptSegment, type UUID } from "@videocraft/domain";
import type { AssetRepository, ProjectRepository, RevisionRepository } from "@videocraft/application";
import type { ObjectStorage } from "@videocraft/storage";
import { briefHints, planOperations, sanitizePlan, type Director, type DirectorInput, type DirectorPlan } from "@videocraft/director";
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
}

/** Plans a whole edit from the person's own description (AI director, or rules without a key), then applies the accepted parts. */
export function registerDirectorRoutes(server: FastifyInstance, dependencies: DirectorRouteDependencies): void {
  const context = async (request: FastifyRequest, reply: FastifyReply) => {
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

  server.post("/v1/projects/:projectId/director/plan", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } } as never, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await context(request, reply);
    if (!ctx) return reply;
    const brief = typeof ctx.body.brief === "string" ? ctx.body.brief.trim().slice(0, 2000) : "";
    if (brief.length < 3) return error(reply, 400, "invalid_request", "Describe what the video is about and what you want");
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
    const plan = await dependencies.director.plan({
      brief, durationS: ctx.durationS, frame: { width: Number(ctx.main.metadata.width) || 1080, height: Number(ctx.main.metadata.height) || 1920 },
      transcript: ctx.transcript.map((s) => ({ startS: s.startUs / 1e6, endS: s.endUs / 1e6, text: s.text })), candidates, frames, assets: ctx.others,
    });
    return { plan };
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
    const musicSuggestion = plan.suggestions.find((s) => s.kind === "music" && accepted.has(s.id));
    let music: { description: string } | undefined;
    if (musicSuggestion && musicSuggestion.kind === "music") {
      const clips = timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).sort((a, b) => a.timelineStartUs - b.timelineStartUs);
      const lengthUs = clips.reduce((sum, clip) => sum + clip.sourceEndUs - clip.sourceStartUs, 0);
      if (lengthUs >= 3_000_000) {
        const composed = await composeMusicAsset({ projectId: ctx.projectId, mood: musicSuggestion.mood, lengthUs, accentsS: clips.slice(1).map((c) => c.timelineStartUs / 1e6), seed: Math.floor(Math.random() * 1e9) }, dependencies);
        timeline = applyTimelineOperations(timeline, [{ type: "set-music", assetId: composed.asset.id, volumeDb: -16, duck: true }]);
        music = { description: composed.music.description };
      }
    }
    const revision = await dependencies.saveRevision({
      projectId: ctx.projectId, createdBy: ctx.principal.userId, timeline, acceptedProposalIds: ctx.revision.acceptedProposalIds,
      tailoring: { intent: plan.profile.intent, audience: plan.profile.audience, channel: plan.profile.channel, ...(plan.profile.tone ? { tone: plan.profile.tone } : {}), targetDurationUs: plan.profile.targetSeconds * 1_000_000, constraints: [] },
    });
    const platform = plan.suggestions.find((s) => s.kind === "platform" && accepted.has(s.id));
    return reply.code(201).send({ revision, ...(platform && platform.kind === "platform" ? { platform: platform.platform } : {}), ...(music ? { music } : {}) });
  });
}

/** JPEG stills spread across the video (small, for the director to look at). */
async function sampleFrames(dependencies: DirectorRouteDependencies, storageKey: string, durationS: number, count: number): Promise<DirectorInput["frames"]> {
  const directory = await mkdtemp(join(tmpdir(), "videocraft-frames-"));
  try {
    let input = dependencies.storage.downloadToFile ? join(directory, "input.media") : dependencies.storage.resolve(storageKey);
    if (dependencies.storage.downloadToFile) await dependencies.storage.downloadToFile(storageKey, input);
    const frames: DirectorInput["frames"] = [];
    for (let i = 0; i < count; i += 1) {
      const atS = Math.max(0, (durationS * (i + 0.5)) / count);
      const out = join(directory, "f" + i + ".jpg");
      await run(dependencies.ffmpeg ?? "ffmpeg", ["-v", "error", "-y", "-ss", atS.toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale='min(512,iw)':-2", "-q:v", "6", out]);
      frames.push({ atS, jpegBase64: (await readFile(out)).toString("base64") });
    }
    input = "";
    return frames;
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (c) => { stderr += String(c); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("ffmpeg failed: " + stderr.slice(-300))); });
  });
}
function error(reply: FastifyReply, status: number, code: string, message: string) { return reply.code(status).send({ error: { code, message } }); }
