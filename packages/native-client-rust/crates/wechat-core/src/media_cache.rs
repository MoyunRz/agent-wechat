//! A derived on-disk cache of already decoded and verified media bytes.
//!
//! Serving an attachment decodes its source again on every request: profile
//! files are decrypted again, voice is converted from SILK again, previews are
//! decoded again and vault payloads are unsealed again. This cache keeps the
//! finished bytes of those steps under `<store root>/media-cache`, so a repeat
//! request reads a file instead of decoding again.
//!
//! Every entry is regenerable from bytes the account already owns; deleting
//! the directory at any time loses nothing. Callers verify an entry against
//! the asset's recorded hash before using it and drop damaged entries. Each
//! account keeps its own shard directory, so one account can be purged alone.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

/// Storage budget for the whole cache directory.
const MEDIA_CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// How many successful writes between sweeps. A sweep stat-walks the whole
/// directory, so it runs occasionally instead of on every write.
const SWEEP_EVERY_WRITES: usize = 128;

pub(crate) struct MediaDiskCache {
    root: PathBuf,
    writes: AtomicUsize,
    tmp_counter: AtomicU64,
}

impl MediaDiskCache {
    pub(crate) fn new(root: PathBuf) -> Self {
        // Entries written before account-scoped shards lived directly under
        // the root in two-letter shard folders. Nothing reads those anymore;
        // remove them once so a purge or sweep sees only current entries.
        if let Ok(top) = std::fs::read_dir(&root) {
            for entry in top.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.len() == 2 && !name.starts_with('.') && entry.path().is_dir() {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        Self {
            root,
            writes: AtomicUsize::new(0),
            tmp_counter: AtomicU64::new(0),
        }
    }

    /// The cached bytes for one account's `key`, if a file is on disk. A file
    /// that cannot be read counts as a miss; the caller checks the content
    /// against the recorded hash and drops damaged entries.
    pub(crate) fn get(&self, account: &str, key: &str) -> Option<Vec<u8>> {
        let path = self.entry_path(account, key);
        let bytes = std::fs::read(&path).ok()?;
        // Reading counts as use: recently read entries survive eviction
        // longest. Best effort only; a failed touch costs nothing.
        if let Ok(file) = std::fs::File::options().write(true).open(&path) {
            let _ = file.set_modified(SystemTime::now());
        }
        Some(bytes)
    }

    /// Store `bytes` for one account's `key`. Failures are ignored: the cache
    /// only accelerates, and the next request decodes again instead.
    pub(crate) fn put(&self, account: &str, key: &str, bytes: &[u8]) {
        let path = self.entry_path(account, key);
        if path.exists() {
            return;
        }
        let Some(parent) = path.parent() else {
            return;
        };
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
        // Write beside the entry and rename, so a reader never sees a half
        // written file. Concurrent writers of the same key each use their own
        // temporary name; both produce the same content.
        let tmp = parent.join(format!(
            ".tmp-{}-{}",
            std::process::id(),
            self.tmp_counter.fetch_add(1, Ordering::Relaxed)
        ));
        if std::fs::write(&tmp, bytes).is_ok() && std::fs::rename(&tmp, &path).is_ok() {
            let writes = self.writes.fetch_add(1, Ordering::Relaxed) + 1;
            if writes.is_multiple_of(SWEEP_EVERY_WRITES) {
                self.sweep();
            }
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// Drop one entry of one account, for example when its bytes no longer
    /// match the recorded hash.
    pub(crate) fn remove(&self, account: &str, key: &str) {
        let _ = std::fs::remove_file(self.entry_path(account, key));
    }

    /// Remove this account's cache entries. `older_than` of `None` removes
    /// everything; otherwise only files last written before the cutoff. The
    /// cutoff is checked against the file's modification time, which a read
    /// refreshes. Returns how many files and bytes were removed.
    pub(crate) fn purge(&self, account: &str, older_than: Option<Duration>) -> (u64, u64) {
        // No cutoff removes everything; with one, files written after the
        // cutoff stay.
        let cutoff = older_than.map(|age| SystemTime::now() - age);
        let mut files = 0u64;
        let mut bytes = 0u64;
        let mut paths: Vec<PathBuf> = Vec::new();
        collect_files(
            &self.account_dir(account),
            &mut Vec::new(),
            &mut 0,
            &mut paths,
        );
        for path in paths {
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if let Some(cutoff) = cutoff {
                if meta.modified().unwrap_or(SystemTime::UNIX_EPOCH) >= cutoff {
                    continue;
                }
            }
            let size = meta.len();
            if std::fs::remove_file(&path).is_ok() {
                files += 1;
                bytes += size;
            }
        }
        (files, bytes)
    }

    /// One account's shard directory. The account id itself never becomes a
    /// path component; a short hash of it does.
    fn account_dir(&self, account: &str) -> PathBuf {
        let name = format!("{:x}", Sha256::digest(account.as_bytes()));
        self.root.join(&name[..16])
    }

    /// The file for one account's `key`. The key itself never becomes a path
    /// component; its SHA-256 does, sharded over two directory levels.
    fn entry_path(&self, account: &str, key: &str) -> PathBuf {
        let name = format!("{:x}", Sha256::digest(key.as_bytes()));
        self.account_dir(account)
            .join(&name[..2])
            .join(&name[2..4])
            .join(&name[4..])
    }

    /// Remove the least recently written entries until the directory fits its
    /// budget. Entries are touched on read, so popular media survives.
    fn sweep(&self) {
        self.sweep_to_limit(MEDIA_CACHE_MAX_BYTES);
    }

    #[cfg(test)]
    fn sweep_to_limit_for_test(&self, max_bytes: u64) {
        self.sweep_to_limit(max_bytes);
    }

    fn sweep_to_limit(&self, max_bytes: u64) {
        let mut files: Vec<(SystemTime, PathBuf, u64)> = Vec::new();
        let mut total = 0;
        collect_files(&self.root, &mut files, &mut total, &mut Vec::new());
        if total <= max_bytes {
            return;
        }
        files.sort_by(|left, right| left.0.cmp(&right.0));
        let mut excess = total - max_bytes;
        for (_, path, size) in files {
            if excess == 0 {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                excess = excess.saturating_sub(size);
            }
        }
    }
}

/// Collect every cache file below `dir` with its modification time and size,
/// and clear leftover temporary writes from interrupted runs. `flat` receives
/// every file path when the caller passes a list.
fn collect_files(
    dir: &Path,
    files: &mut Vec<(SystemTime, PathBuf, u64)>,
    total: &mut u64,
    flat: &mut Vec<PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => collect_files(&path, files, total, flat),
            Ok(_) => {
                let size = meta.len();
                if entry.file_name().to_string_lossy().starts_with(".tmp-") {
                    let _ = std::fs::remove_file(&path);
                } else {
                    *total += size;
                    files.push((
                        meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                        path.clone(),
                        size,
                    ));
                    flat.push(path);
                }
            }
            Err(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> (tempfile::TempDir, MediaDiskCache) {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaDiskCache::new(dir.path().join("media-cache"));
        (dir, cache)
    }

    fn cache_files(root: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                if entry.file_type().unwrap().is_dir() {
                    walk(&entry.path(), found);
                } else {
                    found.push(entry.path());
                }
            }
        }
        walk(root, &mut found);
        found.sort();
        found
    }

    #[test]
    fn round_trips_a_key_and_misses_unknown_keys() {
        let (_dir, cache) = cache();
        assert_eq!(cache.get("one", "content|a"), None);
        cache.put("one", "content|a", b"first");
        assert_eq!(cache.get("one", "content|a"), Some(b"first".to_vec()));
        assert_eq!(cache.get("one", "content|b"), None);
        cache.put("one", "content|b", b"second");
        assert_eq!(cache.get("one", "content|b"), Some(b"second".to_vec()));
        assert_eq!(cache.get("one", "content|a"), Some(b"first".to_vec()));
    }

    #[test]
    fn accounts_keep_separate_entries() {
        let (_dir, cache) = cache();
        cache.put("one", "content|a", b"mine");
        cache.put("two", "content|a", b"theirs");
        assert_eq!(cache.get("one", "content|a"), Some(b"mine".to_vec()));
        assert_eq!(cache.get("two", "content|a"), Some(b"theirs".to_vec()));
        cache.purge("one", None);
        assert_eq!(cache.get("one", "content|a"), None);
        assert_eq!(cache.get("two", "content|a"), Some(b"theirs".to_vec()));
    }

    #[test]
    fn keys_never_reach_the_filesystem_as_paths() {
        let (dir, cache) = cache();
        let key = "content|../../etc| conveyor belt \\ .. * ? |🎉";
        cache.put("one", key, b"safe");
        assert_eq!(cache.get("one", key), Some(b"safe".to_vec()));
        let files = cache_files(&dir.path().join("media-cache"));
        assert_eq!(files.len(), 1);
        assert_eq!(std::fs::read(&files[0]).unwrap(), b"safe");
    }

    #[test]
    fn removal_drops_the_entry() {
        let (_dir, cache) = cache();
        cache.put("one", "content|a", b"bytes");
        cache.remove("one", "content|a");
        assert_eq!(cache.get("one", "content|a"), None);
    }

    #[test]
    fn purging_reports_what_it_removed_and_respects_the_age() {
        let (_dir, cache) = cache();
        cache.put("one", "content|old", &[0u8; 30]);
        cache.put("one", "content|new", &[1u8; 50]);
        // Pretend the first entry was written two days ago.
        let entry = cache.entry_path("one", "content|old");
        let file = std::fs::File::options().write(true).open(&entry).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(2 * 24 * 3600))
            .unwrap();
        // Recent entries survive a 24-hour purge.
        let (files, bytes) = cache.purge("one", Some(Duration::from_secs(24 * 3600)));
        assert_eq!((files, bytes), (1, 30));
        assert_eq!(cache.get("one", "content|old"), None);
        assert_eq!(cache.get("one", "content|new"), Some(vec![1u8; 50]));
        // A purge without an age removes the rest.
        let (files, bytes) = cache.purge("one", None);
        assert_eq!((files, bytes), (1, 50));
        assert_eq!(cache.get("one", "content|new"), None);
    }

    #[test]
    fn sweeping_keeps_recently_used_entries_within_the_limit() {
        let (_dir, cache) = cache();
        for index in 0..6u32 {
            cache.put("one", &format!("content|{index}"), &[index as u8; 40]);
        }
        // Read the oldest two entries: their files become the newest by time.
        assert!(cache.get("one", "content|0").is_some());
        assert!(cache.get("one", "content|1").is_some());
        cache.sweep_to_limit_for_test(120);
        let survived: Vec<String> = (0..6u32)
            .filter(|index| cache.get("one", &format!("content|{index}")).is_some())
            .map(|index| format!("content|{index}"))
            .collect();
        // The limit fits three 40-byte files; the recently read ones survive.
        assert_eq!(survived, vec!["content|0", "content|1", "content|5"]);
    }

    #[test]
    fn sweeping_clears_leftover_temporary_writes() {
        let (dir, cache) = cache();
        cache.put("one", "content|a", b"bytes");
        // Any shard directory works; find the one that holds the entry.
        let shard = cache.account_dir("one").join("ab").join("cd");
        std::fs::create_dir_all(&shard).unwrap();
        std::fs::write(shard.join(".tmp-999-1"), b"stale").unwrap();
        cache.sweep_to_limit_for_test(u64::MAX);
        let names: Vec<String> = cache_files(&dir.path().join("media-cache"))
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1);
        assert!(!names[0].starts_with(".tmp-"));
    }
}
