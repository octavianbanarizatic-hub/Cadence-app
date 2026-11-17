//! Scanning music folders into the SQLite library. Phones have no folders to
//! add: music files the user picks are copied into Cadence's own `music`
//! folder (`import`), which is a library folder like any other.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use lofty::prelude::*;
use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::db;

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "webm"];
/// Files are written in batches so other writes are never blocked for long.
const BATCH: usize = 200;
/// Phones: the folder in the app's data that holds imported music files.
pub const IMPORT_DIR: &str = "music";

pub fn mime_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "webm" => "audio/webm",
        _ => "audio/mp4",
    }
}

/// Whether `child` is `parent` or a folder inside it. Separators and (on
/// Windows) letter case are ignored.
pub fn contains(parent: &str, child: &str) -> bool {
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.trim_end_matches('/').to_string();
        if cfg!(windows) {
            p.to_lowercase()
        } else {
            p
        }
    };
    let (parent, child) = (norm(parent), norm(child));
    child == parent || child.starts_with(&format!("{parent}/"))
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

struct TagInfo {
    title: String,
    artist: Option<String>,
    album: Option<String>,
    duration: Option<f64>,
    has_cover: bool,
}

fn non_empty(s: Option<std::borrow::Cow<'_, str>>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn read_tags(path: &Path) -> TagInfo {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Ok(file) = lofty::read_from_path(path) else {
        return TagInfo {
            title: stem,
            artist: None,
            album: None,
            duration: None,
            has_cover: false,
        };
    };
    let tag = file.primary_tag().or_else(|| file.first_tag());
    let duration = file.properties().duration().as_secs_f64();
    TagInfo {
        title: non_empty(tag.and_then(|t| t.title())).unwrap_or(stem),
        artist: non_empty(tag.and_then(|t| t.artist())),
        album: non_empty(tag.and_then(|t| t.album())),
        duration: (duration > 0.0).then_some(duration),
        has_cover: file.tags().iter().any(|t| !t.pictures().is_empty()),
    }
}

/// The embedded front cover (or the first picture) and its MIME type.
pub fn cover(path: &str) -> Option<(Vec<u8>, String)> {
    let file = lofty::read_from_path(path).ok()?;
    let pictures: Vec<_> = file.tags().iter().flat_map(|t| t.pictures()).collect();
    let pic = pictures
        .iter()
        .find(|p| p.pic_type() == lofty::picture::PictureType::CoverFront)
        .or(pictures.first())?;
    let mime = pic
        .mime_type()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "image/jpeg".into());
    Some((pic.data().to_vec(), mime))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    folder: String,
    done: usize,
    total: usize,
    finished: bool,
}

fn mtime(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Brings the library in line with what is on disk: new and changed files are
/// (re)read, files that disappeared are dropped. Unchanged files are skipped.
pub fn scan(app: &AppHandle, db_path: &Path, folders: &[String]) -> Result<(), String> {
    let mut conn = db::open(db_path).map_err(|e| e.to_string())?;
    let err = |e: rusqlite::Error| e.to_string();

    for folder in folders {
        let known: HashMap<String, i64> = {
            let mut stmt = conn
                .prepare("SELECT path, mtime FROM tracks WHERE folder = ?1")
                .map_err(err)?;
            let rows = stmt
                .query_map(params![folder], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(err)?;
            rows.filter_map(Result::ok).collect()
        };
        let files: Vec<PathBuf> = WalkDir::new(folder)
            .follow_links(true)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file() && is_audio(e.path()))
            .map(|e| e.into_path())
            .collect();
        let total = files.len();
        let emit = |done: usize| {
            let _ = app.emit(
                "library-scan",
                ScanProgress {
                    folder: folder.clone(),
                    done,
                    total,
                    finished: false,
                },
            );
        };
        emit(0);

        let mut seen = HashSet::with_capacity(total);
        for (n, batch) in files.chunks(BATCH).enumerate() {
            let tx = conn.transaction().map_err(err)?;
            for path in batch {
                let key = path.to_string_lossy().into_owned();
                let modified = mtime(path);
                seen.insert(key.clone());
                if known.get(&key) == Some(&modified) {
                    continue;
                }
                let tags = read_tags(path);
                tx.execute(
                    "INSERT INTO tracks(path, folder, title, artist, album, duration, has_cover, mtime)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(path) DO UPDATE SET folder = excluded.folder,
                       title = excluded.title, artist = excluded.artist, album = excluded.album,
                       duration = excluded.duration, has_cover = excluded.has_cover,
                       mtime = excluded.mtime",
                    params![
                        key,
                        folder,
                        tags.title,
                        tags.artist,
                        tags.album,
                        tags.duration,
                        tags.has_cover,
                        modified
                    ],
                )
                .map_err(err)?;
            }
            tx.commit().map_err(err)?;
            emit(((n + 1) * BATCH).min(total));
        }

        let tx = conn.transaction().map_err(err)?;
        for gone in known.keys().filter(|k| !seen.contains(*k)) {
            tx.execute("DELETE FROM tracks WHERE path = ?1", params![gone])
                .map_err(err)?;
        }
        // The folder may have been removed while it was being scanned.
        tx.execute(
            "DELETE FROM tracks WHERE folder = ?1 AND folder NOT IN (SELECT path FROM folders)",
            params![folder],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
    }

    let _ = app.emit(
        "library-scan",
        ScanProgress {
            folder: String::new(),
            done: 0,
            total: 0,
            finished: true,
        },
    );
    Ok(())
}

/// What one import did.
#[derive(Debug, Default, Serialize)]
pub struct Imported {
    pub added: usize,
    /// Imported before (the same name and size).
    pub existing: usize,
    /// Picked files that aren't music Cadence can play.
    pub unsupported: usize,
    pub failed: usize,
}

#[cfg(target_os = "android")]
#[derive(Clone, Serialize)]
struct ImportProgress {
    done: usize,
    total: usize,
}

/// Where an imported file called `name` goes in `dir`: under its own name, or
/// "name (2).mp3" and so on when another file has it. `None` when the same
/// file (the same name and size) is already there.
#[cfg(any(target_os = "android", test))]
fn import_target(dir: &Path, name: &str, size: i64) -> Option<PathBuf> {
    let name = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "song".into());
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (name.clone(), String::new()),
    };
    (1..).find_map(|n| {
        let path = if n == 1 { dir.join(&name) } else { dir.join(format!("{stem} ({n}){ext}")) };
        match std::fs::metadata(&path) {
            Err(_) => Some(Some(path)),
            Ok(m) if size >= 0 && m.len() == size as u64 => Some(None),
            Ok(_) => None,
        }
    })?
}

/// Phones: lets the user pick music files (or a folder of them), copies them
/// into the import folder and adds them to the library. `None` when nothing
/// was picked. Blocks until the user is done picking and copying ends.
#[cfg(target_os = "android")]
pub fn import(app: &AppHandle, folder: bool) -> Result<Option<Imported>, String> {
    use tauri::Manager;
    use tauri_plugin_cadence_android::CadenceAndroidExt;

    let picked = app.cadence_android().pick_music(folder)?;
    if picked.is_empty() {
        return Ok(None);
    }
    let state = app.state::<crate::AppState>();
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(IMPORT_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dir_name = dir.to_string_lossy().into_owned();
    db::add_folder(&state.db.lock().unwrap(), &dir_name).map_err(|e| e.to_string())?;

    let (music, other): (Vec<_>, Vec<_>) = picked.into_iter().partition(|f| is_audio(Path::new(&f.name)));
    let mut result = Imported {
        // A folder's covers and notes aren't worth mentioning.
        unsupported: if folder { 0 } else { other.len() },
        ..Default::default()
    };
    let total = music.len();
    for (done, file) in music.iter().enumerate() {
        let _ = app.emit("music-import", ImportProgress { done, total });
        let Some(target) = import_target(&dir, &file.name, file.size) else {
            result.existing += 1;
            continue;
        };
        // Copied under another name first, so a cut-off copy is never scanned.
        let part = target.with_extension("part");
        let copied = app
            .cadence_android()
            .copy_music(&file.uri, &part.to_string_lossy())
            .and_then(|_| std::fs::rename(&part, &target).map_err(|e| e.to_string()));
        match copied {
            Ok(()) => result.added += 1,
            Err(e) => {
                eprintln!("importing {} failed: {e}", file.name);
                let _ = std::fs::remove_file(&part);
                result.failed += 1;
            }
        }
    }
    let _ = app.emit("music-import", ImportProgress { done: total, total });
    scan(app, &state.db_path, &[dir_name])?;
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::{contains, import_target};

    #[test]
    fn import_names() {
        let dir = std::env::temp_dir().join(format!("cadence-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(import_target(&dir, "Song.mp3", 3), Some(dir.join("Song.mp3")));
        std::fs::write(dir.join("Song.mp3"), b"abc").unwrap();
        // The same file again is skipped; another one by that name is kept too.
        assert_eq!(import_target(&dir, "Song.mp3", 3), None);
        assert_eq!(import_target(&dir, "Song.mp3", 5), Some(dir.join("Song (2).mp3")));
        std::fs::write(dir.join("Song (2).mp3"), b"abcde").unwrap();
        assert_eq!(import_target(&dir, "Song.mp3", 5), None);
        assert_eq!(import_target(&dir, "Song.mp3", 7), Some(dir.join("Song (3).mp3")));
        // Only the name counts, never a folder in it.
        assert_eq!(import_target(&dir, "../x/Other.flac", -1), Some(dir.join("Other.flac")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn folder_nesting() {
        assert!(contains(r"C:\Music", r"C:\Music"));
        assert!(contains(r"C:\Music", r"C:\Music\Rock"));
        assert!(contains(r"C:\Music\", "C:/Music/Rock/80s"));
        assert!(!contains(r"C:\Music", r"C:\Musicals"));
        assert!(!contains(r"C:\Music\Rock", r"C:\Music"));
        if cfg!(windows) {
            assert!(contains(r"c:\music", r"C:\Music\Rock"));
        }
    }
}
