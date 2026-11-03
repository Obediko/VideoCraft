export type UUID = string;
export type ISODateTime = string;
export type Microseconds = number;
export type MediaKind = "video" | "audio" | "image" | "caption";
export type TrackKind = "video" | "audio" | "overlay" | "caption";
export interface Project { id: UUID; ownerId: UUID; name: string; revision: number; createdAt: ISODateTime; updatedAt: ISODateTime; }
export interface Asset { id: UUID; projectId: UUID; kind: MediaKind; storageKey: string; checksumSha256: string; durationUs?: Microseconds; metadata: Record<string, string | number | boolean>; createdAt: ISODateTime; }
export interface TranscriptWord { text: string; startUs: Microseconds; endUs: Microseconds; confidence?: number; }
export interface TranscriptSegment { id: UUID; assetId: UUID; startUs: Microseconds; endUs: Microseconds; text: string; words: TranscriptWord[]; provider: string; providerVersion?: string; }
export interface TimelineClip { id: UUID; assetId: UUID; sourceStartUs: Microseconds; sourceEndUs: Microseconds; timelineStartUs: Microseconds; timelineEndUs: Microseconds; transform?: Record<string, string | number | boolean>; /** Why an automated strategy chose this clip. */ reason?: string; /** Strategy score in [0,1], higher is better. */ score?: number; /** Feature scores behind the choice (0..1 each); used to learn from what the person keeps or removes. */ features?: Record<string, number>; }
export interface TimelineTrack { id: UUID; kind: TrackKind; clips: TimelineClip[]; }
export interface Timeline { tracks: TimelineTrack[]; durationUs: Microseconds; }
export interface TailoringProfile { intent: string; audience: string; channel: string; targetDurationUs?: Microseconds; tone?: string; constraints: string[]; }
export interface Evidence { source: "user" | "transcript" | "asset-metadata" | "model"; reference: string; excerpt?: string; /** Source-media start of the evidenced span. */ startUs?: Microseconds; /** Source-media end of the evidenced span. */ endUs?: Microseconds; }
export type TimelineOperation =
  | { type: "trim-clip"; clipId: UUID; sourceStartUs: Microseconds; sourceEndUs: Microseconds }
  | { type: "split-clip"; clipId: UUID; atUs: Microseconds }
  | { type: "remove-clip"; clipId: UUID; reason: string }
  | { type: "add-caption"; text: string; atUs: Microseconds; durationUs: Microseconds }
  /** Background music under the whole cut (looped, faded, ducked under speech unless duck is false). */
  | { type: "set-music"; assetId: UUID; sourceStartUs?: Microseconds; volumeDb?: number; duck?: boolean }
  | { type: "clear-music" }
  /**
   * B-roll over the main video, anchored to a moment of a source video (anchorAssetId at anchorSourceUs)
   * so it moves with that moment through cuts and reorders. "full" covers the frame, "pip" is a corner inset.
   */
  /** Animated text graphics anchored to a moment like b-roll: a title card, a callout, or a lower third (name + role). */
  | { type: "add-graphic"; kind: "title" | "callout" | "lower-third" | "thinking"; text: string; subtitle?: string; anchorAssetId: UUID; anchorClipId?: UUID; anchorSourceUs: Microseconds; durationUs: Microseconds; position?: "top" | "center" | "bottom"; color?: string }
  | { type: "update-graphic"; clipId: string; text?: string; subtitle?: string; color?: string }
  /** A bar filling across the top of the frame over the whole cut. */
  | { type: "set-progress-bar"; enabled: boolean; color?: string }
  | { type: "add-broll"; assetId: UUID; anchorAssetId: UUID; anchorClipId?: UUID; anchorSourceUs: Microseconds; durationUs: Microseconds; sourceStartUs?: Microseconds; mode?: "full" | "pip" | "behind" }
  /** Append (or insert at `index`) a segment of a source asset on the video track. */
  | { type: "insert-clip"; assetId: UUID; sourceStartUs: Microseconds; sourceEndUs: Microseconds; reason: string; score?: number; features?: Record<string, number>; index?: number }
  /** Reorder the video track; `clipIds` must list every video clip exactly once. */
  | { type: "reorder-clips"; clipIds: UUID[] }
  /** Caption cue bound to source-media time so it follows the clip when the timeline is edited. */
  | { type: "add-caption-cue"; assetId: UUID; sourceStartUs: Microseconds; sourceEndUs: Microseconds; text: string; wordDurationsCs?: number[] }
  /** Correct the text of an existing caption cue. */
  | { type: "update-caption"; clipId: UUID; text: string }
  /**
   * Effects on one video clip: a zoom ("punch" = a tighter framing for the whole clip, the classic jump-cut
   * punch-in; "push" = a slow push-in), a colour look, and how it enters / leaves (a transition at the cut).
   * Fields left out are unchanged; "none" / "cut" clears.
   */
  | { type: "set-clip-effects"; clipId: UUID; zoom?: ClipZoom; look?: ColourLook; transitionIn?: Transition; transitionOut?: Transition; transitionSeconds?: number }
  /** Precise, non-destructive primary colour correction for one shot. Zero/one values clear back to neutral. */
  | { type: "set-colour-grade"; clipId: UUID; exposure?: number; contrast?: number; saturation?: number; temperature?: number }
  /** Dialogue cleanup on the source sound carried by one video clip. */
  | { type: "set-dialogue-finish"; clipId: UUID; denoise?: boolean; voiceEnhance?: boolean; deEss?: boolean }
  /** Switch one timeline piece to a synchronized camera source without moving the edit. */
  | { type: "switch-camera"; clipId: UUID; assetId: UUID; sourceStartUs: Microseconds; sourceEndUs: Microseconds; camera?: string }
  /** One colour look on every video clip ("none" clears). */
  | { type: "set-look"; look: ColourLook }
  /** A short generated sound effect anchored to a moment of a source video, like graphics. */
  | { type: "add-sfx"; kind: SoundEffect; anchorAssetId: UUID; anchorClipId?: UUID; anchorSourceUs: Microseconds; volumeDb?: number }
  /**
   * What is behind the person in a video clip (all video clips when clipId is left out): the original ("none"),
   * the original blurred, a solid colour, or a photo / video asset. The person is cut out by a matte;
   * edge (-8..8 px) grows or shrinks the cut-out and feather (0..12 px) softens it.
   */
  /**
   * Narration over the edit: an audio asset (a recording or a generated voice) that starts at a moment of a source
   * video and follows the cut like graphics. While it plays the original sound is lowered (duck, on by default).
   */
  /**
   * Loudness of sound on the audio track, in dB: one clip (clipId), or every clip of a kind (role: the music bed,
   * all sound effects or all voice-overs).
   */
  | { type: "set-volume"; clipId?: UUID; role?: "music" | "sfx" | "voiceover"; volumeDb: number }
  | { type: "add-voiceover"; assetId: UUID; anchorAssetId: UUID; anchorClipId?: UUID; anchorSourceUs: Microseconds; durationUs: Microseconds; volumeDb?: number; duck?: boolean }
  | { type: "set-background"; clipId?: UUID; background: Background; color?: string; assetId?: UUID; edge?: number; feather?: number };
export const BACKGROUNDS = ["none", "blur", "color", "media"] as const;
export type Background = (typeof BACKGROUNDS)[number];
/** Every asset a timeline needs to render: clips plus the backgrounds set on them. */
export function assetsUsedBy(timeline: Timeline): Set<UUID> {
  const used = new Set<UUID>();
  for (const track of timeline.tracks) for (const clip of track.clips) {
    used.add(clip.assetId);
    if (typeof clip.transform?.backgroundAssetId === "string") used.add(clip.transform.backgroundAssetId);
  }
  return used;
}
export const CLIP_ZOOMS = ["none", "punch", "push", "gentle-push", "pull-back", "drift-left", "drift-right"] as const;
export type ClipZoom = (typeof CLIP_ZOOMS)[number];
export const COLOUR_LOOKS = ["none", "warm", "clean", "cinematic", "vivid", "soft", "mono", "golden-hour", "editorial", "heritage", "noir"] as const;
export type ColourLook = (typeof COLOUR_LOOKS)[number];
export const MOTION_CATALOGUE: Record<ClipZoom, { label: string; premium?: boolean; use: string }> = {
  none: { label: "Static", use: "Let an already strong frame breathe." },
  punch: { label: "Punch in", use: "A short emphatic beat." },
  push: { label: "Slow push-in", use: "Sustained focus or growing emotional attention." },
  "gentle-push": { label: "Gentle push", premium: true, use: "Quiet documentary attention without obvious motion." },
  "pull-back": { label: "Pull back", premium: true, use: "Reveal context or create a reflective release." },
  "drift-left": { label: "Drift left", premium: true, use: "A restrained still-image move toward subject matter on the right." },
  "drift-right": { label: "Drift right", premium: true, use: "A restrained still-image move toward subject matter on the left." },
};
export const LOOK_CATALOGUE: Record<ColourLook, { label: string; premium?: boolean; use: string }> = {
  none: { label: "Natural", use: "Preserve the source colour." }, warm: { label: "Warm", use: "Friendly human stories." },
  clean: { label: "Clean & crisp", use: "Clear modern explainers." }, cinematic: { label: "Cinematic", use: "Controlled contrast and subdued colour." },
  vivid: { label: "Vivid", use: "Energetic colour." }, soft: { label: "Soft", use: "Gentle portraits." }, mono: { label: "Black & white", use: "Graphic monochrome." },
  "golden-hour": { label: "Golden hour", premium: true, use: "Warm hopeful people and place." },
  editorial: { label: "Editorial", premium: true, use: "Polished neutral documentary colour." },
  heritage: { label: "Heritage", premium: true, use: "Reflective history with restrained saturation." },
  noir: { label: "Noir", premium: true, use: "High-contrast monochrome for serious dramatic material." },
};
/**
 * How a clip comes in. Dips and the flash fade through a colour; the others blend the two clips over each other
 * (including the standard and premium catalogue), using a little footage past the cut so the timing never shifts.
 */
export const TRANSITIONS = ["cut", "dip-black", "dip-white", "flash", "dissolve", "push", "slide-up", "wipe", "circle", "blur", "soft-pan", "soft-rise", "match-push", "film-fade", "silver-fade", "editorial-cover"] as const;
/** Transitions that overlap the two clips (the rest fade through a colour). */
export const BLEND_TRANSITIONS = ["dissolve", "push", "slide-up", "wipe", "circle", "blur", "soft-pan", "soft-rise", "match-push", "film-fade", "silver-fade", "editorial-cover"] as const;
export type Transition = (typeof TRANSITIONS)[number];
export const TRANSITION_CATALOGUE: Record<Transition, { label: string; family: "cut" | "dip" | "blend"; premium?: boolean; use: string }> = {
  cut: { label: "Cut", family: "cut", use: "Default; invisible and honest." },
  "dip-black": { label: "Dip to black", family: "dip", use: "A chapter, ending or serious passage." },
  "dip-white": { label: "Dip to white", family: "dip", use: "A light or hopeful passage." },
  flash: { label: "Flash", family: "dip", use: "A very brief energetic accent." },
  dissolve: { label: "Dissolve", family: "blend", use: "A calm change of time, place or feeling." },
  push: { label: "Push", family: "blend", use: "Energetic lateral movement." },
  "slide-up": { label: "Slide up", family: "blend", use: "Vertical short-form movement." },
  wipe: { label: "Wipe", family: "blend", use: "A clear graphic reveal." },
  circle: { label: "Circle reveal", family: "blend", use: "A playful iris reveal." },
  blur: { label: "Blur", family: "blend", use: "A soft dreamlike change." },
  "soft-pan": { label: "Soft pan", family: "blend", premium: true, use: "A restrained directional scene change." },
  "soft-rise": { label: "Soft rise", family: "blend", premium: true, use: "A gentle upward reveal for progress or arrival." },
  "match-push": { label: "Match push", family: "blend", premium: true, use: "Aligned then-and-now or detail-to-detail imagery." },
  "film-fade": { label: "Film fade", family: "blend", premium: true, use: "A slower, softer passage of time." },
  "silver-fade": { label: "Silver fade", family: "blend", premium: true, use: "A reflective archival or memory beat." },
  "editorial-cover": { label: "Editorial cover", family: "blend", premium: true, use: "A confident chapter change with matched movement." },
};
export const SOUND_EFFECTS = ["whoosh", "pop", "hit", "riser"] as const;
export type SoundEffect = (typeof SOUND_EFFECTS)[number];
export interface TimelineSignals { silences?: Array<{ startUs: Microseconds; endUs: Microseconds }>; scenes?: Array<{ startUs: Microseconds; endUs: Microseconds }>; }
export interface EditingProposal { id: UUID; projectId: UUID; baseRevision: number; strategyId: string; strategyVersion: string; rationale: string; confidence: number; evidence: Evidence[]; operations: TimelineOperation[]; status: "proposed" | "accepted" | "rejected" | "superseded"; }
export interface ProjectRevision { projectId: UUID; revision: number; timeline: Timeline; tailoring?: TailoringProfile; acceptedProposalIds: UUID[]; createdAt: ISODateTime; createdBy: UUID; }
export interface RenderSettings { format: "mp4" | "webm"; videoCodec: string; audioCodec: string; width: number; height: number; frameRate: number; /** "cover" fills the frame by cropping (e.g. 9:16 from 16:9); "contain" letterboxes. Default "contain". */ fit?: "contain" | "cover"; /** Caption style preset id; captions are omitted when "none". */ captionStyle?: string; /** Normalise embedded audio loudness (default true). */ normalizeLoudness?: boolean; /** Integrated loudness target in LUFS (default -16). */ loudnessLufs?: number; }
export interface RenderOutput { storageKey: string; checksumSha256: string; sizeBytes: number; mimeType: string; }
export interface RenderJob { createdAt?: string; id: UUID; projectId: UUID; revision: number; settings: RenderSettings; idempotencyKey: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; progress: number; errorMessage?: string; output?: RenderOutput; }
export interface FeedbackEvent { id: UUID; projectId: UUID; revision: number; strategyId?: string; proposalId?: UUID; type: "accepted" | "rejected" | "edited" | "exported" | "shared"; value?: number; note?: string; createdAt: ISODateTime; }
export interface TranscriptionPort { transcribe(asset: Asset): Promise<TranscriptSegment[]>; }
export interface IntentAnalysisPort { analyze(input: { prompt: string; transcript?: TranscriptSegment[] }): Promise<{ profile: TailoringProfile; evidence: Evidence[]; provider: string; providerVersion?: string; }>; }
export interface EditingStrategy { id: string; version: string; propose(input: { project: Project; revision: ProjectRevision; profile: TailoringProfile; transcript: TranscriptSegment[]; signals?: TimelineSignals; /** Weight multipliers learned from this person's past edits. */ learned?: import("./learning.js").LearnedPreferences; }): Promise<Omit<EditingProposal, "id" | "projectId" | "baseRevision" | "strategyId" | "strategyVersion">>; }
export interface StrategyRegistry { get(id: string, version?: string): EditingStrategy; list(): Array<Pick<EditingStrategy, "id" | "version">>; }
export interface RendererPort { enqueue(input: { project: Project; revision: ProjectRevision; settings: RenderSettings; idempotencyKey: string; }): Promise<RenderJob>; }
export interface RenderJobRepository { listForProject?(projectId: UUID, limit?: number): Promise<RenderJob[]>; get(id: UUID): Promise<RenderJob | undefined>; save(job: RenderJob): Promise<void>; update(job: RenderJob): Promise<void>; }
export interface FeedbackRepository { append(event: FeedbackEvent): Promise<void>; }
export function validateTimeline(timeline: Timeline): void { if (!Number.isSafeInteger(timeline.durationUs) || timeline.durationUs < 0) throw new Error("Timeline duration must be a non-negative integer in microseconds"); for (const track of timeline.tracks) for (const clip of track.clips) { if (clip.sourceEndUs <= clip.sourceStartUs) throw new Error("Clip has an invalid source range"); if (clip.timelineEndUs <= clip.timelineStartUs) throw new Error("Clip has an invalid timeline range"); if (clip.timelineEndUs > timeline.durationUs) throw new Error("Clip exceeds timeline duration"); } }
export function validateProposal(proposal: EditingProposal): void { if (proposal.confidence < 0 || proposal.confidence > 1) throw new Error("Proposal confidence must be between 0 and 1"); if (proposal.evidence.length === 0) throw new Error("Proposal must include evidence"); }

export * from "./timeline.js";
export * from "./learning.js";
export * from "./transitions.js";

export * from "./effects.js";
