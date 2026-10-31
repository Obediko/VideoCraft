import { THINKING_EQUATIONS } from "@videocraft/domain";
import { assTime, escapeAss } from "./index.js";

export interface GraphicItem { kind: "title" | "callout" | "lower-third" | "thinking"; text: string; subtitle?: string; startUs: number; endUs: number; position?: "top" | "center" | "bottom"; color?: string;
  /** The speaker's face during this graphic (output pixels): the graphic moves so it does not cover it. */
  face?: { x0: number; y0: number; x1: number; y1: number };
  /** The caption band during this graphic, when it differs from the default `avoid` band. */
  avoid?: { topY: number; bottomY: number }; }
export interface ProgressBar { startUs: number; endUs: number; color?: string; }

const DEFAULT_ACCENT = "#F5A524";

/** "#RRGGBB" to ASS "BBGGRR" (alpha separate). Invalid input falls back to the default accent. */
export function assColour(hex: string | undefined): string {
  const value = /^#[0-9a-fA-F]{6}$/.test(hex ?? "") ? hex! : DEFAULT_ACCENT;
  return (value.slice(5, 7) + value.slice(3, 5) + value.slice(1, 3)).toUpperCase();
}

/**
 * Animated motion graphics as an ASS document (rendered by libass in the same FFmpeg pass):
 * title cards and callouts pop in on an accent box, lower thirds slide in from the left with an accent bar,
 * and a progress bar fills across the top over the cut. Drawn above b-roll, beneath captions.
 */
export function renderGraphicsAss(items: GraphicItem[], progress: ProgressBar | undefined, frame: { width: number; height: number }, options: { avoid?: { topY: number; bottomY: number } } = {}): string {
  const { width: W, height: H } = frame;
  const vertical = H > W;
  const base = Math.min(W, H);
  const titleSize = Math.round(base * (vertical ? 0.085 : 0.075));
  const calloutSize = Math.round(titleSize * 0.7);
  const nameSize = Math.round(base * 0.055);
  const roleSize = Math.round(nameSize * 0.72);
  const pad = Math.round(base * 0.025);
  const header = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: " + W, "PlayResY: " + H, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Boxed styles: BorderStyle 3 draws an opaque box in OutlineColour behind the text; it is recoloured per event.
    "Style: Title,DejaVu Sans," + titleSize + ",&H00FFFFFF,&H00FFFFFF,&H00" + assColour(undefined) + ",&H00000000,-1,0,0,0,100,100,0,0,3," + pad + ",0,5,0,0,0,1",
    "Style: Callout,DejaVu Sans," + calloutSize + ",&H00FFFFFF,&H00FFFFFF,&H00" + assColour(undefined) + ",&H00000000,-1,0,0,0,100,100,0,0,3," + Math.round(pad * 0.8) + ",0,5,0,0,0,1",
    "Style: Name,DejaVu Sans," + nameSize + ",&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1," + Math.max(2, Math.round(nameSize * 0.06)) + ",1,1,0,0,0,1",
    "Style: Role,DejaVu Sans," + roleSize + ",&H00F0F0F0,&H00F0F0F0,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1," + Math.max(2, Math.round(roleSize * 0.06)) + ",1,1,0,0,0,1",
    "Style: Shape,DejaVu Sans,10,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const event = (layer: number, startUs: number, endUs: number, style: string, text: string) => "Dialogue: " + layer + "," + assTime(startUs) + "," + assTime(endUs) + "," + style + ",,0,0,0,," + text;
  const lines: string[] = [];

  if (progress && progress.endUs > progress.startUs) {
    const barHeight = Math.max(4, Math.round(H * 0.008));
    const ms = Math.round((progress.endUs - progress.startUs) / 1000);
    lines.push(event(0, progress.startUs, progress.endUs, "Shape", "{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H" + assColour(progress.color) + "&\\fscx0\\t(0," + ms + ",\\fscx100)\\p1}m 0 0 l " + W + " 0 " + W + " " + barHeight + " 0 " + barHeight + "{\\p0}"));
  }

  for (const item of [...items].sort((a, b) => a.startUs - b.startUs)) {
    if (item.endUs <= item.startUs || !item.text.trim()) continue;
    const accent = assColour(item.color);
    const durationMs = Math.round((item.endUs - item.startUs) / 1000);
    const fadeOut = Math.min(250, Math.round(durationMs / 4));
    if (item.kind === "thinking") {
      const size = Math.round(base * 0.047);
      for (const equation of THINKING_EQUATIONS) {
        const start = item.startUs + Math.round(equation.delay * (item.endUs - item.startUs));
        const ms = Math.round((item.endUs - start) / 1000);
        const x = Math.round(W * equation.x), y = Math.round(H * equation.y), drift = Math.round(H * 0.016);
        lines.push(event(2, start, item.endUs, "Name", "{\\an5\\fs" + size + "\\b0\\1c&H" + accent + "&\\frz" + equation.angle + "\\move(" + x + "," + (y + drift) + "," + x + "," + (y - drift) + ",0," + ms + ")\\fad(160,200)}" + escapeAss(equation.text)));
      }
      continue;
    }
    if (item.kind === "lower-third") {
      const margin = Math.round(W * 0.06);
      // Sit just above the caption band when captions are burned in, so the two never overlap.
      const preferred = Math.round(H * (vertical ? 0.66 : 0.8));
      const avoid = item.avoid ?? options.avoid;
      let baseline = avoid && preferred > avoid.topY - pad ? Math.max(Math.round(H * 0.2), avoid.topY - pad) : preferred;
      const barWidth = Math.max(6, Math.round(base * 0.012));
      const blockHeight = nameSize + (item.subtitle ? roleSize + Math.round(pad * 0.4) : 0) + pad;
      // Lower thirds sit at the left; when that would cover the face, move below it (if clear of the captions) or above it.
      const face = item.face;
      const blockRight = margin + barWidth + pad + Math.round(W * 0.55);
      const hits = (b: number) => face !== undefined && b > face.y0 - pad && b - blockHeight < face.y1 + pad && margin < face.x1 && blockRight > face.x0;
      if (hits(baseline)) {
        const below = Math.round(face!.y1 + pad + blockHeight);
        const above = Math.round(face!.y0 - pad);
        if (below <= (avoid ? avoid.topY - pad : H * 0.94)) baseline = below;
        else if (above - blockHeight >= H * 0.06) baseline = above;
      }
      const top = baseline - blockHeight;
      const slide = (from: number, to: number, delay: number) => "\\move(" + from + "," + top + "," + to + "," + top + "," + delay + "," + (delay + 260) + ")";
      lines.push(event(1, item.startUs, item.endUs, "Shape", "{\\an7" + slide(-barWidth, margin, 0) + "\\bord0\\shad0\\1c&H" + accent + "&\\fad(0," + fadeOut + ")\\p1}m 0 0 l " + barWidth + " 0 " + barWidth + " " + blockHeight + " 0 " + blockHeight + "{\\p0}"));
      const textX = margin + barWidth + pad;
      lines.push(event(2, item.startUs, item.endUs, "Name", "{\\an7\\move(" + (-W / 2) + "," + (top + Math.round(pad / 2)) + "," + textX + "," + (top + Math.round(pad / 2)) + ",60,330)\\fad(0," + fadeOut + ")}" + escapeAss(item.text.trim())));
      if (item.subtitle?.trim()) lines.push(event(2, item.startUs, item.endUs, "Role", "{\\an7\\move(" + (-W / 2) + "," + (top + Math.round(pad / 2) + nameSize + Math.round(pad * 0.4)) + "," + textX + "," + (top + Math.round(pad / 2) + nameSize + Math.round(pad * 0.4)) + ",120,390)\\fad(0," + fadeOut + ")}" + escapeAss(item.subtitle.trim())));
      continue;
    }
    const half = Math.round((item.kind === "title" ? titleSize * (item.subtitle ? 1.9 : 1.2) : calloutSize * 1.2) / 2) + pad;
    const avoid = item.avoid ?? options.avoid;
    const slots = { top: Math.round(H * 0.18), center: Math.round(H * 0.42), bottom: Math.round(H * (vertical ? 0.64 : 0.74)) };
    const wanted = item.position ?? "center";
    const inBand = (y: number) => avoid !== undefined && y + half > avoid.topY && y - half < avoid.bottomY;
    const onFace = (y: number) => item.face !== undefined && y + half > item.face.y0 && y - half < item.face.y1;
    // The chosen position first; if it covers the face or the captions, the nearest other slot that covers neither.
    const order = wanted === "top" ? ["top", "center", "bottom"] : wanted === "bottom" ? ["bottom", "center", "top"] : ["center", "top", "bottom"];
    const clear = order.map((key) => slots[key as keyof typeof slots]).find((y) => !inBand(y) && !onFace(y));
    let y = clear ?? slots[wanted];
    // Keep text graphics out of the caption band: move above it when they would overlap.
    if (clear === undefined && avoid && inBand(y)) y = Math.max(half, avoid.topY - half);
    const style = item.kind === "title" ? "Title" : "Callout";
    // Pop: scale up from 70% with a quick fade in, then fade out at the end.
    const pop = "\\fscx70\\fscy70\\t(0,220,\\fscx100\\fscy100)\\fad(160," + fadeOut + ")";
    lines.push(event(2, item.startUs, item.endUs, style, "{\\an5\\pos(" + Math.round(W / 2) + "," + y + ")\\3c&H" + accent + "&" + pop + "}" + escapeAss(item.text.trim()) + (item.kind === "title" && item.subtitle?.trim() ? "\\N{\\fs" + Math.round(titleSize * 0.55) + "\\b0}" + escapeAss(item.subtitle.trim()) : "")));
  }
  return [...header, ...lines, ""].join("\n");
}
