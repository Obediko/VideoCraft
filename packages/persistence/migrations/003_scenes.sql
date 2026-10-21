CREATE TABLE IF NOT EXISTS scenes (
  id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  start_us BIGINT NOT NULL CHECK (start_us >= 0),
  end_us BIGINT NOT NULL CHECK (end_us > start_us),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (asset_id, id)
);

CREATE INDEX IF NOT EXISTS scenes_asset_time_idx ON scenes(asset_id, start_us, id);
