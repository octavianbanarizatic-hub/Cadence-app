mod backup;
mod commands;
mod db;
mod downloads;
mod importer;
mod library;
mod lyrics;
mod media;
#[cfg(desktop)]
mod mini;
#[cfg(desktop)]
mod winicon;
mod podcasts;
mod share;
mod updater;
mod ytdlp;
mod ytmusic;
mod yours;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// A playable item, either a YouTube video or a file in the local library.
/// `id` is prefixed with its source: `yt:<videoId>` or `local:<rowid>`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    /// YouTube Music ids for the album (`MPREb_…`) and first artist (`UC…`)
    /// pages. Missing for local files and songs saved before they existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist_id: Option<String>,
    /// Every artist of a song that has several, in the order `artist` names
    /// them. Empty for one artist (`artist` and `artist_id` say it all), for
    /// local files and for songs saved before this existed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artists: Vec<TrackArtist>,
}

/// One of a song's artists; `id` is their YouTube Music page (`UC…`), if
/// they have one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackArtist {
    pub name: String,
    pub id: Option<String>,
}

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub db_path: PathBuf,
    pub http: reqwest::Client,
    pub ytdlp: ytdlp::YtDlp,
    pub streams: media::StreamCache,
    /// Caps background yt-dlp runs started by hovering or queue look-ahead.
    pub prefetch_slots: tokio::sync::Semaphore,
    pub image_cache: media::ImageCache,
    pub downloads: downloads::Downloads,
    /// Where podcast episodes' links lead (podcasts.rs).
    pub episode_links: podcasts::Redirects,
}

impl AppState {
    /// Photos picked as playlist covers, next to the database.
    pub fn playlist_covers(&self) -> PathBuf {
        self.db_path.with_file_name("playlist-covers")
    }

    /// A picked cover's file, if it's there (backups don't carry the photos).
    pub fn playlist_cover(&self, name: &str) -> Option<PathBuf> {
        // Only plain names; never a path out of the folder.
        let plain = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') && !name.starts_with('.');
        let path = self.playlist_covers().join(name);
        (plain && path.is_file()).then_some(path)
    }
}

pub type CmdResult<T> = Result<T, String>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = {
        use tauri_plugin_window_state::StateFlags;
        builder
            // Must come first: a second launch focuses the running window instead.
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                // Also leaves the mini player: launching the app means the full window.
                let _ = mini::close(app);
            }))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    // The main window is hidden while the mini player is up; it
                    // must never come back hidden on the next launch.
                    .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                    .skip_initial_state(mini::LABEL)
                    .build(),
            )
            .on_window_event(|window, event| {
                use tauri::WindowEvent;
                // Icons are loaded for one DPI; reload them on another monitor.
                if let WindowEvent::ScaleFactorChanged { .. } = event {
                    if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                        winicon::apply(&w);
                    }
                }
                // However the mini player goes away (Alt+F4, the taskbar), the
                // main window must come back, or the app would be invisible.
                if let WindowEvent::Destroyed = event {
                    if window.label() == mini::LABEL {
                        let _ = mini::show_main(window.app_handle());
                    }
                }
            })
    };
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_cadence_android::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("media", |ctx, request, responder| {
            media::handle(ctx.app_handle().clone(), request, responder);
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("cadence.db");
            let conn = db::open(&db_path)?;
            let (downloads, missing) = downloads::Downloads::new(data_dir.join("downloads"), db::downloads(&conn)?);
            for id in missing {
                db::remove_download(&conn, &id)?;
            }
            let http = reqwest::Client::builder()
                .user_agent(ytmusic::BROWSER_UA)
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(20))
                .build()?;
            app.manage(AppState {
                db: Mutex::new(conn),
                db_path,
                http,
                #[cfg(desktop)]
                ytdlp: ytdlp::YtDlp::new(data_dir.join("bin")),
                #[cfg(target_os = "android")]
                ytdlp: ytdlp::YtDlp::new(app.handle().clone(), data_dir.join("bin")),
                streams: media::StreamCache::default(),
                prefetch_slots: tokio::sync::Semaphore::new(2),
                image_cache: media::ImageCache::new(app.path().app_cache_dir()?.join("covers")),
                downloads,
                episode_links: podcasts::Redirects::default(),
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<AppState>();
                // Downloaded songs need their covers offline.
                let keep = state.downloads.covers().iter().map(|url| state.image_cache.path_for(url)).collect();
                state.image_cache.trim(&keep);
            });
            tauri::async_runtime::spawn(downloads::Downloads::run(app.handle().clone()));

            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                winicon::apply(&window);
            }

            // Keep the managed yt-dlp current; YouTube breaks old releases.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                if !state.ytdlp.update_due() {
                    return;
                }
                match state.ytdlp.update(&state.http).await {
                    Ok(Some(version)) => {
                        let _ = handle.emit("ytdlp-updated", version);
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("yt-dlp update failed: {e}"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::search,
            commands::search_pages,
            commands::youtube_playlist,
            commands::prefetch,
            commands::ytdlp_status,
            commands::ytdlp_install,
            commands::ytdlp_update,
            commands::library_folders,
            commands::library_add_folder,
            commands::library_remove_folder,
            commands::library_rescan,
            commands::library_tracks,
            commands::music_import,
            commands::music_remove,
            commands::liked_list,
            commands::liked_set,
            commands::liked_set_many,
            commands::play_start,
            commands::play_time,
            commands::listening_stats,
            commands::lyrics,
            commands::mini_player,
            commands::media_state,
            commands::nav_bar_height,
            commands::app_update_check,
            commands::app_update_install,
            commands::downloads_list,
            commands::download_add,
            commands::download_remove,
            commands::album,
            commands::songs,
            commands::share,
            commands::shared_link,
            commands::unmetered_network,
            commands::share_image,
            commands::share_link,
            commands::open_link,
            commands::image_save,
            commands::artist,
            commands::recommendations,
            commands::playlists_list,
            commands::playlist_get,
            commands::playlist_create,
            commands::playlist_rename,
            commands::playlist_delete,
            commands::playlist_cover_pick,
            commands::playlist_cover_set,
            commands::playlist_cover_clear,
            commands::playlist_add,
            commands::playlist_set_tracks,
            commands::playlist_import,
            commands::backup_create,
            commands::backup_peek,
            commands::backup_restore,
            commands::podcast_search,
            commands::podcast_show,
            commands::podcast_follow,
            commands::podcasts_followed,
            commands::podcast_new_episodes,
            commands::podcast_progress,
            commands::podcast_spot,
            commands::your_songs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cadence");
}
