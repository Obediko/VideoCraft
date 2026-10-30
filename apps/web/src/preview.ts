/** Pure helpers for the live preview (unit-tested). */
export type PreviewClip = { id: string; assetId: string; sourceStartUs: number; sourceEndUs: number; timelineStartUs: number; timelineEndUs: number; transform?: Record<string, string | number | boolean> };
type Clip = PreviewClip;

// CSS approximations of the export's colour looks (packages/rendering LOOK_FILTERS).
export const LOOK_CSS: Record<string, string> = {
  warm: "sepia(0.18) saturate(1.12) contrast(1.03)",
  clean: "contrast(1.06) saturate(1.06) brightness(1.01)",
  cinematic: "contrast(1.1) saturate(0.88) brightness(0.97)",
  vivid: "saturate(1.3) contrast(1.08)",
  soft: "contrast(0.93) saturate(0.94) brightness(1.03)",
  mono: "grayscale(1) contrast(1.12)",
};
const DIP: Record<string, number> = { "dip-black": 250_000, "dip-white": 250_000, flash: 120_000 };

/**
 * Opacity and colour of the transition veil at a time in the edit, worked out exactly like the export
 * (packages/rendering clipFinish): each clip fades in from its own transition and out to its explicit ending,
 * or to the next clip's dip; a fade lasts at most a third of the clip; a flash only fades in, from white.
 */
export function veilAt(clips: Clip[], tUs: number, durationUs: number): { opacity: number; color: string } {
  const i = clips.findIndex((c) => tUs >= c.timelineStartUs && tUs < c.timelineEndUs);
  const clip = clips[i] ?? (tUs >= durationUs ? clips[clips.length - 1] : undefined);
  if (!clip) return { opacity: 0, color: "#000" };
  const index = i >= 0 ? i : clips.length - 1;
  const lengthUs = Math.max(1, clip.timelineEndUs - clip.timelineStartUs);
  const incoming = String(clip.transform?.transitionIn ?? "cut");
  const nextIn = String(clips[index + 1]?.transform?.transitionIn ?? "cut");
  const explicitOut = String(clip.transform?.transitionOut ?? "cut");
  const outgoing = explicitOut !== "cut" ? explicitOut : nextIn === "dip-black" || nextIn === "dip-white" ? nextIn : "cut";
  const colour = (kind: string) => (kind === "dip-black" ? "#000" : "#fff");
  let best = { opacity: 0, color: "#000" };
  const inUs = DIP[incoming] ? Math.min(DIP[incoming]!, lengthUs / 3) : 0;
  const into = tUs - clip.timelineStartUs;
  if (inUs && into < inUs) best = { opacity: Math.max(0, 1 - into / inUs), color: colour(incoming) };
  const outUs = DIP[outgoing] ? Math.min(DIP[outgoing]!, lengthUs / 3) : 0;
  const left = Math.min(clip.timelineEndUs, Math.max(durationUs, clip.timelineEndUs)) - tUs;
  if (outUs && left <= outUs) { const opacity = Math.min(1, Math.max(0, 1 - left / outUs)); if (opacity > best.opacity) best = { opacity, color: colour(outgoing) }; }
  return best;
}

/** Zoom factor of a clip at a time inside it. */
export function zoomAt(clip: Clip | undefined, tUs: number): number {
  if (!clip) return 1;
  if (clip.transform?.zoom === "punch") return 1.12;
  if (clip.transform?.zoom === "push") { const len = Math.max(1, clip.timelineEndUs - clip.timelineStartUs); return 1 + 0.08 * Math.min(1, Math.max(0, (tUs - clip.timelineStartUs) / len)); }
  return 1;
}


/*
 * Face-aware placement, mirroring packages/captions/src/placement.ts (the export) in fractions of the frame,
 * so the live preview shows captions and text where the export will put them.
 */
export type FaceBox = [number, number, number, number];
export type FaceTrack = { step: number; boxes: Array<FaceBox | null> };
export type FrameBox = { x0: number; y0: number; x1: number; y1: number };
/** Caption placement per style, as in the export: distance from the bottom and text size, as fractions of the height. */
export const CAPTION_LAYOUT: Record<string, { bottom: number; size: number }> = { "bold-pop": { bottom: 0.3, size: 0.052 }, clean: { bottom: 0.12, size: 0.042 }, minimal: { bottom: 0.09, size: 0.036 } };

export function faceDuring(track: FaceTrack | undefined, startUs: number, endUs: number): FaceBox | undefined {
  if (!track || !(track.step > 0) || endUs <= startUs) return undefined;
  const first = Math.max(0, Math.floor(startUs / 1e6 / track.step)); const last = Math.min(track.boxes.length - 1, Math.ceil(endUs / 1e6 / track.step));
  let u: FaceBox | undefined;
  for (let i = first; i <= last; i += 1) { const b = track.boxes[i]; if (b) u = u ? [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])] : [...b]; }
  return u;
}

/** Centre of the face over a source range: where the cover crop aims (the export aims at the subject the same way). */
export function focusDuring(track: FaceTrack | undefined, startUs: number, endUs: number): { x: number; y: number } | null {
  if (!track) return null;
  const xs: number[] = []; const ys: number[] = [];
  const first = Math.max(0, Math.floor(startUs / 1e6 / track.step)); const last = Math.min(track.boxes.length - 1, Math.ceil(endUs / 1e6 / track.step));
  for (let i = first; i <= last; i += 1) { const b = track.boxes[i]; if (b) { xs.push((b[0] + b[2]) / 2); ys.push((b[1] + b[3]) / 2); } }
  if (xs.length < Math.max(1, (last - first + 1) * 0.3)) return null;
  const mid = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  return { x: mid(xs), y: mid(ys) };
}

/** A source face box in fractions of the output frame, following the fit, crop focus and zoom. */
export function faceInFrame(box: FaceBox, source: { width: number; height: number }, output: { width: number; height: number }, fit: "cover" | "contain", focus: { x: number; y: number } | null, zoom = 1): FrameBox | undefined {
  if (!(source.width > 0 && source.height > 0)) return undefined;
  const W = output.width; const H = output.height;
  const s = fit === "cover" ? Math.max(W / source.width, H / source.height) : Math.min(W / source.width, H / source.height);
  const iw = source.width * s; const ih = source.height * s;
  const fx = focus?.x ?? 0.5; const fy = focus?.y ?? 0.5;
  const ox = fit === "cover" ? -Math.min(Math.max(iw * fx - W / 2, 0), iw - W) : (W - iw) / 2;
  const oy = fit === "cover" ? -Math.min(Math.max(ih * fy - H / 2, 0), ih - H) : (H - ih) / 2;
  const cx = (W * zoom - W) / 2; const cy = (H * zoom - H) * 0.4;
  const b = { x0: ((ox + box[0] * iw) * zoom - cx) / W, y0: ((oy + box[1] * ih) * zoom - cy) / H, x1: ((ox + box[2] * iw) * zoom - cx) / W, y1: ((oy + box[3] * ih) * zoom - cy) / H };
  const c = { x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(1, b.x1), y1: Math.min(1, b.y1) };
  return c.x1 > c.x0 && c.y1 > c.y0 ? c : undefined;
}

/** Caption distance from the bottom (fraction of the height) that keeps it off the face, as the export decides. */
export function captionBottomFor(face: FrameBox | undefined, style: string): number {
  const layout = CAPTION_LAYOUT[style] ?? CAPTION_LAYOUT["bold-pop"]!;
  if (!face) return layout.bottom;
  const block = 2 * layout.size * 1.25; const pad = 0.02;
  const overlaps = (m: number) => { const bottom = 1 - m; return bottom - block < face.y1 + pad && bottom > face.y0 - pad; };
  if (!overlaps(layout.bottom)) return layout.bottom;
  const below = 1 - (face.y1 + pad + block); const above = 1 - (face.y0 - pad);
  if (below >= 0.1) return below;
  if (face.y0 - pad - block >= 0.07) return above;
  if (below >= 0.04) return below;
  return layout.bottom;
}

/** Vertical slot for a title or callout (fraction of the height of its top edge) that avoids the face and captions. */
export function titleTopFor(wanted: string, face: FrameBox | undefined, captionTop: number | undefined, height = 0.12): number {
  const slots: Record<string, number> = { top: 0.08, center: 0.4, bottom: 0.64 };
  const order = wanted === "top" ? ["top", "center", "bottom"] : wanted === "bottom" ? ["bottom", "center", "top"] : ["center", "top", "bottom"];
  const clear = order.map((k) => slots[k]!).find((y) => !(face && y < face.y1 && y + height > face.y0) && !(captionTop !== undefined && y + height > captionTop));
  return clear ?? slots[wanted] ?? 0.4;
}
