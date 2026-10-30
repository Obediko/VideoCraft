import type { TimelineClip } from "./index.js";

/**
 * Transition timing shared by the renderer and the live preview, so both do exactly the same thing.
 * Dips and the flash fade through a colour inside each clip; blends overlap the end of the outgoing clip (using
 * footage just past its cut, or its last frame held) with the start of the incoming one, so no clip moves.
 */
export const DIP_SECONDS: Record<string, number> = { "dip-black": 0.25, "dip-white": 0.25, flash: 0.12 };
const BLENDS = new Set(["dissolve", "push", "slide-up", "wipe", "circle", "blur"]);
export const BLEND_DEFAULT_SECONDS = 0.5;
/** FFmpeg xfade names for the blends. */
export const XFADE_NAMES: Record<string, string> = { dissolve: "fade", push: "slideleft", "slide-up": "slideup", wipe: "wipeleft", circle: "circleopen", blur: "hblur" };

type Clip = Pick<TimelineClip, "timelineStartUs" | "timelineEndUs" | "transform">;
const lengthOf = (c: Clip) => Math.max(0, (c.timelineEndUs - c.timelineStartUs) / 1e6);
const chosen = (c: Clip | undefined) => (typeof c?.transform?.transitionSeconds === "number" ? (c.transform.transitionSeconds as number) : undefined);

export function isBlend(kind: unknown): boolean { return typeof kind === "string" && BLENDS.has(kind); }

/** How long clip i blends in over the clip before it (0 for none): the chosen length, at most half of either clip. */
export function blendSeconds(clips: Clip[], i: number): number {
  const clip = clips[i]; const before = clips[i - 1];
  if (!clip || !before || !isBlend(clip.transform?.transitionIn)) return 0;
  const wanted = chosen(clip) ?? BLEND_DEFAULT_SECONDS;
  return Math.max(0, Math.min(wanted, lengthOf(clip) / 2, lengthOf(before) / 2));
}

/** The colour fades inside clip i: in (from its own dip or flash) and out (its explicit ending, or the next clip's dip). */
export function dipFades(clips: Clip[], i: number): { in?: { seconds: number; color: "black" | "white" }; out?: { seconds: number; color: "black" | "white" } } {
  const clip = clips[i]; if (!clip) return {};
  const length = lengthOf(clip);
  const incoming = String(clip.transform?.transitionIn ?? "cut");
  const next = clips[i + 1]; const nextIn = String(next?.transform?.transitionIn ?? "cut");
  const explicit = String(clip.transform?.transitionOut ?? "cut");
  const out: { kind: string; set?: number | undefined } = explicit !== "cut" ? { kind: explicit } : nextIn === "dip-black" || nextIn === "dip-white" ? { kind: nextIn, set: chosen(next) } : { kind: "cut" };
  const side = (kind: string, set: number | undefined) => Math.min(set !== undefined ? (kind === "flash" ? set : set / 2) : DIP_SECONDS[kind]!, length / 3);
  const result: ReturnType<typeof dipFades> = {};
  if (DIP_SECONDS[incoming]) result.in = { seconds: side(incoming, chosen(clip)), color: incoming === "dip-black" ? "black" : "white" };
  if (DIP_SECONDS[out.kind]) result.out = { seconds: side(out.kind, out.set), color: out.kind === "dip-black" ? "black" : "white" };
  return result;
}
