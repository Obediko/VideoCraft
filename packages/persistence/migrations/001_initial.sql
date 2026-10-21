CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'image', 'caption')),
  storage_key TEXT NOT NULL,
  checksum_sha256 CHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  duration_us BIGINT CHECK (duration_us IS NULL OR duration_us >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  start_us BIGINT NOT NULL CHECK (start_us >= 0),
  end_us BIGINT NOT NULL CHECK (end_us > start_us),
  text TEXT NOT NULL,
  words JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider TEXT NOT NULL,
  provider_version TEXT
);

CREATE TABLE IF NOT EXISTS project_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  timeline JSONB NOT NULL,
  tailoring JSONB,
  accepted_proposal_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (project_id, revision)
);

CREATE INDEX IF NOT EXISTS assets_project_created_idx ON assets(project_id, created_at);
CREATE INDEX IF NOT EXISTS revisions_project_idx ON project_revisions(project_id, revision DESC);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id);
CREATE INDEX IF NOT EXISTS transcript_asset_time_idx ON transcript_segments(asset_id, start_us);
