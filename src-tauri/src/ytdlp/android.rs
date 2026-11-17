//! yt-dlp on Android: the copy bundled in the app (with its own Python and
//! QuickJS), run through Cadence's Kotlin plugin.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_cadence_android::CadenceAndroidExt;
use tokio::sync::RwLock;

use super::{Status, UPDATE_INTERVAL};

pub struct YtDlp {
    app: AppHandle,
    /// Touched after every update check; its age says when the next is due.
    stamp: PathBuf,
    /// Runs share it; an update takes it alone so no run sees a half-written copy.
    lock: RwLock<()>,
    /// yt-dlp's cache. It finds no home folder on Android and would cache
    /// nothing, fetching YouTube's player (3 MB) and working out its
    /// signature code again for every song.
    cache_dir: PathBuf,
    /// Holds `player_cache.py`, which lets yt-dlp keep YouTube's prepared
    /// player script; `None` if it couldn't be written.
    plugin_dir: Option<String>,
    /// `worker.py`, which the plugin keeps running so songs don't wait for
    /// Python to start; `None` if it couldn't be written (runs then start
    /// their own Python, as before).
    worker: Option<String>,
}

/// YouTube replaces its player every week or two; prepared copies of old
/// ones (4 MB each) are deleted after this long.
const PLAYER_CACHE_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

/// Writes Cadence's yt-dlp plugin where `--plugin-dirs` finds it.
fn install_plugin(bin_dir: &Path) -> Option<String> {
    let root = bin_dir.join("ytdlp-plugins");
    // yt-dlp looks for plugin packages inside the folder it's given.
    let dir = root.join("cadence").join("yt_dlp_plugins").join("extractor");
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::write(dir.join("cadence_player_cache.py"), include_str!("player_cache.py")).ok()?;
    Some(root.to_string_lossy().into_owned())
}

/// Writes the worker script the plugin runs (see `YtdlpWorker.kt`).
fn install_worker(bin_dir: &Path) -> Option<String> {
    let path = bin_dir.join("ytdlp-worker.py");
    std::fs::create_dir_all(bin_dir).ok()?;
    std::fs::write(&path, include_str!("worker.py")).ok()?;
    Some(path.to_string_lossy().into_owned())
}

impl YtDlp {
    pub fn new(app: AppHandle, bin_dir: PathBuf) -> Self {
        Self {
            app,
            stamp: bin_dir.join("ytdlp-checked"),
            lock: RwLock::new(()),
            cache_dir: bin_dir.join("ytdlp-cache"),
            plugin_dir: install_plugin(&bin_dir),
            worker: install_worker(&bin_dir),
        }
        .trim_player_cache()
    }

    /// Where yt-dlp keeps prepared players (and its solver's own scripts).
    fn player_cache(&self) -> PathBuf {
        self.cache_dir.join("challenge-solver")
    }

    /// Deletes prepared players nothing has written for a while.
    fn trim_player_cache(self) -> Self {
        let old = |e: &std::fs::DirEntry| {
            e.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age > PLAYER_CACHE_AGE)
        };
        if let Ok(entries) = std::fs::read_dir(self.player_cache()) {
            for entry in entries.flatten().filter(old) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        self
    }

    /// The plugin blocks until yt-dlp is done, so call it off the async runtime.
    async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let app = self.app.clone();
        tauri::async_runtime::spawn_blocking(move || f(&app))
            .await
            .map_err(|e| e.to_string())?
    }

    pub async fn status(&self) -> Status {
        // Waits out a running update, so the version shown is the new one.
        let _guard = self.lock.read().await;
        let version = self
            .call(|app| app.cadence_android().ytdlp_version())
            .await
            .ok()
            .flatten();
        Status {
            installed: version.is_some(),
            managed: true,
            version,
            path: None,
            js_runtime: Some("quickjs"),
        }
    }

    /// Also due on first launch: the copy in the app is as old as the app.
    pub fn update_due(&self) -> bool {
        std::fs::metadata(&self.stamp)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_none_or(|age| age > UPDATE_INTERVAL)
    }

    /// Updates the bundled copy to the latest release. Returns the new
    /// version, or `None` when it was already current.
    pub async fn update(&self, _http: &reqwest::Client) -> Result<Option<String>, String> {
        let _guard = self.lock.write().await;
        let update = self.call(|app| app.cadence_android().ytdlp_update()).await?;
        if let Some(dir) = self.stamp.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.stamp, b"");
        if update.updated {
            // A new yt-dlp may prepare players differently.
            let _ = std::fs::remove_dir_all(self.player_cache());
        }
        Ok(update.version.filter(|_| update.updated))
    }

    /// yt-dlp always comes with the app here; "installing" means updating it.
    pub async fn install(
        &self,
        http: &reqwest::Client,
        _progress: impl FnMut(u64, Option<u64>),
    ) -> Result<String, String> {
        self.update(http).await?;
        self.status()
            .await
            .version
            .ok_or_else(|| "yt-dlp does not run on this phone".to_string())
    }

    pub(super) async fn run_json(&self, args: &[&str]) -> Result<Value, String> {
        let _guard = self.lock.read().await;
        let cache_dir = self.cache_dir.to_string_lossy();
        let plugins = self.plugin_dir.as_deref().map(|d| ["--plugin-dirs", d]);
        let args: Vec<String> = super::BASE_ARGS
            .iter()
            .chain(&["--cache-dir", &cache_dir])
            .chain(plugins.iter().flatten())
            // Cadence only plays YouTube's plain audio streams; not fetching the
            // HLS and DASH lists saves a request (about half a second) per song.
            .chain(&["--extractor-args", "youtube:skip=hls,dash,translated_subs"])
            .chain(args)
            .map(|s| s.to_string())
            .collect();
        let run = |args: Vec<String>| {
            let worker = self.worker.clone();
            self.call(move |app| app.cadence_android().ytdlp(&args, worker.as_deref()))
        };
        let mut out = run(args.clone()).await?;
        // A prepared player that went bad would fail every song: drop it and
        // try once more without. Other failures (a removed video) keep it.
        let err = out.err.to_lowercase();
        let solving = ["challenge", "signature", "requested format", "quickjs"].iter().any(|w| err.contains(w));
        if out.exit_code != 0 && solving && std::fs::remove_dir_all(self.player_cache()).is_ok() {
            out = run(args).await?;
        }
        super::parse_output(out.exit_code == 0, out.out.as_bytes(), &out.err)
    }
}
