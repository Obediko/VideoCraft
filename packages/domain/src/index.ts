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
  | { type: "add-graphic"; kind: "title" | "callout" | "lower-third"; text: string; subtitle?: string; anchorAssetId: UUID; anchorSourceUs: Microseconds; durationUs: Microseconds; position?: "top" | "center" | "bottom"; color?: string }
  | { type: "update-graphic"; clipId: string; text?: string; subtitle?: string; color?: string }
  /** A bar filling across the top of the frame over the whole cut. */
  | { type: "set-progress-bar"; enabled: boolean; color?: string }
  | { type: "add-broll"; assetId: UUID; anchorAssetId: UUID; anchorSourceUs: Microseconds; durationUs: Microseconds; sourceStartUs?: Microseconds; mode?: "full" | "pip" | "behind" }
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
  /** One colour look on every video clip ("none" clears). */
  | { type: "set-look"; look: ColourLook }
  /** A short generated sound effect anchored to a moment of a source video, like graphics. */
  | { type: "add-sfx"; kind: SoundEffect; anchorAssetId: UUID; anchorSourceUs: Microseconds; volumeDb?: number }
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
  | { type: "add-voiceover"; assetId: UUID; anchorAssetId: UUID; anchorSourceUs: Microseconds; durationUs: Microseconds; volumeDb?: number; duck?: boolean }
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
export const CLIP_ZOOMS = ["none", "punch", "push"] as const;
export type ClipZoom = (typeof CLIP_ZOOMS)[number];
export const COLOUR_LOOKS = ["none", "warm", "clean", "cinematic", "vivid", "soft", "mono"] as const;
export type ColourLook = (typeof COLOUR_LOOKS)[number];
/**
 * How a clip comes in. Dips and the flash fade through a colour; the others blend the two clips over each other
 * (dissolve, push, slide-up, wipe, circle, blur), using a little footage past the cut so the timing never shifts.
 */
export const TRANSITIONS = ["cut", "dip-black", "dip-white", "flash", "dissolve", "push", "slide-up", "wipe", "circle", "blur"] as const;
/** Transitions that overlap the two clips (the rest fade through a colour). */
export const BLEND_TRANSITIONS = ["dissolve", "push", "slide-up", "wipe", "circle", "blur"] as const;
export type Transition = (typeof TRANSITIONS)[number];
export const SOUND_EFFECTS = ["whoosh", "pop", "hit", "riser"] as const;
export type SoundEffect = (typeof SOUND_EFFECTS)[number];
export interface TimelineSignals { silences?: Array<{ startUs: Microseconds; endUs: Microseconds }>; scenes?: Array<{ startUs: Microseconds; endUs: Microseconds }>; }
export interface EditingProposal { id: UUID; projectId: UUID; baseRevision: number; strategyId: string; strategyVersion: string; rationale: string; confidence: number; evidence: Evidence[]; operations: TimelineOperation[]; status: "proposed" | "accepted" | "rejected" | "superseded"; }
export interface ProjectRevision { projectId: UUID; revision: number; timeline: Timeline; tailoring?: TailoringProfile; acceptedProposalIds: UUID[]; createdAt: ISODateTime; createdBy: UUID; }
export interface RenderSettings { format: "mp4" | "webm"; videoCodec: string; audioCodec: string; width: number; height: number; frameRate: number; /** "cover" fills the frame by cropping (e.g. 9:16 from 16:9); "contain" letterboxes. Default "contain". */ fit?: "contain" | "cover"; /** Caption style preset id; captions are omitted when "none". */ captionStyle?: string; /** Normalise embedded audio loudness (default true). */ normalizeLoudness?: boolean; /** Integrated loudness target in LUFS (default -16). */ loudnessLufs?: number; }
export interface RenderOutput { storageKey: string; checksumSha256: string; sizeBytes: number; mimeType: string; }
export interface RenderJob { id: UUID; projectId: UUID; revision: number; settings: RenderSettings; idempotencyKey: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; progress: number; errorMessage?: string; output?: RenderOutput; }
export interface FeedbackEvent { id: UUID; projectId: UUID; revision: number; strategyId?: string; proposalId?: UUID; type: "accepted" | "rejected" | "edited" | "exported" | "shared"; value?: number; note?: string; createdAt: ISODateTime; }
export interface TranscriptionPort { transcribe(asset: Asset): Promise<TranscriptSegment[]>; }
export interface IntentAnalysisPort { analyze(input: { prompt: string; transcript?: TranscriptSegment[] }): Promise<{ profile: TailoringProfile; evidence: Evidence[]; provider: string; providerVersion?: string; }>; }
export interface EditingStrategy { id: string; version: string; propose(input: { project: Project; revision: ProjectRevision; profile: TailoringProfile; transcript: TranscriptSegment[]; signals?: TimelineSignals; /** Weight multipliers learned from this person's past edits. */ learned?: import("./learning.js").LearnedPreferences; }): Promise<Omit<EditingProposal, "id" | "projectId" | "baseRevision" | "strategyId" | "strategyVersion">>; }
export interface StrategyRegistry { get(id: string, version?: string): EditingStrategy; list(): Array<Pick<EditingStrategy, "id" | "version">>; }
export interface RendererPort { enqueue(input: { project: Project; revision: ProjectRevision; settings: RenderSettings; idempotencyKey: string; }): Promise<RenderJob>; }
export interface RenderJobRepository { get(id: UUID): Promise<RenderJob | undefined>; save(job: RenderJob): Promise<void>; update(job: RenderJob): Promise<void>; }
export interface FeedbackRepository { append(event: FeedbackEvent): Promise<void>; }
export function validateTimeline(timeline: Timeline): void { if (!Number.isSafeInteger(timeline.durationUs) || timeline.durationUs < 0) throw new Error("Timeline duration must be a non-negative integer in microseconds"); for (const track of timeline.tracks) for (const clip of track.clips) { if (clip.sourceEndUs <= clip.sourceStartUs) throw new Error("Clip has an invalid source range"); if (clip.timelineEndUs <= clip.timelineStartUs) throw new Error("Clip has an invalid timeline range"); if (clip.timelineEndUs > timeline.durationUs) throw new Error("Clip exceeds timeline duration"); } }
export function validateProposal(proposal: EditingProposal): void { if (proposal.confidence < 0 || proposal.confidence > 1) throw new Error("Proposal confidence must be between 0 and 1"); if (proposal.evidence.length === 0) throw new Error("Proposal must include evidence"); }

export * from "./timeline.js";
export * from "./learning.js";
export * from "./transitions.js";
