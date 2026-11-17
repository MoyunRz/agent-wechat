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
            auto_download_max_bytes: limit.unwrap_or_else(|| defaults.auto_download_max_bytes),
            proactive_cache,
        })
    }
    pub fn set_account_settings(&self, account: &str, settings: &AccountSettings) -> Result<()> {
        if settings.auto_download_max_bytes > wechat_media::MAX_FILE_BYTES as u64 {
            bail!("invalid_auto_download_limit");
        }
        // Kinds omitted in the request keep the values this account already has.
        let kinds = match &settings.proactive_cache {
            Some(kinds) => kinds.clone(),
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
}
#[cfg(test)]
mod tests {
    use super::*;
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
