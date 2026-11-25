use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{backup, db, downloads, importer, library, lyrics, podcasts, share, updater, yours, ytdlp, ytmusic, AppState, CmdResult, Track};

fn db_err(e: rusqlite::Error) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn search(state: State<'_, AppState>, query: String) -> CmdResult<Vec<Track>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    match ytmusic::search(&state.http, query).await {
        Ok(results) if !results.is_empty() => Ok(results),
        // No songs matched; plain YouTube may still have videos. If that
        // fails too (e.g. yt-dlp is not set up yet), it is simply no results.
        Ok(_) => Ok(state.ytdlp.search(query).await.unwrap_or_default()),
        Err(e) => {
            eprintln!("YouTube Music search failed, falling back to yt-dlp: {e}");
            state.ytdlp.search(query).await.map_err(|e2| {
                eprintln!("yt-dlp search failed too: {e2}");
                "Couldn't reach YouTube. Check your internet connection and try again.".into()
            })
        }
    }
}

/// Artists and albums that match `query` (the search page shows songs from `search`).
#[tauri::command]
pub async fn search_pages(state: State<'_, AppState>, query: String) -> CmdResult<ytmusic::Pages> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(ytmusic::Pages { artists: Vec::new(), albums: Vec::new() });
    }
    ytmusic::search_pages(&state.http, query).await
}

/// A playlist on YouTube, opened from a link shared to Cadence.
#[derive(Serialize)]
pub struct YoutubePlaylist {
    title: String,
    tracks: Vec<Track>,
}

#[tauri::command]
pub async fn youtube_playlist(state: State<'_, AppState>, id: String) -> CmdResult<YoutubePlaylist> {
    if !share::valid_list_id(&id) {
        return Err("bad playlist id".into());
    }
    let (title, tracks) = ytmusic::playlist(&state.http, &id).await?;
    Ok(YoutubePlaylist { title, tracks })
}

/// Resolves a YouTube stream ahead of time so the next track starts instantly.
/// Returns false when it was skipped because enough prefetches are running.
#[tauri::command]
pub async fn prefetch(state: State<'_, AppState>, id: String) -> CmdResult<bool> {
    let Some(video_id) = id.strip_prefix("yt:") else {
        return Ok(true);
    };
    // Downloaded songs play from disk; there is nothing to resolve.
    if state.downloads.path(video_id).is_some() {
        return Ok(true);
    }
    let Ok(_slot) = state.prefetch_slots.try_acquire() else {
        return Ok(false);
    };
    state.streams.get(&state.ytdlp, video_id, ytdlp::Quality::Normal).await?;
    Ok(true)
}

#[tauri::command]
pub async fn ytdlp_status(state: State<'_, AppState>) -> CmdResult<ytdlp::Status> {
    Ok(state.ytdlp.status().await)
}

#[derive(Clone, Serialize)]
struct InstallProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn ytdlp_install(app: AppHandle, state: State<'_, AppState>) -> CmdResult<ytdlp::Status> {
    let mut last_emit = 0;
    state
        .ytdlp
        .install(&state.http, |downloaded, total| {
            // Report roughly every 256 KB.
            if downloaded - last_emit >= 256 * 1024 || Some(downloaded) == total {
                last_emit = downloaded;
                let _ = app.emit("ytdlp-progress", InstallProgress { downloaded, total });
            }
        })
        .await?;
    Ok(state.ytdlp.status().await)
}

/// Looks for a newer yt-dlp now rather than at the weekly check.
#[tauri::command]
pub async fn ytdlp_update(state: State<'_, AppState>) -> CmdResult<ytdlp::Status> {
    state.ytdlp.update(&state.http).await?;
    Ok(state.ytdlp.status().await)
}

fn spawn_scan(app: AppHandle, folders: Vec<String>) {
    tauri::async_runtime::spawn_blocking(move || {
        let db_path = app.state::<AppState>().db_path.clone();
        if let Err(e) = library::scan(&app, &db_path, &folders) {
            eprintln!("library scan failed: {e}");
            let _ = app.emit("library-scan-error", e);
        }
    });
}

#[tauri::command]
pub fn library_folders(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    db::folders(&state.db.lock().unwrap()).map_err(db_err)
}

#[tauri::command]
pub fn library_add_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<Vec<String>> {
    if !std::path::Path::new(&path).is_dir() {
        return Err("That folder doesn't exist.".into());
    }
    let folders = {
        let conn = state.db.lock().unwrap();
        // A track belongs to one folder, so library folders must not nest.
        for existing in db::folders(&conn).map_err(db_err)? {
            if library::contains(&existing, &path) {
                return Err(format!("That folder is already in your library (inside {existing})."));
            }
            if library::contains(&path, &existing) {
                return Err(format!(
                    "That folder contains {existing}, which is already in your library. Remove it first."
                ));
            }
        }
        db::add_folder(&conn, &path).map_err(db_err)?;
        db::folders(&conn).map_err(db_err)?
    };
    spawn_scan(app, vec![path]);
    Ok(folders)
}

#[tauri::command]
pub fn library_remove_folder(state: State<'_, AppState>, path: String) -> CmdResult<Vec<String>> {
    let conn = state.db.lock().unwrap();
    db::remove_folder(&conn, &path).map_err(db_err)?;
    db::folders(&conn).map_err(db_err)
}

#[tauri::command]
pub fn library_rescan(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let folders = db::folders(&state.db.lock().unwrap()).map_err(db_err)?;
    spawn_scan(app, folders);
    Ok(())
}

#[tauri::command]
pub fn library_tracks(state: State<'_, AppState>, query: Option<String>) -> CmdResult<Vec<Track>> {
    db::tracks(&state.db.lock().unwrap(), query.as_deref()).map_err(db_err)
}

/// Phones: picks music files (or a folder of them) and imports them into
/// the library. `None` when nothing was picked.
#[tauri::command]
pub async fn music_import(app: AppHandle, folder: bool) -> CmdResult<Option<library::Imported>> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || library::import(&app, folder))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(desktop)]
    {
        let _ = (app, folder);
        Err("Add a folder in Library instead.".into())
    }
}

/// Phones: deletes an imported song, Cadence's copy included.
#[tauri::command]
pub fn music_remove(app: AppHandle, state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(library::IMPORT_DIR);
    let mut conn = state.db.lock().unwrap();
    let Some(path) = db::track_path(&conn, id).map_err(db_err)? else { return Ok(()) };
    // Only Cadence's own copies; never a file in a folder of the user's.
    if !library::contains(&dir.to_string_lossy(), &path) {
        return Err("Only imported songs can be removed.".into());
    }
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
        _ => {}
    }
    db::remove_track(&mut conn, id).map_err(db_err)
}

#[tauri::command]
pub fn liked_list(state: State<'_, AppState>) -> CmdResult<Vec<Track>> {
    db::liked(&state.db.lock().unwrap()).map_err(db_err)
}

#[tauri::command]
pub async fn lyrics(state: State<'_, AppState>, track: Track) -> CmdResult<Option<lyrics::Lyrics>> {
    // Lyrics embedded in a local file win; they are read fresh each time.
    if let Some(id) = track.id.strip_prefix("local:").and_then(|id| id.parse::<i64>().ok()) {
        let path = db::track_path(&state.db.lock().unwrap(), id).map_err(db_err)?;
        if let Some(path) = path {
            let embedded = tauri::async_runtime::spawn_blocking(move || lyrics::from_tags(&path))
                .await
                .map_err(|e| e.to_string())?;
            if embedded.is_some() {
                return Ok(embedded);
            }
        }
    }
    if let Some(hit) = db::cached_lyrics(&state.db.lock().unwrap(), &track.id).map_err(db_err)? {
        return Ok(hit);
    }
    let found = lyrics::fetch(&state.http, &track).await?;
    db::store_lyrics(&state.db.lock().unwrap(), &track.id, found.as_ref()).map_err(db_err)?;
    Ok(found)
}

#[tauri::command]
pub fn liked_set(state: State<'_, AppState>, track: Track, liked: bool) -> CmdResult<()> {
    db::set_liked(&state.db.lock().unwrap(), &track, liked).map_err(db_err)
}

/// Likes or unlikes a whole list at once; returns how many songs changed.
#[tauri::command]
pub fn liked_set_many(state: State<'_, AppState>, tracks: Vec<Track>, liked: bool) -> CmdResult<usize> {
    db::set_liked_many(&mut state.db.lock().unwrap(), &tracks, liked).map_err(db_err)
}

/// Records a play heard for a while; returns its id for `play_time`.
#[tauri::command]
pub fn play_start(state: State<'_, AppState>, track: Track, seconds: u32) -> CmdResult<i64> {
    db::add_play(&state.db.lock().unwrap(), &track, seconds).map_err(db_err)
}

/// How long play `id` has been heard so far, in seconds.
#[tauri::command]
pub fn play_time(state: State<'_, AppState>, id: i64, seconds: u32) -> CmdResult<()> {
    db::set_play_seconds(&state.db.lock().unwrap(), id, seconds).map_err(db_err)
}

/// Top songs, artists and albums played since `since` (unix seconds).
#[tauri::command]
pub fn listening_stats(state: State<'_, AppState>, since: i64) -> CmdResult<db::ListeningStats> {
    db::listening_stats(&state.db.lock().unwrap(), since, 10).map_err(db_err)
}

/// The id of every song ever played.
#[tauri::command]
pub fn played_ids(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    db::played_ids(&state.db.lock().unwrap()).map_err(db_err)
}

/// Switches between the mini player and the main window. Async on purpose:
/// creating a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn mini_player(app: AppHandle, open: bool) -> CmdResult<()> {
    #[cfg(desktop)]
    {
        use crate::mini;
        let result = if open { mini::open(&app) } else { mini::close(&app) };
        result.map_err(|e| e.to_string())
    }
    // Phones have no mini player; the lock screen controls stand in for it.
    #[cfg(mobile)]
    {
        let _ = (app, open);
        Err("The mini player is only on desktop.".into())
    }
}

/// What the phone's lock screen and notification show.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(desktop, allow(dead_code))]
pub struct MediaState {
    active: bool,
    title: String,
    artist: String,
    album: Option<String>,
    /// An https cover URL, or `cover/<id>` for a library song's own cover.
    art: Option<String>,
    duration: Option<f64>,
    position: f64,
    playing: bool,
}

/// Android only. Desktop web views show their own media controls from the
/// page's `navigator.mediaSession`.
#[tauri::command]
pub async fn media_state(app: AppHandle, state: MediaState) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        // The plugin reads a library song's cover from the file itself.
        let mut state = state;
        if let Some(id) = state.art.as_deref().and_then(|a| a.strip_prefix("cover/")) {
            let path = id.parse().ok().map(|id| db::track_path(&app.state::<AppState>().db.lock().unwrap(), id));
            state.art = path.and_then(Result::ok).flatten();
        }
        app.cadence_android().media(&state)
    }
    #[cfg(desktop)]
    {
        let _ = (app, state);
        Ok(())
    }
}

/// Phones: the navigation bar's height in CSS pixels; the page draws behind
/// it. Later changes reach the page as `window.__cadenceInsets(height)`.
#[tauri::command]
pub fn nav_bar_height(app: AppHandle) -> CmdResult<f64> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        app.cadence_android().nav_bar_height()
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(0.0)
    }
}

/// Whether a newer Cadence is out. Only phones and Windows have updates.
#[tauri::command]
pub async fn app_update_check(app: AppHandle, state: State<'_, AppState>) -> CmdResult<updater::Check> {
    let current = app.package_info().version.to_string();
    if cfg!(all(desktop, not(windows))) {
        return Ok(updater::Check { current, update: None });
    }
    updater::check(&state.http, &current).await
}

/// Downloads the newest version. Phones open Android's installer, and
/// resolve to false when Android first wants permission to install apps
/// from Cadence (its settings screen is open then). Windows runs the setup
/// program in passive mode: it shows only its progress, closes Cadence,
/// installs over it and starts it again (/R).
#[tauri::command]
pub async fn app_update_install(app: AppHandle, state: State<'_, AppState>) -> CmdResult<bool> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        let current = app.package_info().version.to_string();
        let release = updater::check(&state.http, &current)
            .await?
            .update
            .ok_or("Cadence is up to date.")?;
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
        let apk = updater::download(&app, &state.http, &release, &dir).await?;
        tauri::async_runtime::spawn_blocking(move || app.cadence_android().install_apk(&apk.to_string_lossy()))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(windows)]
    {
        let current = app.package_info().version.to_string();
        let release = updater::check(&state.http, &current)
            .await?
            .update
            .ok_or("Cadence is up to date.")?;
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
        let setup = updater::download(&app, &state.http, &release, &dir).await?;
        std::process::Command::new(&setup)
            .args(["/P", "/R", "/UPDATE"])
            .spawn()
            .map_err(|e| format!("Couldn't start the installer: {e}"))?;
        // The page shows "Installing" first; the installer would close Cadence anyway.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            app.exit(0);
        });
        Ok(true)
    }
    #[cfg(all(desktop, not(windows)))]
    {
        let _ = (app, state);
        Err("Updates are only for Windows and phones.".into())
    }
}

#[tauri::command]
pub fn downloads_list(state: State<'_, AppState>) -> CmdResult<Vec<downloads::Item>> {
    Ok(state.downloads.list())
}

/// Queues songs for offline listening; returns how many were new.
#[tauri::command]
pub fn download_add(
    app: AppHandle,
    state: State<'_, AppState>,
    tracks: Vec<Track>,
    quality: Option<ytdlp::Quality>,
) -> CmdResult<usize> {
    Ok(state.downloads.add(&app, tracks, quality.unwrap_or_default()))
}

/// Cancels a download, or deletes a downloaded song.
#[tauri::command]
pub fn download_remove(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.downloads.remove(&app, &id)
}

#[tauri::command]
pub async fn album(state: State<'_, AppState>, id: String) -> CmdResult<ytmusic::Album> {
    if !ytmusic::valid_browse_id(&id, "MPRE") {
        return Err("bad album id".into());
    }
    ytmusic::album(&state.http, &id).await
}

/// The songs with these YouTube video ids (a shared playlist), in order.
#[tauri::command]
pub async fn songs(state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<Vec<Track>> {
    let ids: Vec<String> = ids.into_iter().filter(|id| ytmusic::valid_video_id(id)).take(share::MAX_SONGS).collect();
    ytmusic::songs(&state.http, &ids).await
}

/// Phones: opens Android's share sheet with a link to `item`.
#[tauri::command]
pub fn share(app: AppHandle, item: share::Shared) -> CmdResult<()> {
    if !item.valid() {
        return Err("That can't be shared.".into());
    }
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        app.cadence_android().share(&share::message(&item))
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Err("Sharing is only on phones.".into())
    }
}

/// Phones: shares a picture the page drew (a lyrics card, as JPEG bytes)
/// through Android's share sheet. The bytes come as a list: Android's bridge
/// to the page has no raw bodies.
#[tauri::command]
pub fn share_image(app: AppHandle, jpeg: Vec<u8>) -> CmdResult<()> {
    if jpeg.is_empty() {
        return Err("No picture to share.".into());
    }
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        // The cache folder is the one the app's file provider may hand out.
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("share");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("cadence-lyrics.jpg");
        std::fs::write(&path, jpeg).map_err(|e| e.to_string())?;
        app.cadence_android().share_image(&path.to_string_lossy())
    }
    #[cfg(desktop)]
    {
        let _ = (app, jpeg);
        Err("Sharing is only on phones.".into())
    }
}

/// The link to `item`. The desktop copies it; phones open the share sheet (`share`).
#[tauri::command]
pub fn share_link(item: share::Shared) -> CmdResult<String> {
    if !item.valid() {
        return Err("That can't be shared.".into());
    }
    Ok(share::link(&item))
}

/// What a link pasted into Search opens: a Cadence link, or a YouTube or
/// YouTube Music one. None for anything else, which is searched for as text.
#[tauri::command]
pub fn open_link(text: String) -> Option<share::Shared> {
    let text = text.trim();
    share::parse(text).or_else(|| share::parse_youtube(text))
}

/// The desktop: saves a picture the page drew (a lyrics card) where the user
/// chose in the save dialog.
#[tauri::command]
pub async fn image_save(path: String, jpeg: Vec<u8>) -> CmdResult<()> {
    let path = std::path::PathBuf::from(path);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !is_jpeg(&jpeg) || !matches!(ext.as_str(), "jpg" | "jpeg") {
        return Err("The picture can only be saved as a .jpg file.".into());
    }
    std::fs::write(&path, jpeg).map_err(|e| e.to_string())
}

fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
}

/// Phones: whether the connection is Wi-Fi (or another that isn't metered);
/// automatic downloads wait for one. The desktop is always fine.
#[tauri::command]
pub fn unmetered_network(app: AppHandle) -> CmdResult<bool> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        app.cadence_android().unmetered()
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(true)
    }
}

#[cfg(target_os = "android")]
type AudioOutput = tauri_plugin_cadence_android::AudioOutput;
#[cfg(desktop)]
type AudioOutput = ();

/// Phones: where the music plays (this phone, Bluetooth, headphones…), shown
/// under the song. Later changes reach the page as `window.__cadenceOutput`.
/// Nothing on desktop.
#[tauri::command]
pub fn audio_output(app: AppHandle) -> CmdResult<Option<AudioOutput>> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        app.cadence_android().audio_output().map(Some)
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(None)
    }
}

/// Phones: opens Android's panel for picking where the music plays.
#[tauri::command]
pub fn audio_output_pick(app: AppHandle) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        app.cadence_android().pick_audio_output()
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(())
    }
}

/// Phones: what the link that opened the app (or was shared to it) opens,
/// once: a Cadence link, or a YouTube or YouTube Music one. Anything else
/// shared to Cadence is an error the page shows.
#[tauri::command]
pub fn shared_link(app: AppHandle) -> CmdResult<Option<share::Opened>> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        let Some(link) = app.cadence_android().take_link()? else {
            return Ok(None);
        };
        share::parse(&link)
            .or_else(|| share::parse_youtube(&link))
            .map(|item| Some(share::Opened { item, quiet: share::quiet(&link) }))
            .ok_or_else(|| "Cadence opens YouTube, YouTube Music and Cadence links. That one isn't one of them.".into())
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(None)
    }
}

#[tauri::command]
pub async fn artist(state: State<'_, AppState>, id: String) -> CmdResult<ytmusic::Artist> {
    if !ytmusic::valid_browse_id(&id, "UC") {
        return Err("bad artist id".into());
    }
    ytmusic::artist(&state.http, &id).await
}

/// Search's Explore: charts for `country` (two letters, "ZZ" for Global; none
/// for where the phone is), new releases, moods and genres.
#[tauri::command]
pub async fn explore(state: State<'_, AppState>, country: Option<String>) -> CmdResult<ytmusic::Explore> {
    if country.as_ref().is_some_and(|c| !(c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase()))) {
        return Err("bad country".into());
    }
    ytmusic::explore(&state.http, country.as_deref()).await
}

/// A mood's or genre's playlists.
#[tauri::command]
pub async fn mood(state: State<'_, AppState>, params: String) -> CmdResult<Vec<ytmusic::Shelf>> {
    if !ytmusic::valid_params(&params) {
        return Err("bad mood".into());
    }
    ytmusic::mood(&state.http, &params).await
}

/// Songs like the `seeds` (YouTube track ids), mixed from each one's radio.
/// Songs in `skip` (the seeds themselves, liked songs…) are left out.
#[tauri::command]
pub async fn recommendations(state: State<'_, AppState>, seeds: Vec<String>, skip: Vec<String>) -> CmdResult<Vec<Track>> {
    let ids = seeds
        .iter()
        .filter_map(|s| s.strip_prefix("yt:"))
        .filter(|id| ytmusic::valid_video_id(id))
        .take(6);
    let lists = futures_util::future::join_all(ids.map(|id| ytmusic::radio(&state.http, id))).await;
    let mut error = None;
    let lists: Vec<_> = lists.into_iter().filter_map(|r| r.map_err(|e| error = Some(e)).ok()).collect();
    match error {
        Some(e) if lists.is_empty() => Err(e),
        _ => Ok(ytmusic::mix(lists, &skip, 50)),
    }
}

#[tauri::command]
pub fn playlists_list(state: State<'_, AppState>) -> CmdResult<Vec<db::PlaylistInfo>> {
    let mut lists = db::playlists(&state.db.lock().unwrap()).map_err(db_err)?;
    for list in &mut lists {
        if let Some(cover) = cover_thumb(&state, list.cover.as_deref()) {
            list.thumbnail = Some(cover);
        }
    }
    Ok(lists)
}

/// A picked cover as the page loads it (`pcover/<file>`), if its file is there.
fn cover_thumb(state: &AppState, cover: Option<&str>) -> Option<String> {
    cover.filter(|name| state.playlist_cover(name).is_some()).map(|name| format!("pcover/{name}"))
}

#[tauri::command]
pub fn playlist_get(state: State<'_, AppState>, id: i64) -> CmdResult<db::Playlist> {
    let mut list = db::playlist(&state.db.lock().unwrap(), id)
        .map_err(db_err)?
        .ok_or_else(|| "That playlist no longer exists.".to_string())?;
    list.cover = cover_thumb(&state, list.cover.as_deref());
    Ok(list)
}

/// Phones: lets the user pick a photo as a playlist's cover (cropped square
/// by Android). False when they picked none.
#[tauri::command]
pub async fn playlist_cover_pick(app: AppHandle, id: i64) -> CmdResult<bool> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        let state = app.state::<AppState>();
        let (name, path) = new_cover(&state, id)?;
        let path = path.to_string_lossy().into_owned();
        let handle = app.clone();
        let saved = tauri::async_runtime::spawn_blocking(move || handle.cadence_android().pick_cover(&path))
            .await
            .map_err(|e| e.to_string())??;
        if !saved {
            return Ok(false);
        }
        use_cover(&state, id, &name)?;
        Ok(true)
    }
    #[cfg(desktop)]
    {
        let _ = (app, id);
        Err("Covers are picked on phones.".into())
    }
}

/// The desktop: a playlist's cover from a photo the page cut square (JPEG bytes).
#[tauri::command]
pub async fn playlist_cover_set(state: State<'_, AppState>, id: i64, jpeg: Vec<u8>) -> CmdResult<()> {
    if !is_jpeg(&jpeg) {
        return Err("That picture can't be used.".into());
    }
    let (name, path) = new_cover(&state, id)?;
    std::fs::write(&path, jpeg).map_err(|e| e.to_string())?;
    use_cover(&state, id, &name)
}

/// A file for a playlist's new cover. A new name each time, so the page never
/// shows a cached old photo.
fn new_cover(state: &AppState, id: i64) -> CmdResult<(String, std::path::PathBuf)> {
    let dir = state.playlist_covers();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("{id}-{stamp}.jpg");
    let path = dir.join(&name);
    Ok((name, path))
}

/// Makes the saved file `name` the playlist's cover and deletes the one before.
fn use_cover(state: &AppState, id: i64, name: &str) -> CmdResult<()> {
    let old = db::set_playlist_cover(&state.db.lock().unwrap(), id, Some(name)).map_err(db_err)?;
    if let Some(old) = old.and_then(|old| state.playlist_cover(&old)) {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

/// Goes back to the first song's cover.
#[tauri::command]
pub fn playlist_cover_clear(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let old = db::set_playlist_cover(&state.db.lock().unwrap(), id, None).map_err(db_err)?;
    if let Some(old) = old.and_then(|old| state.playlist_cover(&old)) {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

fn playlist_name(name: &str) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A playlist needs a name.".into());
    }
    Ok(name.chars().take(100).collect())
}

/// Returns the new playlist's id.
#[tauri::command]
pub fn playlist_create(state: State<'_, AppState>, name: String, tracks: Vec<Track>) -> CmdResult<i64> {
    db::create_playlist(&state.db.lock().unwrap(), &playlist_name(&name)?, None, &tracks).map_err(db_err)
}

#[tauri::command]
pub fn playlist_rename(state: State<'_, AppState>, id: i64, name: String) -> CmdResult<()> {
    db::rename_playlist(&state.db.lock().unwrap(), id, &playlist_name(&name)?).map_err(db_err)
}

#[tauri::command]
pub fn playlist_delete(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.db.lock().unwrap();
    let cover = db::set_playlist_cover(&conn, id, None).map_err(db_err)?;
    if let Some(path) = cover.and_then(|c| state.playlist_cover(&c)) {
        let _ = std::fs::remove_file(path);
    }
    db::delete_playlist(&conn, id).map_err(db_err)
}

/// Adds songs that aren't in the playlist yet; returns how many.
#[tauri::command]
pub fn playlist_add(state: State<'_, AppState>, id: i64, tracks: Vec<Track>) -> CmdResult<usize> {
    db::add_to_playlist(&state.db.lock().unwrap(), id, &tracks).map_err(db_err)
}

/// Saves a playlist's new order, or the songs left after removing some.
#[tauri::command]
pub fn playlist_set_tracks(state: State<'_, AppState>, id: i64, tracks: Vec<Track>) -> CmdResult<()> {
    db::set_playlist_tracks(&state.db.lock().unwrap(), id, &tracks).map_err(db_err)
}

/// Imports a YouTube or Spotify playlist link as a new playlist.
#[tauri::command]
pub async fn playlist_import(app: AppHandle, state: State<'_, AppState>, link: String) -> CmdResult<importer::ImportResult> {
    importer::import(&app, &state, &link).await
}

/// Saves a backup to `path`; `settings` is the page's settings as JSON.
#[tauri::command]
pub async fn backup_create(state: State<'_, AppState>, path: String, settings: String) -> CmdResult<backup::Summary> {
    backup::create(&state.db.lock().unwrap(), std::path::Path::new(&path), &settings)
}

/// Automatic backups kept in the backups folder; older ones are deleted.
const AUTO_BACKUPS_KEPT: u32 = 4;

/// Saves a backup named `name` where people find it: on phones in Downloads
/// → Cadence backups, on the desktop in Documents → Cadence backups. With
/// `auto`, only the newest few automatic backups stay. Returns the folder.
#[tauri::command]
pub async fn backup_to_folder(app: AppHandle, state: State<'_, AppState>, settings: String, name: String, auto: bool) -> CmdResult<String> {
    let plain = name.ends_with(".cadence-backup") && name.chars().all(|c| c.is_ascii_alphanumeric() || " ._-".contains(c));
    if !plain {
        return Err("bad backup name".into());
    }
    let keep = if auto { AUTO_BACKUPS_KEPT } else { 0 };
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        // Made in the cache first; Android copies it to Downloads.
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("backup");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(&name);
        backup::create(&state.db.lock().unwrap(), &tmp, &settings)?;
        let path = tmp.to_string_lossy().into_owned();
        let handle = app.clone();
        let place = tauri::async_runtime::spawn_blocking(move || handle.cadence_android().save_backup(&path, &name, keep))
            .await
            .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
        place
    }
    #[cfg(desktop)]
    {
        let dir = app.path().document_dir().map_err(|e| e.to_string())?.join("Cadence backups");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        backup::create(&state.db.lock().unwrap(), &dir.join(&name), &settings)?;
        if keep > 0 {
            backup::prune_auto(&dir, keep as usize);
        }
        Ok(dir.to_string_lossy().into_owned())
    }
}

/// Phones: lets the user pick a backup file and copies it where Rust can read
/// it, for `backup_peek` and `backup_restore`. None when they picked none.
#[tauri::command]
pub async fn backup_pick(app: AppHandle) -> CmdResult<Option<String>> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("backup");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("picked.cadence-backup").to_string_lossy().into_owned();
        let (handle, dest) = (app.clone(), path.clone());
        let picked = tauri::async_runtime::spawn_blocking(move || handle.cadence_android().pick_backup(&dest))
            .await
            .map_err(|e| e.to_string())??;
        Ok(picked.then_some(path))
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Err("Backups are picked in the file dialog on the desktop.".into())
    }
}

/// Phones: who to check for new releases in the background (the page's JSON:
/// followed artists and podcasts), or with `on` false, stop checking.
#[tauri::command]
pub fn releases_watch(app: AppHandle, json: String, on: bool) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        app.cadence_android().watch_releases(&json, on)
    }
    #[cfg(desktop)]
    {
        let _ = (app, json, on);
        Ok(())
    }
}

/// Phones: whether Cadence may show notifications; Android 13 and newer ask
/// the first time. The desktop has no release notifications.
#[tauri::command]
pub async fn notifications_allow(app: AppHandle) -> CmdResult<bool> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_cadence_android::CadenceAndroidExt;
        tauri::async_runtime::spawn_blocking(move || app.cadence_android().allow_notifications())
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(false)
    }
}

/// What a backup file holds, shown before restoring it.
#[tauri::command]
pub async fn backup_peek(path: String) -> CmdResult<backup::Summary> {
    backup::peek(std::path::Path::new(&path)).map(|(summary, _)| summary)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    summary: backup::Summary,
    /// The backup's page settings, for the page to apply.
    settings: String,
    /// Where the data that was replaced went.
    safety_copy: String,
}

#[tauri::command]
pub async fn backup_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    current_settings: String,
) -> CmdResult<Restored> {
    let safety_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backups");
    let conn = state.db.lock().unwrap();
    let (summary, settings, safety) =
        backup::restore(&conn, std::path::Path::new(&path), &safety_dir, &current_settings)?;
    for id in state.downloads.reload(db::downloads(&conn).map_err(db_err)?) {
        db::remove_download(&conn, &id).map_err(db_err)?;
    }
    Ok(Restored { summary, settings, safety_copy: safety.to_string_lossy().into_owned() })
}

// ---- podcasts ---------------------------------------------------------------------

#[tauri::command]
pub async fn podcast_search(state: State<'_, AppState>, query: String) -> CmdResult<Vec<podcasts::Show>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    podcasts::search(&state.http, query).await
}

/// A show's page, by Apple's id, with its episodes from its feed.
#[tauri::command]
pub async fn podcast_show(state: State<'_, AppState>, id: String) -> CmdResult<podcasts::ShowPage> {
    if !podcasts::valid_id(&id) {
        return Err("bad podcast id".into());
    }
    podcasts::show_page(&state.db, &state.http, &id).await
}

#[tauri::command]
pub fn podcast_follow(state: State<'_, AppState>, id: String, follow: bool) -> CmdResult<()> {
    podcasts::set_followed(&state.db.lock().unwrap(), &id, follow).map_err(db_err)
}

#[tauri::command]
pub fn podcasts_followed(state: State<'_, AppState>) -> CmdResult<Vec<podcasts::Show>> {
    podcasts::followed(&state.db.lock().unwrap()).map_err(db_err)
}

/// Episodes being listened to, then new ones from followed shows.
#[tauri::command]
pub async fn podcast_new_episodes(state: State<'_, AppState>) -> CmdResult<Vec<podcasts::EpisodeView>> {
    podcasts::new_episodes(&state.db, &state.http).await
}

#[derive(Serialize)]
pub struct Spot {
    position: f64,
    played: bool,
}

#[tauri::command]
pub fn podcast_spot(state: State<'_, AppState>, id: String) -> CmdResult<Option<Spot>> {
    let spot = podcasts::spot(&state.db.lock().unwrap(), &id).map_err(db_err)?;
    Ok(spot.map(|(position, played)| Spot { position, played }))
}

/// Saves where an episode was left off, and whether it was heard to the end.
#[tauri::command]
pub fn podcast_progress(state: State<'_, AppState>, id: String, position: f64, played: bool) -> CmdResult<()> {
    podcasts::set_progress(&state.db.lock().unwrap(), &id, position, played).map_err(db_err)
}

/// Search's first songs: the user's own that match (liked, downloaded, in a
/// playlist, played), the most theirs first.
#[tauri::command]
pub fn your_songs(state: State<'_, AppState>, query: String, limit: usize) -> CmdResult<Vec<Track>> {
    yours::songs(&state.db.lock().unwrap(), &query, limit.min(50)).map_err(db_err)
}
