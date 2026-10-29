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

/** Opacity and colour of the transition veil at a time in the edit. */
export function veilAt(clips: Clip[], tUs: number, durationUs: number): { opacity: number; color: string } {
  let best = { opacity: 0, color: "#000" };
  const consider = (opacity: number, color: string) => { if (opacity > best.opacity) best = { opacity: Math.min(1, opacity), color }; };
  clips.forEach((clip, i) => {
    const kind = String(clip.transform?.transitionIn ?? "cut");
    const d = DIP[kind];
    if (d) {
      const b = clip.timelineStartUs; const color = kind === "dip-black" ? "#000" : "#fff";
      if (kind === "flash") { if (tUs >= b && tUs < b + d) consider(1 - (tUs - b) / d, color); }
      else if (Math.abs(tUs - b) < d && (i > 0 || tUs >= b)) consider(1 - Math.abs(tUs - b) / d, color);
    }
    const out = String(clip.transform?.transitionOut ?? "cut");
    if (i === clips.length - 1 && DIP[out] && out !== "flash") { const end = Math.min(durationUs, clip.timelineEndUs); const d2 = DIP[out]!; if (tUs > end - d2) consider(1 - (end - tUs) / d2, out === "dip-black" ? "#000" : "#fff"); }
  });
  return best;
}

/** Zoom factor of a clip at a time inside it. */
export function zoomAt(clip: Clip | undefined, tUs: number): number {
  if (!clip) return 1;
  if (clip.transform?.zoom === "punch") return 1.12;
  if (clip.transform?.zoom === "push") { const len = Math.max(1, clip.timelineEndUs - clip.timelineStartUs); return 1 + 0.08 * Math.min(1, Math.max(0, (tUs - clip.timelineStartUs) / len)); }
  return 1;
}

