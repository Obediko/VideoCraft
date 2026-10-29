import { buildCues, cueOperations } from "@videocraft/captions";
import type { Timeline, TimelineClip, TimelineOperation, TranscriptWord } from "@videocraft/domain";

/**
 * Edit check: looks over a finished edit the way an editor would before export and proposes a concrete fix for
 * each problem it finds. Nothing is changed until the person accepts a fix.
 */
export interface CheckIssue {
  id: string;
  severity: "fix" | "warn" | "info";
  kind: string;
  title: string;
  detail: string;
  /** Where in the edited video (seconds), when it is about one moment. */
  atS?: number;
  fix?: { label: string; operations: TimelineOperation[] };
  source: "rules" | "ai";
}

export interface MediaSignals {
  /** Black or near-black spans in the source, in source microseconds. */
  black: Array<{ startUs: number; endUs: number }>;
  /** Frozen-picture spans in the source, in source microseconds. */
  frozen: Array<{ startUs: number; endUs: number }>;
}

export interface CheckInput {
  timeline: Timeline;
  /** The main video asset and its timed words. */
  assetId: string;
  words: TranscriptWord[];
  sourceDurationUs: number;
  platform?: "tiktok" | "youtube" | "square" | string;
  targetSeconds?: number;
  media?: MediaSignals;
}

const ENDS_SENTENCE = /[.!?…]["')\]]?$/;
const s = (us: number) => Math.round(us / 100_000) / 10;
const clipsOf = (timeline: Timeline, kind: string) => timeline.tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips).sort((a, b) => a.timelineStartUs - b.timelineStartUs);

export function checkEdit(input: CheckInput): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const add = (issue: Omit<CheckIssue, "id" | "source">) => issues.push({ ...issue, id: issue.kind + "-" + issues.length, source: "rules" });
  const words = [...input.words].sort((a, b) => a.startUs - b.startUs);
  const video = clipsOf(input.timeline, "video");
  const mine = video.filter((c) => c.assetId === input.assetId);
  const captions = clipsOf(input.timeline, "caption");
  const overlays = clipsOf(input.timeline, "overlay");
  const toTimeline = (clip: TimelineClip, sourceUs: number) => clip.timelineStartUs + (sourceUs - clip.sourceStartUs);
  if (video.length === 0) return [{ id: "empty-0", severity: "warn", kind: "empty", title: "The timeline is empty", detail: "Plan or create highlights first.", source: "rules" }];

  // Mostly-still footage (slides, screen recordings, a locked-off shot of a still scene) is a style, not a fault.
  const keptUs = mine.reduce((sum, c) => sum + c.sourceEndUs - c.sourceStartUs, 0);
  const stillUs = mine.reduce((sum, c) => sum + (input.media?.frozen ?? []).reduce((acc, f) => acc + Math.max(0, Math.min(f.endUs, c.sourceEndUs) - Math.max(f.startUs, c.sourceStartUs)), 0), 0);
  const mostlyStill = keptUs > 0 && stillUs / keptUs > 0.3;
  if (mostlyStill) add({ severity: "info", kind: "still", title: "The picture is still for much of the video", detail: Math.round((100 * stillUs) / keptUs) + "% of it barely moves. Fine for slides or a screen recording; for a talk, cutaways or a second angle keep it lively." });

  mine.forEach((clip, index) => {
    const len = clip.sourceEndUs - clip.sourceStartUs;
    if (len < 1_000_000 && mine.length > 1) {
      add({ severity: "fix", kind: "short-piece", title: "A " + s(len) + " s piece at " + s(clip.timelineStartUs) + " s feels like a glitch", detail: "Very short pieces between cuts read as a mistake.", atS: s(clip.timelineStartUs), fix: { label: "Remove this piece", operations: [{ type: "remove-clip", clipId: clip.id, reason: "Edit check: too short" }] } });
      return;
    }
    const inside = words.filter((w) => w.endUs > clip.sourceStartUs && w.startUs < clip.sourceEndUs);
    // Cut in the middle of a word, at either end.
    let start = clip.sourceStartUs; let end = clip.sourceEndUs;
    const atStart = words.find((w) => w.startUs < clip.sourceStartUs - 40_000 && w.endUs > clip.sourceStartUs + 40_000);
    // A clip that already runs to the end of the recording cannot keep more of a word the recogniser timed past it.
    const atEnd = clip.sourceEndUs >= input.sourceDurationUs - 50_000 ? undefined : words.find((w) => w.startUs < clip.sourceEndUs - 40_000 && w.endUs > clip.sourceEndUs + 40_000);
    // A little air around the word, but never into the neighbouring word.
    // Words that run together or overlap (recognisers often stretch or overlap timings) are kept as one block,
    // so the new cut always lands in a real gap of at least 60 ms.
    if (atStart) {
      let blockStart = atStart.startUs; let prevEnd = -Infinity;
      for (const w of [...words].filter((x) => x.startUs < atStart.startUs).reverse()) {
        if (w.endUs > blockStart - 60_000) blockStart = Math.min(blockStart, w.startUs); else { prevEnd = w.endUs; break; }
      }
      start = Math.max(0, blockStart - 80_000, prevEnd + 20_000);
    }
    if (atEnd) {
      let blockEnd = atEnd.endUs; let nextStart = Infinity;
      for (const w of words.filter((x) => x.startUs > atEnd.startUs || (x.startUs === atEnd.startUs && x !== atEnd))) {
        if (w.startUs < blockEnd + 60_000) blockEnd = Math.max(blockEnd, w.endUs); else { nextStart = w.startUs; break; }
      }
      end = Math.min(input.sourceDurationUs, blockEnd + 150_000, nextStart - 20_000);
    }
    if (atStart || atEnd) {
      const which = [atStart && "“" + atStart.text + "” at the start", atEnd && "“" + atEnd.text + "” at the end"].filter(Boolean).join(" and ");
      add({ severity: "fix", kind: "mid-word", title: "Cut in the middle of a word", detail: "The cut clips " + which + ".", atS: s(atStart ? clip.timelineStartUs : clip.timelineEndUs), fix: { label: "Keep the whole word", operations: [{ type: "trim-clip", clipId: clip.id, sourceStartUs: Math.round(start), sourceEndUs: Math.round(end) }, ...captionsFor(input.assetId, words, [{ startUs: start, endUs: clip.sourceStartUs }, { startUs: clip.sourceEndUs, endUs: end }])] } });
    }
    // Dead air inside a kept piece.
    for (let i = 1; i < inside.length; i += 1) {
      const gapStart = inside[i - 1]!.endUs; const gapEnd = inside[i]!.startUs;
      if (gapEnd - gapStart < 1_600_000 || gapStart < clip.sourceStartUs || gapEnd > clip.sourceEndUs) continue;
      const cutAt = gapStart + 200_000; const resumeAt = gapEnd - 150_000;
      add({ severity: "fix", kind: "dead-air", title: s(gapEnd - gapStart) + " s of silence at " + s(toTimeline(clip, gapStart)) + " s", detail: "Long pauses lose viewers; tighten it to a beat.", atS: s(toTimeline(clip, gapStart)), fix: { label: "Tighten the pause", operations: [{ type: "trim-clip", clipId: clip.id, sourceStartUs: clip.sourceStartUs, sourceEndUs: Math.round(cutAt) }, { type: "insert-clip", assetId: input.assetId, sourceStartUs: Math.round(resumeAt), sourceEndUs: clip.sourceEndUs, reason: clip.reason ?? "Edit check: pause tightened", index: video.indexOf(clip) + 1 }] } });
      break; // One at a time: the fix renumbers the pieces.
    }
    // Black or frozen picture in what is kept.
    for (const [label, spans] of [["black", input.media?.black ?? []], ["frozen", mostlyStill ? [] : input.media?.frozen ?? []]] as const) {
      for (const span of spans) {
        const a = Math.max(span.startUs, clip.sourceStartUs); const b = Math.min(span.endUs, clip.sourceEndUs);
        if (b - a < 400_000) continue;
        const atEdgeStart = a - clip.sourceStartUs < 300_000; const atEdgeEnd = clip.sourceEndUs - b < 300_000;
        // Cut out the bad picture without clipping a word on either side of it.
        const afterBad = words.find((w) => w.startUs >= b - 40_000); const beforeBad = words.filter((w) => w.endUs <= a + 40_000).at(-1);
        const trimmed = atEdgeStart ? { start: afterBad ? Math.max(b, afterBad.startUs - 60_000) : b, end: clip.sourceEndUs } : atEdgeEnd ? { start: clip.sourceStartUs, end: beforeBad ? Math.min(a, beforeBad.endUs + 60_000) : a } : undefined;
        // Frozen picture is normal for slides and screen recordings, so it is only ever a suggestion.
        add({ severity: trimmed && label === "black" ? "fix" : "warn", kind: label, title: (label === "black" ? "Black screen" : "Frozen picture") + " for " + s(b - a) + " s at " + s(toTimeline(clip, a)) + " s", detail: label === "black" ? "Viewers think the video broke." : "The picture does not move while the sound goes on. Fine for slides; if the camera froze, " + (trimmed ? "cut it out." : "cover it with a cutaway."), atS: s(toTimeline(clip, a)), ...(trimmed && trimmed.end - trimmed.start >= 500_000 ? { fix: { label: "Cut it out", operations: [{ type: "trim-clip" as const, clipId: clip.id, sourceStartUs: Math.round(trimmed.start), sourceEndUs: Math.round(trimmed.end) }] } } : {}) });
      }
    }
    // Opening and ending mid-sentence.
    if (index === 0) {
      const first = inside[0]; const before = words.filter((w) => w.endUs <= (first?.startUs ?? 0)).at(-1);
      if (first && before && first.startUs - before.endUs < 350_000 && !ENDS_SENTENCE.test(before.text)) {
        const sentenceStart = [...words].reverse().find((w, j, arr) => w.startUs < first.startUs && (j === arr.length - 1 || ENDS_SENTENCE.test(arr[j + 1]!.text) || arr[j + 1]!.endUs < w.startUs - 600_000));
        const from = sentenceStart ? Math.max(0, sentenceStart.startUs - 120_000, (words.filter((w) => w.endUs <= sentenceStart.startUs).at(-1)?.endUs ?? -Infinity) + 20_000) : undefined;
        add({ severity: from !== undefined && first.startUs - from <= 5_000_000 ? "fix" : "warn", kind: "opens-mid-sentence", title: "Opens mid-sentence", detail: "The first words continue a sentence the viewer never heard (“…" + before.text + " " + first.text + "”).", atS: 0, ...(from !== undefined && first.startUs - from <= 5_000_000 ? { fix: { label: "Start at the beginning of the sentence", operations: [{ type: "trim-clip" as const, clipId: clip.id, sourceStartUs: Math.round(from), sourceEndUs: clip.sourceEndUs }, ...captionsFor(input.assetId, words, [{ startUs: from, endUs: clip.sourceStartUs }])] } } : {}) });
      }
    }
    if (index === mine.length - 1) {
      const last = inside.at(-1);
      if (last && !ENDS_SENTENCE.test(last.text)) {
        const finish = words.find((w) => w.startUs >= last.startUs && ENDS_SENTENCE.test(w.text));
        const to = finish && finish.endUs - last.endUs <= 6_000_000 ? Math.min(input.sourceDurationUs, finish.endUs + 300_000, (words.find((w) => w.startUs >= finish.endUs)?.startUs ?? Infinity) - 20_000) : undefined;
        add({ severity: to ? "fix" : "warn", kind: "ends-mid-sentence", title: "Ends mid-sentence", detail: "The video stops on “" + last.text + "”; finishing the thought makes a cleaner ending.", atS: s(clip.timelineEndUs), ...(to ? { fix: { label: "Finish the sentence (+" + s(to - clip.sourceEndUs) + " s)", operations: [{ type: "trim-clip" as const, clipId: clip.id, sourceStartUs: clip.sourceStartUs, sourceEndUs: Math.round(to) }, ...captionsFor(input.assetId, words, [{ startUs: clip.sourceEndUs, endUs: to }])] } } : {}) });
      }
    }
  });

  // On-screen text: overlapping graphics, too short to read, too long for a vertical frame.
  const graphics = overlays.filter((c) => c.transform?.role === "graphic");
  graphics.forEach((g, i) => {
    const text = String(g.transform?.text ?? ""); const kind = String(g.transform?.kind ?? "title");
    const shownUs = g.timelineEndUs - g.timelineStartUs;
    const needUs = Math.round((1 + text.split(/\s+/).filter(Boolean).length / 3.2) * 1_000_000);
    const readd = (changes: { durationUs?: number; text?: string }): TimelineOperation[] => [{ type: "remove-clip", clipId: g.id, reason: "Edit check" }, { type: "add-graphic", kind: kind as "title" | "callout" | "lower-third", text: changes.text ?? text, ...(g.transform?.subtitle ? { subtitle: String(g.transform.subtitle) } : {}), anchorAssetId: String(g.transform?.anchorAssetId), anchorSourceUs: Number(g.transform?.anchorSourceUs), durationUs: changes.durationUs ?? Number(g.transform?.durationUs ?? shownUs), ...(g.transform?.position ? { position: g.transform.position as "top" | "center" | "bottom" } : {}), ...(g.transform?.color ? { color: String(g.transform.color) } : {}) }];
    const other = graphics.slice(0, i).find((o) => o.timelineEndUs > g.timelineStartUs + 100_000 && (o.transform?.position ?? "top") === (g.transform?.position ?? "top"));
    if (other) add({ severity: "fix", kind: "graphics-overlap", title: "Two graphics on top of each other at " + s(g.timelineStartUs) + " s", detail: "“" + String(other.transform?.text) + "” and “" + text + "” are on screen together in the same place.", atS: s(g.timelineStartUs), fix: { label: "Remove “" + text.slice(0, 30) + "”", operations: [{ type: "remove-clip", clipId: g.id, reason: "Edit check: overlapped another graphic" }] } });
    else if (shownUs + 200_000 < needUs && g.transform?.anchorAssetId) add({ severity: "fix", kind: "too-fast", title: "“" + text.slice(0, 40) + "” is gone before it can be read", detail: "On screen " + s(shownUs) + " s; it needs about " + s(needUs) + " s.", atS: s(g.timelineStartUs), fix: { label: "Show it for " + s(needUs) + " s", operations: readd({ durationUs: needUs }) } });
    const limit = input.platform === "tiktok" ? 32 : 48;
    if (kind === "title" && text.length > limit) {
      const short = text.slice(0, limit + 1).replace(/\s+\S*$/, "").replace(/[,;:–-]+$/, "");
      add({ severity: short.length >= 8 ? "fix" : "warn", kind: "title-long", title: "Title is long for " + (input.platform === "tiktok" ? "a vertical video" : "the frame"), detail: text.length + " characters; titles land best under " + limit + ".", atS: s(g.timelineStartUs), ...(short.length >= 8 && g.transform?.anchorAssetId ? { fix: { label: "Shorten to “" + short + "”", operations: [{ type: "update-graphic" as const, clipId: g.id, text: short }] } } : {}) });
    }
  });

  // Music balance.
  const music = clipsOf(input.timeline, "audio").find((c) => c.transform?.role === "music");
  if (music) {
    const volume = Number(music.transform?.volumeDb ?? -16); const duck = music.transform?.duck !== false;
    if (volume > (duck ? -8 : -14)) add({ severity: "fix", kind: "music-loud", title: "Music may drown out the voice", detail: "Music is at " + volume + " dB" + (duck ? "" : " and does not dip under speech") + ".", fix: { label: "Set music to −16 dB, dipping under speech", operations: [{ type: "set-music", assetId: music.assetId, volumeDb: -16, duck: true }] } });
  }

  // Captions on short-form.
  if (captions.length === 0 && (input.platform === "tiktok" || input.platform === "square") && mine.length > 0) {
    const ranges = mine.map((c) => ({ startUs: c.sourceStartUs, endUs: c.sourceEndUs }));
    const ops = cueOperations(input.assetId, buildCues(words, { ranges }));
    if (ops.length) add({ severity: "fix", kind: "no-captions", title: "No captions", detail: "Most short-form videos are watched with the sound off.", fix: { label: "Add captions", operations: ops } });
  }

  // Length against the goal.
  const total = mine.reduce((sum, c) => sum + c.sourceEndUs - c.sourceStartUs, 0) / 1e6;
  if (input.targetSeconds && total > input.targetSeconds * 1.25) add({ severity: "info", kind: "long", title: "Runs " + Math.round(total) + " s, longer than the " + input.targetSeconds + " s you asked for", detail: "Plan again with the same description, or remove a piece." });
  if (input.platform === "tiktok" && total > 90) add({ severity: "info", kind: "long-short", title: "Long for a short-form video", detail: Math.round(total) + " s; Reels and Shorts perform best under about a minute." });

  return issues;
}

function captionsFor(assetId: string, words: TranscriptWord[], ranges: Array<{ startUs: number; endUs: number }>): TimelineOperation[] {
  const useful = ranges.filter((r) => r.endUs - r.startUs > 50_000);
  return useful.length ? cueOperations(assetId, buildCues(words, { ranges: useful.map((r) => ({ startUs: Math.round(r.startUs), endUs: Math.round(r.endUs) })) })) : [];
}

/** ffmpeg blackdetect / freezedetect output → source spans (offset added: the scan starts at `offsetUs`). */
export function parseMediaSignals(stderr: string, offsetUs = 0): MediaSignals {
  const us = (v: string) => Math.round(Number(v) * 1e6) + offsetUs;
  const black = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ startUs: us(m[1]!), endUs: us(m[2]!) }));
  const starts = [...stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => us(m[1]!));
  const ends = [...stderr.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m) => us(m[1]!));
  const frozen = starts.map((startUs, i) => ({ startUs, endUs: ends[i] ?? startUs + 2_000_000 }));
  return { black, frozen };
}
