//! The `media://` protocol the player's <audio> element reads from.
//!
//! - `yt/<videoId>`  streams YouTube audio, fetched in ranges from YouTube's
//!   CDN, or from disk when the song is downloaded
//! - `file/<id>`     streams a file from the local library
//! - `cover/<id>`    returns the artwork embedded in a local file
//! - `img/<url>`     returns a YouTube Music cover through an on-disk cache
//! - `pcover/<file>` returns a photo picked as a playlist's cover
//! - `pod/<id>`      streams a podcast episode, fetched in ranges from the
//!   publisher, or from disk when it is downloaded
//! - `pcast/<id>`    returns a podcast's artwork through the cover cache
//!
//! Every response allows any origin so the Web Audio equalizer can process
//! audio and the accent color can be read from artwork.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeResponder};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::OnceCell;

use crate::ytdlp::{Quality, Resolved, YtDlp};
use crate::{db, library, podcasts, AppState};

/// YouTube throttles large single requests, so stream in modest ranges.
const YT_CHUNK: u64 = 2 * 1024 * 1024;
/// A song's first range on phones: about 15 seconds of audio, which mobile
/// networks bring in a fraction of the time 2 MB takes, so it starts sooner.
#[cfg(target_os = "android")]
const YT_FIRST_CHUNK: u64 = 256 * 1024;
const FILE_CHUNK: u64 = 4 * 1024 * 1024;
/// Stream URLs expire after about six hours; refresh well before that.
const STREAM_TTL: Duration = Duration::from_secs(3 * 60 * 60);
/// YouTube's CDN rejects a stream URL with 403 for a moment after it is
/// issued, so wait this long before first using one, and retry 403s.
#[cfg(desktop)]
const URL_WARMUP: Duration = Duration::from_millis(1500);
/// Phones, where every second before a song starts shows, try a fresh URL at
/// once (most work straight away) and while it is younger than `URL_FRESH`
/// retry a refusal every `FRESH_RETRY`, without counting it as a failure.
#[cfg(target_os = "android")]
const URL_WARMUP: Duration = Duration::ZERO;
#[cfg(target_os = "android")]
const URL_FRESH: Duration = Duration::from_secs(3);
#[cfg(target_os = "android")]
const FRESH_RETRY: Duration = Duration::from_millis(250);
const MAX_ATTEMPTS: u32 = 6;

type Fail = (StatusCode, String);

struct Entry {
    created: Instant,
    cell: Arc<OnceCell<Resolved>>,
}

/// Resolved stream URLs by video id and quality. Concurrent requests for the
/// same stream share one yt-dlp run.
#[derive(Default)]
pub struct StreamCache {
    map: Mutex<HashMap<(String, Quality), Entry>>,
}

impl StreamCache {
    pub async fn get(&self, ytdlp: &YtDlp, id: &str, quality: Quality) -> Result<Resolved, String> {
        let cell = {
            let mut map = self.map.lock().unwrap();
            map.retain(|_, e| e.created.elapsed() < STREAM_TTL);
            map.entry((id.to_string(), quality))
                .or_insert_with(|| Entry {
                    created: Instant::now(),
                    cell: Arc::new(OnceCell::new()),
                })
                .cell
                .clone()
        };
        cell.get_or_try_init(|| ytdlp.resolve(id, quality)).await.cloned()
    }

    fn invalidate(&self, id: &str, quality: Quality) {
        self.map.lock().unwrap().remove(&(id.to_string(), quality));
    }
}

pub fn handle(app: AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    tauri::async_runtime::spawn(async move {
        let response = if request.method() == "OPTIONS" {
            base(StatusCode::NO_CONTENT).body(Vec::new()).unwrap()
        } else {
            serve(&app, &request).await.unwrap_or_else(|(status, msg)| {
                base(status)
                    .header(header::CONTENT_TYPE, "text/plain")
                    .body(msg.into_bytes())
                    .unwrap()
            })
        };
        responder.respond(response);
    });
}

fn base(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length")
}

fn partial(mime: &str, start: u64, body: Vec<u8>, total: u64) -> Response<Vec<u8>> {
    let end = start + body.len().max(1) as u64 - 1;
    base(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
        .header(header::CONTENT_LENGTH, body.len())
        .body(body)
        .unwrap()
}

fn unsatisfiable(total: u64) -> Response<Vec<u8>> {
    base(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{total}"))
        .body(Vec::new())
        .unwrap()
}

/// Reads `Range: bytes=start-[end]`. Suffix ranges are treated as a full read.
fn parse_range(request: &Request<Vec<u8>>) -> (u64, Option<u64>) {
    let Some(spec) = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
    else {
        return (0, None);
    };
    let (a, b) = spec.split_once('-').unwrap_or((spec, ""));
    let start = a.trim().parse().unwrap_or(0);
    let end = b.trim().parse().ok().filter(|&e| e >= start);
    (start, end)
}

async fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, Fail> {
    let path = request.uri().path().trim_start_matches('/');
    let path = urlencoding::decode(path)
        .map_err(|_| (StatusCode::BAD_REQUEST, "bad path".to_string()))?;
    let (kind, arg) = path
        .split_once('/')
        .ok_or((StatusCode::NOT_FOUND, "not found".to_string()))?;
    let state = app.state::<AppState>();
    match kind {
        "yt" => serve_youtube(&state, arg, parse_range(request)).await,
        "file" => serve_file(&state, local_id(arg)?, parse_range(request)).await,
        "cover" => serve_cover(&state, local_id(arg)?).await,
        "img" => serve_remote_image(&state, arg).await,
        "pcover" => serve_playlist_cover(&state, arg).await,
        "pod" => serve_episode(&state, arg, parse_range(request)).await,
        "pcast" => serve_show_art(&state, arg).await,
        _ => Err((StatusCode::NOT_FOUND, "not found".into())),
    }
}

/// Covers come from Google's image CDN, which answers bursts of requests
/// from the web view with 429. Fetching them here, once, and keeping them on
/// disk avoids that and makes repeat views free.
async fn serve_remote_image(state: &AppState, url: &str) -> Result<Response<Vec<u8>>, Fail> {
    let bytes = cached_image(state, url).await?;
    Ok(base(StatusCode::OK)
        .header(header::CONTENT_TYPE, sniff_image(&bytes))
        .header(header::CACHE_CONTROL, "max-age=604800")
        .body(bytes)
        .unwrap())
}

/// A cover from the disk cache, fetched first if needed. Only Google's and
/// YouTube's image hosts are allowed, and Apple's for podcasts.
pub async fn cached_image(state: &AppState, url: &str) -> Result<Vec<u8>, Fail> {
    let parsed = reqwest::Url::parse(url).map_err(|_| (StatusCode::BAD_REQUEST, "bad url".to_string()))?;
    let host = parsed.host_str().unwrap_or("");
    let allowed = parsed.scheme() == "https"
        && ["googleusercontent.com", "ytimg.com", "ggpht.com", "mzstatic.com"]
            .iter()
            .any(|d| host == *d || host.ends_with(&format!(".{d}")));
    if !allowed {
        return Err((StatusCode::FORBIDDEN, "host not allowed".into()));
    }
    cached_fetch(state, url).await
}

/// A cover from the disk cache, fetched first if needed, from any host.
async fn cached_fetch(state: &AppState, url: &str) -> Result<Vec<u8>, Fail> {
    let path = state.image_cache.path_for(url);
    if let Ok(bytes) = tokio::fs::read(&path).await {
        return Ok(bytes);
    }
    let _slot = state.image_cache.fetch_slots.acquire().await;
    let bytes = fetch_image(&state.http, url).await?;
    let _ = tokio::fs::write(&path, &bytes).await;
    Ok(bytes)
}

async fn fetch_image(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, Fail> {
    let fail = |e: String| (StatusCode::BAD_GATEWAY, e);
    for attempt in 0..3u64 {
        let resp = http.get(url).send().await.map_err(|e| fail(e.to_string()))?;
        if resp.status() == StatusCode::TOO_MANY_REQUESTS && attempt < 2 {
            tokio::time::sleep(Duration::from_millis(800 * (attempt + 1))).await;
            continue;
        }
        let resp = resp.error_for_status().map_err(|e| fail(e.to_string()))?;
        return Ok(resp.bytes().await.map_err(|e| fail(e.to_string()))?.to_vec());
    }
    Err(fail("image server is rate limiting".into()))
}

fn sniff_image(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'G', b'I', b'F', ..] => "image/gif",
        _ => "image/jpeg",
    }
}

/// Covers saved under the app's cache folder, named by a hash of their URL.
pub struct ImageCache {
    dir: std::path::PathBuf,
    fetch_slots: tokio::sync::Semaphore,
}

impl ImageCache {
    /// Cache size above which the oldest covers are deleted at startup.
    const MAX_BYTES: u64 = 200 * 1024 * 1024;

    pub fn new(dir: std::path::PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self {
            dir,
            fetch_slots: tokio::sync::Semaphore::new(6),
        }
    }

    pub fn path_for(&self, url: &str) -> std::path::PathBuf {
        use sha2::{Digest, Sha256};
        self.dir.join(format!("{:x}", Sha256::digest(url.as_bytes())))
    }

    /// Deletes the least recently written covers once the cache is too big.
    /// Covers in `keep` (those of downloaded songs) always stay.
    pub fn trim(&self, keep: &std::collections::HashSet<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        let mut files: Vec<_> = entries
            .filter_map(Result::ok)
            .filter(|e| !keep.contains(&e.path()))
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                Some((meta.modified().ok()?, meta.len(), e.path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= Self::MAX_BYTES {
            return;
        }
        files.sort_by_key(|f| f.0);
        for (_, len, path) in files {
            if total <= Self::MAX_BYTES * 3 / 4 {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total -= len;
            }
        }
    }
}

fn local_id(arg: &str) -> Result<i64, Fail> {
    arg.parse()
        .map_err(|_| (StatusCode::BAD_REQUEST, "bad id".to_string()))
}

fn library_path(state: &AppState, id: i64) -> Result<String, Fail> {
    let conn = state.db.lock().unwrap();
    db::track_path(&conn, id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "This song is no longer in your library.".into()))
}

pub fn valid_video_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

async fn serve_youtube(
    state: &AppState,
    id: &str,
    (start, req_end): (u64, Option<u64>),
) -> Result<Response<Vec<u8>>, Fail> {
    if !valid_video_id(id) {
        return Err((StatusCode::BAD_REQUEST, "bad video id".into()));
    }
    // A downloaded song plays from disk, so it works offline.
    if let Some(path) = state.downloads.path(id) {
        if let Ok(response) = serve_path(&path, library::mime_for(&path.to_string_lossy()), (start, req_end)).await {
            return Ok(response);
        }
    }
    #[cfg(target_os = "android")]
    let req_end = req_end.or((start == 0).then_some(YT_FIRST_CHUNK - 1));
    Ok(match fetch_youtube(state, id, Quality::Normal, start, req_end).await? {
        Chunk::Partial { mime, body, total } => partial(mime, start, body, total),
        Chunk::Whole { mime, body } => base(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, body.len())
            .body(body)
            .unwrap(),
        Chunk::PastEnd { total } => unsatisfiable(total),
    })
}

/// One piece of a YouTube audio stream.
pub enum Chunk {
    Partial { mime: &'static str, body: Vec<u8>, total: u64 },
    /// The CDN ignored the range and sent the whole file.
    Whole { mime: &'static str, body: Vec<u8> },
    PastEnd { total: u64 },
}

/// Fetches up to `YT_CHUNK` bytes from `start`, resolving the stream and
/// riding out the CDN's 403s for fresh URLs. Used for playback and downloads.
pub async fn fetch_youtube(
    state: &AppState,
    id: &str,
    quality: Quality,
    start: u64,
    req_end: Option<u64>,
) -> Result<Chunk, Fail> {
    let bad_gateway = |e: String| (StatusCode::BAD_GATEWAY, e);
    let mut attempt = 1;
    while attempt <= MAX_ATTEMPTS {
        let stream = state.streams.get(&state.ytdlp, id, quality).await.map_err(bad_gateway)?;
        let age = stream.resolved_at.elapsed();
        if age < URL_WARMUP {
            tokio::time::sleep(URL_WARMUP - age).await;
        }
        let mut end = start + YT_CHUNK - 1;
        if let Some(e) = req_end {
            end = end.min(e);
        }
        if let Some(size) = stream.size {
            if start >= size {
                return Ok(Chunk::PastEnd { total: size });
            }
            end = end.min(size - 1);
        }

        let mut req = state.http.get(&stream.url);
        for (k, v) in &stream.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let resp = req
            .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
            .send()
            .await
            .map_err(|e| bad_gateway(e.to_string()))?;

        let status = resp.status();
        if (status == 403 || status == 410) && attempt < MAX_ATTEMPTS {
            #[cfg(target_os = "android")]
            if stream.resolved_at.elapsed() < URL_FRESH {
                tokio::time::sleep(FRESH_RETRY).await;
                continue;
            }
            // Halfway through, assume the URL itself went bad and resolve a new one.
            if attempt == MAX_ATTEMPTS / 2 {
                state.streams.invalidate(id, quality);
            }
            tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt.min(3)))).await;
            attempt += 1;
            continue;
        }
        if status == 416 {
            return Ok(Chunk::PastEnd { total: stream.size.unwrap_or(0) });
        }
        if !status.is_success() {
            return Err(bad_gateway(format!("YouTube returned {status}")));
        }

        let total = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse::<u64>().ok());
        let body = resp
            .bytes()
            .await
            .map_err(|e| bad_gateway(e.to_string()))?
            .to_vec();
        return Ok(match total {
            Some(total) => Chunk::Partial { mime: stream.mime, body, total },
            None => Chunk::Whole { mime: stream.mime, body },
        });
    }
    Err(bad_gateway("stream URL keeps expiring".into()))
}

async fn serve_file(
    state: &AppState,
    id: i64,
    range: (u64, Option<u64>),
) -> Result<Response<Vec<u8>>, Fail> {
    let path = library_path(state, id)?;
    serve_path(std::path::Path::new(&path), library::mime_for(&path), range).await
}

/// Serves a byte range of a file on disk.
async fn serve_path(
    path: &std::path::Path,
    mime: &str,
    (start, req_end): (u64, Option<u64>),
) -> Result<Response<Vec<u8>>, Fail> {
    let io = |_: std::io::Error| (StatusCode::NOT_FOUND, "The file is missing or can't be read.".to_string());
    let mut file = tokio::fs::File::open(path).await.map_err(io)?;
    let len = file.metadata().await.map_err(io)?.len();
    if start >= len {
        return Ok(unsatisfiable(len));
    }
    let end = req_end
        .unwrap_or(u64::MAX)
        .min(start + FILE_CHUNK - 1)
        .min(len - 1);
    file.seek(SeekFrom::Start(start)).await.map_err(io)?;
    let mut body = vec![0; (end - start + 1) as usize];
    file.read_exact(&mut body).await.map_err(io)?;
    Ok(partial(mime, start, body, len))
}

/// A podcast's artwork; the URL comes from its feed, as saved (podcasts.rs).
async fn serve_show_art(state: &AppState, id: &str) -> Result<Response<Vec<u8>>, Fail> {
    let not_found = || (StatusCode::NOT_FOUND, "no artwork".to_string());
    if !podcasts::valid_id(id) {
        return Err(not_found());
    }
    let url = podcasts::artwork(&state.db.lock().unwrap(), id)
        .ok()
        .flatten()
        .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
        .ok_or_else(not_found)?;
    let bytes = cached_fetch(state, &url).await?;
    Ok(base(StatusCode::OK)
        .header(header::CONTENT_TYPE, sniff_image(&bytes))
        .header(header::CACHE_CONTROL, "max-age=604800")
        .body(bytes)
        .unwrap())
}

/// Podcast episodes come in pieces of this size, the first one smaller so
/// it starts sooner.
const EPISODE_CHUNK: u64 = 1024 * 1024;
const EPISODE_FIRST_CHUNK: u64 = 256 * 1024;

/// A podcast episode: from disk once downloaded, otherwise from the
/// publisher, a range at a time.
async fn serve_episode(state: &AppState, id: &str, (start, req_end): (u64, Option<u64>)) -> Result<Response<Vec<u8>>, Fail> {
    if !podcasts::valid_id(id) {
        return Err((StatusCode::BAD_REQUEST, "bad episode id".into()));
    }
    let episode = podcasts::episode(&state.db.lock().unwrap(), id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "This episode is no longer in its podcast.".to_string()))?;
    if let Some(path) = state.downloads.path_of(&format!("pod:{id}")) {
        if let Ok(response) = serve_path(&path, &episode.mime, (start, req_end)).await {
            return Ok(response);
        }
    }
    let size = if start == 0 { EPISODE_FIRST_CHUNK } else { EPISODE_CHUNK };
    let end = req_end.unwrap_or(u64::MAX).min(start + size - 1);
    let piece = state
        .episode_links
        .fetch(&state.http, &episode.url, start, end)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    if start >= piece.total {
        return Ok(unsatisfiable(piece.total));
    }
    Ok(partial(&episode.mime, start, piece.body, piece.total))
}

async fn serve_playlist_cover(state: &AppState, name: &str) -> Result<Response<Vec<u8>>, Fail> {
    let path = state
        .playlist_cover(name)
        .ok_or((StatusCode::NOT_FOUND, "no cover".to_string()))?;
    let body = tokio::fs::read(path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    // Each picked photo gets a new name, so a name never changes content.
    Ok(base(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::CACHE_CONTROL, "max-age=31536000")
        .body(body)
        .unwrap())
}

async fn serve_cover(state: &AppState, id: i64) -> Result<Response<Vec<u8>>, Fail> {
    let path = library_path(state, id)?;
    let cover = tauri::async_runtime::spawn_blocking(move || library::cover(&path))
        .await
        .ok()
        .flatten()
        .ok_or((StatusCode::NOT_FOUND, "no cover".to_string()))?;
    Ok(base(StatusCode::OK)
        .header(header::CONTENT_TYPE, cover.1)
        .header(header::CACHE_CONTROL, "max-age=86400")
        .body(cover.0)
        .unwrap())
}
