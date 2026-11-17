//! Turning a YouTube or Spotify playlist link into a Cadence playlist.
//!
//! YouTube playlists are read with yt-dlp and keep their videos. Spotify
//! has no public API without an account, so its embed page (the one other
//! sites use to show a playlist) is read for titles, artists and lengths,
//! and each song is then looked up on YouTube Music. That page lists at most
//! 100 songs.

use futures_util::{stream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::{db, ytmusic, AppState, Track};

/// How many YouTube Music searches run at once while matching.
const PARALLEL_SEARCHES: usize = 4;
/// How far a match's length may be from the Spotify song's, in seconds.
const DURATION_SLACK: f64 = 7.0;
/// What the Spotify embed page lists at most.
const SPOTIFY_EMBED_LIMIT: usize = 100;

#[derive(Debug, PartialEq)]
pub enum Source {
    YouTube(String),
    /// "playlist" or "album", and its id.
    Spotify(&'static str, String),
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() < 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Recognizes youtube.com / music.youtube.com / youtu.be links with a
/// `list=` parameter, and open.spotify.com playlist or album links.
pub fn parse_link(link: &str) -> Option<Source> {
    let link = link.trim();
    if let Some(rest) = link.strip_prefix("spotify:") {
        let (kind, id) = rest.split_once(':')?;
        let kind = match kind {
            "playlist" => "playlist",
            "album" => "album",
            _ => return None,
        };
        return valid_id(id).then(|| Source::Spotify(kind, id.to_string()));
    }
    let with_scheme = if link.contains("://") { link.to_string() } else { format!("https://{link}") };
    let url = reqwest::Url::parse(&with_scheme).ok()?;
    let host = url.host_str()?.trim_start_matches("www.").trim_start_matches("m.");
    match host {
        "youtube.com" | "music.youtube.com" | "youtu.be" => {
            let list = url.query_pairs().find(|(k, _)| k == "list")?.1.to_string();
            valid_id(&list).then_some(Source::YouTube(list))
        }
        "open.spotify.com" => {
            // Paths look like /playlist/<id> or /intl-de/album/<id>.
            let parts: Vec<_> = url.path_segments()?.filter(|s| !s.starts_with("intl-")).collect();
            let kind = match *parts.first()? {
                "playlist" => "playlist",
                "album" => "album",
                _ => return None,
            };
            let id = parts.get(1)?;
            valid_id(id).then(|| Source::Spotify(kind, id.to_string()))
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub playlist_id: i64,
    pub name: String,
    pub added: usize,
    /// "Title – Artist" of songs that couldn't be found on YouTube Music.
    pub missing: Vec<String>,
    /// Spotify listed exactly as many songs as its embed page allows, so the
    /// playlist is probably longer.
    pub maybe_truncated: bool,
}

#[derive(Clone, Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

/// A song as Spotify describes it.
#[derive(Debug, Clone, PartialEq)]
struct Wanted {
    title: String,
    artist: String,
    duration: Option<f64>,
}

pub async fn import(app: &AppHandle, state: &AppState, link: &str) -> Result<ImportResult, String> {
    let source = parse_link(link).ok_or(
        "That doesn't look like a YouTube or Spotify playlist link. Copy the link from the playlist's Share menu.",
    )?;
    let (name, tracks, missing, maybe_truncated) = match source {
        Source::YouTube(list) => {
            let (name, tracks) = state.ytdlp.playlist(&list).await?;
            (name, tracks, Vec::new(), false)
        }
        Source::Spotify(kind, id) => {
            let (name, wanted) = spotify(&state.http, kind, &id).await?;
            let truncated = wanted.len() >= SPOTIFY_EMBED_LIMIT;
            let total = wanted.len();
            let mut done = 0;
            let mut tracks = Vec::new();
            let mut missing = Vec::new();
            let mut results = stream::iter(wanted)
                .map(|w| async move {
                    let found = find_on_youtube_music(&state.http, &w).await;
                    (w, found)
                })
                .buffered(PARALLEL_SEARCHES);
            while let Some((w, found)) = results.next().await {
                done += 1;
                let _ = app.emit("import-progress", Progress { done, total });
                match found {
                    Some(t) => tracks.push(t),
                    None => missing.push(format!("{} – {}", w.title, w.artist)),
                }
            }
            (name, tracks, missing, truncated)
        }
    };
    if tracks.is_empty() {
        return Err("No songs from that playlist could be found.".into());
    }
    // The same song twice in a row is almost always a duplicate upload.
    let mut seen = std::collections::HashSet::new();
    let tracks: Vec<Track> = tracks.into_iter().filter(|t| seen.insert(t.id.clone())).collect();
    let playlist_id = db::create_playlist(&state.db.lock().unwrap(), &name, Some(link.trim()), &tracks)
        .map_err(|e| e.to_string())?;
    Ok(ImportResult { playlist_id, name, added: tracks.len(), missing, maybe_truncated })
}

async fn spotify(http: &reqwest::Client, kind: &str, id: &str) -> Result<(String, Vec<Wanted>), String> {
    let html = http
        .get(format!("https://open.spotify.com/embed/{kind}/{id}"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| {
            if e.status().is_some_and(|s| s == 404) {
                "Spotify says that playlist doesn't exist, or it's private.".to_string()
            } else {
                "Couldn't reach Spotify. Check your internet connection.".to_string()
            }
        })?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    parse_spotify_embed(&html).ok_or_else(|| "Couldn't read that Spotify playlist. It may be private.".to_string())
}

fn parse_spotify_embed(html: &str) -> Option<(String, Vec<Wanted>)> {
    let start = html.find(r#"<script id="__NEXT_DATA__""#)?;
    let json_start = start + html[start..].find('>')? + 1;
    let json_end = json_start + html[json_start..].find("</script>")?;
    let data: Value = serde_json::from_str(&html[json_start..json_end]).ok()?;
    let entity = &data["props"]["pageProps"]["state"]["data"]["entity"];
    let name = entity["name"].as_str().or(entity["title"].as_str())?.to_string();
    let wanted = entity["trackList"]
        .as_array()?
        .iter()
        .filter_map(|t| {
            Some(Wanted {
                title: t["title"].as_str()?.to_string(),
                artist: t["subtitle"].as_str().unwrap_or("").to_string(),
                duration: t["duration"].as_f64().map(|ms| ms / 1000.0),
            })
        })
        .collect();
    Some((name, wanted))
}

/// Lowercase letters and digits of the part before any " - " or bracket:
/// "Song - Remastered 2011" and "Song (feat. X)" both become "song".
fn core(title: &str) -> String {
    let squash = |s: &str| -> String { s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect() };
    let end = [" - ", "(", "["].iter().filter_map(|s| title.find(s)).min().unwrap_or(title.len());
    // "(I Can't Get No) Satisfaction" has nothing before its bracket.
    Some(squash(&title[..end])).filter(|c| !c.is_empty()).unwrap_or_else(|| squash(title))
}

fn same_song(wanted: &str, found: &str) -> bool {
    let (a, b) = (core(wanted), core(found));
    !a.is_empty() && !b.is_empty() && (a.contains(&b) || b.contains(&a))
}

/// The YouTube Music song that best matches: among the top results with a
/// matching title, the first one close in length; else the first match.
fn pick(wanted: &Wanted, results: Vec<Track>) -> Option<Track> {
    let candidates: Vec<Track> = results
        .into_iter()
        .take(6)
        .filter(|t| same_song(&wanted.title, &t.title))
        .collect();
    let close = |t: &&Track| match (wanted.duration, t.duration) {
        (Some(a), Some(b)) => (a - b).abs() <= DURATION_SLACK,
        _ => true,
    };
    candidates.iter().find(close).cloned().or_else(|| candidates.into_iter().next())
}

async fn find_on_youtube_music(http: &reqwest::Client, wanted: &Wanted) -> Option<Track> {
    let artist = crate::lyrics::primary_artist(&wanted.artist);
    let query = format!("{} {artist}", core_title(&wanted.title));
    // One retry: a burst of searches occasionally gets a transient error.
    for attempt in 0..2 {
        match ytmusic::search(http, &query).await {
            Ok(results) => return pick(wanted, results),
            Err(_) if attempt == 0 => tokio::time::sleep(std::time::Duration::from_millis(800)).await,
            Err(_) => {}
        }
    }
    None
}

/// Spotify titles carry suffixes such as " - Remastered 2011" that make
/// searches worse; keep the part before them.
fn core_title(title: &str) -> &str {
    title.split(" - ").next().unwrap_or(title).trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_links() {
        let yt = |s: &str| Some(Source::YouTube(s.into()));
        assert_eq!(parse_link("https://www.youtube.com/playlist?list=PLabc_123"), yt("PLabc_123"));
        assert_eq!(parse_link("music.youtube.com/playlist?list=RDCLAK5uy_x&si=1"), yt("RDCLAK5uy_x"));
        assert_eq!(parse_link("https://youtu.be/dQw4w9WgXcQ?list=PLx"), yt("PLx"));
        assert_eq!(parse_link("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), None);
        let sp = |k, s: &str| Some(Source::Spotify(k, s.into()));
        assert_eq!(parse_link("https://open.spotify.com/playlist/37i9dQZF1DX4UtSsGT1Sbe?si=abc"), sp("playlist", "37i9dQZF1DX4UtSsGT1Sbe"));
        assert_eq!(parse_link("https://open.spotify.com/intl-de/album/4m2880jivSbbyEGAKfITCa"), sp("album", "4m2880jivSbbyEGAKfITCa"));
        assert_eq!(parse_link("spotify:playlist:37i9dQZF1DX4UtSsGT1Sbe"), sp("playlist", "37i9dQZF1DX4UtSsGT1Sbe"));
        assert_eq!(parse_link("https://open.spotify.com/track/abc"), None);
        assert_eq!(parse_link("not a link"), None);
    }

    #[test]
    fn reads_spotify_embed() {
        let html = r#"<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"name":"Mix","trackList":[{"title":"Song","subtitle":"Band","duration":208810},{"title":"Other","subtitle":"Act"}]}}}}}}</script></html>"#;
        let (name, wanted) = parse_spotify_embed(html).unwrap();
        assert_eq!(name, "Mix");
        assert_eq!(wanted[0], Wanted { title: "Song".into(), artist: "Band".into(), duration: Some(208.81) });
        assert_eq!(wanted[1].duration, None);
        assert!(parse_spotify_embed("<html>nothing</html>").is_none());
    }

    #[test]
    fn matches_songs() {
        assert!(same_song("Bohemian Rhapsody - Remastered 2011", "Bohemian Rhapsody"));
        assert!(same_song("Starboy", "Starboy (feat. Daft Punk)"));
        assert!(!same_song("Starboy", "Blinding Lights"));
        assert!(same_song("(I Can't Get No) Satisfaction", "(I Can't Get No) Satisfaction - Mono"));
        let wanted = Wanted { title: "Starboy".into(), artist: "The Weeknd".into(), duration: Some(230.0) };
        let t = |id: &str, title: &str, d: f64| Track { id: id.into(), title: title.into(), duration: Some(d), ..Default::default() };
        // A cover with the wrong length loses to the right-length original.
        let picked = pick(&wanted, vec![t("a", "Blinding Lights", 200.0), t("b", "Starboy", 300.0), t("c", "Starboy", 231.0)]);
        assert_eq!(picked.unwrap().id, "c");
        // No length match: the first title match still counts.
        assert_eq!(pick(&wanted, vec![t("b", "Starboy", 300.0)]).unwrap().id, "b");
        assert!(pick(&wanted, vec![t("a", "Blinding Lights", 230.0)]).is_none());
        assert_eq!(core_title("Bohemian Rhapsody - Remastered 2011"), "Bohemian Rhapsody");
    }
}
