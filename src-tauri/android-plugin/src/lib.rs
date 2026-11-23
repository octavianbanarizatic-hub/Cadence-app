//! Cadence's Android-only native parts, written in Kotlin (see `android/`).
//! Besides yt-dlp, the plugin routes the back button to the page and runs the
//! media session (lock screen and notification controls) with a foreground
//! service that keeps the music going while the screen is off, it opens
//! Android's installer for app updates, it imports music files the user
//! picks in Android's file picker, it saves photos picked as playlist
//! covers, and it shares Cadence links and hands over the ones that open it.
//! It also draws the home-screen widget, lists the library for Android Auto,
//! and says whether the connection is metered (automatic downloads).
//!
//! yt-dlp is a Python program, and Android cannot run the desktop build of it.
//! The Kotlin side uses youtubedl-android, which ships Python, yt-dlp and
//! QuickJS (the JavaScript runtime YouTube now needs) inside the app.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime};

pub struct CadenceAndroid<R: Runtime>(PluginHandle<R>);

/// What one yt-dlp run printed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub exit_code: i32,
    pub out: String,
    pub err: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    /// False when the bundled copy was already the latest release.
    pub updated: bool,
    pub version: Option<String>,
}

#[derive(Serialize)]
struct Args<'a> {
    args: &'a [String],
    worker: Option<&'a str>,
}

#[derive(Serialize)]
struct InstallArgs<'a> {
    path: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Installed {
    opened: bool,
}

#[derive(Deserialize)]
struct Bars {
    bottom: f64,
}

/// A music file picked in Android's file picker. Only Android can read its
/// `uri`; `copy_music` makes a copy Rust can read.
#[derive(Debug, Deserialize)]
pub struct PickedFile {
    pub uri: String,
    pub name: String,
    /// -1 when Android doesn't say.
    pub size: i64,
}

#[derive(Deserialize)]
struct Picked {
    files: Vec<PickedFile>,
}

#[derive(Serialize)]
struct PickArgs {
    folder: bool,
}

#[derive(Serialize)]
struct PathArgs<'a> {
    path: &'a str,
}

#[derive(Deserialize)]
struct Saved {
    saved: bool,
}

#[derive(Serialize)]
struct ShareArgs<'a> {
    text: &'a str,
}

#[derive(Deserialize)]
struct Link {
    url: Option<String>,
}

#[derive(Deserialize)]
struct Network {
    unmetered: bool,
}

#[derive(Serialize)]
struct CopyArgs<'a> {
    uri: &'a str,
    path: &'a str,
}

#[derive(Serialize)]
struct BackupArgs<'a> {
    path: &'a str,
    name: &'a str,
    keep: u32,
}

#[derive(Deserialize)]
struct Place {
    place: String,
}

#[derive(Serialize)]
struct WatchArgs<'a> {
    json: &'a str,
    on: bool,
}

#[derive(Deserialize)]
struct Allowed {
    allowed: bool,
}

/// Where the music plays: `kind` is "phone", "bluetooth", "headphones" or
/// "speaker"; `name` is the device's own, when Android has one worth showing.
#[derive(Debug, Deserialize, Serialize)]
pub struct AudioOutput {
    pub kind: String,
    pub name: Option<String>,
}

/// These calls block until yt-dlp finishes; run them off the async runtime.
impl<R: Runtime> CadenceAndroid<R> {
    /// Runs yt-dlp; with `worker` (Cadence's worker script), in the Python kept running for it.
    pub fn ytdlp(&self, args: &[String], worker: Option<&str>) -> Result<Output, String> {
        self.0
            .run_mobile_plugin("ytdlp", Args { args, worker })
            .map_err(|e| e.to_string())
    }

    pub fn ytdlp_version(&self) -> Result<Option<String>, String> {
        self.0
            .run_mobile_plugin::<Version>("ytdlpVersion", ())
            .map(|v| v.version)
            .map_err(|e| e.to_string())
    }

    pub fn ytdlp_update(&self) -> Result<Update, String> {
        self.0.run_mobile_plugin("ytdlpUpdate", ()).map_err(|e| e.to_string())
    }

    /// Shows `state` (the page's `MediaState`) on the lock screen and in the
    /// notification, and keeps the app running while it plays.
    pub fn media(&self, state: &impl Serialize) -> Result<(), String> {
        self.0
            // It answers with nothing (null), so any answer will do.
            .run_mobile_plugin::<serde::de::IgnoredAny>("mediaUpdate", state)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// The navigation bar's height in CSS pixels. The page draws behind it
    /// and pads its bottom-most parts by this much.
    pub fn nav_bar_height(&self) -> Result<f64, String> {
        self.0
            .run_mobile_plugin::<Bars>("systemBars", ())
            .map(|b| b.bottom)
            .map_err(|e| e.to_string())
    }

    /// Opens Android's file picker for music files (or, with `folder`, a
    /// folder: every file in it and its subfolders). Waits for the user to
    /// pick; nothing when they cancel.
    pub fn pick_music(&self, folder: bool) -> Result<Vec<PickedFile>, String> {
        self.0
            .run_mobile_plugin::<Picked>("pickMusic", PickArgs { folder })
            .map(|p| p.files)
            .map_err(|e| e.to_string())
    }

    /// Copies a picked file to `path`.
    pub fn copy_music(&self, uri: &str, path: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("copyMusic", CopyArgs { uri, path })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Opens Android's photo picker and saves the photo picked, cropped to a
    /// square JPEG, at `path`. Waits for the user; false when they cancel.
    pub fn pick_cover(&self, path: &str) -> Result<bool, String> {
        self.0
            .run_mobile_plugin::<Saved>("pickCover", PathArgs { path })
            .map(|s| s.saved)
            .map_err(|e| e.to_string())
    }

    /// Opens Android's share sheet with `text` (a Cadence link).
    pub fn share(&self, text: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("share", ShareArgs { text })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Opens Android's share sheet with the picture at `path` (in the cache folder).
    pub fn share_image(&self, path: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("shareImage", PathArgs { path })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Saves the backup file at `path` in Downloads → Cadence backups as
    /// `name`; with `keep` above 0, only the newest `keep` automatic ones stay.
    /// Returns where it went, for the page to say.
    pub fn save_backup(&self, path: &str, name: &str, keep: u32) -> Result<String, String> {
        self.0
            .run_mobile_plugin::<Place>("saveBackup", BackupArgs { path, name, keep })
            .map(|p| p.place)
            .map_err(|e| e.to_string())
    }

    /// Opens Android's file picker for a backup and copies it to `path`.
    /// Waits for the user; false when they cancel.
    pub fn pick_backup(&self, path: &str) -> Result<bool, String> {
        self.0
            .run_mobile_plugin::<Saved>("pickBackup", PathArgs { path })
            .map(|s| s.saved)
            .map_err(|e| e.to_string())
    }

    /// Who to check for new releases in the background (the page's JSON), or
    /// with `on` false, stops the checks.
    pub fn watch_releases(&self, json: &str, on: bool) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("watchReleases", WatchArgs { json, on })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Whether Cadence may notify; asks the first time on Android 13 and newer.
    pub fn allow_notifications(&self) -> Result<bool, String> {
        self.0
            .run_mobile_plugin::<Allowed>("allowNotifications", ())
            .map(|a| a.allowed)
            .map_err(|e| e.to_string())
    }

    /// Where the music plays now; the page hears of changes as
    /// `window.__cadenceOutput(output)`.
    pub fn audio_output(&self) -> Result<AudioOutput, String> {
        self.0.run_mobile_plugin("audioOutput", ()).map_err(|e| e.to_string())
    }

    /// Opens Android's panel for picking where the music plays (Bluetooth
    /// settings on phones without one).
    pub fn pick_audio_output(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde::de::IgnoredAny>("pickAudioOutput", ())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Whether the connection is Wi-Fi or another one that isn't metered.
    pub fn unmetered(&self) -> Result<bool, String> {
        self.0
            .run_mobile_plugin::<Network>("network", ())
            .map(|n| n.unmetered)
            .map_err(|e| e.to_string())
    }

    /// The link that opened the app, once; later ones arrive while it runs,
    /// and the page hears of them as `window.__cadenceLink()`.
    pub fn take_link(&self) -> Result<Option<String>, String> {
        self.0
            .run_mobile_plugin::<Link>("takeLink", ())
            .map(|l| l.url)
            .map_err(|e| e.to_string())
    }

    /// Opens Android's installer for the APK at `path` (an app update). False
    /// when Android first wants permission to install apps from Cadence: its
    /// settings screen opens instead.
    pub fn install_apk(&self, path: &str) -> Result<bool, String> {
        self.0
            .run_mobile_plugin::<Installed>("installApk", InstallArgs { path })
            .map(|i| i.opened)
            .map_err(|e| e.to_string())
    }
}

pub trait CadenceAndroidExt<R: Runtime> {
    fn cadence_android(&self) -> &CadenceAndroid<R>;
}

impl<R: Runtime, T: Manager<R>> CadenceAndroidExt<R> for T {
    fn cadence_android(&self) -> &CadenceAndroid<R> {
        self.state::<CadenceAndroid<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("cadence-android")
        .setup(|app, api| {
            let handle = api.register_android_plugin("dev.cadence.android", "CadencePlugin")?;
            app.manage(CadenceAndroid(handle));
            Ok(())
        })
        .build()
}
