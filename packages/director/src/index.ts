import { buildCues, cueOperations } from "@videocraft/captions";
import type { ColourLook, Timeline, TimelineOperation, TranscriptWord } from "@videocraft/domain";
import type { CheckIssue } from "./check.js";

/**
 * The AI director: reads what is said, looks at sampled frames, and proposes a whole edit as a list of
 * suggestions, each with a reason, that the person accepts or rejects one by one. Everything it proposes
 * is grounded (cuts come from real transcript windows, graphics land on moments that survive the cut,
 * images come from the project) and validated before it can touch the timeline.
 */

export const MOODS = ["upbeat", "calm", "inspiring", "serious", "playful"] as const;
export const PLATFORMS = ["tiktok", "youtube", "square"] as const;
export const LOOKS = ["warm", "clean", "cinematic", "vivid", "soft", "mono"] as const;

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
  | { id: string; kind: "broll"; title: string; reason: string; assetId: string; atS: number; durationS: number; mode: "full" | "pip" | "behind" }
  | { id: string; kind: "progress"; title: string; reason: string }
  | { id: string; kind: "platform"; title: string; reason: string; platform: (typeof PLATFORMS)[number] }
  | { id: string; kind: "advice"; title: string; reason: string }
  | { id: string; kind: "look"; title: string; reason: string; look: Exclude<ColourLook, "none"> }
  /** "punch" = alternate tighter framings between pieces (jump-cut energy); "push" = a slow push-in on every piece. */
  | { id: string; kind: "zooms"; title: string; reason: string; style: "punch" | "push" }
  /** Fade in from and out to black, plus this transition where the edit jumps to a new part of the talk. */
  | { id: string; kind: "transitions"; title: string; reason: string; transition: "dip-black" | "dip-white" | "flash" }
  /** A whoosh on transitions and a pop when on-screen text appears. */
  | { id: string; kind: "sfx"; title: string; reason: string }
  /** What is behind the person in the whole video: blurred, or a plain colour (the person is cut out and kept). */
  | { id: string; kind: "background"; title: string; reason: string; background: "blur" | "color"; color?: string };

export interface DirectorPlan {
  summary: string;
  profile: { intent: string; audience: string; channel: string; tone: string; targetSeconds: number };
  suggestions: Suggestion[];
  source: "ai" | "rules";
  model?: string;
  /** Why the AI director was not used, when it was not. */
  note?: string;
}

export interface Director {
  plan(input: DirectorInput): Promise<DirectorPlan>;
  /** A change to the current edit, asked for in the person's own words. */
  ask?(input: AskInput): Promise<DirectorPlan>;
  /** A second look at a finished edit (AI only); the rules check runs separately. */
  review?(input: ReviewInput): Promise<CheckIssue[]>;
}

export interface AskInput extends DirectorInput {
  instruction: string;
  /** The current edit in words: its pieces (source times), on-screen text, look, music. */
  current: { pieces: Array<{ startS: number; endS: number; text: string }>; graphics: string[]; look: string; music: string; seconds: number };
}

export interface ReviewInput {
  brief: string;
  /** The kept pieces in play order, with their place in the edit and what is said. */
  pieces: Array<{ clipId: string; startS: number; endS: number; text: string }>;
  graphics: Array<{ clipId: string; kind: string; text: string; atS: number; durationS: number }>;
  cutaways: Array<{ atS: number; durationS: number; name: string }>;
  music?: string;
  platform: string;
  /** Frames of the source at moments of the edit (cut points, graphics), labelled with their place in the edit. */
  frames: Array<{ atS: number; label: string; jpegBase64: string }>;
}

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
      suggestions.push({ ...base(s, index), kind: "broll", assetId, atS, durationS: clamp(num(s.durationS) || 2.5, 0.5, 10), mode: s.mode === "pip" ? "pip" : s.mode === "behind" ? "behind" : "full" });
    } else if (kind === "progress") {
      if (!suggestions.some((existing) => existing.kind === "progress")) suggestions.push({ ...base(s, index), kind: "progress" });
    } else if (kind === "platform") {
      if (PLATFORMS.includes(s.platform as never) && !suggestions.some((existing) => existing.kind === "platform")) suggestions.push({ ...base(s, index), kind: "platform", platform: s.platform as (typeof PLATFORMS)[number] });
    } else if (kind === "advice") {
      const b = base(s, index); if (b.reason || b.title) suggestions.push({ ...b, kind: "advice" });
    } else if (kind === "look") {
      if (LOOKS.includes(s.look as never) && !suggestions.some((e) => e.kind === "look")) suggestions.push({ ...base(s, index), kind: "look", look: s.look as (typeof LOOKS)[number] });
    } else if (kind === "background") {
      const background = s.background === "color" ? "color" : s.background === "blur" ? "blur" : undefined;
      const color = typeof s.color === "string" && /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : undefined;
      if (background && !suggestions.some((e) => e.kind === "background")) suggestions.push({ ...base(s, index), kind: "background", background, ...(background === "color" && color ? { color } : {}) });
    } else if (kind === "zooms") {
      if ((s.style === "punch" || s.style === "push") && !suggestions.some((e) => e.kind === "zooms")) suggestions.push({ ...base(s, index), kind: "zooms", style: s.style });
    } else if (kind === "transitions") {
      const transition = s.transition === "dip-white" || s.transition === "flash" ? s.transition : "dip-black";
      if (!suggestions.some((e) => e.kind === "transitions")) suggestions.push({ ...base(s, index), kind: "transitions", transition });
    } else if (kind === "sfx") {
      if (!suggestions.some((e) => e.kind === "sfx")) suggestions.push({ ...base(s, index), kind: "sfx" });
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

function lookFor(hints: { mood?: string; platform: string }): (typeof LOOKS)[number] {
  return hints.mood === "calm" ? "soft" : hints.mood === "serious" ? "cinematic" : hints.mood === "inspiring" ? "warm" : hints.mood === "upbeat" || hints.mood === "playful" ? "vivid" : "clean";
}

/** A director without a model: the strongest windows, a hook title, matching music and the right format. */
export class RuleDirector implements Director {
  /** Understands length, look, music mood, zooms, transitions and format changes; everything else needs the AI. */
  async ask(input: AskInput): Promise<DirectorPlan> {
    const t = input.instruction.toLowerCase();
    const hints = briefHints(input.instruction);
    const raw: Array<Record<string, unknown>> = [];
    const shorter = /short|tight|trim|cut down|quicker|faster/.test(t); const longer = /longer|more of|extend/.test(t);
    const target = hints.targetSeconds ?? (shorter ? Math.max(5, Math.round(input.current.seconds * 0.7)) : longer ? Math.round(input.current.seconds * 1.4) : undefined);
    let summary = "";
    if (target) {
      const base = await this.plan({ ...input, brief: target + " seconds. " + input.brief.replace(/\d{1,3}\s*-?\s*(s|sec|secs|second|seconds|min|mins|minute|minutes)\b/gi, "") });
      const cut = base.suggestions.find((x) => x.kind === "cut");
      if (cut) { raw.push({ ...cut, title: "Make it about " + target + " seconds", reason: "You asked for a " + (shorter ? "shorter" : longer ? "longer" : target + "-second") + " cut; these are the strongest moments that fit." }); summary = "A new cut of about " + target + " seconds."; }
    }
    const look = LOOKS.find((l) => t.includes(l)) ?? (/black and white|b&w|monochrome|grey/.test(t) ? "mono" : /warm/.test(t) ? "warm" : /colou?rful|punchy|bright/.test(t) ? "vivid" : /film|moody/.test(t) ? "cinematic" : undefined);
    if (look) raw.push({ id: "look", kind: "look", title: (look === "mono" ? "Black and white" : look[0]!.toUpperCase() + look.slice(1)) + " look", reason: "As you asked.", look });
    if (hints.mood && /music|song|sound|track|mood|vibe/.test(t)) raw.push({ id: "music", kind: "music", title: hints.mood[0]!.toUpperCase() + hints.mood.slice(1) + " music", reason: "As you asked.", mood: hints.mood });
    if (/background|backdrop|green ?screen/.test(t) && /blur|soft|out of focus|bokeh/.test(t)) raw.push({ id: "background", kind: "background", title: "Blur the background", reason: "As you asked: you stay sharp, what is behind you is blurred.", background: "blur" });
    else if (/(remove|replace|change|plain|clean|get rid of).{0,20}(background|backdrop)|green ?screen/.test(t)) raw.push({ id: "background", kind: "background", title: "Plain background", reason: "As you asked: you are cut out and placed on a plain colour. Pick a photo or clip in Visuals → Background to use that instead.", background: "color", color: "#1F2A24" });
    if (/zoom|punch/.test(t)) raw.push({ id: "zooms", kind: "zooms", title: /slow|push|gentle/.test(t) ? "Slow push-ins" : "Punch in on alternate parts", reason: "As you asked.", style: /slow|push|gentle/.test(t) ? "push" : "punch" });
    if (/transition|fade|dip|flash/.test(t)) raw.push({ id: "transitions", kind: "transitions", title: /flash/.test(t) ? "Flash between topics" : /white/.test(t) ? "Dip to white between topics" : "Fade in and out, dip to black between topics", reason: "As you asked.", transition: /flash/.test(t) ? "flash" : /white/.test(t) ? "dip-white" : "dip-black" });
    if (/youtube|16:9|landscape|square|1:1|vertical|9:16|reel|tiktok|short/.test(t) && !shorter) raw.push({ id: "platform", kind: "platform", title: "Export for " + hints.platform, reason: "As you asked.", platform: hints.platform });
    const plan = sanitizePlan({ summary: summary || "Changes for your request.", profile: { intent: input.brief, targetSeconds: target ?? input.current.seconds }, suggestions: raw }, input, "rules");
    return raw.length ? plan : { ...plan, suggestions: [{ id: "advice", kind: "advice", title: "I can't do that without the AI director", reason: "The built-in rules understand length (shorter, 30 seconds), look (warm, black and white), background (blur or plain), music mood, zooms, transitions and format. Add an OpenAI key for anything else." }] };
  }
  async plan(input: DirectorInput): Promise<DirectorPlan> {
    const hints = briefHints(input.brief);
    const target = hints.targetSeconds ?? (hints.platform === "youtube" ? 90 : 30);
    const chosen: DirectorInput["candidates"] = [];
    let total = 0;
    for (const candidate of [...input.candidates].sort((a, b) => b.score - a.score)) {
      const length = candidate.endS - candidate.startS;
      if (chosen.some((c) => candidate.startS < c.endS && candidate.endS > c.startS)) continue;
      if (chosen.length > 0 && total + length > target * 1.1) continue;
      if (chosen.length === 0 && length > target * 1.2) {
        // The best moment is longer than asked: keep its opening sentences up to the length.
        const lines = input.transcript.filter((line) => line.startS >= candidate.startS - 0.05 && line.endS <= candidate.endS + 0.05);
        let end = candidate.startS;
        for (const line of lines) { if (end > candidate.startS && line.endS - candidate.startS > target * 1.1) break; end = line.endS; }
        // One long transcript line: cut at the length asked (the cut is snapped to whole words when applied).
        if (!(end - candidate.startS >= 1 && end < candidate.endS && end - candidate.startS <= target * 1.2)) end = candidate.startS + target;
        chosen.push({ ...candidate, endS: end }); total += end - candidate.startS;
        if (total >= target * 0.9) break;
        continue;
      }
      chosen.push(candidate); total += length;
      if (total >= target * 0.9) break;
    }
    chosen.sort((a, b) => a.startS - b.startS);
    const first = chosen[0];
    // A short hook from the first line: at most seven whole words, no trailing punctuation.
    const sentence = first ? first.text.split(/(?<=[.!?])\s/)[0]! : "";
    const hookWords = sentence.split(/\s+/).filter(Boolean);
    const hook = (hookWords.slice(0, 7).join(" ") + (hookWords.length > 7 ? "…" : "")).replace(/[,;:.!?]+(…)?$/, "$1");
    const raw = {
      summary: "Built-in rules picked the strongest moments for your brief and added a title, matching music and the " + (hints.platform === "tiktok" ? "9:16" : hints.platform === "youtube" ? "YouTube 16:9" : "1:1 feed") + " format. Add an OpenAI key for an AI director that also looks at your footage.",
      profile: { intent: input.brief, audience: "", channel: hints.channel, tone: hints.mood ?? "", targetSeconds: target },
      suggestions: [
        ...(chosen.length ? [{ id: "cut", kind: "cut", title: "Keep the " + chosen.length + " strongest moment" + (chosen.length === 1 ? "" : "s") + " (" + Math.round(total) + "s)", reason: "Highest scores for completeness, pace and fit to your brief.", segments: chosen.map((c) => ({ startS: c.startS, endS: c.endS })) }] : []),
        ...(hook && first ? [{ id: "title", kind: "title", title: "Open with a title", reason: "A short title in the first seconds tells viewers what they are about to get.", text: hook, atS: first.startS + 0.2, durationS: 2.5, position: "top" }] : []),
        { id: "music", kind: "music", title: "Add " + (hints.mood ?? (hints.platform === "youtube" ? "calm" : "upbeat")) + " music", reason: "Matches the feel of your brief; it dips under speech.", mood: hints.mood ?? (hints.platform === "youtube" ? "calm" : "upbeat") },
        ...(hints.platform !== "youtube" ? [{ id: "progress", kind: "progress", title: "Show a progress bar", reason: "Short-form viewers stay longer when they can see how much is left." }] : []),
        { id: "look", kind: "look", title: "Give it a " + lookFor(hints) + " look", reason: "A consistent colour treatment that suits a " + (hints.mood ?? "clear") + " video.", look: lookFor(hints) },
        ...(chosen.length > 1 ? [hints.platform === "youtube"
          ? { id: "zooms", kind: "zooms", title: "Slow push-ins", reason: "A gentle push on each part keeps a long talk feeling alive without drawing attention.", style: "push" }
          : { id: "zooms", kind: "zooms", title: "Punch in on alternate parts", reason: "Changing the framing at cuts hides the jump and keeps short-form energy up.", style: "punch" }] : []),
        { id: "transitions", kind: "transitions", title: hints.platform === "youtube" ? "Fade in and out, dip to black between topics" : "Flash between topics, fade at the ends", reason: "Hard cuts inside a thought, a visible transition where the video moves to a new point.", transition: hints.platform === "youtube" ? "dip-black" : "flash" },
        ...(hints.platform !== "youtube" ? [{ id: "sfx", kind: "sfx", title: "Subtle sound effects", reason: "A soft whoosh on transitions and a pop when text appears make short-form feel produced." }] : []),
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
- "look": one colour look for the whole video: warm, clean, cinematic, vivid, soft or mono (field look). Choose from the mood and what the frames look like.
- "zooms": style "punch" (alternate tighter framings at cuts; energetic short-form) or "push" (slow push-in; calm or long-form).
- "transitions": fades at the start and end plus transition "dip-black", "dip-white" or "flash" where the edit jumps to a new part. Do not add transitions inside a continuous thought.
- "background": only when the creator asks: "blur" (keep the person sharp, blur what is behind) or "color" with a calm #RRGGBB colour (field color).
- "sfx": subtle whooshes on transitions and pops when text appears; only for energetic short-form.
- "advice": what you see in the frames that the creator could improve that you cannot change (lighting, framing, background, sound), kindly and concretely.
Every suggestion needs a short title and a reason that cites what you saw or heard. Never invent facts, names, numbers or quotes.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "profile", "suggestions"],
  properties: {
    summary: { type: "string" },
    profile: { type: "object", additionalProperties: false, required: ["intent", "audience", "channel", "tone", "targetSeconds"], properties: { intent: { type: "string" }, audience: { type: "string" }, channel: { type: "string" }, tone: { type: "string" }, targetSeconds: { type: "number" } } },
    suggestions: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["id", "kind", "title", "reason", "segments", "text", "subtitle", "atS", "durationS", "position", "mood", "assetId", "mode", "platform", "look", "style", "transition", "background", "color"],
      properties: {
        id: { type: "string" }, kind: { type: "string", enum: ["cut", "title", "callout", "lower-third", "music", "broll", "progress", "platform", "look", "zooms", "transitions", "sfx", "background", "advice"] },
        title: { type: "string" }, reason: { type: "string" },
        segments: { type: "array", items: { type: "object", additionalProperties: false, required: ["startS", "endS"], properties: { startS: { type: "number" }, endS: { type: "number" } } } },
        text: { type: "string" }, subtitle: { type: "string" }, atS: { type: "number" }, durationS: { type: "number" },
        position: { type: "string", enum: ["top", "center", "bottom", ""] }, mood: { type: "string", enum: [...MOODS, ""] }, assetId: { type: "string" },
        mode: { type: "string", enum: ["full", "pip", "behind", ""] }, platform: { type: "string", enum: [...PLATFORMS, ""] },
        look: { type: "string", enum: [...LOOKS, ""] }, style: { type: "string", enum: ["punch", "push", ""] }, transition: { type: "string", enum: ["dip-black", "dip-white", "flash", ""] },
        background: { type: "string", enum: ["blur", "color", ""] }, color: { type: "string" },
      } } },
  },
};

const ASK = SYSTEM + `
You are now changing an existing edit, not making a new one. Suggest ONLY what the creator's request needs; everything else stays as it is.
- To change what is kept (shorter, longer, remove a part, add a part, reorder), give ONE "cut" with the complete new list of segments in source seconds, starting from the current pieces.
- For text, music, look, zooms, transitions, cutaways or format, use those kinds as before.
- If the request cannot be done by editing, return one "advice" saying so kindly.`;

const REVIEW = `You are a senior video editor giving a final review of an edit before it is published. You get the creator's description, the edit piece by piece with what is said, the on-screen text, cutaways, and frames from the edit.
Find at most 6 real problems a viewer would notice, most important first: a weak or slow opening, a piece that repeats or wanders off the point, a story order that confuses, on-screen text that is wrong, unclear, misspelt or covers something important in the frame, a cutaway that does not match the words, a look problem in the frames (dark, blurry, cluttered or distracting background, poor framing).
For each, choose one action that fixes it if possible:
- "remove-piece" (piece = index) to drop a piece; "move-piece" (piece, toIndex) to reorder, e.g. toIndex 0 to open on the strongest line;
- "rewrite-text" (graphic = index, text = the new wording) or "remove-graphic" (graphic = index);
- "none" when it cannot be fixed by editing (then say concretely what to change when filming).
Use -1 for unused indexes and "" for unused text. Never invent facts. If the edit is good, return an empty list.`;

const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false, required: ["issues"],
  properties: { issues: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["title", "detail", "atS", "severity", "action", "piece", "toIndex", "graphic", "text"],
    properties: { title: { type: "string" }, detail: { type: "string" }, atS: { type: "number" }, severity: { type: "string", enum: ["fix", "warn", "info"] }, action: { type: "string", enum: ["none", "remove-piece", "move-piece", "rewrite-text", "remove-graphic"] }, piece: { type: "integer" }, toIndex: { type: "integer" }, graphic: { type: "integer" }, text: { type: "string" } } } } },
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
  async ask(input: AskInput): Promise<DirectorPlan> {
    try {
      const extra = "\n\nThe current edit (" + input.current.seconds.toFixed(0) + " s), piece by piece in source seconds:\n" + input.current.pieces.map((p) => "[" + p.startS.toFixed(1) + "-" + p.endS.toFixed(1) + "] " + p.text.slice(0, 300)).join("\n") + "\nOn-screen text: " + (input.current.graphics.join(" | ") || "none") + "\nLook: " + input.current.look + "\nMusic: " + input.current.music + "\n\nThe creator asks for this change: " + input.instruction.slice(0, 500);
      const raw = await this.call(input, ASK, extra);
      const plan = sanitizePlan(raw, input, "ai", { model: this.options.model });
      if (plan.suggestions.length === 0) throw new Error("the AI found nothing to change");
      return plan;
    } catch (error) {
      const fallback = await new RuleDirector().ask(input);
      return { ...fallback, note: "The AI director was unavailable (" + (error instanceof Error ? error.message : "error").slice(0, 200) + "); built-in rules handled the request." + (fallback.note ? " " + fallback.note : "") };
    }
  }
  async review(input: ReviewInput): Promise<CheckIssue[]> {
    const pieces = input.pieces.map((p, i) => "#" + i + " [" + p.startS.toFixed(1) + "-" + p.endS.toFixed(1) + " s] " + p.text.slice(0, 500)).join("\n");
    const graphics = input.graphics.map((g, i) => "#" + i + " " + g.kind + " at " + g.atS.toFixed(1) + " s for " + g.durationS.toFixed(1) + " s: " + g.text).join("\n") || "(none)";
    const cutaways = input.cutaways.map((c) => c.name + " at " + c.atS.toFixed(1) + " s for " + c.durationS.toFixed(1) + " s").join("\n") || "(none)";
    const content: Array<Record<string, unknown>> = [{ type: "input_text", text: "Creator's description:\n" + input.brief.slice(0, 2000) + "\n\nFormat: " + input.platform + "\nMusic: " + (input.music ?? "none") + "\n\nThe edit, piece by piece (times are in the edited video):\n" + pieces + "\n\nOn-screen text:\n" + graphics + "\n\nCutaways:\n" + cutaways + "\n\nFrames from the edit follow." }];
    for (const frame of input.frames.slice(0, 12)) {
      content.push({ type: "input_text", text: frame.label + " (" + frame.atS.toFixed(1) + " s):" });
      content.push({ type: "input_image", image_url: "data:image/jpeg;base64," + frame.jpegBase64, detail: "low" });
    }
    const raw = (await this.request(REVIEW, content, "edit_review", REVIEW_SCHEMA)) as { issues?: Array<Record<string, unknown>> };
    const out: CheckIssue[] = [];
    for (const [i, issue] of (Array.isArray(raw.issues) ? raw.issues : []).slice(0, 8).entries()) {
      const title = typeof issue.title === "string" ? issue.title.slice(0, 140) : ""; if (!title) continue;
      const detail = typeof issue.detail === "string" ? issue.detail.slice(0, 400) : "";
      const atS = typeof issue.atS === "number" && Number.isFinite(issue.atS) && issue.atS >= 0 ? Math.round(issue.atS * 10) / 10 : undefined;
      const piece = input.pieces[Number(issue.piece)]; const graphic = input.graphics[Number(issue.graphic)];
      let fix: CheckIssue["fix"];
      if (issue.action === "remove-piece" && piece && input.pieces.length > 1) fix = { label: "Remove piece " + (Number(issue.piece) + 1), operations: [{ type: "remove-clip", clipId: piece.clipId, reason: "AI check: " + title }] };
      else if (issue.action === "move-piece" && piece && Number.isInteger(issue.toIndex) && Number(issue.toIndex) >= 0 && Number(issue.toIndex) < input.pieces.length && Number(issue.toIndex) !== Number(issue.piece)) {
        const order = input.pieces.map((p) => p.clipId).filter((id) => id !== piece.clipId); order.splice(Number(issue.toIndex), 0, piece.clipId);
        fix = { label: Number(issue.toIndex) === 0 ? "Open with this piece" : "Move piece " + (Number(issue.piece) + 1) + " to position " + (Number(issue.toIndex) + 1), operations: [{ type: "reorder-clips", clipIds: order }] };
      } else if (issue.action === "rewrite-text" && graphic && typeof issue.text === "string" && issue.text.trim().length >= 2) fix = { label: "Change to “" + issue.text.trim().slice(0, 80) + "”", operations: [{ type: "update-graphic", clipId: graphic.clipId, text: issue.text.trim().slice(0, 120) }] };
      else if (issue.action === "remove-graphic" && graphic) fix = { label: "Remove “" + graphic.text.slice(0, 40) + "”", operations: [{ type: "remove-clip", clipId: graphic.clipId, reason: "AI check: " + title }] };
      const severity = fix ? "fix" : issue.severity === "info" ? "info" : "warn";
      out.push({ id: "ai-" + i, severity, kind: "ai-" + String(issue.action || "note"), title, detail, ...(atS !== undefined ? { atS } : {}), ...(fix ? { fix } : {}), source: "ai" });
    }
    return out;
  }
  private async call(input: DirectorInput, instructions = SYSTEM, extra = ""): Promise<unknown> {
    const lines = input.transcript.map((s) => "[" + s.startS.toFixed(1) + "-" + s.endS.toFixed(1) + "] " + s.text).join("\n").slice(0, 60_000);
    const candidates = input.candidates.slice(0, 16).map((c) => c.id + " [" + c.startS.toFixed(1) + "-" + c.endS.toFixed(1) + "] score " + c.score.toFixed(2) + ": " + c.text.slice(0, 300)).join("\n");
    const media = input.assets.length ? input.assets.map((a) => a.id + " (" + a.kind + "): " + a.name).join("\n") : "(none)";
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: "Creator's description:\n" + input.brief.slice(0, 2000) + "\n\nVideo: " + input.durationS.toFixed(1) + " s, " + input.frame.width + "x" + input.frame.height + "\n\nTranscript:\n" + lines + "\n\nCandidate moments:\n" + candidates + "\n\nProject media:\n" + media + extra + "\n\nFrames follow, each labelled with its time." },
    ];
    for (const frame of input.frames.slice(0, 10)) {
      content.push({ type: "input_text", text: "Frame at " + frame.atS.toFixed(1) + " s:" });
      content.push({ type: "input_image", image_url: "data:image/jpeg;base64," + frame.jpegBase64, detail: "low" });
    }
    return this.request(instructions, content, "edit_plan", SCHEMA);
  }
  private async request(instructions: string, content: Array<Record<string, unknown>>, name: string, schema: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 90_000);
    let response;
    try {
      response = await this.fetchImpl((this.options.endpoint ?? "https://api.openai.com/v1").replace(/\/$/, "") + "/responses", {
        method: "POST", signal: controller.signal,
        headers: { authorization: "Bearer " + this.options.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ model: this.options.model, instructions, input: [{ role: "user", content }], text: { format: { type: "json_schema", name, strict: true, schema } } }),
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

/**
 * Effects for the accepted look / zooms / transitions / sfx suggestions, worked out on the timeline after the cut
 * was applied (so they refer to the real clips).
 */
export function effectOperations(plan: DirectorPlan, accepted: Set<string>, timeline: Timeline, assetId: string): TimelineOperation[] {
  const chosen = plan.suggestions.filter((s) => accepted.has(s.id));
  const ops: TimelineOperation[] = [];
  const pieces = timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  if (pieces.length === 0) return ops;
  const look = chosen.find((s): s is Extract<Suggestion, { kind: "look" }> => s.kind === "look");
  if (look) ops.push({ type: "set-look", look: look.look });
  const background = chosen.find((s): s is Extract<Suggestion, { kind: "background" }> => s.kind === "background");
  if (background) ops.push({ type: "set-background", background: background.background, ...(background.color ? { color: background.color } : {}) });
  const zooms = chosen.find((s): s is Extract<Suggestion, { kind: "zooms" }> => s.kind === "zooms");
  const transitions = chosen.find((s): s is Extract<Suggestion, { kind: "transitions" }> => s.kind === "transitions");
  const sfx = chosen.some((s) => s.kind === "sfx");
  // A "jump" is a cut to a different part of the source (not just a removed pause).
  const jumps = new Set(pieces.flatMap((p, i) => i > 0 && (p.assetId !== pieces[i - 1]!.assetId || Math.abs(p.sourceStartUs - pieces[i - 1]!.sourceEndUs) > 8_000_000) ? [i] : []));
  pieces.forEach((piece, i) => {
    const effect: Extract<TimelineOperation, { type: "set-clip-effects" }> = { type: "set-clip-effects", clipId: piece.id };
    if (zooms) {
      const length = piece.sourceEndUs - piece.sourceStartUs;
      if (zooms.style === "push" && length >= 2_500_000) effect.zoom = "push";
      else if (zooms.style === "punch") effect.zoom = i % 2 === 1 ? "punch" : "none";
    }
    if (transitions) {
      if (i === 0) effect.transitionIn = "dip-black";
      else if (jumps.has(i)) effect.transitionIn = transitions.transition;
      if (i === pieces.length - 1) effect.transitionOut = "dip-black";
    }
    if (Object.keys(effect).length > 2) ops.push(effect);
    if (sfx && transitions && jumps.has(i) && piece.assetId === assetId) ops.push({ type: "add-sfx", kind: "whoosh", anchorAssetId: piece.assetId, anchorSourceUs: Math.max(piece.sourceStartUs, piece.sourceStartUs + 10_000), volumeDb: -14 });
  });
  if (sfx) {
    for (const g of timeline.tracks.filter((t) => t.kind === "overlay").flatMap((t) => t.clips).filter((c) => c.transform?.role === "graphic").slice(0, 8)) {
      ops.push({ type: "add-sfx", kind: "pop", anchorAssetId: String(g.transform?.anchorAssetId), anchorSourceUs: Number(g.transform?.anchorSourceUs), volumeDb: -16 });
    }
  }
  return ops;
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

export * from "./check.js";
