import type {
  EditingProposal,
  EditingStrategy,
  Evidence,
  Project,
  ProjectRevision,
  TailoringProfile,
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
    const evidence: Evidence[] = [
      {
        source: "user",
        reference: "tailoring-profile.intent",
        excerpt: input.profile.intent,
      },
    ];
    if (firstSegment) {
      evidence.push({
        source: "transcript",
        reference: firstSegment.id,
        excerpt: firstSegment.text,
      });
    }

    return {
      rationale:
        "Prioritize a clear opening, preserve source material, and keep edits reversible for review.",
      confidence: firstSegment ? 0.72 : 0.55,
      evidence,
      operations: [],
      status: "proposed",
    };
  }
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
