import type { Database } from "./index.js";
import type { FeedbackEvent, FeedbackRepository, UUID } from "@videocraft/domain";

export class PostgresFeedbackRepository implements FeedbackRepository {
  constructor(private readonly db: Database) {}
  async append(event: FeedbackEvent): Promise<void> {
    await this.db.query(
      "INSERT INTO feedback_events (id, project_id, revision, strategy_id, proposal_id, type, value, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [event.id, event.projectId, event.revision, event.strategyId ?? null, event.proposalId ?? null, event.type, event.value ?? null, event.note ?? null, event.createdAt],
    );
  }
}
export interface FeedbackReader {
  listForProject(projectId: UUID): Promise<FeedbackEvent[]>;
}
