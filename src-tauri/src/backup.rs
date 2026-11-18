//! Backing up and restoring everything the user made: playlists, liked
//! songs, the library list, download records, saved lyrics, listening
//! history and the page's settings. A backup is one file: a consistent
//! SQLite copy of the database (made with `VACUUM INTO`) plus a
//! `backup_meta` table. Downloaded audio is left out because it can be
//! gigabytes; on the same PC it simply stays.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

/// Marks a file as a Cadence backup.
const MAGIC: &str = "cadence-backup-1";
/// Tables copied back on restore, parents before children.
const TABLES: &[&str] = &["folders", "tracks", "liked", "playlists", "playlist_tracks", "downloads", "lyrics", "plays"];
/// Safety copies made before a restore that are kept.
const KEEP_SAFETY_COPIES: usize = 5;

/// What a backup holds, shown before restoring it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Seconds since 1970.
    pub created_at: i64,
    pub app_version: String,
    pub playlists: i64,
    pub liked: i64,
    pub library_tracks: i64,
    pub downloads: i64,
}

type Res<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn table_exists(conn: &Connection, schema: &str, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        &format!("SELECT 1 FROM {schema}.sqlite_master WHERE type = 'table' AND name = ?1"),
        params![table],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
}

fn count(conn: &Connection, table: &str) -> i64 {
    if !table_exists(conn, "main", table).unwrap_or(false) {
        return 0;
    }
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap_or(0)
}

fn meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM backup_meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
}

/// Writes a backup of `conn`'s database, with the page's `settings` (JSON),
/// to `dest`. Goes through a temporary file, so a failure never leaves a
/// half-written backup behind.
pub fn create(conn: &Connection, dest: &Path, settings: &str) -> Res<Summary> {
    let tmp = dest.with_extension("part");
    let _ = std::fs::remove_file(&tmp);
    let result = (|| {
        conn.execute("VACUUM INTO ?1", params![tmp.to_string_lossy()]).map_err(err)?;
        let copy = Connection::open(&tmp).map_err(err)?;
        copy.execute_batch("CREATE TABLE backup_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .map_err(err)?;
        let created_at = now_secs();
        for (key, value) in [
            ("magic", MAGIC.to_string()),
            ("app_version", env!("CARGO_PKG_VERSION").to_string()),
            ("created_at", created_at.to_string()),
            ("settings", settings.to_string()),
        ] {
            copy.execute("INSERT INTO backup_meta(key, value) VALUES (?1, ?2)", params![key, value])
                .map_err(err)?;
        }
        let summary = summarize(&copy)?;
        drop(copy);
        // Replaces an existing file the user chose to overwrite.
        std::fs::rename(&tmp, dest).map_err(err)?;
        Ok(summary)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn summarize(conn: &Connection) -> Res<Summary> {
    let bad = || "That file isn't a Cadence backup.".to_string();
    if !table_exists(conn, "main", "backup_meta").map_err(|_| bad())? || meta(conn, "magic").map_err(err)?.as_deref() != Some(MAGIC) {
        return Err(bad());
    }
    Ok(Summary {
        created_at: meta(conn, "created_at").map_err(err)?.and_then(|v| v.parse().ok()).unwrap_or(0),
        app_version: meta(conn, "app_version").map_err(err)?.unwrap_or_default(),
        playlists: count(conn, "playlists"),
        liked: count(conn, "liked"),
        library_tracks: count(conn, "tracks"),
        downloads: count(conn, "downloads"),
    })
}

/// Reads a backup's summary and settings without changing anything.
pub fn peek(path: &Path) -> Res<(Summary, String)> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Couldn't open that file.".to_string())?;
    let summary = summarize(&conn).map_err(|_| "That file isn't a Cadence backup.".to_string())?;
    let settings = meta(&conn, "settings").map_err(err)?.unwrap_or_else(|| "{}".into());
    Ok((summary, settings))
}

fn columns(conn: &Connection, schema: &str, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info({table})"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    rows.collect()
}

/// Replaces the data in `conn` with the backup's. A safety copy of the
/// current data (with `current_settings`) goes into `safety_dir` first.
/// Returns the backup's summary and its settings for the page to apply.
pub fn restore(conn: &Connection, path: &Path, safety_dir: &Path, current_settings: &str) -> Res<(Summary, String, PathBuf)> {
    let (summary, settings) = peek(path)?;
    std::fs::create_dir_all(safety_dir).map_err(err)?;
    let safety = safety_dir.join(format!("before-restore-{}.cadence-backup", now_secs()));
    create(conn, &safety, current_settings)?;
    prune(safety_dir);

    conn.execute("ATTACH DATABASE ?1 AS b", params![path.to_string_lossy()]).map_err(err)?;
    let copied = (|| -> rusqlite::Result<()> {
        let tx = conn.unchecked_transaction()?;
        for table in TABLES {
            tx.execute(&format!("DELETE FROM main.{table}"), [])?;
            if !table_exists(&tx, "b", table)? {
                continue;
            }
            // Only columns both sides know, so older and newer backups work.
            let theirs = columns(&tx, "b", table)?;
            let shared: Vec<String> = columns(&tx, "main", table)?
                .into_iter()
                .filter(|c| theirs.contains(c))
                .map(|c| format!("\"{c}\""))
                .collect();
            let list = shared.join(", ");
            tx.execute(&format!("INSERT INTO main.{table} ({list}) SELECT {list} FROM b.{table}"), [])?;
        }
        tx.execute("INSERT INTO tracks_fts(tracks_fts) VALUES ('rebuild')", [])?;
        tx.commit()
    })();
    let _ = conn.execute("DETACH DATABASE b", []);
    copied.map_err(|e| format!("Restoring failed, nothing was changed: {e}"))?;
    Ok((summary, settings, safety))
}

/// Keeps only the newest few safety copies.
fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut copies: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("before-restore-")))
        .collect();
    // The names end in a timestamp, so they sort oldest first.
    copies.sort();
    let excess = copies.len().saturating_sub(KEEP_SAFETY_COPIES);
    for old in copies.into_iter().take(excess) {
        let _ = std::fs::remove_file(old);
    }
}

/// The desktop's backups folder: keeps only the newest \`keep\` automatic
/// backups. Their names end in the date, so they sort oldest first. Backups
/// made by hand are never deleted. (Phones do this in Kotlin, Backups.kt.)
#[cfg_attr(not(desktop), allow(dead_code))]
pub fn prune_auto(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut autos: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("Cadence auto backup ")))
        .collect();
    autos.sort();
    let excess = autos.len().saturating_sub(keep);
    for old in autos.into_iter().take(excess) {
        let _ = std::fs::remove_file(old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, Track};

    #[test]
    fn automatic_backups_keep_the_newest() {
        let dir = temp_dir("auto");
        std::fs::create_dir_all(&dir).unwrap();
        for day in ["2026-11-01", "2026-11-08", "2026-11-15", "2026-11-22", "2026-11-29"] {
            std::fs::write(dir.join(format!("Cadence auto backup {day}.cadence-backup")), "x").unwrap();
        }
        std::fs::write(dir.join("Cadence backup 2026-10-01.cadence-backup"), "x").unwrap();
        prune_auto(&dir, 4);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left.len(), 5);
        // The oldest automatic one went; the one made by hand stayed.
        assert!(!left.iter().any(|n| n.contains("2026-11-01")));
        assert!(left.iter().any(|n| n == "Cadence backup 2026-10-01.cadence-backup"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cadence-backup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn song(id: &str) -> Track {
        Track { id: id.into(), title: format!("Song {id}"), artist: "Band".into(), ..Default::default() }
    }

    #[test]
    fn backup_and_restore_round_trip() {
        let dir = temp_dir("round");
        let conn = db::open(&dir.join("cadence.db")).unwrap();
        db::set_liked(&conn, &song("yt:a"), true).unwrap();
        db::create_playlist(&conn, "Mix", None, &[song("yt:a"), song("yt:b")]).unwrap();
        conn.execute(
            "INSERT INTO tracks(path, folder, title, artist, mtime) VALUES ('f/x.mp3', 'f', 'Blue Tone', 'Act', 0)",
            [],
        )
        .unwrap();

        let file = dir.join("my.cadence-backup");
        let made = create(&conn, &file, r#"{"cadence.volume":"0.5"}"#).unwrap();
        assert_eq!((made.playlists, made.liked, made.library_tracks), (1, 1, 1));
        assert!(!dir.join("my.part").exists());

        // Change everything after the backup.
        db::set_liked(&conn, &song("yt:a"), false).unwrap();
        db::create_playlist(&conn, "Later", None, &[]).unwrap();
        conn.execute("DELETE FROM tracks", []).unwrap();

        let (summary, settings, safety) = restore(&conn, &file, &dir.join("safety"), "{}").unwrap();
        assert_eq!(summary, made);
        assert_eq!(settings, r#"{"cadence.volume":"0.5"}"#);
        assert_eq!(db::liked(&conn).unwrap().len(), 1);
        let lists = db::playlists(&conn).unwrap();
        assert_eq!(lists.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Mix"]);
        assert_eq!(db::playlist(&conn, lists[0].id).unwrap().unwrap().tracks.len(), 2);
        // The search index is rebuilt for the restored library.
        assert_eq!(db::tracks(&conn, Some("blue")).unwrap().len(), 1);
        // The data replaced by the restore was kept.
        let (before, _) = peek(&safety).unwrap();
        assert_eq!((before.playlists, before.liked, before.library_tracks), (2, 0, 0));
        // Windows won't delete a database that is still open.
        drop(conn);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_other_files() {
        let dir = temp_dir("reject");
        std::fs::write(dir.join("notes.txt"), "hello").unwrap();
        assert!(peek(&dir.join("notes.txt")).is_err());
        // A plain database that isn't a backup.
        let conn = db::open(&dir.join("other.db")).unwrap();
        drop(conn);
        assert!(peek(&dir.join("other.db")).is_err());
        assert!(peek(&dir.join("missing.cadence-backup")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_only_recent_safety_copies() {
        let dir = temp_dir("prune");
        for i in 0..8 {
            std::fs::write(dir.join(format!("before-restore-{}.cadence-backup", 1000 + i)), "x").unwrap();
        }
        std::fs::write(dir.join("mine.cadence-backup"), "x").unwrap();
        prune(&dir);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left.len(), KEEP_SAFETY_COPIES + 1);
        assert!(left.contains(&"before-restore-1007.cadence-backup".to_string()));
        assert!(!left.contains(&"before-restore-1000.cadence-backup".to_string()));
        assert!(left.contains(&"mine.cadence-backup".to_string()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
