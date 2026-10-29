/**
 * Editing by transcript: which words are in the cut, and the timeline operations that cut a stretch of
 * words out or bring it back (keeping captions in step). Pure functions, so they are unit-tested.
 */
export type Word = { text: string; startUs: number; endUs: number };
export type Clip = { id: string; assetId: string; sourceStartUs: number; sourceEndUs: number; timelineStartUs: number; timelineEndUs: number; transform?: Record<string, string | number | boolean> };
export type Op = Record<string, unknown> & { type: string };

const byStart = (a: Clip, b: Clip) => a.timelineStartUs - b.timelineStartUs;

/** For each word: is its middle inside a kept clip of this asset? */
export function keptWords(words: Word[], clips: Clip[], assetId: string): boolean[] {
  const mine = clips.filter((c) => c.assetId === assetId);
  return words.map((w) => { const mid = (w.startUs + w.endUs) / 2; return mine.some((c) => mid >= c.sourceStartUs && mid < c.sourceEndUs); });
}

/** The source range covering words[from..to], with a little air that never reaches into a neighbouring word. */
export function rangeForWords(words: Word[], from: number, to: number): { startUs: number; endUs: number } {
  const a = Math.max(0, Math.min(from, to)); const b = Math.min(words.length - 1, Math.max(from, to));
  const first = words[a]!; const last = words[b]!;
  const prevEnd = a > 0 ? words[a - 1]!.endUs : -Infinity; const nextStart = b < words.length - 1 ? words[b + 1]!.startUs : Infinity;
  const startUs = Math.max(0, first.startUs - 120_000, Number.isFinite(prevEnd) ? (prevEnd + first.startUs) / 2 : 0);
  const endUs = Math.min(last.endUs + 180_000, Number.isFinite(nextStart) ? (last.endUs + nextStart) / 2 : last.endUs + 180_000);
  return { startUs: Math.round(startUs), endUs: Math.round(Math.max(endUs, startUs + 1)) };
}

/** Caption cues of at most four words for the given words, bound to the source (they follow the cut). */
export function cueOps(words: Word[], assetId: string): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < words.length;) {
    const group = [words[i]!]; i += 1;
    while (i < words.length && group.length < 4 && words[i]!.startUs - group[group.length - 1]!.endUs < 500_000 && !/[.!?]$/.test(group[group.length - 1]!.text)) { group.push(words[i]!); i += 1; }
    const start = group[0]!.startUs; const end = group[group.length - 1]!.endUs;
    if (end <= start) continue;
    ops.push({ type: "add-caption-cue", assetId, sourceStartUs: start, sourceEndUs: end, text: group.map((w) => w.text).join(" "), wordDurationsCs: group.map((w, k) => Math.max(1, Math.round(((k + 1 < group.length ? group[k + 1]!.startUs : w.endUs) - w.startUs) / 10_000))) });
  }
  return ops;
}

/** Operations that take the source range out of the cut. */
export function removeRangeOps(range: { startUs: number; endUs: number }, clips: Clip[], cues: Clip[], words: Word[], assetId: string): Op[] {
  const ops: Op[] = [];
  const { startUs: a, endUs: b } = range;
  for (const clip of [...clips].sort(byStart)) {
    if (clip.assetId !== assetId || clip.sourceEndUs <= a || clip.sourceStartUs >= b) continue;
    const keepsBefore = clip.sourceStartUs < a - 50_000; const keepsAfter = clip.sourceEndUs > b + 50_000;
    if (!keepsBefore && !keepsAfter) ops.push({ type: "remove-clip", clipId: clip.id, reason: "Cut in the transcript" });
    else if (keepsBefore && !keepsAfter) ops.push({ type: "trim-clip", clipId: clip.id, sourceStartUs: clip.sourceStartUs, sourceEndUs: a });
    else if (!keepsBefore && keepsAfter) ops.push({ type: "trim-clip", clipId: clip.id, sourceStartUs: b, sourceEndUs: clip.sourceEndUs });
    else {
      // The cut is inside the clip: split around it and drop the middle.
      ops.push({ type: "split-clip", clipId: clip.id, atUs: a }, { type: "split-clip", clipId: clip.id + ":b", atUs: b }, { type: "remove-clip", clipId: clip.id + ":b:a", reason: "Cut in the transcript" });
    }
  }
  // Captions that show any of the removed words are rebuilt from the words that stay.
  for (const cue of cues) {
    if (cue.assetId !== assetId || cue.sourceEndUs <= a || cue.sourceStartUs >= b) continue;
    ops.push({ type: "remove-clip", clipId: cue.id, reason: "Caption rebuilt after a cut" });
    ops.push(...cueOps(words.filter((w) => w.startUs >= cue.sourceStartUs - 1 && w.endUs <= cue.sourceEndUs + 1 && (w.endUs <= a || w.startUs >= b)), assetId));
  }
  return ops;
}

/** Operations that bring a source range back into the cut, in source order, with its captions. */
export function restoreRangeOps(range: { startUs: number; endUs: number }, clips: Clip[], words: Word[], assetId: string): Op[] {
  const ordered = [...clips].sort(byStart);
  // Only the parts of the range that are not already in the cut.
  let pieces = [{ ...range }];
  for (const c of ordered.filter((x) => x.assetId === assetId)) {
    pieces = pieces.flatMap((p) => c.sourceEndUs <= p.startUs || c.sourceStartUs >= p.endUs ? [p] : [{ startUs: p.startUs, endUs: c.sourceStartUs }, { startUs: c.sourceEndUs, endUs: p.endUs }].filter((q) => q.endUs - q.startUs > 50_000));
  }
  const ops: Op[] = [];
  let inserted = 0;
  const mine = ordered.filter((c) => c.assetId === assetId);
  const touches = (x: number, y: number) => Math.abs(x - y) <= 60_000;
  for (const piece of pieces) {
    // Rejoin neighbouring clips instead of leaving short separate pieces (a cut that is brought back heals).
    const left = mine.find((c) => touches(c.sourceEndUs, piece.startUs));
    const right = mine.find((c) => touches(c.sourceStartUs, piece.endUs));
    const adjacent = left && right && ordered.indexOf(right) === ordered.indexOf(left) + 1;
    if (left && right && adjacent) {
      ops.push({ type: "trim-clip", clipId: left.id, sourceStartUs: left.sourceStartUs, sourceEndUs: right.sourceEndUs }, { type: "remove-clip", clipId: right.id, reason: "Joined after bringing words back" });
      ops.push(...cueOps(words.filter((w) => w.startUs >= piece.startUs - 1 && w.endUs <= piece.endUs + 1), assetId));
      continue;
    }
    if (left && !right) {
      ops.push({ type: "trim-clip", clipId: left.id, sourceStartUs: left.sourceStartUs, sourceEndUs: piece.endUs });
      ops.push(...cueOps(words.filter((w) => w.startUs >= piece.startUs - 1 && w.endUs <= piece.endUs + 1), assetId));
      continue;
    }
    if (right && !left) {
      ops.push({ type: "trim-clip", clipId: right.id, sourceStartUs: piece.startUs, sourceEndUs: right.sourceEndUs });
      ops.push(...cueOps(words.filter((w) => w.startUs >= piece.startUs - 1 && w.endUs <= piece.endUs + 1), assetId));
      continue;
    }
    // After the last kept clip of this asset that ends before the piece starts.
    const before = ordered.map((c, i) => ({ c, i })).filter(({ c }) => c.assetId === assetId && c.sourceEndUs <= piece.startUs + 1);
    const index = (before.length ? before[before.length - 1]!.i + 1 : 0) + inserted;
    ops.push({ type: "insert-clip", assetId, sourceStartUs: piece.startUs, sourceEndUs: piece.endUs, reason: "Brought back in the transcript", index });
    inserted += 1;
    ops.push(...cueOps(words.filter((w) => w.startUs >= piece.startUs - 1 && w.endUs <= piece.endUs + 1), assetId));
  }
  return ops;
}

/** The source moment shown at a time in the edit. */
export function timelineToSource(clips: Clip[], atUs: number): { assetId: string; sourceUs: number } | undefined {
  const clip = clips.find((c) => atUs >= c.timelineStartUs && atUs < c.timelineEndUs) ?? clips[clips.length - 1];
  return clip ? { assetId: clip.assetId, sourceUs: Math.min(clip.sourceEndUs, clip.sourceStartUs + Math.max(0, atUs - clip.timelineStartUs)) } : undefined;
}

/** The time in the edit at which a source moment plays, if it is in the cut. */
export function sourceToTimeline(clips: Clip[], assetId: string, sourceUs: number): number | undefined {
  const clip = clips.find((c) => c.assetId === assetId && sourceUs >= c.sourceStartUs && sourceUs < c.sourceEndUs);
  return clip ? clip.timelineStartUs + (sourceUs - clip.sourceStartUs) : undefined;
}

/** The length the description asks for ("a 30 second Reel", "2 minutes"), if any. */
export function secondsFromBrief(brief: string): number | undefined {
  const s = /(\d{1,3})\s*-?\s*(s|sec|secs|second|seconds)\b/i.exec(brief); if (s) return Number(s[1]);
  const m = /(\d{1,2})\s*-?\s*(min|mins|minute|minutes)\b/i.exec(brief); return m ? Number(m[1]) * 60 : undefined;
}
