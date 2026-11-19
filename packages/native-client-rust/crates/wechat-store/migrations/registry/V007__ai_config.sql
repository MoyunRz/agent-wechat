BEGIN;
CREATE TABLE IF NOT EXISTS ai_config(
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  models TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
PRAGMA user_version=7;
COMMIT;
