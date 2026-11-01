import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Asset, ProjectRevision, Timeline, TimelineClip, TranscriptSegment } from "@videocraft/domain";
import type { AssetRepository, ProjectRepository, RevisionRepository } from "@videocraft/application";
import { applyTimelineOperations } from "@videocraft/domain";
import { composeMusicAsset } from "./music-routes.js";
import type { ObjectStorage } from "@videocraft/storage";
import { criticInstructions, scriptPreferences, scriptQualityIssues, writerInstructions, type ScriptPreferences } from "./director-playbook.js";

export type StoryScene = { assetId: string; startS: number; durationS: number; text: string; visual: string; search?: string };

const CAMERA_WORDS = new Set("a an the and or of to in on at with into onto over under from by for as is are be then while their his her its our your this that these those same shot shots close-up closeup close up wide medium tracking lateral smooth slow push pull pan tilt zoom frame framing angle eye level depth field shallow cut match-cut match cinematic camera lens focus light lighting daylight sunlight warm soft natural gentle gently soundscape ambience music score footsteps shot vignette opening scene continue continues continuing end ends hold holds brief briefly glimpse glimpses beat moment authentic realistic dignified restrained understated exaggerated distress shows show showing reveals reveal genuine exchange exchanges small little very more most some one two three first second third modest beautiful quiet sunlit sunny morning evening afternoon residential shaded filled school-age naturally moving background foreground pausing pauses beside near through".split(" "));
/** A few plain words a stock library can match, from a cinematic scene description ("girl homework courtyard nigeria"). */
export function stockQuery(visual: string): string {
  const words = visual.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !CAMERA_WORDS.has(w) && !/ly$/.test(w));
  const seen = new Set<string>(); const picked: string[] = [];
  for (const w of words) { const base = w.replace(/'s$/, ""); if (!seen.has(base)) { seen.add(base); picked.push(base); } if (picked.length >= 5) break; }
  return picked.join(" ");
}
export type StoryPlan = { summary: string; script: string; scenes: StoryScene[]; source: "ai" | "rules"; note?: string; selectedApproach?: string; critique?: string };
export type StoryFrame = { assetId: string; atS: number; jpegBase64: string };
export type StoryInput = { brief: string; seconds: number; assets: Array<{ id: string; kind: string; name: string; seconds: number; transcript: string }>; frames: StoryFrame[]; preferences?: ScriptPreferences };
export interface CreationDependencies {
  projects: ProjectRepository; assets: AssetRepository; revisions: RevisionRepository; storage: ObjectStorage;
  transcripts: { listForAsset(id: string): Promise<TranscriptSegment[]> };
  authenticate(request: FastifyRequest): Promise<{ userId: string } | null>;
  authorize: { canAccess(principal: { userId: string }, id: string, role: "editor"): Promise<boolean> };
  saveRevision(input: { projectId: string; createdBy: string; timeline: Timeline; acceptedProposalIds: string[]; tailoring: NonNullable<ProjectRevision["tailoring"]> }): Promise<ProjectRevision>;
  plan?(input: StoryInput): Promise<unknown>;
  ffmpeg?: string;
  clock(): string;
}

/** Bounded samples, not a claim to have watched every second. Unknown/large uploads are explicitly skipped. */
export async function sampleStoryFrames(d: Pick<CreationDependencies, "storage" | "ffmpeg">, assets: Asset[], moments?: Array<{ assetId: string; atS: number }>): Promise<StoryFrame[]> {
  const frames: StoryFrame[] = []; let bytes = 0;
  const signal = AbortSignal.timeout(15_000);
  for (const asset of assets.slice(0, 12)) {
    if (signal.aborted) break;
    const size = Number(asset.metadata.sizeBytes);
    if (!Number.isFinite(size) || size <= 0 || size > 50 * 1024 ** 2 || bytes + size > 100 * 1024 ** 2) continue;
    bytes += size;
    const directory = await mkdtemp(join(tmpdir(), "videocraft-story-frames-"));
    try {
      const path = d.storage.downloadToFile ? join(directory, "source.media") : d.storage.resolve(asset.storageKey);
      if (d.storage.downloadToFile) await d.storage.downloadToFile(asset.storageKey, path, { signal });
      const times = moments ? [...new Set(moments.filter(m => m.assetId === asset.id && Number.isFinite(m.atS) && m.atS >= 0).slice(0, 2).map(m => asset.kind === "image" ? 0 : m.atS))] : asset.kind === "image" ? [0] : [0, Math.max(0, (asset.durationUs ?? 0) / 2e6)];
      for (const atS of times) {
        const jpeg = await new Promise<Buffer>((resolve, reject) => {
          execFile(d.ffmpeg ?? "ffmpeg", ["-v", "error", "-threads", "1", "-filter_threads", "1", "-ss", atS.toFixed(3), "-i", path, "-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease", "-q:v", "7", "-threads", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { timeout: 10_000, maxBuffer: 1024 ** 2, signal, encoding: "buffer" }, (err, stdout) => err ? reject(err) : resolve(stdout));
        });
        if (jpeg.length > 2 && jpeg[0] === 255 && jpeg[1] === 216) frames.push({ assetId: asset.id, atS, jpegBase64: jpeg.toString("base64") });
      }
    } catch { /* The returned sample count makes missing visual evidence explicit. */ }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  return frames;
}

/** Validate both provider output and the editable storyboard returned by the browser. */
export function storyScenes(value: unknown, assets: Asset[], allowMissing = false): StoryScene[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) throw new Error("Choose between 1 and 40 scenes");
  const owned = new Map(assets.map(a => [a.id, a]));
  const scenes = value.map((row): StoryScene => {
    if (!row || typeof row !== "object") throw new Error("Invalid scene");
    const s = row as Record<string, unknown>;
    if (typeof s.assetId !== "string") throw new Error("Choose a visual for every scene");
    const a = owned.get(s.assetId);
    if ((!a || !["image", "video"].includes(a.kind)) && !(allowMissing && s.assetId === "")) throw new Error("A scene references media outside this project");
    if (typeof s.startS !== "number" || !Number.isFinite(s.startS) || s.startS < 0 || s.startS > 86400) throw new Error("Invalid scene start");
    if (typeof s.durationS !== "number" || !Number.isFinite(s.durationS) || s.durationS < 0.5 || s.durationS > 60) throw new Error("Scenes must last between 0.5 and 60 seconds");
    if (a?.kind === "image" && s.startS !== 0) throw new Error("Photos must start at zero");
    if (a?.kind === "video" && (!a.durationUs || Math.round((s.startS + s.durationS) * 1e6) > a.durationUs)) throw new Error("A scene extends beyond its video");
    return { assetId: s.assetId, startS: s.startS, durationS: s.durationS, text: typeof s.text === "string" ? s.text.slice(0, 120) : "", visual: typeof s.visual === "string" ? s.visual.slice(0, 300) : "", ...(typeof s.search === "string" && s.search.trim() ? { search: s.search.trim().slice(0, 80) } : typeof s.visual === "string" && s.visual.trim() ? { search: stockQuery(s.visual) } : {}) };
  });
  if (scenes.reduce((n, s) => n + s.durationS, 0) > 600) throw new Error("Stories can last up to ten minutes");
  return scenes;
}

/** Keep the complete narration. Repeat the last visual rather than silently cutting the voice. */
export function storyTimeline(scenes: StoryScene[], narration?: Asset, sceneText = true, assets: Asset[] = []): Timeline {
  const clips: TimelineClip[] = []; let at = 0;
  const add = (s: StoryScene, durationUs = Math.round(s.durationS * 1e6)) => {
    if (clips.length >= 40) throw new Error("Narration needs too many repeated clips. Lengthen the final scene or finish with a photo.");
    const start = Math.round(s.startS * 1e6);
    clips.push({ id: randomUUID(), assetId: s.assetId, sourceStartUs: start, sourceEndUs: start + durationUs, timelineStartUs: at, timelineEndUs: at + durationUs, reason: s.visual || "Storyboard scene", transform: { background: "none", ...(narration ? { muteSource: true } : {}) } });
    at += durationUs;
  };
  scenes.forEach(s => add(s));
  if (narration) {
    if (!narration.durationUs || narration.durationUs < 200_000 || narration.durationUs > 600_000_000) throw new Error("Narration must have a known duration between 0.2 seconds and ten minutes");
    const last = scenes.at(-1)!;
    if (at < narration.durationUs && assets.find(a => a.id === last.assetId)?.kind === "image") {
      const tail = clips.at(-1)!; tail.sourceEndUs += narration.durationUs - at; tail.timelineEndUs = narration.durationUs; at = narration.durationUs;
    } else while (at < narration.durationUs) add(last, Math.min(Math.round(last.durationS * 1e6), narration.durationUs - at));
  }
  let timeline: Timeline = { durationUs: at, tracks: [{ id: "video", kind: "video", clips }] };
  if (narration) timeline.tracks.push({ id: "narration", kind: "audio", clips: [{ id: randomUUID(), assetId: narration.id, sourceStartUs: 0, sourceEndUs: narration.durationUs!, timelineStartUs: 0, timelineEndUs: narration.durationUs!, transform: { role: "voiceover", volumeDb: 0, duck: true, anchorAssetId: clips[0]!.assetId, anchorSourceUs: clips[0]!.sourceStartUs, anchorClipId: clips[0]!.id, durationUs: narration.durationUs!, timelineBound: true } }] });
  // Text is approved scene text, not fabricated word timings for a generated or recorded voice.
  if (sceneText) {
    const graphics: TimelineClip[] = scenes.flatMap((s, i) => s.text.trim() ? [{ id: randomUUID(), assetId: "generated:graphic", sourceStartUs: 0, sourceEndUs: clips[i]!.timelineEndUs - clips[i]!.timelineStartUs, timelineStartUs: clips[i]!.timelineStartUs, timelineEndUs: clips[i]!.timelineEndUs, transform: { role: "graphic", kind: "callout", text: s.text.trim(), position: "bottom", anchorAssetId: clips[i]!.assetId, anchorSourceUs: clips[i]!.sourceStartUs, anchorClipId: clips[i]!.id, durationUs: clips[i]!.timelineEndUs - clips[i]!.timelineStartUs } }] : []);
    if (graphics.length) timeline.tracks.push({ id: "graphics", kind: "overlay", clips: graphics });
  }
  return timeline;
}

export function registerCreationRoutes(server: FastifyInstance, d: CreationDependencies): void {
  const context = async (request: FastifyRequest) => {
    const principal = await d.authenticate(request); if (!principal) return { status: 401, message: "Authentication required" } as const;
    const { projectId } = request.params as { projectId: string };
    if (!(await d.authorize.canAccess(principal, projectId, "editor"))) return { status: 403, message: "Project access denied" } as const;
    const project = await d.projects.get(projectId); if (!project) return { status: 404, message: "Project not found" } as const;
    return { principal, projectId, project, assets: await d.assets.listForProject(projectId) };
  };
  server.post("/v1/projects/:projectId/creation/plan", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } } as never, async (request: FastifyRequest, reply) => {
    const c = await context(request); if ("status" in c) return reply.code(c.status).send({ error: { message: c.message } });
    const b = (request.body ?? {}) as Record<string, unknown>;
    const brief = typeof b.brief === "string" ? b.brief.trim().slice(0, 2000) : "";
    if (brief.length < 3) return reply.code(400).send({ error: { message: "Describe the story first" } });
    const seconds = Number(b.seconds); if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) return reply.code(400).send({ error: { message: "Choose a duration from 5 to 600 seconds" } });
    if (!Array.isArray(b.assetIds) || b.assetIds.length > 40 || !b.assetIds.every(id => typeof id === "string")) return reply.code(400).send({ error: { message: "Choose up to 40 media items" } });
    const selected = b.assetIds.map(id => c.assets.find(a => a.id === id && ["image", "video"].includes(a.kind)));
    if (selected.some(a => !a)) return reply.code(400).send({ error: { message: "Media must belong to this project" } });
    const assets = selected as Asset[];
    const fallback: StoryPlan = { source: "rules", summary: "A storyboard in your chosen media order. Review the visuals and write your narration before assembling.", script: "", scenes: assets.length ? assets.map(a => ({ assetId: a.id, startS: 0, durationS: Math.max(0.5, Math.min(60, seconds / assets.length, a.kind === "video" ? (a.durationUs ?? 0) / 1e6 : 60)), text: "", visual: String(a.metadata.filename ?? a.kind) })) : [{ assetId: "", startS: 0, durationS: Math.min(60, seconds), text: "", visual: brief.slice(0, 300) }] };
    let plan = fallback;
    if (d.plan) try {
      const [frames, media] = await Promise.all([sampleStoryFrames(d, assets), Promise.all(assets.map(async a => ({ id: a.id, kind: a.kind, name: String(a.metadata.filename ?? a.kind), seconds: a.kind === "image" ? 60 : (a.durationUs ?? 0) / 1e6, transcript: (await d.transcripts.listForAsset(a.id)).map(s => s.text).join(" ").slice(0, 3000) })))]);
      const input: StoryInput = { brief, seconds, assets: media, frames, preferences: scriptPreferences(b.preferences) };
      const raw = await d.plan(input) as Record<string, unknown>;
      plan = { source: "ai", summary: typeof raw.summary === "string" ? raw.summary.slice(0, 1000) : "Review your storyboard", script: typeof raw.script === "string" ? raw.script.slice(0, 3000) : "", scenes: storyScenes(raw.scenes, assets, true), ...(typeof raw.selectedApproach === "string" ? { selectedApproach: raw.selectedApproach.slice(0, 120) } : {}), ...(typeof raw.critique === "string" ? { critique: raw.critique.slice(0, 1000) } : {}) };
      if (assets.length) plan.note = "Visual samples from " + new Set(frames.map(f => f.assetId)).size + " of " + assets.length + " selected media items informed this plan. Large uploads, missing size metadata, and items beyond the sampling limit use filenames and existing transcripts. Review every scene before assembling.";
    } catch (err) { request.log.warn({ err, projectId: c.projectId }, "Storyboard planning failed"); plan = { ...fallback, note: "AI planning was unavailable. Your media is kept in its selected order; you can edit the storyboard below." }; }
    return { plan };
  });
  server.post("/v1/projects/:projectId/creation/apply", async (request, reply) => {
    const c = await context(request); if ("status" in c) return reply.code(c.status).send({ error: { message: c.message } });
    const b = (request.body ?? {}) as Record<string, unknown>;
    if (!Number.isSafeInteger(b.revision) || b.revision !== c.project.revision) return reply.code(409).send({ error: { message: "A newer edit exists. Reload before assembling this story." } });
    try {
      const scenes = storyScenes(b.scenes, c.assets);
      const narration = typeof b.narrationAssetId === "string" && b.narrationAssetId ? c.assets.find(a => a.id === b.narrationAssetId && a.kind === "audio") : undefined;
      if (b.narrationAssetId && !narration) throw new Error("Narration must be an audio asset in this project");
      let timeline = storyTimeline(scenes, narration, b.sceneText === true, c.assets);
      if (narration && b.captions === true) {
        const segments = await d.transcripts.listForAsset(narration.id);
        const words = segments.flatMap(s => s.words).filter(w => Number.isSafeInteger(w.startUs) && Number.isSafeInteger(w.endUs) && w.startUs >= 0 && w.endUs > w.startUs && w.startUs < narration.durationUs!).sort((a, b) => a.startUs - b.startUs);
        if (!words.length) throw new Error("Transcribe the narration before adding speech captions, or turn captions off");
        const cues: TimelineClip[] = [];
        for (let i = 0; i < words.length; i += 4) {
          const group = words.slice(i, i + 4); const start = group[0]!.startUs; const end = Math.min(group.at(-1)!.endUs, narration.durationUs!);
          if (end <= start) continue;
          cues.push({ id: randomUUID(), assetId: "generated:caption", sourceStartUs: 0, sourceEndUs: end - start, timelineStartUs: start, timelineEndUs: end, transform: { text: group.map(w => w.text).join(" ") } });
        }
        timeline.tracks.push({ id: "captions", kind: "caption", clips: cues });
      }

      if (b.music === true) {
        const music = await composeMusicAsset({ projectId: c.projectId, mood: "inspiring", lengthUs: timeline.durationUs, accentsS: timeline.tracks[0]!.clips.slice(1).map(clip => clip.timelineStartUs / 1e6), seed: 23 }, d);
        timeline = applyTimelineOperations(timeline, [{ type: "set-music", assetId: music.asset.id, volumeDb: -22, duck: true }]);
      }
      const platform = ["tiktok", "youtube", "square"].includes(String(b.platform)) ? String(b.platform) : "tiktok";
      const latest = await d.projects.get(c.projectId);
      if (latest?.revision !== b.revision) return reply.code(409).send({ error: { message: "A newer edit exists. Reload before assembling this story." } });
      const revision = await d.saveRevision({ projectId: c.projectId, createdBy: c.principal.userId, timeline, acceptedProposalIds: [], tailoring: { intent: String(b.brief ?? "").slice(0, 2000), audience: "", channel: platform, tone: "", targetDurationUs: timeline.durationUs, constraints: ["creation:story"] } });
      return reply.code(201).send({ revision, platform });
    } catch (err) { return reply.code(400).send({ error: { message: err instanceof Error ? err.message : "Could not assemble the story" } }); }
  });
}

/** Same structured Responses API used by AI Director; provider failures are an explicit fallback. */
export function storyboardPlanner(options: { apiKey: string; model: string; endpoint?: string }) {
  return async (input: StoryInput): Promise<unknown> => {
    const { frames, ...description } = input;
    const content: Array<Record<string, unknown>> = [{ type: "input_text", text: JSON.stringify(description) }];
    for (const frame of frames) content.push({ type: "input_text", text: "Asset " + frame.assetId + ", frame at " + frame.atS.toFixed(2) + " seconds" }, { type: "input_image", image_url: "data:image/jpeg;base64," + frame.jpegBase64, detail: "low" });
    const fields = { assetId: { type: "string" }, startS: { type: "number" }, durationS: { type: "number" }, text: { type: "string" }, visual: { type: "string" }, search: { type: "string" } };
    const sceneSchema = { type: "array", items: { type: "object", additionalProperties: false, properties: fields, required: Object.keys(fields) } };
    const endpoint = (options.endpoint ?? "https://api.openai.com/v1").replace(/\/$/, "") + "/responses";
    const ask = async (instructions: string, requestContent: Array<Record<string, unknown>>, name: string, schema: unknown) => {
      const response = await fetch(endpoint, {
      method: "POST", signal: AbortSignal.timeout(60_000), headers: { authorization: "Bearer " + options.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ model: options.model, instructions, input: [{ role: "user", content: requestContent }], text: { format: { type: "json_schema", name, strict: true, schema } } }),
    });
    if (!response.ok) throw new Error("Storyboard provider returned " + response.status);
    const body = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    const text = body.output_text ?? body.output?.flatMap(x => x.content ?? []).find(x => x.type === "output_text")?.text;
    if (!text) throw new Error("Storyboard provider returned no text");
    return JSON.parse(text);
    };
    const approach = { type: "object", additionalProperties: false, properties: { label: { type: "string" }, strategy: { type: "string" }, summary: { type: "string" }, script: { type: "string" }, scenes: sceneSchema }, required: ["label", "strategy", "summary", "script", "scenes"] };
    const drafts = await ask(writerInstructions(input.brief, input.preferences ?? scriptPreferences(null)), content, "storyboard_approaches", { type: "object", additionalProperties: false, properties: { approaches: { type: "array", minItems: 3, maxItems: 3, items: approach } }, required: ["approaches"] }) as { approaches: unknown[] };
    const criticContent = [{ type: "input_text", text: JSON.stringify({ brief: input.brief, seconds: input.seconds, approaches: drafts.approaches }) }];
    const final = await ask(criticInstructions(input.preferences ?? scriptPreferences(null)), criticContent, "storyboard_final", { type: "object", additionalProperties: false, properties: { summary: { type: "string" }, script: { type: "string" }, scenes: sceneSchema, selectedApproach: { type: "string" }, critique: { type: "string" } }, required: ["summary", "script", "scenes", "selectedApproach", "critique"] }) as Record<string, unknown>;
    const issues = scriptQualityIssues(String(final.script ?? ""), input.brief, input.preferences ?? scriptPreferences(null));
    if (issues.length) throw new Error("Storyboard quality gate rejected the script: " + issues.join("; "));
    return final;
  };
}
