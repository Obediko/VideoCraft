-- Labelled clip outcomes used to learn each person's editing preferences.
CREATE TABLE IF NOT EXISTS preference_samples (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  features JSONB NOT NULL,
  label SMALLINT NOT NULL CHECK (label IN (-1, 1)),
  weight REAL NOT NULL CHECK (weight > 0 AND weight <= 1),
  source TEXT NOT NULL CHECK (source IN ('removed', 'exported', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS preference_samples_user_idx ON preference_samples(user_id, strategy_id, created_at DESC);
