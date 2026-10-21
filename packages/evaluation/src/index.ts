import type { FeedbackEvent } from "@videocraft/domain";

export interface StrategyEvaluationReport {
  strategyId: string;
  totalEvents: number;
  decisionEvents: number;
  accepted: number;
  rejected: number;
  edited: number;
  exported: number;
  shared: number;
  acceptanceRate: number;
  editRate: number;
  outcomeScore: number;
}

export function evaluateStrategyFeedback(events: readonly FeedbackEvent[], strategyId: string): StrategyEvaluationReport {
  const scoped = events.filter((event) => event.strategyId === strategyId);
  const accepted = count(scoped, "accepted");
  const rejected = count(scoped, "rejected");
  const edited = count(scoped, "edited");
  const exported = count(scoped, "exported");
  const shared = count(scoped, "shared");
  const decisionEvents = accepted + rejected + edited;
  const acceptanceRate = decisionEvents === 0 ? 0 : accepted / decisionEvents;
  const editRate = decisionEvents === 0 ? 0 : edited / decisionEvents;
  const outcomeScore = decisionEvents === 0
    ? 0
    : (accepted + exported * 0.5 + shared * 0.5 - rejected - edited * 0.5) / decisionEvents;
  return {
    strategyId,
    totalEvents: scoped.length,
    decisionEvents,
    accepted,
    rejected,
    edited,
    exported,
    shared,
    acceptanceRate,
    editRate,
    outcomeScore,
  };
}

function count(events: readonly FeedbackEvent[], type: FeedbackEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}
