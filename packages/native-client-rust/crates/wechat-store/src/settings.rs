//! Registry settings are separate from the official operating profile.
use super::*;
/// Which message kinds the daemon downloads and keeps cached on arrival. Each
/// kind is enabled by default; thumbnails stay exempt from the gates.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, ts_rs::TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProactiveCacheKinds {
    /// Download and cache received images. The default is true.
    pub image: bool,
    /// Download and cache received stickers and emoji. The default is true.
    pub sticker: bool,
    /// Download and cache received files. The default is true.
    pub file: bool,
    /// Download and cache received videos. The default is true.
    pub video: bool,
    /// Download and cache received voice notes. The default is true.
    pub voice: bool,
}
impl Default for ProactiveCacheKinds {
    fn default() -> Self {
        Self {
            image: true,
            sticker: true,
            file: true,
            video: true,
            voice: true,
        }
    }
}
impl ProactiveCacheKinds {
    /// Whether one media kind is proactively cached. Unknown kinds count as
    /// disabled so a future kind needs an explicit opt-in.
    pub fn allows(&self, kind: &str) -> bool {
        match kind {
            "image" => self.image,
            "sticker" => self.sticker,
            "file" => self.file,
            "video" => self.video,
            "voice" => self.voice,
            _ => false,
        }
    }
    fn from_column(value: Option<String>) -> Self {
        value
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }
}
/// Hub policy; this is never written into an official WeChat profile.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountSettings {
    /// Largest advertised size in bytes that the daemon downloads automatically for this account,
    /// from 0 to 536870912. Thumbnails and voice notes are always downloaded, and 0 limits
    /// automatic downloads to those; the default is 52428800.
    #[ts(type = "number")]
    pub auto_download_max_bytes: u64,
    /// Which message kinds arrive already downloaded and cached. Every kind is on by default.
    /// A request that omits this keeps the kinds the account already has.
    #[serde(default)]
    pub proactive_cache: Option<ProactiveCacheKinds>,
}
impl Default for AccountSettings {
    fn default() -> Self {
        Self {
            auto_download_max_bytes: 50 * 1024 * 1024,
            proactive_cache: Some(ProactiveCacheKinds::default()),
        }
    }
}
impl Store {
    pub fn account_settings(&self, account: &str) -> Result<AccountSettings> {
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
        Self::require_registered(&db, account)?;
        use rusqlite::OptionalExtension;
        let limit = db
            .query_row(
                "SELECT auto_download_max_bytes, proactive_cache FROM account_settings WHERE account_id=?1",
                [account],
                |r| {
                    Ok((
                        r.get::<_, u64>(0)?,
                        r.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()?;
        let defaults = AccountSettings::default();
        let (limit, proactive_cache) = limit
            .map(|(limit, kinds)| (Some(limit), Some(ProactiveCacheKinds::from_column(kinds))))
            .unwrap_or((None, Some(defaults.proactive_cache.unwrap_or_default())));
        Ok(AccountSettings {
            auto_download_max_bytes: limit.unwrap_or(defaults.auto_download_max_bytes),
            proactive_cache,
        })
    }
    pub fn set_account_settings(&self, account: &str, settings: &AccountSettings) -> Result<()> {
        if settings.auto_download_max_bytes > wechat_media::MAX_FILE_BYTES as u64 {
            bail!("invalid_auto_download_limit");
        }
        // Kinds omitted in the request keep the values this account already has.
        let kinds = match &settings.proactive_cache {
            Some(kinds) => *kinds,
            None => self
                .account_settings(account)?
                .proactive_cache
                .unwrap_or_default(),
        };
        let proactive = serde_json::to_string(&kinds)?;
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
        Self::require_registered(&db, account)?;
        db.execute("INSERT INTO account_settings(account_id,auto_download_max_bytes,proactive_cache) VALUES(?1,?2,?3) ON CONFLICT(account_id) DO UPDATE SET auto_download_max_bytes=excluded.auto_download_max_bytes,proactive_cache=excluded.proactive_cache",params![account,settings.auto_download_max_bytes,proactive])?;
        Ok(())
    }

    pub fn resolve_account(&self, value: &str) -> Result<String> {
        if self.accounts()?.iter().any(|a| a.id == value) {
            return Ok(value.into());
        }
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
        db.query_row(
            "SELECT s.account_id FROM account_settings s JOIN accounts a ON a.id=s.account_id WHERE s.alias=?1 AND a.removed_at IS NULL",
            [value],
            |r| r.get(0),
        )
        .context("account not found")
    }
    pub fn account_alias(&self, account: &str) -> Result<Option<String>> {
        self.account(account)?;
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
        use rusqlite::OptionalExtension;
        Ok(db
            .query_row(
                "SELECT alias FROM account_settings WHERE account_id=?1",
                [account],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }
    pub fn set_account_alias(&self, account: &str, alias: &str) -> Result<()> {
        self.account(account)?;
        if alias.is_empty()
            || alias.len() > 64
            || !alias
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            bail!("invalid account alias");
        }
        if alias != account && self.accounts()?.iter().any(|a| a.id == alias) {
            bail!("account_alias_conflict");
        }
        let mut db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
        Self::require_registered(&db, account)?;
        let tx = db.transaction()?;
        use rusqlite::OptionalExtension;
        let existing: Option<String> = tx
            .query_row(
                "SELECT s.account_id FROM account_settings s JOIN accounts a ON a.id=s.account_id WHERE s.alias=?1 AND a.removed_at IS NULL",
                [alias],
                |r| r.get(0),
            )
            .optional()?;
        if existing.is_some_and(|id| id != account) {
            bail!("account_alias_conflict");
        }
        tx.execute("INSERT INTO account_settings(account_id,alias)VALUES(?1,?2)ON CONFLICT(account_id)DO UPDATE SET alias=excluded.alias",params![account,alias])?;
        tx.commit()?;
        Ok(())
    }

    /// One account's stored OpenClaw configuration document and the unix
    /// seconds it was last written. `None` means no stored copy: the account
    /// falls back to whatever the OpenClaw host config provides.
    pub fn openclaw_config(&self, account: &str) -> Result<Option<(serde_json::Value, i64)>> {
        self.account(account)?;
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
        use rusqlite::OptionalExtension;
        let row: Option<(String, i64)> = db
            .query_row(
                "SELECT config,updated_at FROM openclaw_configs WHERE account_id=?1",
                [account],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(row.map(|(config, updated_at)| {
            (
                serde_json::from_str(&config).unwrap_or(serde_json::Value::Null),
                updated_at,
            )
        }))
    }

    /// Store or clear one account's OpenClaw configuration document. Each
    /// WeChat account keeps its own copy, so different users configure
    /// different OpenClaw policies. The document must be a JSON object of at
    /// most 256 KiB. `None` removes the stored copy.
    pub fn set_openclaw_config(
        &self,
        account: &str,
        config: Option<&serde_json::Value>,
    ) -> Result<i64> {
        if let Some(config) = config {
            if !config.is_object()
                || serde_json::to_vec(config).is_ok_and(|bytes| bytes.len() > 256 * 1024)
            {
                bail!("invalid_openclaw_config");
            }
        }
        let updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or_default();
        self.account(account)?;
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
        match config {
            Some(config) => db.execute(
                "INSERT INTO openclaw_configs(account_id,config,updated_at) VALUES(?1,?2,?3) ON CONFLICT(account_id) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at",
                params![account, config.to_string(), updated_at],
            )?,
            None => db.execute(
                "DELETE FROM openclaw_configs WHERE account_id=?1",
                params![account],
            )?,
        };
        Ok(updated_at)
    }

    /// One WeChat account's AI assistant configuration: an OpenAI-compatible
    /// endpoint, its key and the selectable models. Each account keeps its own
    /// copy, so different users configure different providers. Never expose
    /// the API key through read APIs; callers only learn whether one exists.
    pub fn ai_config(&self, account: &str) -> Result<Option<AiConfig>> {
        self.account(account)?;
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
        use rusqlite::OptionalExtension;
        let row: Option<(String, String, String, String, String, i64)> = db
            .query_row(
                "SELECT base_url,api_key,models,model,reasoning,updated_at FROM ai_config WHERE account_id=?1",
                params![account],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(
            |(base_url, api_key, models, model, reasoning, updated_at)| AiConfig {
                models: serde_json::from_str(&models).unwrap_or_default(),
                base_url,
                api_key,
                model,
                reasoning,
                updated_at,
            },
        ))
    }

    /// Store one account's AI configuration. `api_key` of `None` keeps the
    /// stored key so the UI can update the rest without resending the secret.
    pub fn set_ai_config(
        &self,
        account: &str,
        base_url: &str,
        api_key: Option<&str>,
        models: &[String],
        model: &str,
        reasoning: &str,
    ) -> Result<i64> {
        let base = base_url.trim();
        let valid = (base.starts_with("http://") || base.starts_with("https://"))
            && base.len() > 8
            && base.len() <= 2048
            && !base.contains(char::is_whitespace);
        if !valid {
            bail!("invalid_ai_base_url");
        }
        for model in models {
            if model.is_empty() || model.len() > 200 {
                bail!("invalid_ai_model");
            }
        }
        if let Some(key) = api_key {
            if key.len() > 4096 {
                bail!("invalid_ai_api_key");
            }
        }
        // OpenAI-compatible reasoning effort; empty means never send it.
        if !matches!(reasoning, "" | "minimal" | "low" | "medium" | "high") {
            bail!("invalid_ai_reasoning");
        }
        let updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or_default();
        self.account(account)?;
        let db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("registry lock poisoned"))?;
        db.execute(
            "INSERT INTO ai_config(account_id,base_url,api_key,models,model,reasoning,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(account_id) DO UPDATE SET
               base_url=excluded.base_url,
               api_key=CASE WHEN excluded.api_key='' THEN ai_config.api_key ELSE excluded.api_key END,
               models=excluded.models,
               model=excluded.model,
               reasoning=excluded.reasoning,
               updated_at=excluded.updated_at",
            params![
                account,
                base_url,
                api_key.unwrap_or_default(),
                serde_json::to_string(models)?,
                model,
                reasoning,
                updated_at
            ],
        )?;
        Ok(updated_at)
    }
}

/// One WeChat account's AI assistant configuration stored in the registry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    pub model: String,
    /// Reasoning effort sent as `reasoning_effort`; empty means never send it.
    pub reasoning: String,
    pub updated_at: i64,
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openclaw_configs_are_per_account_persisted_and_clearable() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data");
        let store = Store::open(&path).unwrap();
        store.create_account("a").unwrap();
        store.create_account("b").unwrap();
        assert!(store.openclaw_config("a").unwrap().is_none());
        let config = serde_json::json!({"dmPolicy":"open","allowFrom":["*"]});
        let first = store.set_openclaw_config("a", Some(&config)).unwrap();
        let stored = store.openclaw_config("a").unwrap().unwrap();
        assert_eq!(stored.0, config);
        assert_eq!(stored.1, first);
        // Each account keeps its own copy.
        assert!(store.openclaw_config("b").unwrap().is_none());
        store
            .set_openclaw_config("b", Some(&serde_json::json!({"dmPolicy":"disabled"})))
            .unwrap();
        assert_eq!(
            store.openclaw_config("a").unwrap().unwrap().0["dmPolicy"],
            "open"
        );
        // Only JSON objects are stored, and the account must exist.
        assert!(store
            .set_openclaw_config("a", Some(&serde_json::json!([1])))
            .is_err());
        assert!(store.set_openclaw_config("absent", Some(&config)).is_err());
        // Clearing removes the stored copy.
        store.set_openclaw_config("a", None).unwrap();
        assert!(store.openclaw_config("a").unwrap().is_none());
        // The stored document survives reopening.
        store.set_openclaw_config("b", Some(&config)).unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.openclaw_config("b").unwrap().unwrap().0, config);
    }

    #[test]
    fn upgrading_registry_creates_the_openclaw_config_table() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data");
        let store = Store::open(&path).unwrap();
        store.create_account("a").unwrap();
        store
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE openclaw_configs; PRAGMA user_version=4;")
            .unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert!(store.openclaw_config("a").unwrap().is_none());
        store
            .set_openclaw_config("a", Some(&serde_json::json!({"dmPolicy":"open"})))
            .unwrap();
    }

    #[test]
    fn ai_config_is_per_account_persisted_and_keeps_the_key_when_omitted() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("data")).unwrap();
        store.create_account("a").unwrap();
        store.create_account("b").unwrap();
        assert!(store.ai_config("a").unwrap().is_none());
        store
            .set_ai_config(
                "a",
                "https://api.example.com/v1/",
                Some("secret-key"),
                &["model-b".into(), "model-a".into()],
                "model-a",
                "medium",
            )
            .unwrap();
        let stored = store.ai_config("a").unwrap().unwrap();
        assert_eq!(stored.base_url, "https://api.example.com/v1/");
        assert_eq!(stored.api_key, "secret-key");
        assert_eq!(
            stored.models,
            vec!["model-b".to_string(), "model-a".to_string()]
        );
        assert_eq!(stored.model, "model-a");
        assert_eq!(stored.reasoning, "medium");
        // Each account keeps its own copy.
        assert!(store.ai_config("b").unwrap().is_none());
        // Updating without a key keeps the stored secret; an empty base URL or
        // a non-HTTP scheme is refused.
        store
            .set_ai_config(
                "a",
                "https://api.example.com/v2",
                None,
                &["model-a".into()],
                "model-a",
                "",
            )
            .unwrap();
        let updated = store.ai_config("a").unwrap().unwrap();
        assert_eq!(updated.base_url, "https://api.example.com/v2");
        assert_eq!(updated.api_key, "secret-key");
        assert_eq!(updated.reasoning, "");
        assert!(store
            .set_ai_config("a", "ftp://bad.example.com", None, &[], "", "")
            .is_err());
        assert!(store
            .set_ai_config("a", "https://api.example.com", None, &[], "", "bogus")
            .is_err());
        store
            .set_ai_config(
                "b",
                "https://other.example.com/v1",
                Some("other-key"),
                &["model-c".into()],
                "model-c",
                "low",
            )
            .unwrap();
        assert_eq!(store.ai_config("b").unwrap().unwrap().api_key, "other-key");
        assert_eq!(store.ai_config("a").unwrap().unwrap().api_key, "secret-key");
    }

    #[test]
    fn media_settings_are_per_account_and_survive_reopening() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data");
        let store = Store::open(&path).unwrap();
        store.create_account("a").unwrap();
        store.create_account("b").unwrap();
        assert_eq!(
            store.account_settings("a").unwrap().auto_download_max_bytes,
            52_428_800
        );
        store.set_account_alias("a", "personal").unwrap();
        store
            .set_account_settings(
                "a",
                &AccountSettings {
                    auto_download_max_bytes: 0,
                    proactive_cache: Some(ProactiveCacheKinds {
                        image: true,
                        sticker: false,
                        file: true,
                        video: false,
                        voice: true,
                    }),
                },
            )
            .unwrap();
        assert_eq!(
            store.account_settings("b").unwrap().auto_download_max_bytes,
            52_428_800
        );
        assert!(store
            .account_settings("b")
            .unwrap()
            .proactive_cache
            .unwrap()
            .allows("sticker"));
        let settings = store.account_settings("a").unwrap();
        assert_eq!(settings.auto_download_max_bytes, 0);
        assert!(!settings.proactive_cache.unwrap().allows("sticker"));
        assert!(settings.proactive_cache.unwrap().allows("image"));
        assert!(store
            .set_account_settings(
                "a",
                &AccountSettings {
                    auto_download_max_bytes: 536_870_913,
                    proactive_cache: Some(ProactiveCacheKinds::default()),
                }
            )
            .is_err());
        assert!(store
            .set_account_settings("absent", &AccountSettings::default())
            .is_err());
        drop(store);
        let store = Store::open(&path).unwrap();
        let settings = store.account_settings("a").unwrap();
        assert_eq!(settings.auto_download_max_bytes, 0);
        assert!(!settings.proactive_cache.unwrap().allows("sticker"));
        assert!(store
            .account_settings("b")
            .unwrap()
            .proactive_cache
            .unwrap()
            .allows("voice"));
    }
    #[test]
    fn upgrading_registry_settings_keeps_existing_accounts_and_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("data");
        let store = Store::open(&path).unwrap();
        store.create_account("a").unwrap();
        store.set_account_alias("a", "personal").unwrap();
        store.db.lock().unwrap().execute_batch("ALTER TABLE account_settings DROP COLUMN auto_download_max_bytes; ALTER TABLE account_settings DROP COLUMN proactive_cache; PRAGMA user_version=3;").unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.resolve_account("personal").unwrap(), "a");
        assert_eq!(
            store.account_settings("a").unwrap().auto_download_max_bytes,
            52_428_800
        );
    }
    #[test]
    fn aliases_are_unique_and_cannot_shadow_ids() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(&temp.path().join("data")).unwrap();
        store.create_account("a").unwrap();
        store.create_account("b").unwrap();
        store.set_account_alias("a", "personal").unwrap();
        assert_eq!(store.resolve_account("personal").unwrap(), "a");
        assert!(store.set_account_alias("b", "personal").is_err());
        assert!(store.set_account_alias("a", "b").is_err());
        store.set_account_alias("a", "a").unwrap();
        assert!(store.resolve_account("personal").is_err());
    }
}
