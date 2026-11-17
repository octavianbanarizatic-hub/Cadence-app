//! Saving YouTube songs to disk for offline listening. Songs download one at
//! a time through the same ranged fetch that playback uses, into
//! `<app data>/downloads/<videoId>.<ext>`. Once a song is saved, `media.rs`
//! plays it from there, so every list in the app works offline. Podcast
//! episodes (`pod:<id>`) download the same way, from the publisher, into
//! `pod-<id>.<ext>`.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

use crate::media::{self, Chunk};
use crate::ytdlp::Quality;
use crate::{db, lyrics, podcasts, AppState, Track};

/// A download's state, as sent to the page in `download` events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub track: Track,
    /// queued, downloading, done, failed or removed.
    pub state: &'static str,
    /// Bytes saved so far; the file size once done.
    pub done: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

impl Item {
    fn new(track: Track, state: &'static str) -> Self {
        Self { track, state, done: 0, total: None, error: None }
    }
}

struct Saved {
    track: Track,
    path: PathBuf,
    size: u64,
}

#[derive(Default)]
struct Inner {
    /// Finished downloads, newest first.
    saved: Vec<Saved>,
    /// Waiting songs, each with the quality it was asked for in.
    queue: VecDeque<(Track, Quality)>,
    active: Option<Item>,
    cancelled: HashSet<String>,
}

pub struct Downloads {
    dir: PathBuf,
    inner: Mutex<Inner>,
    wake: Notify,
}

fn video_id(track: &Track) -> Option<&str> {
    track.id.strip_prefix("yt:").filter(|id| media::valid_video_id(id))
}

fn episode_id(track: &Track) -> Option<&str> {
    track.id.strip_prefix("pod:").filter(|id| podcasts::valid_id(id))
}

fn extension(mime: &str) -> &'static str {
    match mime {
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/mpeg" => "mp3",
        _ => "m4a",
    }
}

impl Downloads {
    /// Picks up finished downloads from the database. Rows whose file has
    /// gone missing are returned so the caller can drop them.
    pub fn new(dir: PathBuf, rows: Vec<db::Download>) -> (Self, Vec<String>) {
        let _ = std::fs::create_dir_all(&dir);
        // Leftovers from downloads interrupted by quitting.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                if e.path().extension().is_some_and(|x| x == "part") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let (saved, missing) = Self::load(&dir, rows);
        let inner = Inner { saved, ..Default::default() };
        (Self { dir, inner: Mutex::new(inner), wake: Notify::new() }, missing)
    }

    fn load(dir: &Path, rows: Vec<db::Download>) -> (Vec<Saved>, Vec<String>) {
        let mut missing = Vec::new();
        let mut saved = Vec::new();
        for row in rows {
            let path = dir.join(&row.file);
            if path.is_file() {
                saved.push(Saved { track: row.track, path, size: row.size });
            } else {
                missing.push(row.track.id);
            }
        }
        (saved, missing)
    }

    /// Takes over the finished downloads of a restored database. Like at
    /// startup, rows whose file isn't on this PC are returned for removal.
    pub fn reload(&self, rows: Vec<db::Download>) -> Vec<String> {
        let (saved, missing) = Self::load(&self.dir, rows);
        self.inner.lock().unwrap().saved = saved;
        missing
    }

    /// Where a downloaded YouTube video is on disk.
    pub fn path(&self, video_id: &str) -> Option<PathBuf> {
        let inner = self.inner.lock().unwrap();
        inner
            .saved
            .iter()
            .find(|s| s.track.id.strip_prefix("yt:") == Some(video_id))
            .map(|s| s.path.clone())
    }

    /// Where a downloaded song or episode is on disk, by its track id.
    pub fn path_of(&self, id: &str) -> Option<PathBuf> {
        let inner = self.inner.lock().unwrap();
        inner.saved.iter().find(|s| s.track.id == id).map(|s| s.path.clone())
    }

    /// Covers of downloaded songs, which the cover cache must keep.
    pub fn covers(&self) -> Vec<String> {
        let inner = self.inner.lock().unwrap();
        inner
            .saved
            .iter()
            .filter_map(|s| s.track.thumbnail.clone())
            .filter(|t| t.starts_with("https://"))
            .collect()
    }

    /// Everything, for the Downloads page: the active one, the queue, then
    /// finished downloads.
    pub fn list(&self) -> Vec<Item> {
        let inner = self.inner.lock().unwrap();
        let queued = inner.queue.iter().map(|(t, _)| Item::new(t.clone(), "queued"));
        let saved = inner.saved.iter().map(|s| Item {
            done: s.size,
            total: Some(s.size),
            ..Item::new(s.track.clone(), "done")
        });
        inner.active.clone().into_iter().chain(queued).chain(saved).collect()
    }

    /// Queues YouTube songs and podcast episodes that aren't saved or queued
    /// yet. Returns how many.
    pub fn add(&self, app: &AppHandle, tracks: Vec<Track>, quality: Quality) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let mut added = 0;
        for track in tracks {
            let id = track.id.as_str();
            let known = inner.saved.iter().any(|s| s.track.id == id)
                || inner.queue.iter().any(|(t, _)| t.id == id)
                || inner.active.as_ref().is_some_and(|a| a.track.id == id);
            if known || (video_id(&track).is_none() && episode_id(&track).is_none()) {
                continue;
            }
            inner.cancelled.remove(id);
            let _ = app.emit("download", Item::new(track.clone(), "queued"));
            inner.queue.push_back((track, quality));
            added += 1;
        }
        drop(inner);
        if added > 0 {
            self.wake.notify_one();
        }
        added
    }

    /// Cancels a queued or running download, or deletes a finished one.
    pub fn remove(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(i) = inner.queue.iter().position(|(t, _)| t.id == id) {
            let (track, _) = inner.queue.remove(i).unwrap();
            let _ = app.emit("download", Item::new(track, "removed"));
        } else if inner.active.as_ref().is_some_and(|a| a.track.id == id) {
            // The worker notices between chunks and cleans up.
            inner.cancelled.insert(id.to_string());
        } else if let Some(i) = inner.saved.iter().position(|s| s.track.id == id) {
            let saved = inner.saved.remove(i);
            drop(inner);
            let state = app.state::<AppState>();
            db::remove_download(&state.db.lock().unwrap(), id).map_err(|e| e.to_string())?;
            // If it is playing right now, playback carries on from YouTube.
            let _ = std::fs::remove_file(&saved.path);
            let _ = app.emit("download", Item::new(saved.track, "removed"));
        }
        Ok(())
    }

    fn take_next(&self) -> Option<(Track, Quality)> {
        let mut inner = self.inner.lock().unwrap();
        let (track, quality) = inner.queue.pop_front()?;
        inner.active = Some(Item::new(track.clone(), "downloading"));
        Some((track, quality))
    }

    fn is_cancelled(&self, id: &str) -> bool {
        self.inner.lock().unwrap().cancelled.contains(id)
    }

    fn progress(&self, app: &AppHandle, done: u64, total: Option<u64>) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(active) = inner.active.as_mut() {
            active.done = done;
            active.total = total;
            let _ = app.emit("download", active.clone());
        }
    }

    /// Ends the active download with `item` as its final state.
    fn finish(&self, app: &AppHandle, item: Item, saved: Option<Saved>) {
        let mut inner = self.inner.lock().unwrap();
        inner.active = None;
        inner.cancelled.remove(&item.track.id);
        if let Some(saved) = saved {
            inner.saved.insert(0, saved);
        }
        let _ = app.emit("download", item);
    }

    /// The worker: runs for the life of the app, one download at a time.
    pub async fn run(app: AppHandle) {
        let state = app.state::<AppState>();
        let this = &state.downloads;
        loop {
            let Some((track, quality)) = this.take_next() else {
                this.wake.notified().await;
                continue;
            };
            let outcome = this.save(&app, &state, &track, quality).await;
            match outcome {
                Ok(saved) => {
                    let size = saved.size;
                    let item = Item { done: size, total: Some(size), ..Item::new(track.clone(), "done") };
                    this.finish(&app, item, Some(saved));
                    tauri::async_runtime::spawn(save_extras(app.clone(), track));
                }
                Err(None) => this.finish(&app, Item::new(track, "removed"), None),
                Err(Some(error)) => {
                    eprintln!("download of {} failed: {error}", track.id);
                    this.finish(&app, Item { error: Some(error), ..Item::new(track, "failed") }, None);
                }
            }
        }
    }

    /// Downloads one song. `Err(None)` means it was cancelled.
    async fn save(&self, app: &AppHandle, state: &AppState, track: &Track, quality: Quality) -> Result<Saved, Option<String>> {
        let name = match episode_id(track) {
            Some(id) => format!("pod-{id}"),
            None => video_id(track).ok_or_else(|| Some("Only YouTube songs can be downloaded.".to_string()))?.to_string(),
        };
        let part = self.dir.join(format!("{name}.part"));
        let result = match episode_id(track) {
            Some(id) => self.fetch_episode_to(app, state, track, id, &part).await,
            None => self.fetch_to(app, state, track, &name, quality, &part).await,
        };
        let (size, mime) = match result {
            Ok(done) => done,
            Err(e) => {
                let _ = tokio::fs::remove_file(&part).await;
                return Err(e);
            }
        };
        let file = format!("{name}.{}", extension(mime));
        let path = self.dir.join(&file);
        tokio::fs::rename(&part, &path).await.map_err(|e| Some(e.to_string()))?;
        db::add_download(&state.db.lock().unwrap(), track, &file, size).map_err(|e| Some(e.to_string()))?;
        Ok(Saved { track: track.clone(), path, size })
    }

    async fn fetch_to(
        &self,
        app: &AppHandle,
        state: &AppState,
        track: &Track,
        id: &str,
        quality: Quality,
        part: &Path,
    ) -> Result<(u64, &'static str), Option<String>> {
        let io = |e: std::io::Error| Some(format!("Couldn't save the file: {e}"));
        let mut file = tokio::fs::File::create(part).await.map_err(io)?;
        let mut pos = 0u64;
        let mut mime = "audio/mp4";
        loop {
            if self.is_cancelled(&track.id) {
                return Err(None);
            }
            let chunk = media::fetch_youtube(state, id, quality, pos, None).await.map_err(|(_, e)| Some(e))?;
            let total = match chunk {
                Chunk::Partial { mime: m, body, total } => {
                    if body.is_empty() {
                        return Err(Some("YouTube sent an empty response.".into()));
                    }
                    mime = m;
                    file.write_all(&body).await.map_err(io)?;
                    pos += body.len() as u64;
                    total
                }
                Chunk::Whole { mime: m, body } => {
                    mime = m;
                    file.write_all(&body).await.map_err(io)?;
                    pos = body.len() as u64;
                    pos
                }
                Chunk::PastEnd { total } => total,
            };
            self.progress(app, pos, Some(total));
            if pos >= total {
                break;
            }
        }
        if pos == 0 {
            return Err(Some("YouTube sent an empty file.".into()));
        }
        file.flush().await.map_err(io)?;
        Ok((pos, mime))
    }
}

impl Downloads {
    /// Saves an episode's file, a piece at a time as playback fetches it.
    async fn fetch_episode_to(
        &self,
        app: &AppHandle,
        state: &AppState,
        track: &Track,
        id: &str,
        part: &Path,
    ) -> Result<(u64, &'static str), Option<String>> {
        const PIECE: u64 = 4 * 1024 * 1024;
        let io = |e: std::io::Error| Some(format!("Couldn't save the file: {e}"));
        let episode = podcasts::episode(&state.db.lock().unwrap(), id)
            .ok()
            .flatten()
            .ok_or_else(|| Some("This episode is no longer in its podcast.".to_string()))?;
        let mime = match episode.mime.as_str() {
            "audio/mp4" => "audio/mp4",
            "audio/ogg" => "audio/ogg",
            _ => "audio/mpeg",
        };
        let mut file = tokio::fs::File::create(part).await.map_err(io)?;
        let mut pos = 0u64;
        loop {
            if self.is_cancelled(&track.id) {
                return Err(None);
            }
            let piece = state.episode_links.fetch(&state.http, &episode.url, pos, pos + PIECE - 1).await.map_err(Some)?;
            if piece.body.is_empty() {
                break;
            }
            file.write_all(&piece.body).await.map_err(io)?;
            pos += piece.body.len() as u64;
            self.progress(app, pos, Some(piece.total));
            if pos >= piece.total {
                break;
            }
        }
        if pos == 0 {
            return Err(Some("The podcast sent an empty file.".into()));
        }
        file.flush().await.map_err(io)?;
        Ok((pos, mime))
    }
}

/// The cover and lyrics, so a downloaded song is complete offline. Runs
/// beside the queue; neither is worth failing a download over.
async fn save_extras(app: AppHandle, track: Track) {
    let state = app.state::<AppState>();
    // Episodes have no lyrics, and their artwork is the show's.
    if episode_id(&track).is_some() {
        return;
    }
    if let Some(url) = track.thumbnail.as_deref().filter(|t| t.starts_with("https://")) {
        let _ = media::cached_image(&state, url).await;
    }
    let cached = db::cached_lyrics(&state.db.lock().unwrap(), &track.id).ok().flatten();
    if cached.is_some() {
        return;
    }
    // LRCLIB is sometimes briefly unavailable; one more try.
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        if let Ok(found) = lyrics::fetch(&state.http, &track).await {
            let _ = db::store_lyrics(&state.db.lock().unwrap(), &track.id, found.as_ref());
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str) -> Track {
        Track {
            id: id.into(),
            title: "t".into(),
            artist: "a".into(),
            album: None,
            duration: None,
            thumbnail: Some("https://i.ytimg.com/vi/x/mqdefault.jpg".into()),
            ..Default::default()
        }
    }

    #[test]
    fn startup_skips_missing_files_and_cleans_partials() {
        let dir = std::env::temp_dir().join(format!("cadence-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("aaaaaaaaaaa.m4a"), b"x").unwrap();
        std::fs::write(dir.join("ccccccccccc.part"), b"x").unwrap();
        let rows = vec![
            db::Download { track: track("yt:aaaaaaaaaaa"), file: "aaaaaaaaaaa.m4a".into(), size: 1 },
            db::Download { track: track("yt:bbbbbbbbbbb"), file: "bbbbbbbbbbb.m4a".into(), size: 1 },
        ];
        let (downloads, missing) = Downloads::new(dir.clone(), rows);
        assert_eq!(missing, vec!["yt:bbbbbbbbbbb".to_string()]);
        assert!(downloads.path("aaaaaaaaaaa").is_some());
        assert!(downloads.path("bbbbbbbbbbb").is_none());
        assert!(!dir.join("ccccccccccc.part").exists());
        assert_eq!(downloads.list().len(), 1);
        assert_eq!(downloads.covers().len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_youtube_ids_are_downloadable() {
        assert_eq!(video_id(&track("yt:aaaaaaaaaaa")), Some("aaaaaaaaaaa"));
        assert_eq!(video_id(&track("yt:short")), None);
        assert_eq!(video_id(&track("local:3")), None);
        assert_eq!(extension("audio/webm"), "webm");
        assert_eq!(extension("audio/mp4"), "m4a");
    }
}
