BEGIN;
CREATE TABLE IF NOT EXISTS openclaw_configs(
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
PRAGMA user_version=6;
COMMIT;
