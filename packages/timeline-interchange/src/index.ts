import type { Timeline, TimelineClip, TimelineTrack } from "@videocraft/domain";

export interface OtioRationalTime { value: number; rate: number; }
export interface OtioDocument { OTIO_SCHEMA: "Timeline.1"; name: string; durationUs: number; tracks: { OTIO_SCHEMA: "Stack.1"; children: OtioTrack[] }; }
export interface OtioTrack { OTIO_SCHEMA: "Track.1"; name: string; kind: string; children: OtioClip[]; }
export interface OtioClip { OTIO_SCHEMA: "Clip.1"; name: string; assetId: string; sourceRange: { startUs: number; durationUs: number }; timelineStartUs: number; durationUs: number; }

export function exportOtio(timeline: Timeline, name = "VideoCraft timeline"): OtioDocument {
  return {
    OTIO_SCHEMA: "Timeline.1", name, durationUs: timeline.durationUs,
    tracks: { OTIO_SCHEMA: "Stack.1", children: timeline.tracks.map((track) => ({
      OTIO_SCHEMA: "Track.1", name: track.id, kind: track.kind,
      children: track.clips.map((clip) => ({
        OTIO_SCHEMA: "Clip.1", name: clip.id, assetId: clip.assetId,
        sourceRange: { startUs: clip.sourceStartUs, durationUs: clip.sourceEndUs - clip.sourceStartUs },
        timelineStartUs: clip.timelineStartUs, durationUs: clip.timelineEndUs - clip.timelineStartUs,
      })),
    })) },
  };
}
export function importOtio(document: unknown): Timeline {
  if (!isObject(document) || document.OTIO_SCHEMA !== "Timeline.1" || !isObject(document.tracks) || !Array.isArray(document.tracks.children) || typeof document.durationUs !== "number") throw new Error("Invalid OTIO document");
  const tracks: TimelineTrack[] = document.tracks.children.map((track, trackIndex) => {
    if (!isObject(track) || track.OTIO_SCHEMA !== "Track.1" || typeof track.name !== "string" || typeof track.kind !== "string" || !Array.isArray(track.children)) throw new Error("Invalid OTIO track at index " + trackIndex);
    const clips: TimelineClip[] = track.children.map((clip, clipIndex) => {
      if (!isObject(clip) || clip.OTIO_SCHEMA !== "Clip.1" || typeof clip.name !== "string" || typeof clip.assetId !== "string" || !isObject(clip.sourceRange) || typeof clip.sourceRange.startUs !== "number" || typeof clip.sourceRange.durationUs !== "number" || typeof clip.timelineStartUs !== "number" || typeof clip.durationUs !== "number" || clip.sourceRange.durationUs <= 0 || clip.durationUs <= 0) throw new Error("Invalid OTIO clip at " + trackIndex + ":" + clipIndex);
      return { id: clip.name, assetId: clip.assetId, sourceStartUs: clip.sourceRange.startUs, sourceEndUs: clip.sourceRange.startUs + clip.sourceRange.durationUs, timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineStartUs + clip.durationUs };
    });
    return { id: track.name, kind: track.kind as TimelineTrack["kind"], clips };
  });
  return { durationUs: document.durationUs, tracks };
}
function isObject(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
