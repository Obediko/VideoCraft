import { buildCues, cueOperations } from "@videocraft/captions";
import type { Timeline, TimelineOperation, TranscriptWord } from "@videocraft/domain";

/**
 * The AI director: reads what is said, looks at sampled frames, and proposes a whole edit as a list of
 * suggestions, each with a reason, that the person accepts or rejects one by one. Everything it proposes
 * is grounded (cuts come from real transcript windows, graphics land on moments that survive the cut,
 * images come from the project) and validated before it can touch the timeline.
 */

export const MOODS = ["upbeat", "calm", "inspiring", "serious", "playful"] as const;
export const PLATFORMS = ["tiktok", "youtube", "square"] as const;

export interface DirectorInput {
  brief: string;
  durationS: number;
  frame: { width: number; height: number };
  transcript: Array<{ startS: number; endS: number; text: string }>;
  /** Strong candidate windows (from the highlight scorer); cuts are built from these. */
  candidates: Array<{ id: string; startS: number; endS: number; text: string; score: number }>;
  frames: Array<{ atS: number; jpegBase64: string }>;
  /** Other project media the director may cut away to. */
  assets: Array<{ id: string; kind: "image" | "video"; name: string }>;
}

export type Suggestion =
  | { id: string; kind: "cut"; title: string; reason: string; segments: Array<{ startS: number; endS: number }> }
  | { id: string; kind: "title" | "callout" | "lower-third"; title: string; reason: string; text: string; subtitle?: string; atS: number; durationS: number; position?: "top" | "center" | "bottom" }
  | { id: string; kind: "music"; title: string; reason: string; mood: (typeof MOODS)[number] }
  | { id: string; kind: "broll"; title: string; reason: string; assetId: string; atS: number; durationS: number; mode: "full" | "pip" }
  | { id: string; kind: "progress"; title: string; reason: string }
  | { id: string; kind: "platform"; title: string; reason: string; platform: (typeof PLATFORMS)[number] }
  | { id: string; kind: "advice"; title: string; reason: string };

export interface DirectorPlan {
  summary: string;
  profile: { intent: string; audience: string; channel: string; tone: string; targetSeconds: number };
  suggestions: Suggestion[];
  source: "ai" | "rules";
  model?: string;
  /** Why the AI director was not used, when it was not. */
  note?: string;
}

export interface Director { plan(input: DirectorInput): Promise<DirectorPlan>; }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/** Turns any model output into a safe plan: unknown kinds, out-of-range times and foreign assets are dropped. */
export function sanitizePlan(raw: unknown, input: DirectorInput, source: DirectorPlan["source"], extra: { model?: string; note?: string } = {}): DirectorPlan {
  const r = (raw ?? {}) as Record<string, unknown>;
  const p = (r.profile ?? {}) as Record<string, unknown>;
  const targetSeconds = clamp(Math.round(num(p.targetSeconds) || 30), 5, Math.max(5, Math.floor(input.durationS)));
  const profile = { intent: text(p.intent, 300) || text(input.brief, 300) || "A clear, engaging edit", audience: text(p.audience, 120) || "General audience", channel: text(p.channel, 40) || "short-form", tone: text(p.tone, 60) || "", targetSeconds };
  const assetIds = new Set(input.assets.map((asset) => asset.id));
  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();
  const base = (s: Record<string, unknown>, index: number) => {
    let id = text(s.id, 40).replace(/[^a-zA-Z0-9_-]/g, "") || "s" + (index + 1);
    while (seen.has(id)) id += "x";
    seen.add(id);
    return { id, title: text(s.title, 120) || "Suggestion", reason: text(s.reason, 400) };
  };
  const list = Array.isArray(r.suggestions) ? (r.suggestions as Array<Record<string, unknown>>).slice(0, 30) : [];
  list.forEach((s, index) => {
    if (!s || typeof s !== "object") return;
    const kind = s.kind;
    if (kind === "cut") {
      if (suggestions.some((existing) => existing.kind === "cut")) return; // one cut per plan
      const segments = (Array.isArray(s.segments) ? s.segments : []).map((seg: Record<string, unknown>) => ({ startS: num(seg?.startS), endS: num(seg?.endS) }))
        .filter((seg) => seg.startS >= 0 && seg.endS > seg.startS + 0.5 && seg.endS <= input.durationS + 0.01)
        .sort((a, b) => a.startS - b.startS)
        .filter((seg, i, all) => i === 0 || seg.startS >= all[i - 1]!.endS); // no overlaps
      if (segments.length === 0) return;
      // Keep the plan close to the target length: drop trailing segments that overshoot by more than 15%.
      const kept: typeof segments = [];
      let total = 0;
      for (const seg of segments) { const length = seg.endS - seg.startS; if (kept.length > 0 && total + length > targetSeconds * 1.15) continue; kept.push(seg); total += length; }
      suggestions.push({ ...base(s, index), kind: "cut", segments: kept.slice(0, 12) });
    } else if (kind === "title" || kind === "callout" || kind === "lower-third") {
      const t = text(s.text, 120); const atS = num(s.atS); const durationS = clamp(num(s.durationS) || 3, 0.5, 15);
      if (!t || !(atS >= 0 && atS < input.durationS)) return;
      const position = s.position === "top" || s.position === "center" || s.position === "bottom" ? s.position : undefined;
      const subtitle = text(s.subtitle, 120);
      suggestions.push({ ...base(s, index), kind, text: t, ...(subtitle ? { subtitle } : {}), atS, durationS, ...(position ? { position } : {}) });
    } else if (kind === "music") {
      if (!MOODS.includes(s.mood as never) || suggestions.some((existing) => existing.kind === "music")) return;
      suggestions.push({ ...base(s, index), kind: "music", mood: s.mood as (typeof MOODS)[number] });
    } else if (kind === "broll") {
      const assetId = text(s.assetId, 80); const atS = num(s.atS);
      if (!assetIds.has(assetId) || !(atS >= 0 && atS < input.durationS)) return;
      suggestions.push({ ...base(s, index), kind: "broll", assetId, atS, durationS: clamp(num(s.durationS) || 2.5, 0.5, 10), mode: s.mode === "pip" ? "pip" : "full" });
    } else if (kind === "progress") {
      if (!suggestions.some((existing) => existing.kind === "progress")) suggestions.push({ ...base(s, index), kind: "progress" });
    } else if (kind === "platform") {
      if (PLATFORMS.includes(s.platform as never) && !suggestions.some((existing) => existing.kind === "platform")) suggestions.push({ ...base(s, index), kind: "platform", platform: s.platform as (typeof PLATFORMS)[number] });
    } else if (kind === "advice") {
      const b = base(s, index); if (b.reason || b.title) suggestions.push({ ...b, kind: "advice" });
    }
  });
  return { summary: text(r.summary, 600) || "A proposed edit for your video.", profile, suggestions, source, ...(extra.model ? { model: extra.model } : {}), ...(extra.note ? { note: extra.note } : {}) };
}

/** Infers platform and length hints from the person's own words. */
export function briefHints(brief: string): { channel: string; platform: (typeof PLATFORMS)[number]; targetSeconds?: number; mood?: (typeof MOODS)[number] } {
  const b = brief.toLowerCase();
  const platform = /youtube(?! short)|landscape|16:9|long[- ]form/.test(b) ? "youtube" : /linkedin|square|1:1|feed/.test(b) ? "square" : "tiktok";
  const seconds = /(\d{1,3})\s*-?\s*(s|sec|secs|second|seconds)\b/.exec(b)?.[1] ?? (/(\d{1,2})\s*(min|minute)/.exec(b)?.[1] ? String(Number(/(\d{1,2})\s*(min|minute)/.exec(b)![1]) * 60) : undefined);
  // Only moods the person actually asked for (the music package's inferMood also guesses from the channel).
  const mood = /\b(calm|relax|gentle|soft|peace|meditat|soothing|reflect|poem|poetry|spoken word|devotion|worship|prayer)/.test(b) ? "calm"
    : /\b(serious|professional|formal|corporate|news|sermon|dramatic|documentar)/.test(b) ? "serious"
    : /\b(inspir|motivat|uplift|hope|mission|impact)/.test(b) ? "inspiring"
    : /\b(fun|funny|playful|kids|children|comedy|silly|quirky|cute)/.test(b) ? "playful"
    : /\b(energ|hype|exciting|launch|sale|promo|upbeat|dynamic|lively|punchy)/.test(b) ? "upbeat" : undefined;
  return { channel: platform === "youtube" ? "youtube" : "short-form", platform, ...(seconds ? { targetSeconds: Number(seconds) } : {}), ...(mood ? { mood } : {}) };
}

/** A director without a model: the strongest windows, a hook title, matching music and the right format. */
export class RuleDirector implements Director {
  async plan(input: DirectorInput): Promise<DirectorPlan> {
    const hints = briefHints(input.brief);
    const target = hints.targetSeconds ?? (hints.platform === "youtube" ? 90 : 30);
    const chosen: DirectorInput["candidates"] = [];
    let total = 0;
    for (const candidate of [...input.candidates].sort((a, b) => b.score - a.score)) {
      const length = candidate.endS - candidate.startS;
      if (chosen.some((c) => candidate.startS < c.endS && candidate.endS > c.startS)) continue;
      if (chosen.length > 0 && total + length > target * 1.1) continue;
      chosen.push(candidate); total += length;
      if (total >= target * 0.9) break;
    }
    chosen.sort((a, b) => a.startS - b.startS);
    const first = chosen[0];
    const hook = first ? first.text.split(/(?<=[.!?])\s/)[0]!.slice(0, 60) : "";
    const raw = {
      summary: "Built-in rules picked the strongest moments for your brief and added a title, matching music and the " + (hints.platform === "tiktok" ? "9:16" : hints.platform === "youtube" ? "YouTube 16:9" : "1:1 feed") + " format. Add an OpenAI key for an AI director that also looks at your footage.",
      profile: { intent: input.brief, audience: "", channel: hints.channel, tone: hints.mood ?? "", targetSeconds: target },
      suggestions: [
        ...(chosen.length ? [{ id: "cut", kind: "cut", title: "Keep the " + chosen.length + " strongest moment" + (chosen.length === 1 ? "" : "s") + " (" + Math.round(total) + "s)", reason: "Highest scores for completeness, pace and fit to your brief.", segments: chosen.map((c) => ({ startS: c.startS, endS: c.endS })) }] : []),
        ...(hook && first ? [{ id: "title", kind: "title", title: "Open with a title", reason: "A short title in the first seconds tells viewers what they are about to get.", text: hook, atS: first.startS + 0.2, durationS: 2.5, position: "top" }] : []),
        { id: "music", kind: "music", title: "Add " + (hints.mood ?? (hints.platform === "youtube" ? "calm" : "upbeat")) + " music", reason: "Matches the feel of your brief; it dips under speech.", mood: hints.mood ?? (hints.platform === "youtube" ? "calm" : "upbeat") },
        ...(hints.platform !== "youtube" ? [{ id: "progress", kind: "progress", title: "Show a progress bar", reason: "Short-form viewers stay longer when they can see how much is left." }] : []),
        { id: "platform", kind: "platform", title: "Export for " + (hints.platform === "tiktok" ? "TikTok / Reels / Shorts (9:16)" : hints.platform === "youtube" ? "YouTube (16:9)" : "feeds (1:1)"), reason: "Taken from your description.", platform: hints.platform },
      ],
    };
    return sanitizePlan(raw, input, "rules");
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
export interface OpenAiDirectorOptions { apiKey: string; model: string; endpoint?: string; timeoutMs?: number; fetchImpl?: Fetch; fallback?: Director; }

const SYSTEM = `You are an award-winning video editor and creative director. You will get: the creator's own description of the video and what they want, the timed transcript, candidate moments (with ids and scores), still frames sampled from the footage, and the other media in the project.
Propose a complete edit as a list of suggestions the creator can accept or reject one by one. Be specific and tasteful, like a professional editor: a strong hook, tight pacing, text only where it adds meaning, music that fits the feeling.
Rules:
- "cut": choose the moments to keep, as segments (startS/endS in source seconds) taken from the candidates or exact sentence boundaries in the transcript. Respect the length the creator asks for; otherwise 20-45 s for short-form, 60-180 s for YouTube.
- "title", "callout", "lower-third": text on screen at a source time (atS) INSIDE a kept segment. Titles max ~6 words. Lower thirds name a person (text) and role (subtitle) only if the transcript or brief makes them clear.
- "music": one mood from: upbeat, calm, inspiring, serious, playful.
- "broll": only with assetId values from the project media list; place at a source time inside a kept segment where the words describe it.
- "progress": a progress bar (good for short-form).
- "platform": tiktok (9:16), youtube (16:9) or square (1:1).
- "advice": what you see in the frames that the creator could improve that you cannot change (lighting, framing, background, sound), kindly and concretely.
Every suggestion needs a short title and a reason that cites what you saw or heard. Never invent facts, names, numbers or quotes.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "profile", "suggestions"],
  properties: {
    summary: { type: "string" },
    profile: { type: "object", additionalProperties: false, required: ["intent", "audience", "channel", "tone", "targetSeconds"], properties: { intent: { type: "string" }, audience: { type: "string" }, channel: { type: "string" }, tone: { type: "string" }, targetSeconds: { type: "number" } } },
    suggestions: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["id", "kind", "title", "reason", "segments", "text", "subtitle", "atS", "durationS", "position", "mood", "assetId", "mode", "platform"],
      properties: {
        id: { type: "string" }, kind: { type: "string", enum: ["cut", "title", "callout", "lower-third", "music", "broll", "progress", "platform", "advice"] },
        title: { type: "string" }, reason: { type: "string" },
        segments: { type: "array", items: { type: "object", additionalProperties: false, required: ["startS", "endS"], properties: { startS: { type: "number" }, endS: { type: "number" } } } },
        text: { type: "string" }, subtitle: { type: "string" }, atS: { type: "number" }, durationS: { type: "number" },
        position: { type: "string", enum: ["top", "center", "bottom", ""] }, mood: { type: "string", enum: [...MOODS, ""] }, assetId: { type: "string" },
        mode: { type: "string", enum: ["full", "pip", ""] }, platform: { type: "string", enum: [...PLATFORMS, ""] },
      } } },
  },
};

/** The AI director over OpenAI's Responses API with image input and a strict JSON schema; falls back to rules. */
export class OpenAiDirector implements Director {
  private readonly fetchImpl: Fetch;
  constructor(private readonly options: OpenAiDirectorOptions) {
    if (!options.apiKey || !options.model) throw new Error("OpenAI director needs an API key and a model");
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as Fetch);
  }
  async plan(input: DirectorInput): Promise<DirectorPlan> {
    try {
      const raw = await this.call(input);
      const plan = sanitizePlan(raw, input, "ai", { model: this.options.model });
      if (!plan.suggestions.some((s) => s.kind === "cut")) throw new Error("the AI plan had no usable cut");
      return plan;
    } catch (error) {
      const fallback = await (this.options.fallback ?? new RuleDirector()).plan(input);
      return { ...fallback, note: "The AI director was unavailable (" + (error instanceof Error ? error.message : "error").slice(0, 200) + "); built-in rules made this plan." };
    }
  }
  private async call(input: DirectorInput): Promise<unknown> {
    const lines = input.transcript.map((s) => "[" + s.startS.toFixed(1) + "-" + s.endS.toFixed(1) + "] " + s.text).join("\n").slice(0, 60_000);
    const candidates = input.candidates.slice(0, 16).map((c) => c.id + " [" + c.startS.toFixed(1) + "-" + c.endS.toFixed(1) + "] score " + c.score.toFixed(2) + ": " + c.text.slice(0, 300)).join("\n");
    const media = input.assets.length ? input.assets.map((a) => a.id + " (" + a.kind + "): " + a.name).join("\n") : "(none)";
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: "Creator's description:\n" + input.brief.slice(0, 2000) + "\n\nVideo: " + input.durationS.toFixed(1) + " s, " + input.frame.width + "x" + input.frame.height + "\n\nTranscript:\n" + lines + "\n\nCandidate moments:\n" + candidates + "\n\nProject media:\n" + media + "\n\nFrames follow, each labelled with its time." },
    ];
    for (const frame of input.frames.slice(0, 10)) {
      content.push({ type: "input_text", text: "Frame at " + frame.atS.toFixed(1) + " s:" });
      content.push({ type: "input_image", image_url: "data:image/jpeg;base64," + frame.jpegBase64, detail: "low" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 90_000);
    let response;
    try {
      response = await this.fetchImpl((this.options.endpoint ?? "https://api.openai.com/v1").replace(/\/$/, "") + "/responses", {
        method: "POST", signal: controller.signal,
        headers: { authorization: "Bearer " + this.options.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ model: this.options.model, instructions: SYSTEM, input: [{ role: "user", content }], text: { format: { type: "json_schema", name: "edit_plan", strict: true, schema: SCHEMA } } }),
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("timed out");
      throw error;
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const message = /"message"\s*:\s*"([^"]{1,160})/.exec(detail)?.[1];
      throw new Error("OpenAI returned " + response.status + (message ? ": " + message : ""));
    }
    const payload = (await response.json()) as { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
    const out = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).find((part) => part.type === "output_text")?.text;
    if (typeof out !== "string") throw new Error("no text in the response");
    try { return JSON.parse(out); } catch { throw new Error("the response was not valid JSON"); }
  }
}

export interface ApplyContext {
  timeline: Timeline;
  /** The main talking video the cut is made from. */
  assetId: string;
  words: TranscriptWord[];
}

/** Timeline operations for the accepted suggestions (music and platform are handled by the caller). */
export function planOperations(plan: DirectorPlan, accepted: Set<string>, ctx: ApplyContext): TimelineOperation[] {
  const ops: TimelineOperation[] = [];
  const chosen = plan.suggestions.filter((s) => accepted.has(s.id));
  const cut = chosen.find((s): s is Extract<Suggestion, { kind: "cut" }> => s.kind === "cut");
  const words = [...ctx.words].sort((a, b) => a.startUs - b.startUs);
  let kept: Array<{ startUs: number; endUs: number }> = ctx.timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).filter((c) => c.assetId === ctx.assetId).map((c) => ({ startUs: c.sourceStartUs, endUs: c.sourceEndUs }));
  if (cut) {
    // Snap each segment out to whole words (with a little air), so no word is clipped at a cut.
    const snapped = cut.segments.map((seg) => {
      const s = seg.startS * 1e6; const e = seg.endS * 1e6;
      const inside = words.filter((w) => w.endUs > s && w.startUs < e);
      const first = inside[0]; const last = inside[inside.length - 1];
      const prevEnd = words.filter((w) => w.endUs <= (first?.startUs ?? s)).reduce((m, w) => Math.max(m, w.endUs), 0);
      const startUs = first ? Math.max(prevEnd + 20_000, first.startUs - 150_000, 0) : s;
      const nextStart = words.find((w) => w.startUs >= (last?.endUs ?? e))?.startUs ?? Number.MAX_SAFE_INTEGER;
      const endUs = last ? Math.min(nextStart - 20_000, last.endUs + 220_000) : e;
      return { startUs: Math.round(startUs), endUs: Math.round(endUs) };
    }).filter((seg) => seg.endUs - seg.startUs >= 500_000);
    if (snapped.length > 0) {
      for (const track of ctx.timeline.tracks) if (track.kind === "video" || track.kind === "caption") for (const clip of track.clips) ops.push({ type: "remove-clip", clipId: clip.id, reason: "Replaced by the director's cut" });
      for (const seg of snapped) ops.push({ type: "insert-clip", assetId: ctx.assetId, sourceStartUs: seg.startUs, sourceEndUs: seg.endUs, reason: cut.reason || cut.title });
      for (const op of cueOperations(ctx.assetId, buildCues(words, { ranges: snapped }))) ops.push(op);
      kept = snapped;
    }
  }
  // Moments that land outside the kept footage move to the start of the nearest kept segment.
  const anchor = (atS: number) => {
    const at = Math.round(atS * 1e6);
    const inside = kept.find((k) => at >= k.startUs && at < k.endUs);
    if (inside) return at;
    const nearest = [...kept].sort((a, b) => Math.abs(a.startUs - at) - Math.abs(b.startUs - at))[0];
    return nearest ? nearest.startUs + 100_000 : at;
  };
  for (const s of chosen) {
    if (s.kind === "title" || s.kind === "callout" || s.kind === "lower-third") {
      ops.push({ type: "add-graphic", kind: s.kind, text: s.text, ...(s.subtitle ? { subtitle: s.subtitle } : {}), anchorAssetId: ctx.assetId, anchorSourceUs: anchor(s.atS), durationUs: Math.round(s.durationS * 1e6), ...(s.position ? { position: s.position } : {}) });
    } else if (s.kind === "broll") {
      ops.push({ type: "add-broll", assetId: s.assetId, anchorAssetId: ctx.assetId, anchorSourceUs: anchor(s.atS), durationUs: Math.round(s.durationS * 1e6), mode: s.mode });
    } else if (s.kind === "progress") {
      ops.push({ type: "set-progress-bar", enabled: true });
    }
  }
  return ops;
}
