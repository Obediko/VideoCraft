import { BACKGROUNDS, CLIP_ZOOMS, COLOUR_LOOKS, SOUND_EFFECTS, TRANSITIONS, type Timeline, type TimelineClip, type TimelineOperation, type TimelineTrack } from "./index.js";
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
      case "set-music": {
        const audio = ensureTrack(tracks, "audio", "music");
        audio.clips = audio.clips.filter((clip) => clip.transform?.role !== "music");
        const start = operation.sourceStartUs ?? 0;
        // The span is re-laid to cover the whole cut by normalizeTimeline; the renderer loops the track.
        audio.clips.push({ id: "music", assetId: operation.assetId, sourceStartUs: start, sourceEndUs: start + 1, timelineStartUs: 0, timelineEndUs: 1, transform: { role: "music", volumeDb: operation.volumeDb ?? -20, duck: operation.duck ?? true } });
        break;
      }
      case "add-broll": {
        if (operation.durationUs < 200_000) throw new Error("B-roll must be at least 0.2s long");
        const overlay = ensureTrack(tracks, "overlay", "broll");
        const base = "broll-" + operation.anchorSourceUs;
        let id = base;
        for (let n = 2; tracks.some((track) => track.clips.some((clip) => clip.id === id)); n += 1) id = base + "-" + n;
        const start = operation.sourceStartUs ?? 0;
        overlay.clips.push({ id, assetId: operation.assetId, sourceStartUs: start, sourceEndUs: start + operation.durationUs, timelineStartUs: 0, timelineEndUs: operation.durationUs, transform: { role: "broll", mode: operation.mode ?? "full", anchorAssetId: operation.anchorAssetId, ...(operation.anchorClipId ? { anchorClipId: operation.anchorClipId } : {}), anchorSourceUs: operation.anchorSourceUs, durationUs: operation.durationUs } });
        break;
      }
      case "add-graphic": {
        if (operation.durationUs < 300_000) throw new Error("A graphic must be at least 0.3s long");
        const overlay = ensureTrack(tracks, "overlay", "graphics");
        const base = "gfx-" + operation.anchorSourceUs;
        let id = base;
        for (let n = 2; tracks.some((track) => track.clips.some((clip) => clip.id === id)); n += 1) id = base + "-" + n;
        overlay.clips.push({ id, assetId: GENERATED_PREFIX + "graphic", sourceStartUs: 0, sourceEndUs: operation.durationUs, timelineStartUs: 0, timelineEndUs: operation.durationUs, transform: {
          role: "graphic", kind: operation.kind, text: operation.text, ...(operation.subtitle ? { subtitle: operation.subtitle } : {}), position: operation.position ?? (operation.kind === "lower-third" ? "bottom" : "center"),
          ...(operation.color ? { color: operation.color } : {}), anchorAssetId: operation.anchorAssetId, ...(operation.anchorClipId ? { anchorClipId: operation.anchorClipId } : {}), anchorSourceUs: operation.anchorSourceUs, durationUs: operation.durationUs,
        } });
        break;
      }
      case "update-graphic": {
        const found = findClip(tracks, operation.clipId);
        if (!found || found.clip.transform?.role !== "graphic") throw new Error("update-graphic references an unknown graphic");
        const transform = { ...found.clip.transform, ...(operation.text !== undefined ? { text: operation.text } : {}) } as Record<string, string | number | boolean>;
        if (operation.subtitle !== undefined) { if (operation.subtitle) transform.subtitle = operation.subtitle; else delete transform.subtitle; }
        if (operation.color !== undefined) transform.color = operation.color;
        found.track.clips[found.index] = { ...found.clip, transform };
        break;
      }
      case "set-clip-effects": {
        const found = findClip(tracks, operation.clipId);
        if (!found || found.track.kind !== "video") throw new Error("set-clip-effects references an unknown video clip");
        const transform: Record<string, string | number | boolean> = { ...(found.clip.transform ?? {}) };
        const put = (key: string, value: string | undefined, off: string) => { if (value === undefined) return; if (value === off) delete transform[key]; else transform[key] = value; };
        put("zoom", operation.zoom, "none"); put("look", operation.look, "none"); put("transitionIn", operation.transitionIn, "cut"); put("transitionOut", operation.transitionOut, "cut");
        if (operation.transitionSeconds !== undefined) transform.transitionSeconds = operation.transitionSeconds;
        if (!transform.transitionIn) delete transform.transitionSeconds;
        const { transform: _old, ...rest } = found.clip;
        found.track.clips[found.index] = Object.keys(transform).length ? { ...rest, transform } : rest;
        break;
      }
      case "set-background": {
        const targets = tracks.filter((track) => track.kind === "video").flatMap((track) => track.clips.map((clip, index) => ({ track, clip, index })))
          .filter(({ clip }) => operation.clipId === undefined || clip.id === operation.clipId);
        if (operation.clipId !== undefined && targets.length === 0) throw new Error("set-background references an unknown video clip");
        for (const { track, clip, index } of targets) {
          const transform: Record<string, string | number | boolean> = { ...(clip.transform ?? {}) };
          for (const key of ["background", "backgroundColor", "backgroundAssetId", "matteEdge", "matteFeather"]) delete transform[key];
          if (operation.background !== "none") {
            transform.background = operation.background;
            if (operation.background === "color") transform.backgroundColor = operation.color ?? "#1F2A24";
            if (operation.background === "media" && operation.assetId) transform.backgroundAssetId = operation.assetId;
            if (operation.edge) transform.matteEdge = operation.edge;
            if (operation.feather !== undefined) transform.matteFeather = operation.feather;
          }
          const { transform: _old, ...rest } = clip;
          track.clips[index] = Object.keys(transform).length ? { ...rest, transform } : rest;
        }
        break;
      }
      case "set-look": {
        for (const track of tracks) if (track.kind === "video") track.clips = track.clips.map((clip) => {
          const transform: Record<string, string | number | boolean> = { ...(clip.transform ?? {}) };
          if (operation.look === "none") delete transform.look; else transform.look = operation.look;
          const { transform: _old, ...rest } = clip;
          return Object.keys(transform).length ? { ...rest, transform } : rest;
        });
        break;
      }
      case "add-sfx": {
        const audio = ensureTrack(tracks, "audio", "music");
        const base = "sfx-" + operation.anchorSourceUs;
        let id = base;
        for (let n = 2; tracks.some((track) => track.clips.some((clip) => clip.id === id)); n += 1) id = base + "-" + n;
        const durationUs = SFX_LENGTH_US[operation.kind] ?? 700_000;
        audio.clips.push({ id, assetId: GENERATED_PREFIX + "sfx", sourceStartUs: 0, sourceEndUs: durationUs, timelineStartUs: 0, timelineEndUs: durationUs, transform: { role: "sfx", kind: operation.kind, volumeDb: operation.volumeDb ?? -18, anchorAssetId: operation.anchorAssetId, ...(operation.anchorClipId ? { anchorClipId: operation.anchorClipId } : {}), anchorSourceUs: operation.anchorSourceUs, durationUs } });
        break;
      }
      case "set-volume": {
        let changed = 0;
        for (const track of tracks) {
          if (track.kind !== "audio") continue;
          track.clips = track.clips.map((clip) => {
            const role = String(clip.transform?.role ?? "");
            if (operation.clipId !== undefined ? clip.id !== operation.clipId : role !== operation.role) return clip;
            changed += 1;
            return { ...clip, transform: { ...(clip.transform ?? {}), volumeDb: operation.volumeDb } };
          });
        }
        if (changed === 0) throw new Error("set-volume found no matching sound");
        break;
      }
      case "add-voiceover": {
        const audio = ensureTrack(tracks, "audio", "music");
        const base = "vo-" + operation.anchorSourceUs;
        let id = base;
        for (let n = 2; tracks.some((track) => track.clips.some((clip) => clip.id === id)); n += 1) id = base + "-" + n;
        audio.clips.push({ id, assetId: operation.assetId, sourceStartUs: 0, sourceEndUs: operation.durationUs, timelineStartUs: 0, timelineEndUs: operation.durationUs, transform: { role: "voiceover", volumeDb: operation.volumeDb ?? 0, duck: operation.duck ?? true, anchorAssetId: operation.anchorAssetId, ...(operation.anchorClipId ? { anchorClipId: operation.anchorClipId } : {}), anchorSourceUs: operation.anchorSourceUs, durationUs: operation.durationUs } });
        break;
      }
      case "set-progress-bar": {
        for (const track of tracks) if (track.kind === "overlay") track.clips = track.clips.filter((clip) => clip.transform?.role !== "progress");
        if (operation.enabled) ensureTrack(tracks, "overlay", "graphics").clips.push({ id: "progress", assetId: GENERATED_PREFIX + "progress", sourceStartUs: 0, sourceEndUs: 1, timelineStartUs: 0, timelineEndUs: 1, transform: { role: "progress", ...(operation.color ? { color: operation.color } : {}) } });
        break;
      }
      case "clear-music": {
        for (const track of tracks) if (track.kind === "audio") track.clips = track.clips.filter((clip) => clip.transform?.role !== "music");
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
          for (const lane of tracks) lane.clips = lane.clips.map(item => item.transform?.anchorClipId === clip.id ? { ...item, transform: { ...item.transform, anchorClipId: clip.id + (Number(item.transform.anchorSourceUs) >= operation.atUs ? ":b" : ":a") } } : item);
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

  // B-roll follows the moment it is anchored to and never straddles a cut; it disappears with its moment.
  for (const track of tracks) {
    if (track.kind !== "overlay") continue;
    track.clips = track.clips.flatMap((clip) => {
      if (clip.transform?.role === "progress") return videoEnd > 0 ? [{ ...clip, timelineStartUs: 0, timelineEndUs: videoEnd, sourceStartUs: 0, sourceEndUs: videoEnd }] : [];
      if (clip.transform?.role !== "broll" && clip.transform?.role !== "graphic") return [clip];
      const anchorAsset = String(clip.transform.anchorAssetId);
      const anchor = Number(clip.transform.anchorSourceUs);
      const wanted = Number(clip.transform.durationUs);
      const host = video?.clips.find((candidate) => (typeof clip.transform?.anchorClipId === "string" ? candidate.id === clip.transform.anchorClipId : candidate.assetId === anchorAsset) && anchor >= candidate.sourceStartUs && anchor < candidate.sourceEndUs);
      if (!host) return [];
      const start = host.timelineStartUs + (anchor - host.sourceStartUs);
      const end = Math.min(start + wanted, host.timelineEndUs);
      return end - start >= 200_000 ? [{ ...clip, timelineStartUs: start, timelineEndUs: end, sourceEndUs: clip.sourceStartUs + (end - start) }] : [];
    }).sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  }
  for (let index = tracks.length - 1; index >= 0; index -= 1) if (tracks[index]!.kind === "overlay" && tracks[index]!.clips.length === 0) tracks.splice(index, 1);

  // A music bed always spans the whole cut, however the video track was edited.
  for (const track of tracks) {
    if (track.kind !== "audio") continue;
    track.clips = track.clips.flatMap((clip) => {
      if (clip.transform?.role === "sfx" || clip.transform?.role === "voiceover") {
        if (clip.transform.timelineBound === true) {
          const end = Math.min(Number(clip.transform.durationUs), videoEnd);
          return end >= 50_000 ? [{ ...clip, timelineStartUs: 0, timelineEndUs: end, sourceEndUs: clip.sourceStartUs + end }] : [];
        }
        // A sound effect plays at its moment; it may ring past a cut but not past the end.
        const host = video?.clips.find((candidate) => (typeof clip.transform?.anchorClipId === "string" ? candidate.id === clip.transform.anchorClipId : candidate.assetId === String(clip.transform!.anchorAssetId)) && Number(clip.transform!.anchorSourceUs) >= candidate.sourceStartUs && Number(clip.transform!.anchorSourceUs) < candidate.sourceEndUs);
        if (!host) return [];
        const start = host.timelineStartUs + (Number(clip.transform.anchorSourceUs) - host.sourceStartUs);
        const end = Math.min(start + Number(clip.transform.durationUs), videoEnd);
        return end - start >= 50_000 ? [{ ...clip, timelineStartUs: start, timelineEndUs: end, sourceEndUs: clip.sourceStartUs + (end - start) }] : [];
      }
      return clip.transform?.role !== "music" ? [clip] : videoEnd > 0 ? [{ ...clip, timelineStartUs: 0, timelineEndUs: videoEnd, sourceEndUs: clip.sourceStartUs + videoEnd }] : [];
    });
  }
  for (let index = tracks.length - 1; index >= 0; index -= 1) if (tracks[index]!.kind === "audio" && tracks[index]!.clips.length === 0) tracks.splice(index, 1);

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

const SFX_LENGTH_US: Record<string, number> = { whoosh: 700_000, pop: 250_000, hit: 1_200_000, riser: 1_800_000 };
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
    if (op.anchorClipId !== undefined && !isId(op.anchorClipId)) return fail("anchorClipId must be a clip id");
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
      case "set-music":
        if (!isId(op.assetId)) return fail("set-music needs assetId");
        if (op.sourceStartUs !== undefined && !isUs(op.sourceStartUs)) return fail("set-music sourceStartUs must be a non-negative integer");
        if (op.volumeDb !== undefined && !(typeof op.volumeDb === "number" && op.volumeDb >= -40 && op.volumeDb <= 0)) return fail("set-music volumeDb must be between -40 and 0");
        if (op.duck !== undefined && typeof op.duck !== "boolean") return fail("set-music duck must be a boolean");
        return { type: "set-music", assetId: op.assetId, ...(op.sourceStartUs === undefined ? {} : { sourceStartUs: op.sourceStartUs as number }), ...(op.volumeDb === undefined ? {} : { volumeDb: op.volumeDb as number }), ...(op.duck === undefined ? {} : { duck: op.duck as boolean }) };
      case "clear-music":
        return { type: "clear-music" };
      case "add-graphic": {
        if (op.kind !== "title" && op.kind !== "callout" && op.kind !== "lower-third" && op.kind !== "thinking") return fail("add-graphic kind must be title, callout, lower-third or thinking");
        if (!isGraphicText(op.text)) return fail("add-graphic text must be 1-120 characters");
        if (op.subtitle !== undefined && op.subtitle !== "" && !isGraphicText(op.subtitle)) return fail("add-graphic subtitle must be at most 120 characters");
        if (!isId(op.anchorAssetId) || !isUs(op.anchorSourceUs) || !isUs(op.durationUs) || (op.durationUs as number) < 300_000 || (op.durationUs as number) > 600_000_000) return fail("add-graphic needs anchorAssetId, anchorSourceUs and a duration of 0.3s-10min");
        if (op.position !== undefined && op.position !== "top" && op.position !== "center" && op.position !== "bottom") return fail("add-graphic position must be top, center or bottom");
        if (op.color !== undefined && !isHexColor(op.color)) return fail("color must be #RRGGBB");
        return { type: "add-graphic", kind: op.kind, text: (op.text as string).trim(), ...(op.subtitle ? { subtitle: (op.subtitle as string).trim() } : {}), anchorAssetId: op.anchorAssetId, ...(typeof op.anchorClipId === "string" ? { anchorClipId: op.anchorClipId } : {}), anchorSourceUs: op.anchorSourceUs as number, durationUs: op.durationUs as number, ...(op.position === undefined ? {} : { position: op.position as "top" | "center" | "bottom" }), ...(op.color === undefined ? {} : { color: (op.color as string).toUpperCase() }) };
      }
      case "update-graphic":
        if (!isId(op.clipId) || (op.text === undefined && op.subtitle === undefined && op.color === undefined)) return fail("update-graphic needs clipId and text, subtitle or color");
        if (op.color !== undefined && !isHexColor(op.color)) return fail("color must be #RRGGBB");
        if (op.text !== undefined && !isGraphicText(op.text)) return fail("update-graphic text must be 1-120 characters");
        if (op.subtitle !== undefined && op.subtitle !== "" && !isGraphicText(op.subtitle)) return fail("update-graphic subtitle must be at most 120 characters");
        return { type: "update-graphic", clipId: op.clipId, ...(op.text === undefined ? {} : { text: (op.text as string).trim() }), ...(op.subtitle === undefined ? {} : { subtitle: (op.subtitle as string).trim() }), ...(op.color === undefined ? {} : { color: (op.color as string).toUpperCase() }) };
      case "set-progress-bar":
        if (typeof op.enabled !== "boolean") return fail("set-progress-bar needs enabled");
        if (op.color !== undefined && !isHexColor(op.color)) return fail("color must be #RRGGBB");
        return { type: "set-progress-bar", enabled: op.enabled, ...(op.color === undefined ? {} : { color: (op.color as string).toUpperCase() }) };
      case "add-broll":
        if (!isId(op.assetId) || !isId(op.anchorAssetId) || !isUs(op.anchorSourceUs) || !isUs(op.durationUs) || (op.durationUs as number) < 200_000 || (op.durationUs as number) > 600_000_000) return fail("add-broll needs assetId, anchorAssetId, anchorSourceUs and a duration of 0.2s-10min");
        if (op.sourceStartUs !== undefined && !isUs(op.sourceStartUs)) return fail("add-broll sourceStartUs must be a non-negative integer");
        if (op.mode !== undefined && op.mode !== "full" && op.mode !== "pip" && op.mode !== "behind") return fail("add-broll mode must be full, pip or behind");
        return { type: "add-broll", assetId: op.assetId, anchorAssetId: op.anchorAssetId, ...(typeof op.anchorClipId === "string" ? { anchorClipId: op.anchorClipId } : {}), anchorSourceUs: op.anchorSourceUs as number, durationUs: op.durationUs as number, ...(op.sourceStartUs === undefined ? {} : { sourceStartUs: op.sourceStartUs as number }), ...(op.mode === undefined ? {} : { mode: op.mode as "full" | "pip" | "behind" }) };
      case "set-clip-effects": {
        if (!isId(op.clipId)) return fail("set-clip-effects needs clipId");
        const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => { const v = op[key]; if (v === undefined) return undefined; if (typeof v !== "string" || !allowed.includes(v as T)) return fail(key + " must be one of " + allowed.join(", ")); return v as T; };
        const zoom = pick("zoom", CLIP_ZOOMS); const look = pick("look", COLOUR_LOOKS); const transitionIn = pick("transitionIn", TRANSITIONS); const transitionOut = pick("transitionOut", TRANSITIONS);
        if (transitionOut !== undefined && !["cut", "dip-black", "dip-white", "flash"].includes(transitionOut)) return fail("transitionOut must be cut, dip-black, dip-white or flash (blends are set on the next clip)");
        const seconds = op.transitionSeconds;
        if (seconds !== undefined && !(typeof seconds === "number" && seconds >= 0.1 && seconds <= 2)) return fail("transitionSeconds must be between 0.1 and 2");
        if (zoom === undefined && look === undefined && transitionIn === undefined && transitionOut === undefined && seconds === undefined) return fail("set-clip-effects needs at least one effect");
        return { type: "set-clip-effects", clipId: op.clipId, ...(zoom ? { zoom } : {}), ...(look ? { look } : {}), ...(transitionIn ? { transitionIn } : {}), ...(transitionOut ? { transitionOut } : {}), ...(seconds !== undefined ? { transitionSeconds: Math.round((seconds as number) * 20) / 20 } : {}) };
      }
      case "set-volume": {
        if (op.clipId === undefined && op.role !== "music" && op.role !== "sfx" && op.role !== "voiceover") return fail("set-volume needs clipId or role (music, sfx or voiceover)");
        if (op.clipId !== undefined && !isId(op.clipId)) return fail("set-volume clipId must be an id");
        if (!(typeof op.volumeDb === "number" && Number.isFinite(op.volumeDb) && op.volumeDb >= -40 && op.volumeDb <= 6)) return fail("set-volume volumeDb must be between -40 and 6");
        return { type: "set-volume", ...(op.clipId !== undefined ? { clipId: op.clipId as string } : { role: op.role as "music" | "sfx" | "voiceover" }), volumeDb: Math.round((op.volumeDb as number) * 2) / 2 };
      }
      case "add-voiceover":
        if (!isId(op.assetId) || !isId(op.anchorAssetId) || !isUs(op.anchorSourceUs)) return fail("add-voiceover needs assetId, anchorAssetId and anchorSourceUs");
        if (!isUs(op.durationUs) || (op.durationUs as number) < 200_000 || (op.durationUs as number) > 3_600_000_000) return fail("add-voiceover needs a duration of 0.2s-1h");
        if (op.volumeDb !== undefined && !(typeof op.volumeDb === "number" && op.volumeDb >= -30 && op.volumeDb <= 6)) return fail("add-voiceover volumeDb must be between -30 and 6");
        if (op.duck !== undefined && typeof op.duck !== "boolean") return fail("add-voiceover duck must be true or false");
        return { type: "add-voiceover", assetId: op.assetId, anchorAssetId: op.anchorAssetId, ...(typeof op.anchorClipId === "string" ? { anchorClipId: op.anchorClipId } : {}), anchorSourceUs: op.anchorSourceUs as number, durationUs: op.durationUs as number, ...(op.volumeDb === undefined ? {} : { volumeDb: op.volumeDb as number }), ...(op.duck === undefined ? {} : { duck: op.duck }) };
      case "set-background": {
        if (op.clipId !== undefined && !isId(op.clipId)) return fail("set-background clipId must be an id");
        if (typeof op.background !== "string" || !(BACKGROUNDS as readonly string[]).includes(op.background)) return fail("set-background background must be one of " + BACKGROUNDS.join(", "));
        if (op.background === "color" && op.color !== undefined && !(typeof op.color === "string" && /^#[0-9a-fA-F]{6}$/.test(op.color))) return fail("set-background color must be #RRGGBB");
        if (op.background === "media" && !isId(op.assetId)) return fail("set-background media needs assetId");
        if (op.edge !== undefined && !(Number.isInteger(op.edge) && (op.edge as number) >= -8 && (op.edge as number) <= 8)) return fail("set-background edge must be a whole number from -8 to 8");
        if (op.feather !== undefined && !(Number.isInteger(op.feather) && (op.feather as number) >= 0 && (op.feather as number) <= 12)) return fail("set-background feather must be a whole number from 0 to 12");
        return { type: "set-background", ...(op.clipId === undefined ? {} : { clipId: op.clipId }), background: op.background as (typeof BACKGROUNDS)[number], ...(op.background === "color" && typeof op.color === "string" ? { color: op.color } : {}), ...(op.background === "media" ? { assetId: op.assetId as string } : {}), ...(op.edge === undefined ? {} : { edge: op.edge as number }), ...(op.feather === undefined ? {} : { feather: op.feather as number }) };
      }
      case "set-look":
        if (typeof op.look !== "string" || !(COLOUR_LOOKS as readonly string[]).includes(op.look)) return fail("set-look look must be one of " + COLOUR_LOOKS.join(", "));
        return { type: "set-look", look: op.look as (typeof COLOUR_LOOKS)[number] };
      case "add-sfx":
        if (typeof op.kind !== "string" || !(SOUND_EFFECTS as readonly string[]).includes(op.kind)) return fail("add-sfx kind must be one of " + SOUND_EFFECTS.join(", "));
        if (!isId(op.anchorAssetId) || !isUs(op.anchorSourceUs)) return fail("add-sfx needs anchorAssetId and anchorSourceUs");
        if (op.volumeDb !== undefined && !(typeof op.volumeDb === "number" && op.volumeDb >= -40 && op.volumeDb <= 0)) return fail("add-sfx volumeDb must be between -40 and 0");
        return { type: "add-sfx", kind: op.kind as (typeof SOUND_EFFECTS)[number], anchorAssetId: op.anchorAssetId, ...(typeof op.anchorClipId === "string" ? { anchorClipId: op.anchorClipId } : {}), anchorSourceUs: op.anchorSourceUs as number, ...(op.volumeDb === undefined ? {} : { volumeDb: op.volumeDb as number }) };
      default:
        return fail("unknown operation type");
    }
  });
}

function isGraphicText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120 && !/[\u0000-\u001f]/.test(value); }
function isHexColor(value: unknown): value is string { return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value); }

function redistribute(totalCs: number, words: string[]): number[] {
  const weights = words.map((word) => Math.max(1, word.length));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((weight) => Math.max(1, Math.round((totalCs * weight) / sum)));
  const drift = totalCs - out.reduce((a, b) => a + b, 0);
  const last = out.length - 1;
  if (last >= 0) out[last] = Math.max(1, (out[last] ?? 1) + drift);
  return out;
}
