BEGIN;
ALTER TABLE account_settings ADD COLUMN proactive_cache TEXT NOT NULL DEFAULT '{"image":true,"sticker":true,"file":true,"video":true,"voice":true}';
PRAGMA user_version=5;
COMMIT;
