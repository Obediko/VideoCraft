import type { CaptionStyle } from "./index.js";

/**
 * Face-aware placement: where the speaker's face sits in the output frame, and where captions and text graphics
 * go so they never cover it. Pure functions; the web live preview mirrors them (apps/web/src/preview.ts).
 */

/** A face box as fractions of the source frame: [left, top, right, bottom]. */
export type FaceBox = [number, number, number, number];
/** Face boxes sampled every `step` seconds from the start of the source (null where no face was seen). */
export interface FaceTrack { step: number; boxes: Array<FaceBox | null>; }
/** A box in output pixels. */
export interface PixelBox { x0: number; y0: number; x1: number; y1: number; }

/** The area the face covers during a source range (the union of its sampled boxes), or undefined if none. */
export function faceDuring(track: FaceTrack | undefined, startUs: number, endUs: number): FaceBox | undefined {
  if (!track || !(track.step > 0) || endUs <= startUs) return undefined;
  const first = Math.max(0, Math.floor(startUs / 1e6 / track.step));
  const last = Math.min(track.boxes.length - 1, Math.ceil(endUs / 1e6 / track.step));
  let union: FaceBox | undefined;
  for (let i = first; i <= last; i += 1) {
    const box = track.boxes[i];
    if (!box) continue;
    union = union ? [Math.min(union[0], box[0]), Math.min(union[1], box[1]), Math.max(union[2], box[2]), Math.max(union[3], box[3])] : [...box];
  }
  return union;
}

/** The face's centre over a source range (median), when a face is seen for at least 30% of it: where a cover crop aims. */
export function focusFromTrack(track: FaceTrack | undefined, startUs: number, endUs: number): { x: number; y: number; confidence: number } | null {
  if (!track || !(track.step > 0) || endUs <= startUs) return null;
  const first = Math.max(0, Math.floor(startUs / 1e6 / track.step)); const last = Math.min(track.boxes.length - 1, Math.ceil(endUs / 1e6 / track.step));
  const xs: number[] = []; const ys: number[] = [];
  for (let i = first; i <= last; i += 1) { const b = track.boxes[i]; if (b) { xs.push((b[0] + b[2]) / 2); ys.push((b[1] + b[3]) / 2); } }
  const samples = Math.max(1, last - first + 1);
  if (xs.length < samples * 0.3) return null;
  const mid = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  return { x: mid(xs), y: mid(ys), confidence: xs.length / samples };
}

export interface Framing {
  source: { width: number; height: number };
  output: { width: number; height: number };
  fit: "cover" | "contain";
  /** Subject focus the cover crop is aimed at (fractions); null centres the crop. */
  focus?: { x: number; y: number } | null;
  zoom?: string;
}

/** Maps a face box from source fractions into output pixels, following the renderer's scale, crop and zoom. */
export function faceInOutput(box: FaceBox, framing: Framing): PixelBox | undefined {
  const { source, output, fit } = framing;
  if (!(source.width > 0 && source.height > 0)) return undefined;
  const W = output.width; const H = output.height;
  const s = fit === "cover" ? Math.max(W / source.width, H / source.height) : Math.min(W / source.width, H / source.height);
  const iw = source.width * s; const ih = source.height * s;
  let ox: number; let oy: number;
  if (fit === "cover") {
    const fx = framing.focus ? clamp01(framing.focus.x) : 0.5; const fy = framing.focus ? clamp01(framing.focus.y) : 0.5;
    ox = -Math.min(Math.max(iw * fx - W / 2, 0), iw - W); oy = -Math.min(Math.max(ih * fy - H / 2, 0), ih - H);
  } else { ox = (W - iw) / 2; oy = (H - ih) / 2; }
  const place = (zoom: number): PixelBox => {
    // Zooms scale the framed picture and crop it centred horizontally, a little above centre vertically.
    const cx = (W * zoom - W) / 2; const cy = (H * zoom - H) * 0.4;
    return { x0: (ox + box[0] * iw) * zoom - cx, y0: (oy + box[1] * ih) * zoom - cy, x1: (ox + box[2] * iw) * zoom - cx, y1: (oy + box[3] * ih) * zoom - cy };
  };
  const zooms = framing.zoom === "punch" ? [1.12] : framing.zoom === "push" ? [1, 1.08] : [1];
  const boxes = zooms.map(place);
  const out = { x0: Math.min(...boxes.map((b) => b.x0)), y0: Math.min(...boxes.map((b) => b.y0)), x1: Math.max(...boxes.map((b) => b.x1)), y1: Math.max(...boxes.map((b) => b.y1)) };
  const clipped = { x0: Math.max(0, out.x0), y0: Math.max(0, out.y0), x1: Math.min(W, out.x1), y1: Math.min(H, out.y1) };
  return clipped.x1 > clipped.x0 && clipped.y1 > clipped.y0 ? clipped : undefined;
}

/** Height of the caption block for this style, for up to `lines` lines. */
export function captionHeight(style: CaptionStyle, height: number, lines = 2): number {
  return Math.round(lines * Math.max(12, Math.round(height * style.sizeRatio)) * 1.25);
}

/**
 * The caption's distance from the bottom of the frame (ASS MarginV, in pixels) that keeps it off the face:
 * the style's usual place when that is clear; otherwise just below the face when there is room, else just above it.
 */
export function captionMarginFor(face: PixelBox | undefined, style: CaptionStyle, frame: { width: number; height: number }, lines = 2): number {
  const H = frame.height;
  const usual = Math.round(H * style.bottomRatio);
  if (!face) return usual;
  const block = captionHeight(style, H, lines);
  const pad = Math.round(H * 0.02);
  const overlaps = (marginV: number) => { const bottom = H - marginV; const top = bottom - block; return top < face.y1 + pad && bottom > face.y0 - pad; };
  if (!overlaps(usual)) return usual;
  const below = Math.round(H - (face.y1 + pad + block));
  const above = Math.round(H - (face.y0 - pad));
  const aboveFits = face.y0 - pad - block >= H * 0.07;
  // Below the face, but not so low that platform buttons and descriptions cover it; else above; else as low as allowed.
  if (below >= H * 0.1) return below;
  if (aboveFits) return above;
  if (below >= H * 0.04) return below;
  return usual;
}

/** The band (top and bottom y, in pixels) a caption with this margin occupies. */
export function captionBandAt(style: CaptionStyle, height: number, marginV: number, lines = 2): { topY: number; bottomY: number } {
  const bottomY = height - marginV;
  return { topY: Math.max(0, bottomY - captionHeight(style, height, lines)), bottomY };
}

function clamp01(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5; }
