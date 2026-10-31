import { SOUND_EFFECTS, CLIP_ZOOMS, type TimelineOperation, type SoundEffect, type ClipZoom } from "./index.js";

/** Code-owned recipes: no remote scripts, personal footage, or third-party assets. */
export const EFFECT_PRESETS = [
  { id: "thinking", name: "Thinking equations", tags: ["confusion", "thinking", "playful"], description: "Floating equations for a brief puzzled or calculating moment.", text: "Thinking…", kind: "thinking", color: "#E9F5FF", durationS: 2.5 },
  { id: "realization", name: "Realization pop", tags: ["discovery", "reaction", "playful"], description: "A short callout and a soft pop when an idea clicks.", text: "Aha!", kind: "callout", color: "#637A52", durationS: 2 },
  { id: "key-point", name: "Key point", tags: ["explanation", "emphasis", "clean"], description: "A restrained callout for the words that matter.", text: "Key point", kind: "callout", color: "#395B75", durationS: 3 },
  { id: "focus", name: "Quiet focus", tags: ["motion", "reflective", "cinematic"], description: "A slow push-in across the selected clip for a reflective point.", text: "Focus", kind: "callout", color: "#395B75", durationS: 3 },
  { id: "impact", name: "Impact beat", tags: ["motion", "sound", "emphasis"], description: "A tighter framing on the selected clip and a quiet hit at the chosen moment.", text: "Impact", kind: "callout", color: "#395B75", durationS: 2 },
  { id: "smooth-reveal", name: "Smooth reveal", tags: ["transition", "cinematic", "calm"], description: "A gentle dissolve into the selected clip.", text: "Reveal", kind: "callout", color: "#395B75", durationS: 2 },
  { id: "chapter", name: "Chapter reveal", tags: ["typography", "story", "structure"], description: "An animated title to introduce the next part of the story.", text: "A new chapter", kind: "title", color: "#637A52", durationS: 3 },
  { id: "question", name: "Question beat", tags: ["typography", "curiosity", "explanation"], description: "A short question on screen to invite the viewer to think.", text: "What happens next?", kind: "callout", color: "#395B75", durationS: 3 },
] as const;
export type EffectPresetId = (typeof EFFECT_PRESETS)[number]["id"] | "stock-cutaway";
export interface StockEffectSource { provider: "pexels" | "pixabay"; id: string; kind: "video" | "photo"; mode: "full" | "pip" | "behind"; }
export interface EffectRecipe { presetId: EffectPresetId; text: string; color: string; durationS: number; sound?: SoundEffect | "none"; zoom?: ClipZoom; stock?: StockEffectSource; }
export interface SavedEffect { id: string; recipe: EffectRecipe; updatedAt: string; }
export interface EffectLibraryRepository {
  list(userId: string): Promise<SavedEffect[]>;
  save(userId: string, effect: SavedEffect): Promise<void>;
  remove(userId: string, id: string): Promise<void>;
}
export function parseEffectRecipe(value: unknown): EffectRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a supported effect");
  const r = value as Record<string, unknown>;
  const preset = EFFECT_PRESETS.find(p => p.id === r.presetId) ?? (r.presetId === "stock-cutaway" ? { id: "stock-cutaway" as const, text: "Stock cutaway", color: "#395B75", durationS: 3 } : undefined);
  if (!preset) throw new Error("Unknown effect preset");
  const text = r.text === undefined ? preset.text : r.text;
  const color = r.color === undefined ? preset.color : r.color;
  const durationS = r.durationS === undefined ? preset.durationS : r.durationS;
  if (typeof text !== "string" || !text.trim() || text.trim().length > 80 || /[\x00-\x1f]/.test(text)) throw new Error("Effect text must be 1–80 characters");
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Use a six-digit colour");
  if (typeof durationS !== "number" || !Number.isFinite(durationS) || durationS < 1 || durationS > 6) throw new Error("Effects last 1–6 seconds");
  let stock: StockEffectSource | undefined;
  if (preset.id === "stock-cutaway") {
    const s = r.stock as Record<string, unknown> | undefined;
    if (!s || (s.provider !== "pexels" && s.provider !== "pixabay") || typeof s.id !== "string" || !/^[0-9]{1,20}$/.test(s.id) || (s.kind !== "photo" && s.kind !== "video") || (s.mode !== "full" && s.mode !== "pip" && s.mode !== "behind")) throw new Error("Choose a supported stock item with its provider id");
    stock = { provider: s.provider, id: s.id, kind: s.kind, mode: s.mode };
  }
  const sound = r.sound ?? (preset.id === "realization" ? "pop" : preset.id === "impact" ? "hit" : "none");
  const zoom = r.zoom ?? (preset.id === "focus" ? "push" : preset.id === "impact" ? "punch" : "none");
  if (sound !== "none" && !SOUND_EFFECTS.includes(sound as SoundEffect)) throw new Error("Unknown treatment sound");
  if (!CLIP_ZOOMS.includes(zoom as ClipZoom)) throw new Error("Unknown treatment motion");
  return { ...(stock ? { stock } : {}), sound: sound as SoundEffect | "none", zoom: zoom as ClipZoom, presetId: preset.id, text: text.trim(), color: color.toUpperCase(), durationS: Math.round(durationS * 100) / 100 };
}
export function effectRecipeOperations(recipe: EffectRecipe, anchor: { anchorAssetId: string; anchorClipId?: string; anchorSourceUs: number; importedAssetId?: string }): TimelineOperation[] {
  const r = parseEffectRecipe(recipe), preset = EFFECT_PRESETS.find(p => p.id === r.presetId)!;
  const operations: TimelineOperation[] = [];
  if (r.zoom !== "none" || r.presetId === "smooth-reveal") {
    if (!anchor.anchorClipId) throw new Error("Select a clip for this treatment");
    if (r.zoom && r.zoom !== "none") operations.push({ type: "set-clip-effects", clipId: anchor.anchorClipId, zoom: r.zoom });
    if (r.presetId === "smooth-reveal") operations.push({ type: "set-clip-effects", clipId: anchor.anchorClipId, transitionIn: "dissolve", transitionSeconds: 0.5 });
  }
  if (r.stock) {
    if (!anchor.importedAssetId) throw new Error("Import the stock item into this project first");
    operations.push({ type: "add-broll", assetId: anchor.importedAssetId, anchorAssetId: anchor.anchorAssetId, ...(anchor.anchorClipId ? { anchorClipId: anchor.anchorClipId } : {}), anchorSourceUs: anchor.anchorSourceUs, durationUs: Math.round(r.durationS * 1e6), mode: r.stock.mode });
  } else if (!["focus", "impact", "smooth-reveal"].includes(r.presetId)) operations.push({ type: "add-graphic", kind: preset!.kind, text: r.text, color: r.color, durationUs: Math.round(r.durationS * 1e6), position: "top", ...anchor });
  if (r.sound && r.sound !== "none") operations.push({ type: "add-sfx", kind: r.sound, volumeDb: -24, ...anchor });
  return operations;
}
/** Normalised layout shared by browser and ASS renderer. Equations are decorative, not factual captions. */
export const THINKING_EQUATIONS = [
  { text: "x² + y² = ?", x: 0.22, y: 0.16, delay: 0, angle: -8 },
  { text: "Δ = b² − 4ac", x: 0.73, y: 0.26, delay: 0.12, angle: 6 },
  { text: "∑ x = ?", x: 0.23, y: 0.42, delay: 0.24, angle: -5 },
  { text: "√(a² + b²)", x: 0.74, y: 0.54, delay: 0.34, angle: 8 },
] as const;
