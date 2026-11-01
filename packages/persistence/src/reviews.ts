import type { UUID } from "@videocraft/domain";
import type { Database } from "./index.js";

export type ReviewComment = { id: UUID; projectId: UUID; revision: number; userId: UUID; atUs?: number; body: string; resolvedAt?: string; createdAt: string };
export type ReviewDecision = { projectId: UUID; revision: number; userId: UUID; decision: "approved" | "changes_requested"; note?: string; createdAt: string };

export class PostgresReviewRepository {
  constructor(private readonly db: Database) {}
  async list(projectId: UUID, revision: number): Promise<{ comments: ReviewComment[]; decisions: ReviewDecision[] }> {
    const comments = await this.db.query<{ id: string; project_id: string; revision: number; user_id: string; at_us: string | null; body: string; resolved_at: string | null; created_at: string }>("SELECT id, project_id, revision, user_id, at_us, body, resolved_at, created_at FROM project_review_comments WHERE project_id = $1 AND revision = $2 ORDER BY created_at, id", [projectId, revision]);
    const decisions = await this.db.query<{ project_id: string; revision: number; user_id: string; decision: ReviewDecision["decision"]; note: string | null; created_at: string }>("SELECT project_id, revision, user_id, decision, note, created_at FROM project_review_decisions WHERE project_id = $1 AND revision = $2 ORDER BY created_at, user_id", [projectId, revision]);
    return {
      comments: comments.rows.map(row => ({ id: row.id, projectId: row.project_id, revision: row.revision, userId: row.user_id, ...(row.at_us === null ? {} : { atUs: Number(row.at_us) }), body: row.body, ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }), createdAt: row.created_at })),
      decisions: decisions.rows.map(row => ({ projectId: row.project_id, revision: row.revision, userId: row.user_id, decision: row.decision, ...(row.note === null ? {} : { note: row.note }), createdAt: row.created_at })),
    };
  }
  async addComment(comment: ReviewComment): Promise<void> { await this.db.query("INSERT INTO project_review_comments (id, project_id, revision, user_id, at_us, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [comment.id, comment.projectId, comment.revision, comment.userId, comment.atUs ?? null, comment.body, comment.createdAt]); }
  async resolveComment(projectId: UUID, id: UUID, at: string): Promise<void> { await this.db.query("UPDATE project_review_comments SET resolved_at = $3 WHERE project_id = $1 AND id = $2", [projectId, id, at]); }
  async decide(decision: ReviewDecision): Promise<void> { await this.db.query("INSERT INTO project_review_decisions (project_id, revision, user_id, decision, note, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id, revision, user_id) DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note, created_at = EXCLUDED.created_at", [decision.projectId, decision.revision, decision.userId, decision.decision, decision.note ?? null, decision.createdAt]); }
}
