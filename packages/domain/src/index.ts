export type UUID = string;
export type ISODateTime = string;
export type Microseconds = number;

export type MediaKind = "video" | "audio" | "image" | "caption";
export type TrackKind = "video" | "audio" | "overlay" | "caption";

export interface Project {
  id: UUID; ownerId: UUID; name: string; revision: number;
  createdAt: ISODateTime; updatedAt: ISODateTime;
}

export interface Asset {
  id: UUID; projectId: UUID; kind: MediaKind; storageKey: string;
  checksumSha256: string; durationUs?: Microseconds;
  metadata: Record<string, string | number | boolean>; createdAt: ISODateTime;
}

export interface TranscriptWord {
  text: string; startUs: Microseconds; endUs: Microseconds; confidence?: number;
}
export interface TranscriptSegment {
  id: UUID; assetId: UUID; startUs: Microseconds; endUs: Microseconds;
  text: string; words: TranscriptWord[]; provider: string; providerVersion?: string;
}
export interface TimelineClip {
  id: UUID; assetId: UUID; sourceStartUs: Microseconds; sourceEndUs: Microseconds;
  timelineStartUs: Microseconds; timelineEndUs: Microseconds;
  transform?: Record<string, string | number | boolean>;
}
export interface TimelineTrack { id: UUID; kind: TrackKind; clips: TimelineClip[]; }
export interface Timeline { tracks: TimelineTrack[]; durationUs: Microseconds; }

export interface TailoringProfile {
  intent: string; audience: string; channel: string; targetDurationUs?: Microseconds;
  tone?: string; constraints: string[];
}
export interface Evidence {
  source: "user" | "transcript" | "asset-metadata" | "model";
  reference: string; excerpt?: string;
}
export type TimelineOperation =
  | { type: "trim-clip"; clipId: UUID; sourceStartUs: Microseconds; sourceEndUs: Microseconds }
  | { type: "split-clip"; clipId: UUID; atUs: Microseconds }
  | { type: "remove-clip"; clipId: UUID; reason: string }
  | { type: "add-caption"; text: string; atUs: Microseconds; durationUs: Microseconds };

export interface EditingProposal {
  id: UUID; projectId: UUID; baseRevision: number; strategyId: string;
  strategyVersion: string; rationale: string; confidence: number;
  evidence: Evidence[]; operations: TimelineOperation[];
  status: "proposed" | "accepted" | "rejected" | "superseded";
}
export interface ProjectRevision {
  projectId: UUID; revision: number; timeline: Timeline;
  tailoring?: TailoringProfile; acceptedProposalIds: UUID[];
  createdAt: ISODateTime; createdBy: UUID;
}
export interface RenderSettings {
  format: "mp4" | "webm"; videoCodec: string; audioCodec: string;
  width: number; height: number; frameRate: number;
}
export interface RenderJob {
  id: UUID; projectId: UUID; revision: number; settings: RenderSettings;
  idempotencyKey: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
}
export interface FeedbackEvent {
  id: UUID; projectId: UUID; revision: number; strategyId?: string;
  proposalId?: UUID; type: "accepted" | "rejected" | "edited" | "exported" | "shared";
  value?: number; note?: string; createdAt: ISODateTime;
}

export interface TranscriptionPort { transcribe(asset: Asset): Promise<TranscriptSegment[]>; }
export interface IntentAnalysisPort {
  analyze(input: { prompt: string; transcript?: TranscriptSegment[] }): Promise<{
    profile: TailoringProfile; evidence: Evidence[]; provider: string; providerVersion?: string;
  }>;
}
export interface EditingStrategy {
  id: string; version: string;
  propose(input: {
    project: Project; revision: ProjectRevision; profile: TailoringProfile;
    transcript: TranscriptSegment[];
  }): Promise<Omit<EditingProposal, "id" | "projectId" | "baseRevision" | "strategyId" | "strategyVersion">>;
}
export interface StrategyRegistry {
  get(id: string, version?: string): EditingStrategy;
  list(): Array<Pick<EditingStrategy, "id" | "version">>;
}
export interface RendererPort {
  enqueue(input: {
    project: Project; revision: ProjectRevision; settings: RenderSettings; idempotencyKey: string;
  }): Promise<RenderJob>;
}
export interface FeedbackRepository { append(event: FeedbackEvent): Promise<void>; }

export function validateTimeline(timeline: Timeline): void {
  if (!Number.isSafeInteger(timeline.durationUs) || timeline.durationUs < 0) {
    throw new Error("Timeline duration must be a non-negative integer in microseconds");
  }
  for (const track of timeline.tracks) for (const clip of track.clips) {
    if (clip.sourceEndUs <= clip.sourceStartUs) throw new Error("Clip has an invalid source range");
    if (clip.timelineEndUs <= clip.timelineStartUs) throw new Error("Clip has an invalid timeline range");
    if (clip.timelineEndUs > timeline.durationUs) throw new Error("Clip exceeds timeline duration");
  }
}
export function validateProposal(proposal: EditingProposal): void {
  if (proposal.confidence < 0 || proposal.confidence > 1) throw new Error("Proposal confidence must be between 0 and 1");
  if (proposal.evidence.length === 0) throw new Error("Proposal must include evidence");
}
