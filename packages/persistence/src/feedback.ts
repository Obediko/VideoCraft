import type { Database } from "./index.js";
import type { FeedbackEvent, FeedbackRepository, UUID } from "@videocraft/domain";

export class PostgresFeedbackRepository implements FeedbackRepository {
  constructor(private readonly db: Database) {}
  async append(event: FeedbackEvent): Promise<void> {
    if (event.proposalId) {
      const result = await this.db.query<{ project_id: UUID }>("SELECT project_id FROM editing_proposals WHERE id = $1", [event.proposalId]);
      if (result.rows[0]?.project_id !== event.projectId) throw new Error("Feedback proposal does not belong to project");
    }
    await this.db.query(
      "INSERT INTO feedback_events (id, project_id, revision, strategy_id, proposal_id, type, value, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [event.id, event.projectId, event.revision, event.strategyId ?? null, event.proposalId ?? null, event.type, event.value ?? null, event.note ?? null, event.createdAt],
    );
  }
}
export interface FeedbackReader {
  listForProject(projectId: UUID): Promise<FeedbackEvent[]>;
}
