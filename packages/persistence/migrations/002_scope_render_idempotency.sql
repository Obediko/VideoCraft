-- Render idempotency keys are scoped to a project, matching the queue identity.
ALTER TABLE render_jobs DROP CONSTRAINT IF EXISTS render_jobs_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS render_jobs_project_idempotency_key_idx
  ON render_jobs(project_id, idempotency_key);
