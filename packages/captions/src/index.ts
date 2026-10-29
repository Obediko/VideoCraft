import type { Microseconds, TimelineOperation, TranscriptWord } from "@videocraft/domain";

export interface CueOptions {
  maxWords?: number;
  maxChars?: number;
  /** A pause at least this long always starts a new cue. */
  breakGapUs?: Microseconds;
  maxDurationUs?: Microseconds;
  /** Only words inside these source ranges are captioned (e.g. the clips that survived editing). */
  ranges?: Array<{ startUs: Microseconds; endUs: Microseconds }>;
}

export interface CaptionCue {
  startUs: Microseconds;
  endUs: Microseconds;
  text: string;
  words: Array<{ text: string; startUs: Microseconds; endUs: Microseconds }>;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;
const SOFT_BREAK = /[,;:–—]["')\]]*$/;

/** Groups transcribed words into short, readable caption cues. */
export function buildCues(words: TranscriptWord[], options: CueOptions = {}): CaptionCue[] {
  const maxWords = options.maxWords ?? 4;
  const maxChars = options.maxChars ?? 26;
  const breakGap = options.breakGapUs ?? 500_000;
  const maxDuration = options.maxDurationUs ?? 3_200_000;
  const ranges = options.ranges;
  const inRange = (word: TranscriptWord) => !ranges || ranges.some((range) => word.startUs >= range.startUs && word.endUs <= range.endUs);

  const cleaned = words
    .map((word) => ({ ...word, text: word.text.trim() }))
    .filter((word) => word.text.length > 0 && word.endUs > word.startUs && inRange(word))
    .sort((a, b) => a.startUs - b.startUs);

  const cues: CaptionCue[] = [];
  let current: CaptionCue["words"] = [];
  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last) cues.push({ startUs: first.startUs, endUs: last.endUs, text: current.map((word) => word.text).join(" "), words: current });
    current = [];
  };

  for (const word of cleaned) {
    const previous = current[current.length - 1];
    if (previous) {
      const chars = current.reduce((total, entry) => total + entry.text.length + 1, 0) + word.text.length;
      const crossesRange = ranges !== undefined && !ranges.some((range) => previous.startUs >= range.startUs && word.endUs <= range.endUs);
      if (word.startUs - previous.endUs >= breakGap || crossesRange || current.length >= maxWords || chars > maxChars || word.endUs - (current[0]?.startUs ?? word.startUs) > maxDuration) flush();
    }
    current.push({ text: word.text, startUs: word.startUs, endUs: word.endUs });
    if (SENTENCE_END.test(word.text) || (SOFT_BREAK.test(word.text) && current.length >= 2)) flush();
  }
  flush();
  return cues;
}

/** Caption operations bound to source time, so they follow clips through later edits. */
export function cueOperations(assetId: string, cues: CaptionCue[]): TimelineOperation[] {
  return cues.map((cue) => ({
    type: "add-caption-cue" as const,
    assetId,
    sourceStartUs: cue.startUs,
    sourceEndUs: cue.endUs,
    text: cue.text,
    wordDurationsCs: wordDurationsCs(cue),
  }));
}

/** Per-word durations in centiseconds that exactly cover the cue. */
export function wordDurationsCs(cue: CaptionCue): number[] {
  const total = Math.max(1, Math.round((cue.endUs - cue.startUs) / 10_000));
  const durations = cue.words.map((word, index) => {
    const next = cue.words[index + 1];
    const end = next ? next.startUs : cue.endUs;
    return Math.max(1, Math.round((end - word.startUs) / 10_000));
  });
  const drift = total - durations.reduce((sum, value) => sum + value, 0);
  const last = durations.length - 1;
  if (last >= 0) durations[last] = Math.max(1, (durations[last] ?? 1) + drift);
  return durations;
}

export interface CaptionStyle {
  id: string;
  fontName: string;
  /** Font size as a fraction of the frame height. */
  sizeRatio: number;
  bold: boolean;
  uppercase: boolean;
  /** ASS colours are BGR hex, e.g. "FFFFFF". */
  textColor: string;
  activeColor?: string;
  outlineColor: string;
  outlineRatio: number;
  shadow: number;
  boxed: boolean;
  /** Vertical anchor as a fraction of the frame height measured from the bottom. */
  bottomRatio: number;
  popActiveWord: boolean;
}

export const CAPTION_STYLES: Record<string, CaptionStyle> = {
  "bold-pop": { id: "bold-pop", fontName: "DejaVu Sans", sizeRatio: 0.052, bold: true, uppercase: true, textColor: "FFFFFF", activeColor: "00D7FF", outlineColor: "000000", outlineRatio: 0.0075, shadow: 2, boxed: false, bottomRatio: 0.3, popActiveWord: true },
  clean: { id: "clean", fontName: "DejaVu Sans", sizeRatio: 0.042, bold: true, uppercase: false, textColor: "FFFFFF", outlineColor: "000000", outlineRatio: 0.012, shadow: 0, boxed: true, bottomRatio: 0.12, popActiveWord: false },
  minimal: { id: "minimal", fontName: "DejaVu Sans", sizeRatio: 0.036, bold: false, uppercase: false, textColor: "F2F2F2", outlineColor: "000000", outlineRatio: 0.006, shadow: 1, boxed: false, bottomRatio: 0.09, popActiveWord: false },
};

export function resolveCaptionStyle(id: string | undefined): CaptionStyle | undefined {
  if (id === "none") return undefined;
  return CAPTION_STYLES[id ?? "bold-pop"] ?? CAPTION_STYLES["bold-pop"];
}

export interface TimedCue { startUs: Microseconds; endUs: Microseconds; text: string; wordDurationsCs?: number[]; /** Distance from the bottom in pixels, overriding the style (used to keep captions off a face). */ marginV?: number; }

/** Renders cues positioned on the output timeline to an Advanced SubStation Alpha document. */
export function renderAss(cues: TimedCue[], style: CaptionStyle, frame: { width: number; height: number }): string {
  const fontSize = Math.max(12, Math.round(frame.height * style.sizeRatio));
  const outline = Math.max(1, Math.round(frame.height * style.outlineRatio));
  const marginV = Math.round(frame.height * style.bottomRatio);
  const marginH = Math.round(frame.width * 0.06);
  const active = style.activeColor;
  const borderStyle = style.boxed ? 3 : 1;
  const backColour = style.boxed ? "&H99000000" : "&H64000000";
  const header = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: " + frame.width, "PlayResY: " + frame.height, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default," + style.fontName + "," + fontSize + ",&H00" + style.textColor + ",&H00" + style.textColor + ",&H00" + style.outlineColor + "," + backColour + "," + (style.bold ? -1 : 0) + ",0,0,0,100,100,0,0," + borderStyle + "," + outline + "," + style.shadow + ",2," + marginH + "," + marginH + "," + marginV + ",1",
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines: string[] = [];
  for (const cue of [...cues].sort((a, b) => a.startUs - b.startUs)) {
    if (cue.endUs <= cue.startUs) continue;
    const words = cue.text.trim().split(/\s+/).filter(Boolean).map((word) => (style.uppercase ? word.toUpperCase() : word));
    if (words.length === 0) continue;
    const timings = cue.wordDurationsCs && cue.wordDurationsCs.length === words.length ? cue.wordDurationsCs : undefined;
    if (!active || !timings) {
      lines.push(event(cue.startUs, cue.endUs, words.map(escapeAss).join(" "), cue.marginV));
      continue;
    }
    // One event per spoken word, with the active word recoloured (and optionally popped).
    let cursor = cue.startUs;
    const totalCs = timings.reduce((sum, value) => sum + value, 0);
    const scale = (cue.endUs - cue.startUs) / (totalCs * 10_000);
    words.forEach((_, index) => {
      const length = Math.round((timings[index] ?? 1) * 10_000 * scale);
      const end = index === words.length - 1 ? cue.endUs : Math.min(cue.endUs, cursor + length);
      const text = words.map((word, wordIndex) => {
        const safe = escapeAss(word);
        if (wordIndex !== index) return safe;
        const pop = style.popActiveWord ? "\\fscx112\\fscy112\\t(0,90,\\fscx100\\fscy100)" : "";
        return "{\\c&H" + active + "&" + pop + "}" + safe + "{\\c&H" + style.textColor + "&}";
      }).join(" ");
      if (end > cursor) lines.push(event(cursor, end, text, cue.marginV));
      cursor = end;
    });
  }
  return header.concat(lines).join("\n") + "\n";
}

function event(startUs: number, endUs: number, text: string, marginV?: number): string {
  // An event MarginV of 0 means "use the style's"; any other value moves this caption.
  const margin = marginV !== undefined && Number.isFinite(marginV) ? Math.max(1, Math.round(marginV)) : 0;
  return "Dialogue: 0," + assTime(startUs) + "," + assTime(endUs) + ",Default,,0,0," + margin + ",," + text;
}

export function assTime(us: number): string {
  const cs = Math.max(0, Math.round(us / 10_000));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(cs % 100).padStart(2, "0");
}

export function escapeAss(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/[\r\n]+/g, " ");
}
export * from "./graphics.js";
export * from "./placement.js";

/** The vertical band (in pixels) captions of this style can occupy, assuming up to `lines` lines. */
export function captionBand(style: CaptionStyle, height: number, lines = 3): { topY: number; bottomY: number } {
  const fontSize = Math.max(12, Math.round(height * style.sizeRatio));
  const bottomY = Math.round(height * (1 - style.bottomRatio));
  return { topY: Math.max(0, bottomY - Math.round(lines * fontSize * 1.25)), bottomY };
}
