//! Song search through YouTube Music's web API (the same one music.youtube.com
//! uses). It is much faster than asking yt-dlp and returns clean artist and
//! album fields.

use serde::Serialize;
use serde_json::{json, Value};

use crate::{Track, TrackArtist};

pub const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CLIENT_VERSION: &str = "1.20251020.01.00";
/// Search filter that restricts results to songs.
/// Search filters that restrict results to songs, artists or albums.
const SONGS_FILTER: &str = "EgWKAQIIAWoMEA4QChADEAQQCRAF";
const ARTISTS_FILTER: &str = "EgWKAQIgAWoMEA4QChADEAQQCRAF";
const ALBUMS_FILTER: &str = "EgWKAQIYAWoMEA4QChADEAQQCRAF";
const VIDEOS_FILTER: &str = "EgWKAQIQAWoMEA4QChADEAQQCRAF";

/// One call to the API (`search`, `browse`, `next`…), as music.youtube.com
/// makes it: `body` gets the web client's context added.
async fn call(http: &reqwest::Client, endpoint: &str, mut body: Value) -> Result<Value, String> {
    body["context"] = json!({ "client": {
        "clientName": "WEB_REMIX",
        "clientVersion": CLIENT_VERSION,
        "hl": "en",
        "gl": "US",
    }});
    http.post(format!("https://music.youtube.com/youtubei/v1/{endpoint}?prettyPrint=false"))
        .header("Origin", "https://music.youtube.com")
        .header("Referer", "https://music.youtube.com/")
        .header("X-YouTube-Client-Name", "67")
        .header("X-YouTube-Client-Version", CLIENT_VERSION)
        .json(&body)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| "Couldn't reach YouTube Music. Check your internet connection.".to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn search(http: &reqwest::Client, query: &str) -> Result<Vec<Track>, String> {
    let resp = call(http, "search", json!({ "query": query, "params": SONGS_FILTER })).await?;
    let mut items = Vec::new();
    collect(&resp, "musicResponsiveListItemRenderer", &mut items);
    let mut seen = std::collections::HashSet::new();
    Ok(items
        .into_iter()
        .filter_map(parse_item)
        .filter(|t| seen.insert(t.id.clone()))
        .collect())
}

/// Gathers every object stored under `key`, anywhere in the response.
fn collect<'a>(v: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(map) => {
            for (k, child) in map {
                if k == key {
                    out.push(child);
                } else {
                    collect(child, key, out);
                }
            }
        }
        Value::Array(arr) => arr.iter().for_each(|c| collect(c, key, out)),
        _ => {}
    }
}

fn find_video_id(v: &Value) -> Option<&str> {
    match v {
        Value::Object(map) => {
            if let Some(id) = map.get("watchEndpoint").and_then(|w| w["videoId"].as_str()) {
                return Some(id);
            }
            map.values().find_map(find_video_id)
        }
        Value::Array(arr) => arr.iter().find_map(find_video_id),
        _ => None,
    }
}

fn runs(column: &Value) -> Vec<&Value> {
    column["musicResponsiveListItemFlexColumnRenderer"]["text"]["runs"]
        .as_array()
        .map(|r| r.iter().collect())
        .unwrap_or_default()
}

/// Parses "3:45" or "1:02:03" into seconds.
pub fn parse_duration(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    parts.iter().try_fold(0.0, |acc, p| {
        let n: u32 = p.parse().ok()?;
        Some(acc * 60.0 + n as f64)
    })
}

/// Asks the image CDN for a larger square cover than the 60px thumbnail.
fn larger_cover(url: &str) -> String {
    if url.contains("googleusercontent.com") {
        if let Some(i) = url.rfind("=w") {
            return format!("{}=w400-h400-l90-rj", &url[..i]);
        }
    }
    url.to_string()
}

fn parse_item(r: &Value) -> Option<Track> {
    let video_id = r["playlistItemData"]["videoId"]
        .as_str()
        .or_else(|| find_video_id(r))?;
    if video_id.len() != 11 {
        return None;
    }
    let cols = r["flexColumns"].as_array()?;
    let title: String = runs(cols.first()?)
        .iter()
        .filter_map(|run| run["text"].as_str())
        .collect();
    if title.is_empty() {
        return None;
    }

    let mut artists = Vec::new();
    let mut album = None;
    let mut album_id = None;
    let mut duration = None;
    let mut loose = Vec::new();
    let detail_runs = cols.iter().skip(1).flat_map(runs);
    let fixed_runs = r["fixedColumns"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|c| {
            c["musicResponsiveListItemFixedColumnRenderer"]["text"]["runs"]
                .as_array()
                .into_iter()
                .flatten()
        });
    for run in detail_runs.chain(fixed_runs) {
        let text = run["text"].as_str().unwrap_or("").trim();
        if text.is_empty() || text == "•" || text == "&" || text == "," {
            continue;
        }
        let browse = run["navigationEndpoint"]["browseEndpoint"]["browseId"]
            .as_str()
            .unwrap_or("");
        if browse.starts_with("UC") || browse.starts_with("MPLA") {
            let id = browse.starts_with("UC").then(|| browse.to_string());
            artists.push(TrackArtist { name: text.to_string(), id });
        } else if browse.starts_with("MPRE") {
            album = Some(text.to_string());
            album_id = Some(browse.to_string());
        } else if let Some(d) = parse_duration(text) {
            duration = Some(d);
        } else if !matches!(text, "Song" | "Video" | "Episode") && !text.ends_with(" plays") {
            loose.push(text.to_string());
        }
    }
    // Some artists have no channel link; fall back to the first plain text run.
    if artists.is_empty() {
        artists.extend(loose.into_iter().take(1).map(|name| TrackArtist { name, id: None }));
    }

    let thumbnail = r["thumbnail"]["musicThumbnailRenderer"]["thumbnail"]["thumbnails"]
        .as_array()
        .and_then(|t| t.last())
        .and_then(|t| t["url"].as_str())
        .map(larger_cover);

    let (artist, artist_id, artists) = artist_fields(artists);
    Some(Track {
        id: format!("yt:{video_id}"),
        title,
        artist,
        album,
        duration,
        thumbnail,
        album_id,
        artist_id,
        artists,
    })
}

/// A song's artist fields: the names joined, the first artist page, and the
/// whole list when there are several.
fn artist_fields(artists: Vec<TrackArtist>) -> (String, Option<String>, Vec<TrackArtist>) {
    let names: Vec<&str> = artists.iter().map(|a| a.name.as_str()).collect();
    let first_page = artists.iter().find_map(|a| a.id.clone());
    (names.join(", "), first_page, if artists.len() > 1 { artists } else { Vec::new() })
}

fn text(v: &Value) -> String {
    v["runs"]
        .as_array()
        .map(|r| r.iter().filter_map(|run| run["text"].as_str()).collect())
        .unwrap_or_default()
}

fn biggest_thumbnail(v: &Value) -> Option<String> {
    let mut found = Vec::new();
    collect(v, "thumbnails", &mut found);
    found
        .first()?
        .as_array()?
        .last()?["url"]
        .as_str()
        .map(larger_cover)
}

/// The first object under `key`, anywhere in `v`.
fn first<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    let mut found = Vec::new();
    collect(v, key, &mut found);
    found.into_iter().next()
}

fn browse_id(v: &Value) -> Option<String> {
    v["navigationEndpoint"]["browseEndpoint"]["browseId"]
        .as_str()
        .map(str::to_string)
}

async fn browse(http: &reqwest::Client, browse_id: &str) -> Result<Value, String> {
    call(http, "browse", json!({ "browseId": browse_id })).await
}

/// An album or single, as listed on an artist page or found by a search.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub id: String,
    pub title: String,
    pub year: Option<String>,
    pub thumbnail: Option<String>,
    /// Search results say whose it is; an artist's own page doesn't need to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
}

/// The artists and albums that match a search, best first.
#[derive(Debug, Clone, Serialize)]
pub struct Pages {
    pub artists: Vec<ArtistRef>,
    pub albums: Vec<Release>,
}

pub async fn search_pages(http: &reqwest::Client, query: &str) -> Result<Pages, String> {
    let (artists, albums) = futures_util::join!(
        call(http, "search", json!({ "query": query, "params": ARTISTS_FILTER })),
        call(http, "search", json!({ "query": query, "params": ALBUMS_FILTER })),
    );
    Ok(Pages { artists: parse_artist_rows(&artists?), albums: parse_album_rows(&albums?) })
}

/// Search rows that lead to a page whose id starts with `prefix`: the id,
/// each column's text and the thumbnail.
fn page_rows(resp: &Value, prefix: &str) -> Vec<(String, Vec<String>, Option<String>)> {
    let mut rows = Vec::new();
    collect(resp, "musicResponsiveListItemRenderer", &mut rows);
    rows.into_iter()
        .filter_map(|r| {
            let id = browse_id(r).filter(|id| id.starts_with(prefix))?;
            let cols = r["flexColumns"].as_array()?.iter().map(|c| text(&c["musicResponsiveListItemFlexColumnRenderer"]["text"])).collect();
            let thumbnail = r["thumbnail"]["musicThumbnailRenderer"]["thumbnail"]["thumbnails"]
                .as_array()
                .and_then(|t| t.last())
                .and_then(|t| t["url"].as_str())
                .map(larger_cover);
            Some((id, cols, thumbnail))
        })
        .collect()
}

fn parse_artist_rows(resp: &Value) -> Vec<ArtistRef> {
    page_rows(resp, "UC")
        .into_iter()
        .filter_map(|(id, cols, thumbnail)| {
            let name = cols.into_iter().next().filter(|n| !n.is_empty())?;
            Some(ArtistRef { id, name, thumbnail })
        })
        .collect()
}

/// Album rows read "Title" and "Album • Artist • 2013".
fn parse_album_rows(resp: &Value) -> Vec<Release> {
    page_rows(resp, "MPRE")
        .into_iter()
        .filter_map(|(id, cols, thumbnail)| {
            let mut cols = cols.into_iter();
            let title = cols.next().filter(|t| !t.is_empty())?;
            let line = cols.next().unwrap_or_default();
            let mut parts: Vec<&str> = line.split(" • ").collect();
            let year = parts.last().filter(|y| y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit())).map(|y| y.to_string());
            if year.is_some() {
                parts.pop();
            }
            // The first part says what it is: "Album", "Single" or "EP".
            let artist = parts.get(1..).map(|p| p.join(" • ")).filter(|a| !a.is_empty());
            Some(Release { id, title, year, thumbnail, artist })
        })
        .collect()
}

/// A YouTube or YouTube Music playlist: its title and up to 500 songs.
pub async fn playlist(http: &reqwest::Client, list_id: &str) -> Result<(String, Vec<Track>), String> {
    let mut resp = browse(http, &format!("VL{list_id}")).await?;
    let title = first(&resp, "musicResponsiveHeaderRenderer")
        .or_else(|| first(&resp, "musicDetailHeaderRenderer"))
        .map(|h| text(&h["title"]))
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "That playlist isn't available. It may be private.".to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut tracks = Vec::new();
    loop {
        let mut rows = Vec::new();
        collect(&resp, "musicResponsiveListItemRenderer", &mut rows);
        let before = tracks.len();
        tracks.extend(rows.into_iter().filter_map(parse_item).filter(|t| seen.insert(t.id.clone())));
        // The rest comes in pages of about 100, each with the key to the next.
        let next = first(&resp, "continuationCommand").and_then(|c| c["token"].as_str()).map(str::to_string);
        match next {
            Some(token) if tracks.len() > before && tracks.len() < 500 => {
                resp = call(http, "browse", json!({ "continuation": token })).await?;
            }
            _ => break,
        }
    }
    tracks.truncate(500);
    Ok((title, tracks))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub artist_id: Option<String>,
    /// "Album", "Single" or "EP", plus the year: "Album • 2013".
    pub subtitle: String,
    pub thumbnail: Option<String>,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistRef {
    pub id: String,
    pub name: String,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: String,
    pub name: String,
    pub thumbnail: Option<String>,
    /// The artist's bio, as YouTube Music has it.
    pub description: Option<String>,
    /// "129M monthly audience".
    pub audience: Option<String>,
    pub top_songs: Vec<Track>,
    pub albums: Vec<Release>,
    pub singles: Vec<Release>,
    pub related: Vec<ArtistRef>,
}

/// Songs like `video_id`: the "radio" YouTube Music plays after it, without
/// the song itself.
pub async fn radio(http: &reqwest::Client, video_id: &str) -> Result<Vec<Track>, String> {
    let body = json!({
        "videoId": video_id,
        "playlistId": format!("RDAMVM{video_id}"),
        "isAudioOnly": true,
    });
    let resp = call(http, "next", body).await?;
    let mut items = Vec::new();
    collect(&resp, "playlistPanelVideoRenderer", &mut items);
    let own = format!("yt:{video_id}");
    Ok(items.into_iter().filter_map(parse_panel_item).filter(|t| t.id != own).collect())
}

/// The songs with these video ids, in the same order, through the call
/// music.youtube.com makes to fill its queue. Ids it doesn't know are left out.
pub async fn songs(http: &reqwest::Client, ids: &[String]) -> Result<Vec<Track>, String> {
    let batches = ids.chunks(100).map(|batch| async move {
        let resp = call(http, "music/get_queue", json!({ "videoIds": batch })).await?;
        Ok::<_, String>(parse_queue(&resp, batch))
    });
    let mut out = Vec::new();
    for batch in futures_util::future::join_all(batches).await {
        out.extend(batch?);
    }
    Ok(out)
}

/// One song per queue entry. A song that also has a music video can come as
/// both; the one with an id that was asked for wins.
fn parse_queue(resp: &Value, asked: &[String]) -> Vec<Track> {
    let entries = resp["queueDatas"].as_array().map(Vec::as_slice).unwrap_or_default();
    entries
        .iter()
        .filter_map(|entry| {
            let mut found = Vec::new();
            collect(entry, "playlistPanelVideoRenderer", &mut found);
            let wanted = |r: &&&Value| r["videoId"].as_str().is_some_and(|id| asked.iter().any(|a| a == id));
            parse_panel_item(found.iter().find(wanted).or(found.first())?)
        })
        .collect()
}

pub fn valid_video_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A song in an "Up next" list. Its byline reads "Artist • Album • Year",
/// or "Artist • 1M views • 2K likes" for a music video.
fn parse_panel_item(r: &Value) -> Option<Track> {
    let video_id = r["videoId"].as_str().filter(|id| id.len() == 11)?;
    let title = text(&r["title"]);
    if title.is_empty() {
        return None;
    }
    let mut artists = Vec::new();
    let mut album = None;
    let mut album_id = None;
    let byline = r["longBylineText"]["runs"].as_array().map(Vec::as_slice).unwrap_or_default();
    for run in byline {
        let text = run["text"].as_str().unwrap_or("").trim();
        let browse = run["navigationEndpoint"]["browseEndpoint"]["browseId"]
            .as_str()
            .unwrap_or("");
        if browse.starts_with("UC") {
            artists.push(TrackArtist { name: text.to_string(), id: Some(browse.to_string()) });
        } else if browse.starts_with("MPRE") {
            album = Some(text.to_string());
            album_id = Some(browse.to_string());
        }
    }
    if artists.is_empty() {
        let name = byline.first().and_then(|r| r["text"].as_str()).map(str::to_string);
        artists.extend(name.map(|name| TrackArtist { name, id: None }));
    }
    let (artist, artist_id, artists) = artist_fields(artists);
    Some(Track {
        id: format!("yt:{video_id}"),
        title,
        artist,
        album,
        duration: parse_duration(&text(&r["lengthText"])),
        thumbnail: r["thumbnail"]["thumbnails"]
            .as_array()
            .and_then(|t| t.last())
            .and_then(|t| t["url"].as_str())
            .map(larger_cover),
        album_id,
        artist_id,
        artists,
    })
}

/// Takes one song from each list in turn, so every list is represented near
/// the top. Songs already taken and those in `skip` are left out.
pub fn mix(lists: Vec<Vec<Track>>, skip: &[String], limit: usize) -> Vec<Track> {
    let mut seen: std::collections::HashSet<String> = skip.iter().cloned().collect();
    let mut lists: Vec<_> = lists.into_iter().map(Vec::into_iter).collect();
    let mut out = Vec::new();
    while out.len() < limit && !lists.is_empty() {
        lists.retain_mut(|list| {
            let Some(t) = list.find(|t| !seen.contains(&t.id)) else {
                return false;
            };
            seen.insert(t.id.clone());
            out.push(t);
            true
        });
    }
    out.truncate(limit);
    out
}

pub fn valid_browse_id(id: &str, prefix: &str) -> bool {
    id.starts_with(prefix)
        && id.len() < 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub async fn album(http: &reqwest::Client, id: &str) -> Result<Album, String> {
    parse_album(id, &browse(http, id).await?).ok_or_else(|| "That album isn't available.".to_string())
}

fn parse_album(id: &str, resp: &Value) -> Option<Album> {
    let header = first(resp, "musicResponsiveHeaderRenderer")?;
    let title = text(&header["title"]);
    let strap = header["straplineTextOne"]["runs"].as_array();
    let artist = text(&header["straplineTextOne"]);
    let artist_id = strap
        .into_iter()
        .flatten()
        .find_map(browse_id)
        .filter(|b| b.starts_with("UC"));
    let thumbnail = biggest_thumbnail(&header["thumbnail"]);
    let mut items = Vec::new();
    collect(resp, "musicResponsiveListItemRenderer", &mut items);
    let tracks = items
        .into_iter()
        .filter_map(parse_item)
        .map(|mut t| {
            // Album rows have no artwork or album link of their own.
            t.thumbnail = t.thumbnail.or_else(|| thumbnail.clone());
            t.album = Some(title.clone());
            t.album_id = Some(id.to_string());
            if t.artist.is_empty() {
                t.artist = artist.clone();
            }
            t.artist_id = t.artist_id.or_else(|| artist_id.clone());
            t
        })
        .collect();
    Some(Album {
        id: id.to_string(),
        title,
        artist,
        artist_id,
        subtitle: text(&header["subtitle"]),
        thumbnail,
        tracks,
    })
}

pub async fn artist(http: &reqwest::Client, id: &str) -> Result<Artist, String> {
    parse_artist(id, &browse(http, id).await?).ok_or_else(|| "That artist isn't available.".to_string())
}

fn parse_artist(id: &str, resp: &Value) -> Option<Artist> {
    let header = first(resp, "musicImmersiveHeaderRenderer").or_else(|| first(resp, "musicVisualHeaderRenderer"))?;
    let name = text(&header["title"]);
    let mut top_songs = Vec::new();
    if let Some(shelf) = first(resp, "musicShelfRenderer") {
        let mut items = Vec::new();
        collect(shelf, "musicResponsiveListItemRenderer", &mut items);
        top_songs = items.into_iter().filter_map(parse_item).collect();
    }
    let (mut albums, mut singles, mut related) = (Vec::new(), Vec::new(), Vec::new());
    let mut carousels = Vec::new();
    collect(resp, "musicCarouselShelfRenderer", &mut carousels);
    for shelf in carousels {
        let heading = text(&shelf["header"]["musicCarouselShelfBasicHeaderRenderer"]["title"]);
        let cards = shelf["contents"].as_array().into_iter().flatten();
        let cards = cards.filter_map(|c| c.get("musicTwoRowItemRenderer"));
        match heading.as_str() {
            "Albums" | "Singles" | "Singles & EPs" => {
                let list = if heading == "Albums" { &mut albums } else { &mut singles };
                list.extend(cards.filter_map(|c| {
                    let id = browse_id(c).filter(|b| b.starts_with("MPRE"))?;
                    // The subtitle ends with the year: "Single • 2023" or "2023".
                    let year = text(&c["subtitle"]).rsplit(" • ").next().map(str::to_string);
                    Some(Release { id, title: text(&c["title"]), year, thumbnail: biggest_thumbnail(&c["thumbnailRenderer"]), artist: None })
                }));
            }
            "Fans might also like" => related.extend(cards.filter_map(|c| {
                let id = browse_id(c).filter(|b| b.starts_with("UC"))?;
                Some(ArtistRef { id, name: text(&c["title"]), thumbnail: biggest_thumbnail(&c["thumbnailRenderer"]) })
            })),
            _ => {}
        }
    }
    let some = |s: String| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    Some(Artist {
        id: id.to_string(),
        name,
        thumbnail: biggest_thumbnail(&header["thumbnail"]),
        // Some pages keep the bio in a shelf of its own instead.
        description: some(text(&header["description"]))
            .or_else(|| some(text(&first(resp, "musicDescriptionShelfRenderer")?["description"]))),
        audience: some(text(&header["monthlyListenerCount"])),
        top_songs,
        albums,
        singles,
        related,
    })
}

// ---- music videos -------------------------------------------------------------------

/// A song's official music video, found with YouTube Music's video search:
/// without an account its `next` endpoint doesn't say which video goes with a song.
pub async fn music_video(http: &reqwest::Client, title: &str, artist: &str) -> Result<Option<String>, String> {
    let resp = call(http, "search", json!({ "query": format!("{title} {artist}"), "params": VIDEOS_FILTER })).await?;
    Ok(pick_music_video(&resp, title, artist))
}

/// Letters and digits only, lowercase: "Beyoncé" matches "BEYONCÉ", "Harder, Better" "harder better".
fn plain(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// A title without what follows it in brackets ("(feat. …)", "(Official Video)",
/// "[4K]") or an "Artist - " before it.
fn bare_title(title: &str) -> String {
    let cut = [" (", " ["].iter().filter_map(|p| title.find(p)).min();
    let title = cut.map_or(title, |i| &title[..i]);
    plain(title.rsplit(" - ").next().unwrap_or(title))
}

/// The first official video (not a fan upload) whose line names the song's
/// first artist and whose title is the song's ("Love" isn't "Lovely").
fn pick_music_video(resp: &Value, title: &str, artist: &str) -> Option<String> {
    let name = bare_title(title);
    let by = plain(artist.split(',').next().unwrap_or(artist));
    if name.is_empty() || by.is_empty() {
        return None;
    }
    let mut rows = Vec::new();
    collect(resp, "musicResponsiveListItemRenderer", &mut rows);
    rows.into_iter().take(8).find_map(|r| {
        let mut kinds = Vec::new();
        collect(r, "musicVideoType", &mut kinds);
        if kinds.first()?.as_str()? != "MUSIC_VIDEO_TYPE_OMV" {
            return None;
        }
        let cols: Vec<String> = r["flexColumns"].as_array()?.iter().map(|c| text(&c["musicResponsiveListItemFlexColumnRenderer"]["text"])).collect();
        // "Blinding Lights (Official Video)" and "The Weeknd • 1B views • 4:23".
        let line = plain(cols.get(1)?.split(" • ").next()?);
        let id = r["playlistItemData"]["videoId"].as_str().or_else(|| find_video_id(r))?;
        (bare_title(cols.first()?) == name && line.contains(&by) && valid_video_id(id)).then(|| id.to_string())
    })
}

// ---- Explore: charts, new releases, moods and genres ------------------------------

/// A playlist or album on a shelf: a chart, a new release, one of a mood's playlists.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    /// A playlist id ("PL…", "OLAK5uy_…", "RDCLAK5uy_…", without the "VL") or an album id ("MPRE…").
    pub id: String,
    pub title: String,
    /// "Album • Artist", "Playlist • YouTube Music"…
    pub sub: Option<String>,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Shelf {
    pub title: String,
    pub cards: Vec<Card>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Country {
    /// Two letters ("RO"), or "ZZ" for Global.
    pub code: String,
    pub name: String,
}

/// A tile in Moods & genres; `params` opens its page.
#[derive(Debug, Clone, Serialize)]
pub struct Mood {
    pub title: String,
    pub params: String,
    /// "#rrggbb", the stripe YouTube Music gives the tile.
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoodGroup {
    pub title: String,
    pub moods: Vec<Mood>,
}

/// Everything Search shows with nothing typed, besides recent searches.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Explore {
    pub country: String,
    pub countries: Vec<Country>,
    pub charts: Vec<Card>,
    pub top_artists: Vec<ArtistRef>,
    pub new_releases: Vec<Card>,
    pub moods: Vec<MoodGroup>,
}

/// Charts for `country` ("ZZ" is Global; YouTube Music shows Global for one it
/// has no charts for), or without one for where the phone is. New releases and
/// moods always go by where it is.
pub async fn explore(http: &reqwest::Client, country: Option<&str>) -> Result<Explore, String> {
    let mut charts = json!({ "browseId": "FEmusic_charts" });
    if let Some(code) = country {
        charts["formData"] = json!({ "selectedValues": [code] });
    }
    let (charts, releases, moods) = futures_util::join!(
        call(http, "browse", charts),
        browse(http, "FEmusic_new_releases"),
        browse(http, "FEmusic_moods_and_genres"),
    );
    let charts = charts?;
    let countries = parse_countries(&charts);
    // The menu always lists where the phone is first.
    let country = country.map(str::to_string).or_else(|| countries.first().map(|c| c.code.clone())).unwrap_or_else(|| "ZZ".into());
    let cards = |resp: &Value, album: bool| -> Vec<Card> {
        shelves(resp).into_iter().flat_map(|s| s.cards).filter(|c| c.id.starts_with("MPRE") == album).collect()
    };
    Ok(Explore {
        country,
        countries,
        charts: cards(&charts, false),
        top_artists: parse_artist_rows(&charts),
        new_releases: releases.map(|r| cards(&r, true)).unwrap_or_default(),
        moods: moods.map(|m| parse_moods(&m)).unwrap_or_default(),
    })
}

/// A mood's or genre's page: shelves of playlists.
pub async fn mood(http: &reqwest::Client, params: &str) -> Result<Vec<Shelf>, String> {
    let resp = call(http, "browse", json!({ "browseId": "FEmusic_moods_and_genres_category", "params": params })).await?;
    let shelves: Vec<Shelf> = shelves(&resp).into_iter().filter(|s| !s.cards.is_empty()).collect();
    if shelves.is_empty() {
        return Err("This list isn't available.".into());
    }
    Ok(shelves)
}

/// Mood params as YouTube Music writes them (base64).
pub fn valid_params(params: &str) -> bool {
    (1..256).contains(&params.len()) && params.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_=%+/".contains(&b))
}

/// The page's shelves of cards, in order: carousels ("contents") and grids ("items").
fn shelves(resp: &Value) -> Vec<Shelf> {
    fn walk(v: &Value, out: &mut Vec<Shelf>) {
        match v {
            Value::Object(map) => {
                for (k, child) in map {
                    let (head, items) = match k.as_str() {
                        "musicCarouselShelfRenderer" => (&child["header"]["musicCarouselShelfBasicHeaderRenderer"]["title"], &child["contents"]),
                        "gridRenderer" => (&child["header"]["gridHeaderRenderer"]["title"], &child["items"]),
                        _ => {
                            walk(child, out);
                            continue;
                        }
                    };
                    let cards = items.as_array().into_iter().flatten().filter_map(|c| c.get("musicTwoRowItemRenderer")).filter_map(parse_card);
                    out.push(Shelf { title: text(head), cards: cards.collect() });
                }
            }
            Value::Array(arr) => arr.iter().for_each(|c| walk(c, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(resp, &mut out);
    out
}

/// A card that opens a playlist or an album; videos and artists aren't cards here.
fn parse_card(c: &Value) -> Option<Card> {
    let browse = browse_id(c).or_else(|| browse_id(c["title"]["runs"].get(0)?))?;
    let id = if let Some(list) = browse.strip_prefix("VL").filter(|l| crate::share::valid_list_id(l)) {
        list.to_string()
    } else if valid_browse_id(&browse, "MPRE") {
        browse
    } else {
        return None;
    };
    let title = text(&c["title"]);
    if title.is_empty() {
        return None;
    }
    let sub = Some(text(&c["subtitle"])).filter(|s| !s.is_empty());
    Some(Card { id, title, sub, thumbnail: biggest_thumbnail(&c["thumbnailRenderer"]) })
}

/// The chart countries, each once, as the menu on music.youtube.com/charts lists them.
fn parse_countries(resp: &Value) -> Vec<Country> {
    let mut items = Vec::new();
    collect(resp, "musicMultiSelectMenuItemRenderer", &mut items);
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter_map(|item| {
            let code = country_code(item["formItemEntityKey"].as_str()?)?;
            let name = text(&item["title"]);
            (!name.is_empty() && seen.insert(code.clone())).then_some(Country { code, name })
        })
        .collect()
}

/// A country menu item's key holds "…explore_charts_country_menu_<digits>RO…" in base64.
fn country_code(key: &str) -> Option<String> {
    let raw = base64_decode(&key.replace("%3D", "="))?;
    let raw = String::from_utf8_lossy(&raw);
    let rest = &raw[raw.find("country_menu_")? + "country_menu_".len()..];
    let code: String = rest.trim_start_matches(|c: char| c.is_ascii_digit()).chars().take(2).collect();
    (code.len() == 2 && code.bytes().all(|b| b.is_ascii_uppercase())).then_some(code)
}

/// Standard or URL-safe base64, padding optional.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for b in s.bytes().take_while(|&b| b != b'=') {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

fn parse_moods(resp: &Value) -> Vec<MoodGroup> {
    let mut grids = Vec::new();
    collect(resp, "gridRenderer", &mut grids);
    grids
        .into_iter()
        .map(|g| MoodGroup {
            title: text(&g["header"]["gridHeaderRenderer"]["title"]),
            moods: g["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|i| {
                    let b = i.get("musicNavigationButtonRenderer")?;
                    let params = b["clickCommand"]["browseEndpoint"]["params"].as_str().filter(|p| valid_params(p))?;
                    // An ARGB number: 4288988671 is #a4c5ff.
                    let color = b["solid"]["leftStripeColor"].as_u64().map(|c| format!("#{:06x}", c & 0xff_ffff));
                    Some(Mood { title: text(&b["buttonText"]), params: params.to_string(), color })
                })
                .collect(),
        })
        .filter(|g| !g.moods.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(parse_duration("3:45"), Some(225.0));
        assert_eq!(parse_duration("1:02:03"), Some(3723.0));
        assert_eq!(parse_duration("Song"), None);
        assert_eq!(parse_duration("12"), None);
    }

    fn song_row(video_id: &str, title: &str) -> Value {
        json!({ "musicResponsiveListItemRenderer": {
            "playlistItemData": { "videoId": video_id },
            "flexColumns": [
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": title }] }}},
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": "12M plays" }] }}}
            ],
            "fixedColumns": [
                { "musicResponsiveListItemFixedColumnRenderer": { "text": { "runs": [{ "text": "4:36" }] }}}
            ]
        }})
    }

    #[test]
    fn parses_album_page() {
        let resp = json!({ "contents": { "twoColumnBrowseResultsRenderer": {
            "tabs": [{ "musicResponsiveHeaderRenderer": {
                "title": { "runs": [{ "text": "Random Access Memories" }] },
                "straplineTextOne": { "runs": [{ "text": "Daft Punk", "navigationEndpoint": { "browseEndpoint": { "browseId": "UCdp" }}}] },
                "subtitle": { "runs": [{ "text": "Album" }, { "text": " • " }, { "text": "2013" }] },
                "thumbnail": { "thumbnails": [{ "url": "https://lh3.googleusercontent.com/x=w60-h60" }] }
            }}],
            "secondaryContents": { "musicShelfRenderer": { "contents": [song_row("IluRBvnYMoY", "Give Life Back to Music"), song_row("dQw4w9WgXcQ", "The Game of Love")] }}
        }}});
        let a = parse_album("MPREb_x", &resp).unwrap();
        assert_eq!((a.title.as_str(), a.artist.as_str(), a.subtitle.as_str()), ("Random Access Memories", "Daft Punk", "Album • 2013"));
        assert_eq!(a.artist_id.as_deref(), Some("UCdp"));
        assert_eq!(a.tracks.len(), 2);
        let t = &a.tracks[0];
        // Rows borrow the album's cover, name, link and artist.
        assert_eq!((t.title.as_str(), t.artist.as_str(), t.duration), ("Give Life Back to Music", "Daft Punk", Some(276.0)));
        assert_eq!(t.album_id.as_deref(), Some("MPREb_x"));
        assert_eq!(t.thumbnail.as_deref(), Some("https://lh3.googleusercontent.com/x=w400-h400-l90-rj"));
    }

    #[test]
    fn parses_artist_page() {
        let card = |title: &str, sub: &str, id: &str| json!({ "musicTwoRowItemRenderer": {
            "title": { "runs": [{ "text": title }] },
            "subtitle": { "runs": [{ "text": sub }] },
            "navigationEndpoint": { "browseEndpoint": { "browseId": id }},
            "thumbnailRenderer": { "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [{ "url": "https://i.ytimg.com/a.jpg" }] }}}
        }});
        let shelf = |heading: &str, items: Vec<Value>| json!({ "musicCarouselShelfRenderer": {
            "header": { "musicCarouselShelfBasicHeaderRenderer": { "title": { "runs": [{ "text": heading }] }}},
            "contents": items
        }});
        let resp = json!({
            "header": { "musicImmersiveHeaderRenderer": {
                "title": { "runs": [{ "text": "Daft Punk" }] },
                "description": { "runs": [{ "text": "Daft Punk were a French duo." }] },
                "monthlyListenerCount": { "runs": [{ "text": "66.1M monthly audience" }] }
            }},
            "contents": [
                { "musicShelfRenderer": { "contents": [song_row("IluRBvnYMoY", "Instant Crush")] }},
                shelf("Albums", vec![card("Discovery", "2001", "MPREb_disc"), card("Not an album", "x", "VLPL")]),
                shelf("Singles & EPs", vec![card("GLBTM", "Single • 2023", "MPREb_glb")]),
                shelf("Videos", vec![card("Some video", "1M views", "MPREb_vid")]),
                shelf("Fans might also like", vec![card("Justice", "10M monthly audience", "UCjustice")])
            ]
        });
        let a = parse_artist("UCdp", &resp).unwrap();
        assert_eq!(a.name, "Daft Punk");
        assert_eq!(a.description.as_deref(), Some("Daft Punk were a French duo."));
        assert_eq!(a.audience.as_deref(), Some("66.1M monthly audience"));
        assert_eq!(a.top_songs.len(), 1);
        assert_eq!(a.albums.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), ["Discovery"]);
        assert_eq!(a.albums[0].year.as_deref(), Some("2001"));
        assert_eq!(a.singles[0].year.as_deref(), Some("2023"));
        assert_eq!(a.related[0].id, "UCjustice");
        assert!(valid_browse_id("UCdp-_x", "UC") && !valid_browse_id("UC/../x", "UC") && !valid_browse_id("MPREb", "UC"));
    }

    #[test]
    fn parses_radio_item() {
        let run = |text: &str, id: &str| json!({ "text": text, "navigationEndpoint": { "browseEndpoint": { "browseId": id }}});
        let item = json!({
            "videoId": "qPRNIHxLhmc",
            "title": { "runs": [{ "text": "I Feel It Coming" }] },
            "longBylineText": { "runs": [run("The Weeknd", "UCweeknd"), { "text": " • " }, run("Starboy", "MPREb_star"), { "text": " • " }, { "text": "2016" }] },
            "lengthText": { "runs": [{ "text": "4:30" }] },
            "thumbnail": { "thumbnails": [{ "url": "https://lh3.googleusercontent.com/s=w60-h60" }, { "url": "https://lh3.googleusercontent.com/s=w544-h544-l90-rj" }] }
        });
        let t = parse_panel_item(&item).unwrap();
        assert_eq!((t.id.as_str(), t.title.as_str(), t.artist.as_str()), ("yt:qPRNIHxLhmc", "I Feel It Coming", "The Weeknd"));
        assert_eq!((t.album.as_deref(), t.album_id.as_deref(), t.artist_id.as_deref()), (Some("Starboy"), Some("MPREb_star"), Some("UCweeknd")));
        assert_eq!(t.duration, Some(270.0));
        assert_eq!(t.thumbnail.as_deref(), Some("https://lh3.googleusercontent.com/s=w400-h400-l90-rj"));
        // A music video: plain-text artist, no album.
        let video = json!({ "videoId": "dQw4w9WgXcQ", "title": { "runs": [{ "text": "Song" }] }, "longBylineText": { "runs": [{ "text": "Someone" }, { "text": " • " }, { "text": "1M views" }] } });
        let v = parse_panel_item(&video).unwrap();
        assert_eq!((v.artist.as_str(), v.album, v.duration), ("Someone", None, None));
    }

    #[test]
    fn mixes_lists_in_turn() {
        let t = |id: &str| Track { id: id.into(), ..Track::default() };
        let lists = vec![vec![t("a1"), t("shared"), t("a2")], vec![t("shared"), t("b1")], vec![t("liked"), t("c1")]];
        let ids = |v: Vec<Track>| v.into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!(ids(mix(lists.clone(), &["liked".into()], 10)), ["a1", "shared", "c1", "a2", "b1"]);
        assert_eq!(ids(mix(lists, &[], 2)), ["a1", "shared"]);
    }

    #[test]
    fn parses_song_row() {
        let row = json!({
            "playlistItemData": { "videoId": "dQw4w9WgXcQ" },
            "thumbnail": { "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [
                { "url": "https://lh3.googleusercontent.com/abc=w60-h60-l90-rj" }
            ]}}},
            "flexColumns": [
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [
                    { "text": "Never Gonna Give You Up" }
                ]}}},
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [
                    { "text": "Rick Astley", "navigationEndpoint": { "browseEndpoint": { "browseId": "UCabc" }}},
                    { "text": " • " },
                    { "text": "Whenever You Need Somebody", "navigationEndpoint": { "browseEndpoint": { "browseId": "MPREb_x" }}},
                    { "text": " • " },
                    { "text": "3:34" }
                ]}}}
            ]
        });
        let t = parse_item(&row).unwrap();
        assert_eq!(t.id, "yt:dQw4w9WgXcQ");
        assert_eq!(t.title, "Never Gonna Give You Up");
        assert_eq!(t.artist, "Rick Astley");
        assert_eq!(t.album.as_deref(), Some("Whenever You Need Somebody"));
        assert_eq!(t.duration, Some(214.0));
        assert_eq!(
            t.thumbnail.as_deref(),
            Some("https://lh3.googleusercontent.com/abc=w400-h400-l90-rj")
        );
    }

    #[test]
    fn parses_queue() {
        let panel = |id: &str, title: &str| json!({ "playlistPanelVideoRenderer": {
            "videoId": id,
            "title": { "runs": [{ "text": title }] },
            "longBylineText": { "runs": [{ "text": "Daft Punk", "navigationEndpoint": { "browseEndpoint": { "browseId": "UCdp" }}}] },
            "lengthText": { "runs": [{ "text": "4:36" }] }
        }});
        let resp = json!({ "queueDatas": [
            { "content": panel("IluRBvnYMoY", "Give Life Back to Music") },
            // A song with a music video comes as both.
            { "content": { "playlistPanelVideoWrapperRenderer": {
                "primaryRenderer": panel("videoxxxxxx", "One More Time (Official Video)"),
                "counterpart": [{ "counterpartRenderer": panel("FGBhQbmPwH8", "One More Time") }]
            }}}
        ]});
        let tracks = parse_queue(&resp, &["IluRBvnYMoY".into(), "FGBhQbmPwH8".into()]);
        let got: Vec<_> = tracks.iter().map(|t| (t.id.as_str(), t.title.as_str(), t.duration)).collect();
        assert_eq!(got, [("yt:IluRBvnYMoY", "Give Life Back to Music", Some(276.0)), ("yt:FGBhQbmPwH8", "One More Time", Some(276.0))]);
        // One artist needs no list.
        assert!(tracks[0].artists.is_empty());
    }

    #[test]
    fn keeps_each_artist_of_a_song_with_several() {
        let artist = |name: &str, id: &str| json!({ "text": name, "navigationEndpoint": { "browseEndpoint": { "browseId": id }}});
        let panel = json!({
            "videoId": "IluRBvnYMoY",
            "title": { "runs": [{ "text": "Get Lucky" }] },
            "longBylineText": { "runs": [
                artist("Daft Punk", "UCdp"), { "text": ", " }, artist("Pharrell Williams", "UCpw"), { "text": " & " }, artist("Nile Rodgers", "UCnr"),
                { "text": " • " }, { "text": "Random Access Memories", "navigationEndpoint": { "browseEndpoint": { "browseId": "MPREb_ram" }}}
            ]}
        });
        let t = parse_panel_item(&panel).unwrap();
        assert_eq!((t.artist.as_str(), t.artist_id.as_deref()), ("Daft Punk, Pharrell Williams, Nile Rodgers", Some("UCdp")));
        let pages: Vec<_> = t.artists.iter().map(|a| (a.name.as_str(), a.id.as_deref())).collect();
        assert_eq!(pages, [("Daft Punk", Some("UCdp")), ("Pharrell Williams", Some("UCpw")), ("Nile Rodgers", Some("UCnr"))]);

        // In search results an artist can come without a page of their own.
        let row = json!({
            "playlistItemData": { "videoId": "IluRBvnYMoY" },
            "flexColumns": [
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": "Get Lucky" }] }}},
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [artist("Daft Punk", "MPLAUCdp"), { "text": " & " }, artist("Pharrell Williams", "UCpw")] }}}
            ]
        });
        let t = parse_item(&row).unwrap();
        assert_eq!(t.artist_id.as_deref(), Some("UCpw"));
        let pages: Vec<_> = t.artists.iter().map(|a| (a.name.as_str(), a.id.as_deref())).collect();
        assert_eq!(pages, [("Daft Punk", None), ("Pharrell Williams", Some("UCpw"))]);
        // Songs saved before the list existed still load, and one artist adds nothing to what is saved.
        let old: Track = serde_json::from_str(r#"{"id":"yt:x","title":"t","artist":"a","album":null,"duration":null,"thumbnail":null}"#).unwrap();
        assert!(old.artists.is_empty() && !serde_json::to_string(&old).unwrap().contains("artists"));
    }

    #[test]
    fn parses_artist_and_album_searches() {
        let row = |id: &str, title: &str, line: &str| json!({ "musicResponsiveListItemRenderer": {
            "navigationEndpoint": { "browseEndpoint": { "browseId": id }},
            "thumbnail": { "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [{ "url": "https://lh3.googleusercontent.com/a=w60-h60-l90-rj" }] }}},
            "flexColumns": [
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": title }] }}},
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": line }] }}}
            ]
        }});
        let artists = json!({ "contents": [row("UCdp", "Daft Punk", "Artist • 66.1M monthly audience"), row("MPREb_x", "Not an artist", "Album")] });
        let a = parse_artist_rows(&artists);
        assert_eq!(a.len(), 1);
        assert_eq!((a[0].id.as_str(), a[0].name.as_str()), ("UCdp", "Daft Punk"));
        assert_eq!(a[0].thumbnail.as_deref(), Some("https://lh3.googleusercontent.com/a=w400-h400-l90-rj"));

        let albums = json!({ "contents": [
            row("MPREb_ram", "Random Access Memories", "Album • Daft Punk • 2013"),
            row("MPREb_gl", "Get Lucky", "Single • Daft Punk • Pharrell Williams • 2013"),
            row("MPREb_ny", "No Year", "EP • Someone"),
        ]});
        let got: Vec<_> = parse_album_rows(&albums).into_iter().map(|r| (r.id, r.title, r.artist, r.year)).collect();
        assert_eq!(got, [
            ("MPREb_ram".into(), "Random Access Memories".into(), Some("Daft Punk".into()), Some("2013".into())),
            ("MPREb_gl".into(), "Get Lucky".into(), Some("Daft Punk • Pharrell Williams".into()), Some("2013".into())),
            ("MPREb_ny".into(), "No Year".into(), Some("Someone".into()), None),
        ]);
    }
    #[test]
    fn parses_explore_shelves() {
        let card = |id: &str, title: &str, sub: &str| json!({ "musicTwoRowItemRenderer": {
            "title": { "runs": [{ "text": title }] },
            "subtitle": { "runs": [{ "text": sub }] },
            "navigationEndpoint": { "browseEndpoint": { "browseId": id }},
            "thumbnailRenderer": { "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [{ "url": "https://yt3.googleusercontent.com/c=s576" }] }}}
        }});
        let video = json!({ "musicTwoRowItemRenderer": {
            "title": { "runs": [{ "text": "A video" }] },
            "navigationEndpoint": { "watchEndpoint": { "videoId": "dQw4w9WgXcQ" }}
        }});
        let resp = json!({ "contents": [
            { "musicCarouselShelfRenderer": {
                "header": { "musicCarouselShelfBasicHeaderRenderer": { "title": { "runs": [{ "text": "Video charts" }] }}},
                "contents": [card("VLPL4fGSI1pDJn6L8lQpfbnXpXUR71uksmP2", "Top 100 Music Videos Romania", "Chart"), video]
            }},
            { "gridRenderer": {
                "header": { "gridHeaderRenderer": { "title": { "runs": [{ "text": "Albums & singles" }] }}},
                "items": [card("MPREb_ram", "Random Access Memories", "Album • Daft Punk"), card("UCdp", "An artist", "Artist")]
            }}
        ]});
        let got: Vec<_> = shelves(&resp).into_iter().map(|s| (s.title, s.cards.into_iter().map(|c| (c.id, c.title, c.sub)).collect::<Vec<_>>())).collect();
        assert_eq!(got, [
            ("Video charts".to_string(), vec![("PL4fGSI1pDJn6L8lQpfbnXpXUR71uksmP2".to_string(), "Top 100 Music Videos Romania".to_string(), Some("Chart".to_string()))]),
            ("Albums & singles".to_string(), vec![("MPREb_ram".to_string(), "Random Access Memories".to_string(), Some("Album • Daft Punk".to_string()))]),
        ]);
    }

    #[test]
    fn parses_chart_countries_and_moods() {
        let country = |name: &str, key: &str| json!({ "musicMultiSelectMenuItemRenderer": { "title": { "runs": [{ "text": name }] }, "formItemEntityKey": key }});
        // Real keys from music.youtube.com/charts; the selected country comes twice.
        let resp = json!({ "items": [
            country("Spain", "EidleHBsb3JlX2NoYXJ0c19jb3VudHJ5X21lbnVfMzE2NzY2NTY3RVMgkQEoAQ%3D%3D"),
            country("Argentina", "EidleHBsb3JlX2NoYXJ0c19jb3VudHJ5X21lbnVfMzE2NzY2NTY3QVIgkQEoAQ%3D%3D"),
            country("Spain", "EidleHBsb3JlX2NoYXJ0c19jb3VudHJ5X21lbnVfMzE2NzY2NTY3RVMgkQEoAQ%3D%3D"),
            country("Broken", "not base64!"),
        ]});
        let got: Vec<_> = parse_countries(&resp).into_iter().map(|c| (c.code, c.name)).collect();
        assert_eq!(got, [("ES".to_string(), "Spain".to_string()), ("AR".to_string(), "Argentina".to_string())]);

        let moods = json!({ "contents": [{ "gridRenderer": {
            "header": { "gridHeaderRenderer": { "title": { "runs": [{ "text": "Moods & moments" }] }}},
            "items": [
                { "musicNavigationButtonRenderer": {
                    "buttonText": { "runs": [{ "text": "Chill" }] },
                    "solid": { "leftStripeColor": 4288988671u64 },
                    "clickCommand": { "browseEndpoint": { "browseId": "FEmusic_moods_and_genres_category", "params": "ggMPOg1uX1JOQWZFeDByc2Jm" }}
                }},
                { "musicNavigationButtonRenderer": { "buttonText": { "runs": [{ "text": "No params" }] }}}
            ]
        }}]});
        let groups = parse_moods(&moods);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].title, "Moods & moments");
        let m = &groups[0].moods;
        assert_eq!(m.len(), 1);
        assert_eq!((m[0].title.as_str(), m[0].params.as_str(), m[0].color.as_deref()), ("Chill", "ggMPOg1uX1JOQWZFeDByc2Jm", Some("#a4c5ff")));
        assert!(!valid_params("a b"));
    }
    #[test]
    fn picks_the_official_music_video() {
        let row = |id: &str, kind: &str, title: &str, line: &str| json!({ "musicResponsiveListItemRenderer": {
            "playlistItemData": { "videoId": id },
            "overlay": { "musicItemThumbnailOverlayRenderer": { "content": { "musicPlayButtonRenderer": { "playNavigationEndpoint": { "watchEndpoint": {
                "videoId": id,
                "watchEndpointMusicSupportedConfigs": { "watchEndpointMusicConfig": { "musicVideoType": kind }}
            }}}}}},
            "flexColumns": [
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": title }] }}},
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": line }] }}}
            ]
        }});
        // Real results for "Levitating Dua Lipa": fan uploads first.
        let resp = json!({ "contents": [
            row("g9UsdYKFz4Q", "MUSIC_VIDEO_TYPE_UGC", "Dua Lipa - Levitating (Lyrics) ft. DaBaby", "Margaret • 10 views • 18:36"),
            row("xxxxxxxxxxx", "MUSIC_VIDEO_TYPE_OMV", "Physical", "Dua Lipa • 400M views • 3:14"),
            row("TUVcZfQe-Kw", "MUSIC_VIDEO_TYPE_OMV", "Levitating (feat. DaBaby)", "Dua Lipa • 1.1B views • 3:51"),
        ]});
        assert_eq!(pick_music_video(&resp, "Levitating (feat. DaBaby)", "Dua Lipa, DaBaby").as_deref(), Some("TUVcZfQe-Kw"));
        // Another artist's official video of a song with the same name is not it.
        assert_eq!(pick_music_video(&resp, "Levitating", "Someone Else"), None);
        let hbfs = json!({ "contents": [row("gAjR4_CbPpQ", "MUSIC_VIDEO_TYPE_OMV", "Harder, Better, Faster, Stronger", "Daft Punk • 164M views • 3:43")] });
        assert_eq!(pick_music_video(&hbfs, "Harder, Better, Faster, Stronger", "Daft Punk").as_deref(), Some("gAjR4_CbPpQ"));
        // A longer title that starts with the song's is another song.
        let love = json!({ "contents": [
            row("aaaaaaaaaaa", "MUSIC_VIDEO_TYPE_OMV", "Lovely (Official Video)", "Someone • 2M views • 3:20"),
            row("bbbbbbbbbbb", "MUSIC_VIDEO_TYPE_OMV", "Someone - Love [4K]", "Someone • 1M views • 3:01"),
        ]});
        assert_eq!(pick_music_video(&love, "Love", "Someone").as_deref(), Some("bbbbbbbbbbb"));
    }
}
