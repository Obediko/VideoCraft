import type {
  EditingProposal,
  EditingStrategy,
  Evidence,
  Project,
  ProjectRevision,
  TailoringProfile,
  TimelineOperation,
  TranscriptSegment,
} from "@videocraft/domain";

export class ShortFormExplainerStrategy implements EditingStrategy {
  readonly id = "short-form-explainer";
  readonly version = "1.0.0";

  async propose(input: {
    project: Project;
    revision: ProjectRevision;
    profile: TailoringProfile;
    transcript: TranscriptSegment[];
  }): Promise<Omit<EditingProposal, "id" | "projectId" | "baseRevision" | "strategyId" | "strategyVersion">> {
    const firstSegment = input.transcript[0];
    const videoTrack = input.revision.timeline.tracks.find((track) => track.kind === "video");
    const firstClip = videoTrack?.clips[0];
    const evidence: Evidence[] = [
      { source: "user", reference: "tailoring-profile.intent", excerpt: input.profile.intent.slice(0, 240) },
      { source: "user", reference: "tailoring-profile.audience", excerpt: input.profile.audience.slice(0, 240) },
      { source: "user", reference: "tailoring-profile.channel", excerpt: input.profile.channel.slice(0, 120) },
    ];
    if (firstSegment) {
      evidence.push({ source: "transcript", reference: firstSegment.id, excerpt: firstSegment.text.slice(0, 240) });
    }

    const operations: TimelineOperation[] = [];
    const targetDurationUs = input.profile.targetDurationUs;
    if (firstClip && targetDurationUs !== undefined && targetDurationUs > 0 && input.revision.timeline.durationUs > targetDurationUs) {
      const sourceDurationUs = firstClip.sourceEndUs - firstClip.sourceStartUs;
      const trimDurationUs = Math.min(sourceDurationUs, targetDurationUs);
      if (trimDurationUs < sourceDurationUs) {
        operations.push({
          type: "trim-clip",
          clipId: firstClip.id,
          sourceStartUs: firstClip.sourceStartUs,
          sourceEndUs: firstClip.sourceStartUs + trimDurationUs,
        });
        evidence.push({ source: "user", reference: "tailoring-profile.targetDurationUs", excerpt: String(targetDurationUs) });
      }
    }

    if (firstClip && input.profile.channel === "short-form") {
      const captionDurationUs = Math.min(targetDurationUs ?? input.revision.timeline.durationUs, 3_000_000);
      if (captionDurationUs > 0) {
        operations.push({
          type: "add-caption",
          text: captionText(input.profile),
          atUs: 0,
          durationUs: captionDurationUs,
        });
      }
    }

    const confidence = firstClip ? (firstSegment ? 0.82 : 0.68) : (firstSegment ? 0.62 : 0.55);
    return {
      rationale: operations.length > 0
        ? "Short-form tailoring proposes a bounded duration trim and an audience-aware opening caption; every operation remains reversible until review."
        : "No source video clip is available for a safe edit proposal; preserve the revision and request review after media is added.",
      confidence,
      evidence,
      operations,
      status: "proposed",
    };
  }
}

function captionText(profile: TailoringProfile): string {
  const audience = profile.audience.trim().replace(/\s+/g, " ").slice(0, 120);
  const intent = profile.intent.trim().replace(/\s+/g, " ").slice(0, 160);
  return audience ? "For " + audience + ": " + intent : intent;
}

export class StaticStrategyRegistry {
  private readonly strategies = new Map<string, EditingStrategy>();

  constructor(strategies: EditingStrategy[] = [new ShortFormExplainerStrategy()]) {
    for (const strategy of strategies) {
      this.strategies.set(strategy.id + "@" + strategy.version, strategy);
    }
  }

  get(id: string, version?: string): EditingStrategy {
    const matches = [...this.strategies.values()].filter((strategy) => strategy.id === id);
    const strategy = version
      ? this.strategies.get(id + "@" + version)
      : matches.sort((a, b) => b.version.localeCompare(a.version))[0];
    if (!strategy) throw new Error("Unknown editing strategy: " + id);
    return strategy;
  }

  list(): Array<Pick<EditingStrategy, "id" | "version">> {
    return [...this.strategies.values()].map(({ id, version }) => ({ id, version }));
  }
}
