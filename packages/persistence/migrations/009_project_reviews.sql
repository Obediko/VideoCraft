CREATE TABLE IF NOT EXISTS project_review_comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  at_us BIGINT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (project_id, revision) REFERENCES project_revisions(project_id, revision) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_review_comments_revision_idx ON project_review_comments(project_id, revision, created_at);

CREATE TABLE IF NOT EXISTS project_review_decisions (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, revision, user_id),
  FOREIGN KEY (project_id, revision) REFERENCES project_revisions(project_id, revision) ON DELETE CASCADE
);
