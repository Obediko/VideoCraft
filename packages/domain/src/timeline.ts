import type { Timeline, TimelineClip, TimelineOperation, TimelineTrack } from "./index.js";
import { sanitizeFeatures } from "./learning.js";

const GENERATED_PREFIX = "generated:";

/** A caption cue bound to source-media time (as opposed to a legacy timeline-time caption). */
export function isSourceBoundCue(track: TimelineTrack, clip: TimelineClip): boolean {
  return track.kind === "caption" && !clip.assetId.startsWith(GENERATED_PREFIX);
}

/**
 * Applies editing operations to a timeline and returns a new timeline.
 *
 * Invariants maintained after every call:
 * - the video track is laid out contiguously from 0 in timeline order (ripple edit);
 * - source-bound caption cues are re-timed to the clip that contains them and dropped
 *   when the audio they transcribe is no longer on the timeline;
 * - `durationUs` equals the end of the video track (or of the last clip on any track
 *   when there is no video).
 */
export function applyTimelineOperations(timeline: Timeline, operations: TimelineOperation[]): Timeline {
  const tracks: TimelineTrack[] = timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip })) }));

  for (const operation of operations) {
    switch (operation.type) {
      case "add-caption": {
        const clip: TimelineClip = {
          id: "caption-" + operation.atUs + "-" + operation.durationUs,
          assetId: GENERATED_PREFIX + "caption",
          sourceStartUs: 0,
          sourceEndUs: operation.durationUs,
          timelineStartUs: operation.atUs,
          timelineEndUs: operation.atUs + operation.durationUs,
          transform: { text: operation.text },
        };
        ensureTrack(tracks, "caption", "captions").clips.push(clip);
        break;
      }
      case "add-caption-cue": {
        if (operation.sourceEndUs <= operation.sourceStartUs) throw new Error("Caption cue range is invalid");
        if (!operation.text.trim()) throw new Error("Caption cue text is required");
        const transform: Record<string, string | number | boolean> = { text: operation.text };
        if (operation.wordDurationsCs?.length) transform.wordDurationsCs = operation.wordDurationsCs.join(",");
        ensureTrack(tracks, "caption", "captions").clips.push({
          id: "cue-" + operation.sourceStartUs,
          assetId: operation.assetId,
          sourceStartUs: operation.sourceStartUs,
          sourceEndUs: operation.sourceEndUs,
          timelineStartUs: 0,
          timelineEndUs: 1,
          transform,
        });
        break;
      }
      case "update-caption": {
        const found = findClip(tracks, operation.clipId);
        if (!found || found.track.kind !== "caption") throw new Error("Proposal references an unknown caption");
        if (!operation.text.trim()) throw new Error("Caption text is required");
        const previous = found.clip.transform ?? {};
        const nextWords = operation.text.trim().split(/\s+/).filter(Boolean);
        const { wordDurationsCs: _timings, ...rest } = previous;
        const timings = typeof previous.wordDurationsCs === "string" ? previous.wordDurationsCs.split(",").map(Number).filter((value) => value > 0) : [];
        const transform: Record<string, string | number | boolean> = { ...rest, text: operation.text };
        if (timings.length > 0) {
          // Keep the word-by-word highlight in sync: unchanged word count keeps the timings,
          // otherwise the same total duration is shared out in proportion to word length.
          transform.wordDurationsCs = timings.length === nextWords.length ? timings.join(",") : redistribute(timings.reduce((a, b) => a + b, 0), nextWords).join(",");
        }
        found.track.clips[found.index] = { ...found.clip, transform };
        break;
      }
      case "insert-clip": {
        if (operation.sourceEndUs <= operation.sourceStartUs) throw new Error("Insert range is invalid");
        const video = ensureTrack(tracks, "video", "video");
        const base = "seg-" + operation.sourceStartUs + "-" + operation.sourceEndUs;
        let id = base;
        for (let n = 2; tracks.some((track) => track.clips.some((clip) => clip.id === id)); n += 1) id = base + "-" + n;
        const length = operation.sourceEndUs - operation.sourceStartUs;
        const clip: TimelineClip = { id, assetId: operation.assetId, sourceStartUs: operation.sourceStartUs, sourceEndUs: operation.sourceEndUs, timelineStartUs: 0, timelineEndUs: length, reason: operation.reason, ...(operation.score === undefined ? {} : { score: operation.score }), ...(operation.features ? { features: operation.features } : {}) };
        const ordered = sortedClips(video);
        const index = operation.index === undefined ? ordered.length : Math.max(0, Math.min(operation.index, ordered.length));
        ordered.splice(index, 0, clip);
        video.clips = ordered;
        break;
      }
      case "reorder-clips": {
        const video = tracks.find((track) => track.kind === "video");
        if (!video) throw new Error("Timeline has no video track");
        const ids = new Set(operation.clipIds);
        const existing = sortedClips(video);
        if (ids.size !== operation.clipIds.length || existing.length !== ids.size || existing.some((clip) => !ids.has(clip.id))) {
          throw new Error("reorder-clips must list every video clip exactly once");
        }
        video.clips = operation.clipIds.map((id) => existing.find((clip) => clip.id === id) as TimelineClip);
        break;
      }
      case "remove-clip":
      case "trim-clip":
      case "split-clip": {
        const found = findClip(tracks, operation.clipId);
        if (!found) throw new Error("Proposal references an unknown clip");
        const { track, clip, index } = found;
        if (operation.type === "remove-clip") {
          track.clips.splice(index, 1);
        } else if (operation.type === "trim-clip") {
          if (operation.sourceEndUs <= operation.sourceStartUs) throw new Error("Trim range is invalid");
          track.clips[index] = { ...clip, sourceStartUs: operation.sourceStartUs, sourceEndUs: operation.sourceEndUs, timelineEndUs: clip.timelineStartUs + operation.sourceEndUs - operation.sourceStartUs };
        } else {
          if (operation.atUs <= clip.sourceStartUs || operation.atUs >= clip.sourceEndUs) throw new Error("Split point is invalid");
          const ratio = (operation.atUs - clip.sourceStartUs) / (clip.sourceEndUs - clip.sourceStartUs);
          const timelineAt = clip.timelineStartUs + Math.round((clip.timelineEndUs - clip.timelineStartUs) * ratio);
          track.clips.splice(index, 1, { ...clip, id: clip.id + ":a", sourceEndUs: operation.atUs, timelineEndUs: timelineAt }, { ...clip, id: clip.id + ":b", sourceStartUs: operation.atUs, timelineStartUs: timelineAt });
        }
        break;
      }
    }
  }

  return normalizeTimeline({ ...timeline, tracks });
}

/** Re-lays out the video track, re-times source-bound captions and recomputes the duration. */
export function normalizeTimeline(timeline: Timeline): Timeline {
  const tracks: TimelineTrack[] = timeline.tracks.map((track) => ({ ...track, clips: [...track.clips] }));
  const video = tracks.find((track) => track.kind === "video");
  let videoEnd = 0;
  if (video) {
    let cursor = 0;
    video.clips = video.clips.map((clip) => {
      const length = clip.sourceEndUs - clip.sourceStartUs;
      const laid = { ...clip, timelineStartUs: cursor, timelineEndUs: cursor + length };
      cursor += length;
      return laid;
    });
    videoEnd = cursor;
  }

  for (const track of tracks) {
    if (track.kind !== "caption") continue;
    const retimed: TimelineClip[] = [];
    for (const clip of track.clips) {
      if (!isSourceBoundCue(track, clip)) { retimed.push(clip); continue; }
      const host = video?.clips.find((candidate) => candidate.assetId === clip.assetId && clip.sourceStartUs >= candidate.sourceStartUs && clip.sourceStartUs < candidate.sourceEndUs);
      if (!host) continue;
      const start = host.timelineStartUs + (clip.sourceStartUs - host.sourceStartUs);
      const end = host.timelineStartUs + (Math.min(clip.sourceEndUs, host.sourceEndUs) - host.sourceStartUs);
      if (end > start) retimed.push({ ...clip, timelineStartUs: start, timelineEndUs: end });
    }
    track.clips = retimed.sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  }

  let durationUs = videoEnd;
  if (!video || video.clips.length === 0) {
    durationUs = 0;
    for (const track of tracks) for (const clip of track.clips) durationUs = Math.max(durationUs, clip.timelineEndUs);
  } else {
    for (const track of tracks) {
      if (track.kind === "video") continue;
      for (const clip of track.clips) if (clip.assetId.startsWith(GENERATED_PREFIX)) clip.timelineEndUs = Math.min(clip.timelineEndUs, Math.max(durationUs, clip.timelineStartUs + 1));
    }
  }
  return { ...timeline, tracks, durationUs };
}

function sortedClips(track: TimelineTrack): TimelineClip[] {
  return [...track.clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
}

function ensureTrack(tracks: TimelineTrack[], kind: TimelineTrack["kind"], id: string): TimelineTrack {
  const existing = tracks.find((track) => track.kind === kind);
  if (existing) return existing;
  const created: TimelineTrack = { id, kind, clips: [] };
  tracks.push(created);
  return created;
}

function findClip(tracks: TimelineTrack[], clipId: string): { track: TimelineTrack; clip: TimelineClip; index: number } | undefined {
  for (const track of tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    const clip = track.clips[index];
    if (index >= 0 && clip) return { track, clip, index };
  }
  return undefined;
}

const MAX_OPERATIONS = 2_000;
const isUs = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0");
const isText = (value: unknown, max = 1_000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** Validates untrusted JSON as a list of timeline operations; throws a presentable error otherwise. */
export function parseTimelineOperations(value: unknown): TimelineOperation[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("operations must be a non-empty array");
  if (value.length > MAX_OPERATIONS) throw new Error("Too many operations in one request");
  return value.map((raw, index) => {
    const op = raw as Record<string, unknown>;
    const fail = (message: string): never => { throw new Error("operations[" + index + "]: " + message); };
    if (typeof op !== "object" || op === null || Array.isArray(op)) return fail("must be an object");
    switch (op.type) {
      case "trim-clip":
        if (!isId(op.clipId) || !isUs(op.sourceStartUs) || !isUs(op.sourceEndUs) || op.sourceEndUs <= op.sourceStartUs) return fail("trim-clip needs clipId and a valid source range");
        return { type: "trim-clip", clipId: op.clipId, sourceStartUs: op.sourceStartUs, sourceEndUs: op.sourceEndUs };
      case "split-clip":
        if (!isId(op.clipId) || !isUs(op.atUs)) return fail("split-clip needs clipId and atUs");
        return { type: "split-clip", clipId: op.clipId, atUs: op.atUs };
      case "remove-clip":
        if (!isId(op.clipId)) return fail("remove-clip needs clipId");
        return { type: "remove-clip", clipId: op.clipId, reason: typeof op.reason === "string" ? op.reason.slice(0, 500) : "Removed by editor" };
      case "insert-clip":
        if (!isId(op.assetId) || !isUs(op.sourceStartUs) || !isUs(op.sourceEndUs) || op.sourceEndUs <= op.sourceStartUs) return fail("insert-clip needs assetId and a valid source range");
        if (op.index !== undefined && !(Number.isSafeInteger(op.index) && (op.index as number) >= 0)) return fail("insert-clip index must be a non-negative integer");
        return { type: "insert-clip", assetId: op.assetId, sourceStartUs: op.sourceStartUs, sourceEndUs: op.sourceEndUs, reason: typeof op.reason === "string" ? op.reason.slice(0, 1_000) : "Added by editor", ...(typeof op.score === "number" && op.score >= 0 && op.score <= 1 ? { score: op.score } : {}), ...(sanitizeFeatures(op.features) ? { features: sanitizeFeatures(op.features) as Record<string, number> } : {}), ...(op.index === undefined ? {} : { index: op.index as number }) };
      case "reorder-clips":
        if (!Array.isArray(op.clipIds) || op.clipIds.length === 0 || !op.clipIds.every(isId)) return fail("reorder-clips needs clipIds");
        return { type: "reorder-clips", clipIds: op.clipIds as string[] };
      case "add-caption-cue":
        if (!isId(op.assetId) || !isUs(op.sourceStartUs) || !isUs(op.sourceEndUs) || op.sourceEndUs <= op.sourceStartUs || !isText(op.text)) return fail("add-caption-cue needs assetId, a valid source range and text");
        if (op.wordDurationsCs !== undefined && !(Array.isArray(op.wordDurationsCs) && op.wordDurationsCs.length <= 100 && op.wordDurationsCs.every((v) => Number.isSafeInteger(v) && (v as number) > 0))) return fail("wordDurationsCs must be positive integers");
        return { type: "add-caption-cue", assetId: op.assetId, sourceStartUs: op.sourceStartUs, sourceEndUs: op.sourceEndUs, text: op.text, ...(op.wordDurationsCs === undefined ? {} : { wordDurationsCs: op.wordDurationsCs as number[] }) };
      case "update-caption":
        if (!isId(op.clipId) || !isText(op.text)) return fail("update-caption needs clipId and non-empty text");
        return { type: "update-caption", clipId: op.clipId, text: op.text };
      case "add-caption":
        if (!isText(op.text) || !isUs(op.atUs) || !isUs(op.durationUs) || op.durationUs <= 0) return fail("add-caption needs text, atUs and durationUs");
        return { type: "add-caption", text: op.text, atUs: op.atUs, durationUs: op.durationUs };
      default:
        return fail("unknown operation type");
    }
  });
}

function redistribute(totalCs: number, words: string[]): number[] {
  const weights = words.map((word) => Math.max(1, word.length));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((weight) => Math.max(1, Math.round((totalCs * weight) / sum)));
  const drift = totalCs - out.reduce((a, b) => a + b, 0);
  const last = out.length - 1;
  if (last >= 0) out[last] = Math.max(1, (out[last] ?? 1) + drift);
  return out;
}
