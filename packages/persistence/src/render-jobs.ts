import type { RenderJob, RenderJobRepository, UUID } from "@videocraft/domain";
import type { Database } from "./index.js";

type RenderJobRow = {
  id: string; project_id: string; revision: number; settings: RenderJob["settings"];
  idempotency_key: string; status: RenderJob["status"]; progress: number;
  error_message: string | null; output: NonNullable<RenderJob["output"]> | null;
};

export class PostgresRenderJobRepository implements RenderJobRepository {
  constructor(private readonly db: Database) {}
  async get(id: UUID): Promise<RenderJob | undefined> {
    const result = await this.db.query<RenderJobRow>("SELECT id, project_id, revision, settings, idempotency_key, status, progress, error_message, output FROM render_jobs WHERE id = $1", [id]);
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }
  async listOutputStorageKeys(): Promise<string[]> {
    const result = await this.db.query<{ storage_key: string }>("SELECT output->>'storageKey' AS storage_key FROM render_jobs WHERE output IS NOT NULL AND output->>'storageKey' IS NOT NULL");
    return result.rows.map((row) => row.storage_key);
  }
  async save(job: RenderJob): Promise<void> {
    await this.db.query(
      "INSERT INTO render_jobs (id, project_id, revision, settings, idempotency_key, status, progress, error_message, output) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING",
      [job.id, job.projectId, job.revision, JSON.stringify(job.settings), job.idempotencyKey, job.status, job.progress, job.errorMessage ?? null, job.output ? JSON.stringify(job.output) : null],
    );
  }
  async update(job: RenderJob): Promise<void> {
    await this.db.query(
      "UPDATE render_jobs SET status = $2, progress = $3, error_message = $4, output = $5 WHERE id = $1",
      [job.id, job.status, job.progress, job.errorMessage ?? null, job.output ? JSON.stringify(job.output) : null],
    );
  }
}
function map(row: RenderJobRow): RenderJob {
  return {
    id: row.id, projectId: row.project_id, revision: row.revision, settings: row.settings,
    idempotencyKey: row.idempotency_key, status: row.status, progress: row.progress,
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.output === null ? {} : { output: row.output }),
  };
}
