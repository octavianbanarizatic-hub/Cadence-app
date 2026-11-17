//! Podcasts, as in Spotify: shows are found through Apple's public podcast
//! directory (the iTunes Search API, no account needed) and read from their
//! own RSS feeds, so episodes are the publisher's audio files and start
//! without yt-dlp. Episodes seen in a feed are kept in the `episodes` table
//! with where each was left off; followed shows in `podcasts`. `media.rs`
//! streams an episode as `pod/<id>` (from disk once downloaded) and a show's
//! artwork as `pcast/<id>`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// A show, as the directory lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Show {
    /// Apple's id for the show.
    pub id: String,
    pub title: String,
    pub author: String,
    pub artwork: Option<String>,
    pub feed: String,
}

/// One episode from a feed. `url` is the audio file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: String,
    pub show_id: String,
    pub title: String,
    /// Plain text, shortened.
    pub description: String,
    /// Unix seconds.
    pub published: Option<i64>,
    pub duration: Option<f64>,
    pub url: String,
    pub mime: String,
}

/// An episode for the page: no audio URL, plus where it was left off.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeView {
    pub id: String,
    pub show_id: String,
    pub show_title: String,
    pub title: String,
    pub description: String,
    pub published: Option<i64>,
    pub duration: Option<f64>,
    /// Seconds in; 0 when not started.
    pub position: f64,
    pub played: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowPage {
    pub show: Show,
    pub description: String,
    pub followed: bool,
    pub episodes: Vec<EpisodeView>,
}

/// A show's page lists this many of its newest episodes.
const PAGE_EPISODES: usize = 300;
/// Followed shows' feeds are read again for Home after this long.
const RECHECK: Duration = Duration::from_secs(6 * 60 * 60);
/// Home's "New episodes" go back this far.
const NEW_FOR: i64 = 30 * 24 * 3600;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---- the directory ------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItunesResult {
    collection_id: Option<u64>,
    collection_name: Option<String>,
    artist_name: Option<String>,
    artwork_url600: Option<String>,
    artwork_url100: Option<String>,
    feed_url: Option<String>,
}

#[derive(Deserialize)]
struct ItunesResults {
    results: Vec<ItunesResult>,
}

impl ItunesResult {
    fn show(self) -> Option<Show> {
        Some(Show {
            id: self.collection_id?.to_string(),
            title: self.collection_name?,
            author: self.artist_name.unwrap_or_default(),
            artwork: self.artwork_url600.or(self.artwork_url100),
            // Shows without a public feed can't be played.
            feed: self.feed_url.filter(|f| f.starts_with("http"))?,
        })
    }
}

async fn itunes(http: &reqwest::Client, url: reqwest::Url) -> Result<Vec<Show>, String> {
    let found: ItunesResults = http
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(found.results.into_iter().filter_map(ItunesResult::show).collect())
}

pub async fn search(http: &reqwest::Client, query: &str) -> Result<Vec<Show>, String> {
    let url = reqwest::Url::parse_with_params(
        "https://itunes.apple.com/search",
        &[("media", "podcast"), ("entity", "podcast"), ("limit", "30"), ("term", query)],
    )
    .map_err(|e| e.to_string())?;
    itunes(http, url).await
}

/// A show by Apple's id: from the database when it has been opened before.
pub async fn show(conn: &Mutex<Connection>, http: &reqwest::Client, id: &str) -> Result<Show, String> {
    if let Some(show) = saved_show(&conn.lock().unwrap(), id).map_err(|e| e.to_string())? {
        return Ok(show);
    }
    let url = reqwest::Url::parse_with_params("https://itunes.apple.com/lookup", &[("id", id), ("entity", "podcast")])
        .map_err(|e| e.to_string())?;
    let show = itunes(http, url).await?.into_iter().next().ok_or("This podcast isn't available.")?;
    remember_show(&conn.lock().unwrap(), &show).map_err(|e| e.to_string())?;
    Ok(show)
}

// ---- feeds ----------------------------------------------------------------------

/// What a feed says about the show, and its episodes newest first.
#[derive(Debug, Default)]
pub struct Feed {
    pub description: String,
    pub episodes: Vec<Episode>,
}

pub async fn fetch_feed(http: &reqwest::Client, show: &Show) -> Result<Feed, String> {
    let text = http
        .get(&show.feed)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let mut feed = parse_feed(&text, &show.id)?;
    feed.episodes.sort_by_key(|e| std::cmp::Reverse(e.published.unwrap_or(0)));
    Ok(feed)
}

/// Reads an RSS feed. Only items with an audio enclosure are episodes.
pub fn parse_feed(xml: &str, show_id: &str) -> Result<Feed, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut feed = Feed::default();
    // Open elements' names, to know where text belongs.
    let mut path: Vec<String> = Vec::new();
    let mut item: Option<Item> = None;
    let mut text = String::new();
    loop {
        match reader.read_event().map_err(|e| format!("bad feed: {e}"))? {
            Event::Start(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if name == "item" {
                    item = Some(Item::default());
                } else if let Some(it) = item.as_mut() {
                    it.attributes(&name, &e);
                }
                path.push(name);
                text.clear();
            }
            Event::Empty(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if let Some(it) = item.as_mut() {
                    it.attributes(&name, &e);
                }
            }
            Event::Text(t) => text.push_str(&t.unescape().map_err(|e| format!("bad feed: {e}"))?),
            Event::CData(c) => text.push_str(&String::from_utf8_lossy(&c)),
            Event::End(_) => {
                let name = path.pop().unwrap_or_default();
                let value = std::mem::take(&mut text);
                let value = value.trim();
                if name == "item" {
                    if let Some(ep) = item.take().and_then(|it| it.episode(show_id)) {
                        feed.episodes.push(ep);
                    }
                } else if let Some(it) = item.as_mut() {
                    it.text(&name, value);
                } else if path.last().is_some_and(|p| p == "channel") {
                    let better = name == "description" || (name == "itunes:summary" && feed.description.is_empty());
                    if better && !value.is_empty() {
                        feed.description = plain_text(value, 1200);
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(feed)
}

#[derive(Default)]
struct Item {
    guid: String,
    title: String,
    description: String,
    published: Option<i64>,
    duration: Option<f64>,
    url: String,
    mime: String,
}

impl Item {
    fn attributes(&mut self, name: &str, e: &BytesStart) {
        if name != "enclosure" || !self.url.is_empty() {
            return;
        }
        let attr = |key: &str| {
            e.try_get_attribute(key)
                .ok()
                .flatten()
                .and_then(|a| a.unescape_value().ok().map(|v| v.into_owned()))
                .unwrap_or_default()
        };
        let (url, mime) = (attr("url"), attr("type"));
        // Video enclosures would play as sound only; some feeds have both.
        if url.starts_with("http") && !mime.starts_with("video") {
            self.url = url;
            self.mime = mime;
        }
    }

    fn text(&mut self, name: &str, value: &str) {
        match name {
            "guid" => self.guid = value.to_string(),
            "title" if self.title.is_empty() => self.title = value.to_string(),
            "description" | "content:encoded" | "itunes:summary" if self.description.is_empty() => {
                self.description = plain_text(value, 600);
            }
            "pubDate" => self.published = parse_date(value),
            "itunes:duration" => self.duration = parse_duration(value),
            _ => {}
        }
    }

    fn episode(self, show_id: &str) -> Option<Episode> {
        if self.url.is_empty() {
            return None;
        }
        use sha2::{Digest, Sha256};
        let key = if self.guid.is_empty() { &self.url } else { &self.guid };
        let hash = Sha256::digest(format!("{show_id}\n{key}").as_bytes());
        Some(Episode {
            id: format!("{hash:x}")[..20].to_string(),
            show_id: show_id.to_string(),
            title: if self.title.is_empty() { "Episode".into() } else { self.title },
            description: self.description,
            published: self.published,
            duration: self.duration,
            mime: audio_mime(&self.mime, &self.url).to_string(),
            url: self.url,
        })
    }
}

/// The file's type, from the feed or else its name.
fn audio_mime(given: &str, url: &str) -> &'static str {
    let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    match given {
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" | "audio/aac" => "audio/mp4",
        "audio/ogg" | "audio/opus" => "audio/ogg",
        "audio/mpeg" | "audio/mp3" => "audio/mpeg",
        _ if path.ends_with(".m4a") || path.ends_with(".mp4") || path.ends_with(".aac") => "audio/mp4",
        _ if path.ends_with(".ogg") || path.ends_with(".opus") => "audio/ogg",
        _ => "audio/mpeg",
    }
}

/// Text without HTML tags, entities decoded, runs of space joined, cut at
/// about `max` characters.
fn plain_text(html: &str, max: usize) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    let joined = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() <= max {
        return joined;
    }
    let cut: String = joined.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

/// "Tue, 05 Nov 2026 10:00:00 +0000" (RFC 2822, as feeds write it) to Unix seconds.
fn parse_date(s: &str) -> Option<i64> {
    let s = s.split_once(',').map_or(s, |(_, rest)| rest).trim();
    let mut parts = s.split_whitespace();
    let day: i64 = parts.next()?.parse().ok()?;
    let month = parts.next()?.get(..3)?.to_ascii_lowercase();
    let month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        .iter()
        .position(|m| *m == month)? as i64
        + 1;
    let mut year: i64 = parts.next()?.parse().ok()?;
    if year < 100 {
        year += 2000;
    }
    let mut hms = parts.next().unwrap_or("0:0:0").split(':').map(|p| p.parse::<i64>().unwrap_or(0));
    let (h, m, sec) = (hms.next().unwrap_or(0), hms.next().unwrap_or(0), hms.next().unwrap_or(0));
    let zone = match parts.next().unwrap_or("+0000") {
        z if z.len() == 5 && (z.starts_with('+') || z.starts_with('-')) => {
            let n: i64 = z[1..].parse().ok()?;
            let offset = (n / 100) * 3600 + (n % 100) * 60;
            if z.starts_with('-') { -offset } else { offset }
        }
        "EDT" => -4 * 3600,
        "EST" | "CDT" => -5 * 3600,
        "CST" | "MDT" => -6 * 3600,
        "MST" | "PDT" => -7 * 3600,
        "PST" => -8 * 3600,
        _ => 0,
    };
    // Days from 1970-01-01 to the date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + h * 3600 + m * 60 + sec - zone)
}

/// "1:02:03", "62:03" or "3723" to seconds.
fn parse_duration(s: &str) -> Option<f64> {
    let mut total = 0.0;
    for part in s.trim().split(':') {
        total = total * 60.0 + part.trim().parse::<f64>().ok()?;
    }
    (total > 0.0).then_some(total)
}

// ---- the database ---------------------------------------------------------------

pub const SCHEMA: &str = r#"
-- Shows that were opened (`followed_at` set when followed); `data` is a Show.
CREATE TABLE IF NOT EXISTS podcasts (
    id          TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    followed_at INTEGER,
    checked_at  INTEGER NOT NULL DEFAULT 0
);

-- Episodes seen in feeds; `data` is an Episode. `position` is where it was
-- left off, in seconds; `played` once it was heard to the end.
CREATE TABLE IF NOT EXISTS episodes (
    id        TEXT PRIMARY KEY,
    show_id   TEXT NOT NULL,
    data      TEXT NOT NULL,
    published INTEGER,
    position  REAL NOT NULL DEFAULT 0,
    played    INTEGER NOT NULL DEFAULT 0,
    heard_at  INTEGER
);
CREATE INDEX IF NOT EXISTS episodes_show ON episodes(show_id, published);
"#;

fn saved_show(conn: &Connection, id: &str) -> rusqlite::Result<Option<Show>> {
    let data: Option<String> = conn
        .query_row("SELECT data FROM podcasts WHERE id = ?1", params![id], |r| r.get(0))
        .optional()?;
    Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
}

fn remember_show(conn: &Connection, show: &Show) -> rusqlite::Result<()> {
    let data = serde_json::to_string(show).unwrap_or_default();
    conn.execute(
        "INSERT INTO podcasts(id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        params![show.id, data],
    )?;
    Ok(())
}

/// Saves a feed's episodes; where each was left off stays as it was.
pub fn store_episodes(conn: &mut Connection, show_id: &str, episodes: &[Episode]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO episodes(id, show_id, data, published) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, published = excluded.published",
        )?;
        for ep in episodes {
            stmt.execute(params![ep.id, show_id, serde_json::to_string(ep).unwrap_or_default(), ep.published])?;
        }
    }
    tx.execute("UPDATE podcasts SET checked_at = ?2 WHERE id = ?1", params![show_id, now_secs()])?;
    tx.commit()
}

const VIEW_SELECT: &str = "SELECT e.data, e.position, e.played, p.data FROM episodes e JOIN podcasts p ON p.id = e.show_id";

fn view_row(r: &rusqlite::Row) -> rusqlite::Result<Option<EpisodeView>> {
    let data: String = r.get(0)?;
    let show: String = r.get(3)?;
    let (Ok(ep), Ok(show)) = (serde_json::from_str::<Episode>(&data), serde_json::from_str::<Show>(&show)) else {
        return Ok(None);
    };
    Ok(Some(EpisodeView {
        id: ep.id,
        show_id: ep.show_id,
        show_title: show.title,
        title: ep.title,
        description: ep.description,
        published: ep.published,
        duration: ep.duration,
        position: r.get(1)?,
        played: r.get::<_, i64>(2)? != 0,
    }))
}

fn views(conn: &Connection, filter: &str, args: impl rusqlite::Params) -> rusqlite::Result<Vec<EpisodeView>> {
    let mut stmt = conn.prepare(&format!("{VIEW_SELECT} {filter}"))?;
    let rows = stmt.query_map(args, view_row)?;
    Ok(rows.filter_map(|r| r.ok().flatten()).collect())
}

/// A show's page, its feed read anew. Offline, it shows what was saved.
pub async fn show_page(conn: &Mutex<Connection>, http: &reqwest::Client, id: &str) -> Result<ShowPage, String> {
    let show = show(conn, http, id).await?;
    let feed = fetch_feed(http, &show).await;
    let db_err = |e: rusqlite::Error| e.to_string();
    let mut db = conn.lock().unwrap();
    let description = match &feed {
        Ok(feed) => {
            store_episodes(&mut db, &show.id, &feed.episodes).map_err(db_err)?;
            feed.description.clone()
        }
        Err(_) => String::new(),
    };
    let episodes = views(
        &db,
        &format!("WHERE e.show_id = ?1 ORDER BY e.published DESC LIMIT {PAGE_EPISODES}"),
        params![show.id],
    )
    .map_err(db_err)?;
    if let (Err(e), true) = (&feed, episodes.is_empty()) {
        return Err(e.clone());
    }
    let followed = db
        .query_row("SELECT followed_at IS NOT NULL FROM podcasts WHERE id = ?1", params![show.id], |r| r.get(0))
        .optional()
        .map_err(db_err)?
        .unwrap_or(false);
    Ok(ShowPage { show, description, followed, episodes })
}

pub fn set_followed(conn: &Connection, id: &str, on: bool) -> rusqlite::Result<()> {
    let at = on.then(now_secs);
    conn.execute("UPDATE podcasts SET followed_at = ?2 WHERE id = ?1", params![id, at])?;
    Ok(())
}

/// Followed shows, the latest followed first.
pub fn followed(conn: &Connection) -> rusqlite::Result<Vec<Show>> {
    let mut stmt = conn.prepare("SELECT data FROM podcasts WHERE followed_at IS NOT NULL ORDER BY followed_at DESC")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).filter_map(|d| serde_json::from_str(&d).ok()).collect())
}

/// Home's "New episodes": episodes being listened to, then new ones from
/// followed shows not heard yet. Feeds not read for a while are read first.
pub async fn new_episodes(conn: &Mutex<Connection>, http: &reqwest::Client) -> Result<Vec<EpisodeView>, String> {
    let due: Vec<Show> = {
        let db = conn.lock().unwrap();
        let mut stmt = db
            .prepare("SELECT data FROM podcasts WHERE followed_at IS NOT NULL AND checked_at < ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![now_secs() - RECHECK.as_secs() as i64], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).filter_map(|d| serde_json::from_str(&d).ok()).collect()
    };
    // A few at a time; one feed failing (offline, moved) doesn't stop the rest.
    for batch in due.chunks(4) {
        let feeds = futures_util::future::join_all(batch.iter().map(|s| fetch_feed(http, s))).await;
        let mut db = conn.lock().unwrap();
        for (show, feed) in batch.iter().zip(feeds) {
            if let Ok(feed) = feed {
                let _ = store_episodes(&mut db, &show.id, &feed.episodes);
            }
        }
    }
    let db = conn.lock().unwrap();
    let mut list = views(
        &db,
        "WHERE e.played = 0 AND e.position > 0 ORDER BY e.heard_at DESC LIMIT 10",
        [],
    )
    .map_err(|e| e.to_string())?;
    let new = views(
        &db,
        "WHERE p.followed_at IS NOT NULL AND e.played = 0 AND e.position = 0 AND e.published > ?1
         ORDER BY e.published DESC LIMIT 20",
        params![now_secs() - NEW_FOR],
    )
    .map_err(|e| e.to_string())?;
    list.extend(new);
    Ok(list)
}

/// Saves where an episode was left off, and whether it was heard to the end.
pub fn set_progress(conn: &Connection, id: &str, position: f64, played: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE episodes SET position = ?2, played = ?3, heard_at = ?4 WHERE id = ?1",
        params![id, position.max(0.0), played, now_secs()],
    )?;
    Ok(())
}

/// Where an episode was left off, and whether it was heard to the end.
pub fn spot(conn: &Connection, id: &str) -> rusqlite::Result<Option<(f64, bool)>> {
    conn.query_row("SELECT position, played FROM episodes WHERE id = ?1", params![id], |r| {
        Ok((r.get(0)?, r.get::<_, i64>(1)? != 0))
    })
    .optional()
}

/// The audio file of an episode, and its type.
pub fn episode(conn: &Connection, id: &str) -> rusqlite::Result<Option<Episode>> {
    let data: Option<String> = conn
        .query_row("SELECT data FROM episodes WHERE id = ?1", params![id], |r| r.get(0))
        .optional()?;
    Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
}

/// A show's artwork URL.
pub fn artwork(conn: &Connection, show_id: &str) -> rusqlite::Result<Option<String>> {
    Ok(saved_show(conn, show_id)?.and_then(|s| s.artwork))
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

// ---- streaming ------------------------------------------------------------------

/// Where episodes' links lead after their redirects (podcast hosts often
/// pass through two or three counting services first), so later ranges of
/// the same episode go straight to the file.
#[derive(Default)]
pub struct Redirects {
    map: Mutex<HashMap<String, (String, Instant)>>,
}

/// Redirect targets are often signed links that expire; renew within this.
const REDIRECT_TTL: Duration = Duration::from_secs(30 * 60);

/// One piece of an episode: its bytes, from where, and the file's size.
pub struct Piece {
    pub body: Vec<u8>,
    pub total: u64,
}

impl Redirects {
    /// Fetches bytes `start..=end` of an episode's file.
    pub async fn fetch(&self, http: &reqwest::Client, url: &str, start: u64, end: u64) -> Result<Piece, String> {
        let known = {
            let mut map = self.map.lock().unwrap();
            map.retain(|_, (_, at)| at.elapsed() < REDIRECT_TTL);
            map.get(url).map(|(to, _)| to.clone())
        };
        if let Some(to) = known {
            if let Ok(piece) = fetch_range(http, &to, start, end).await {
                return Ok(piece);
            }
            // Expired, say: from the start of the chain again.
            self.map.lock().unwrap().remove(url);
        }
        let (piece, landed) = fetch_range_from(http, url, start, end).await?;
        self.map.lock().unwrap().insert(url.to_string(), (landed, Instant::now()));
        Ok(piece)
    }
}

async fn fetch_range(http: &reqwest::Client, url: &str, start: u64, end: u64) -> Result<Piece, String> {
    fetch_range_from(http, url, start, end).await.map(|(piece, _)| piece)
}

/// Returns the piece and the URL it came from after redirects.
async fn fetch_range_from(http: &reqwest::Client, url: &str, start: u64, end: u64) -> Result<(Piece, String), String> {
    use futures_util::StreamExt;
    let resp = http
        .get(url)
        .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let landed = resp.url().to_string();
    let ranged = resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let total = if ranged {
        resp.headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse::<u64>().ok())
    } else {
        resp.content_length()
    }
    .ok_or("The podcast's server didn't say how big the episode is.")?;
    if !ranged && start > 0 {
        return Err("The podcast's server can't skip ahead in this episode.".into());
    }
    // A server that ignores ranges sends everything; keep only the piece asked for.
    let want = (end - start + 1) as usize;
    let mut body = Vec::with_capacity(want.min(4 << 20));
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        body.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        if body.len() >= want {
            body.truncate(want);
            break;
        }
    }
    Ok((Piece { body, total }, landed))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Show</title>
  <description><![CDATA[<p>A show about <b>things</b> &amp; more.</p>]]></description>
  <item>
    <title>First &amp; best</title>
    <guid isPermaLink="false">ep-1</guid>
    <pubDate>Tue, 03 Nov 2026 10:00:00 +0000</pubDate>
    <itunes:duration>1:02:03</itunes:duration>
    <description>Hello &lt;b&gt;there&lt;/b&gt;</description>
    <enclosure url="https://cdn.example.com/1.mp3?x=1" length="100" type="audio/mpeg"/>
  </item>
  <item>
    <title>Video only</title>
    <enclosure url="https://cdn.example.com/2.mp4" type="video/mp4"/>
  </item>
  <item>
    <title>Second</title>
    <pubDate>Wed, 4 Nov 2026 08:30:00 -0500</pubDate>
    <itunes:duration>3600</itunes:duration>
    <enclosure url="https://cdn.example.com/3.m4a" type=""></enclosure>
  </item>
</channel>
</rss>"#;

    #[test]
    fn reads_feeds() {
        let feed = parse_feed(FEED, "42").unwrap();
        assert_eq!(feed.description, "A show about things & more.");
        assert_eq!(feed.episodes.len(), 2);
        let first = &feed.episodes[0];
        assert_eq!(first.title, "First & best");
        assert_eq!(first.description, "Hello there");
        assert_eq!(first.duration, Some(3723.0));
        assert_eq!(first.published, Some(1_793_700_000));
        assert_eq!(first.mime, "audio/mpeg");
        assert_eq!(first.url, "https://cdn.example.com/1.mp3?x=1");
        assert!(valid_id(&first.id));
        let second = &feed.episodes[1];
        assert_eq!(second.mime, "audio/mp4");
        assert_eq!(second.published, Some(1_793_799_000));
        // The id stays the same when the feed is read again.
        assert_eq!(parse_feed(FEED, "42").unwrap().episodes[0].id, first.id);
        assert_ne!(parse_feed(FEED, "43").unwrap().episodes[0].id, first.id);
    }

    #[test]
    fn reads_dates_and_durations() {
        assert_eq!(parse_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(parse_date("Thu, 01 Jan 1970 00:00:00 EST"), Some(5 * 3600));
        assert_eq!(parse_date("1 Jan 1970 01:00:00 +0100"), Some(0));
        assert_eq!(parse_date("nonsense"), None);
        assert_eq!(parse_duration("62:03"), Some(3723.0));
        assert_eq!(parse_duration("45"), Some(45.0));
        assert_eq!(parse_duration(""), None);
        assert_eq!(plain_text("a  <br/>b", 10), "a b");
        assert_eq!(plain_text("abcdefghij klm", 5), "abcde…");
    }

    #[test]
    fn keeps_progress_when_feeds_change() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let show = Show { id: "42".into(), title: "Show".into(), author: "A".into(), artwork: None, feed: "https://x".into() };
        remember_show(&conn, &show).unwrap();
        let feed = parse_feed(FEED, "42").unwrap();
        store_episodes(&mut conn, "42", &feed.episodes).unwrap();
        set_progress(&conn, &feed.episodes[0].id, 120.0, false).unwrap();
        store_episodes(&mut conn, "42", &feed.episodes).unwrap();
        let list = views(&conn, "WHERE e.show_id = '42' ORDER BY e.published DESC", []).unwrap();
        assert_eq!(list.len(), 2);
        let first = list.iter().find(|e| e.id == feed.episodes[0].id).unwrap();
        assert_eq!(first.position, 120.0);
        assert_eq!(first.show_title, "Show");
        set_followed(&conn, "42", true).unwrap();
        assert_eq!(followed(&conn).unwrap(), vec![show]);
        assert_eq!(episode(&conn, &feed.episodes[1].id).unwrap().unwrap().mime, "audio/mp4");
    }
}
