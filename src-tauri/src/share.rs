//! Links for sharing a song, album, artist or playlist with other Cadence users.
//! They point at a small page on GitHub Pages (`share-page/` in this repo).
//! Phones with Cadence open them in the app (an Android App Link, verified
//! by the page's `assetlinks.json`); anyone else sees the page, which offers
//! YouTube Music and the app. Everything a link needs is in the link itself:
//! there is no server. Phones also open YouTube and YouTube Music links
//! (`parse_youtube`), shared to Cadence from those apps. Only phones share
//! and open links, so the desktop leaves most of this unused.
#![cfg_attr(desktop, allow(dead_code))]

use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::ytmusic::{valid_browse_id, valid_video_id};

pub const BASE: &str = "https://octavianbanarizatic-hub.github.io/c/";
/// A playlist link carries every song's id, so long playlists are cut here
/// to keep the link short enough for chat apps.
pub const MAX_SONGS: usize = 300;
/// Titles and names longer than this are cut.
const MAX_TEXT: usize = 120;

/// What a link opens. Ids are YouTube's own, without Cadence's `yt:` prefix.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Shared {
    Song { id: String, title: String, artist: String },
    /// `cover` is a song's id, whose thumbnail the page shows.
    Album { id: String, title: String, artist: String, cover: Option<String> },
    Playlist { name: String, ids: Vec<String> },
    Artist { id: String, name: String },
    /// A playlist on YouTube, by its list id (`PL…`, `OLAK5uy_…`).
    YoutubePlaylist { id: String },
}

impl Shared {
    pub fn valid(&self) -> bool {
        match self {
            Shared::Song { id, .. } => valid_video_id(id),
            Shared::Album { id, cover, .. } => valid_browse_id(id, "MPRE") && cover.as_deref().is_none_or(valid_video_id),
            Shared::Playlist { ids, .. } => !ids.is_empty() && ids.iter().all(|id| valid_video_id(id)),
            Shared::Artist { id, .. } => valid_browse_id(id, "UC"),
            Shared::YoutubePlaylist { id } => valid_list_id(id),
        }
    }
}

pub fn valid_list_id(id: &str) -> bool {
    (2..64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn cut(s: &str) -> String {
    s.trim().chars().take(MAX_TEXT).collect()
}

pub fn link(item: &Shared) -> String {
    let mut url = Url::parse(BASE).expect("valid base");
    {
        let mut q = url.query_pairs_mut();
        match item {
            Shared::Song { id, title, artist } => {
                q.append_pair("s", id).append_pair("t", &cut(title)).append_pair("a", &cut(artist));
            }
            Shared::Album { id, title, artist, cover } => {
                q.append_pair("al", id).append_pair("t", &cut(title)).append_pair("a", &cut(artist));
                if let Some(cover) = cover {
                    q.append_pair("c", cover);
                }
            }
            Shared::Playlist { name, ids } => {
                // Video ids are always 11 characters, so they need no separator.
                q.append_pair("p", &cut(name)).append_pair("ids", &ids.iter().take(MAX_SONGS).map(String::as_str).collect::<String>());
            }
            Shared::Artist { id, name } => {
                q.append_pair("ar", id).append_pair("t", &cut(name));
            }
            Shared::YoutubePlaylist { id } => {
                q.append_pair("yl", id);
            }
        }
    }
    url.into()
}

/// The text the share sheet sends: what it is, then the link.
pub fn message(item: &Shared) -> String {
    let what = match item {
        Shared::Song { title, artist, .. } | Shared::Album { title, artist, .. } if !artist.trim().is_empty() => {
            format!("{} – {}", cut(title), cut(artist))
        }
        Shared::Song { title, .. } | Shared::Album { title, .. } => cut(title),
        Shared::Playlist { name, .. } | Shared::Artist { name, .. } => cut(name),
        Shared::YoutubePlaylist { .. } => "A playlist".into(),
    };
    format!("{what}\n{}", link(item))
}

/// What a Cadence link opens; None for any other link, or a broken one.
pub fn parse(link: &str) -> Option<Shared> {
    let url = Url::parse(link).ok()?;
    let base = Url::parse(BASE).ok()?;
    if url.scheme() != "https" || url.host_str() != base.host_str() || !url.path().starts_with(base.path()) {
        return None;
    }
    let get = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| cut(&v));
    let text = |key: &str| get(key).unwrap_or_default();
    let item = if let Some(id) = get("s") {
        Shared::Song { id, title: text("t"), artist: text("a") }
    } else if let Some(id) = get("al") {
        Shared::Album { id, title: text("t"), artist: text("a"), cover: get("c") }
    } else if let Some(id) = get("ar") {
        Shared::Artist { id, name: text("t") }
    } else if let Some(id) = get("yl") {
        Shared::YoutubePlaylist { id }
    } else {
        let ids = url.query_pairs().find(|(k, _)| k == "ids")?.1.into_owned();
        if ids.len() % 11 != 0 || !ids.is_ascii() {
            return None;
        }
        let ids = (0..ids.len()).step_by(11).take(MAX_SONGS).map(|i| ids[i..i + 11].to_string()).collect();
        Shared::Playlist { name: get("p").filter(|n| !n.is_empty()).unwrap_or_else(|| "Shared playlist".into()), ids }
    };
    item.valid().then_some(item)
}

/// What a YouTube or YouTube Music link opens in Cadence: a song, album,
/// artist or playlist. `text` is what another app shared, which may have
/// words around the link ("Check this out https://youtu.be/…").
pub fn parse_youtube(text: &str) -> Option<Shared> {
    let url = text.split_whitespace().filter(|w| w.starts_with("http")).find_map(|w| Url::parse(w).ok())?;
    let host = url.host_str()?.trim_start_matches("www.").trim_start_matches("m.").trim_start_matches("music.");
    let get = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    let mut path = url.path_segments()?.filter(|p| !p.is_empty());
    let first = path.next().unwrap_or_default();
    let song = |id: &str| Shared::Song { id: id.to_string(), title: String::new(), artist: String::new() };
    let item = match (host, first) {
        ("youtu.be", id) => song(id),
        ("youtube.com", "watch") => song(&get("v")?),
        ("youtube.com", "shorts" | "embed" | "live") => song(path.next()?),
        ("youtube.com", "playlist") => Shared::YoutubePlaylist { id: get("list")? },
        ("youtube.com", "channel") => Shared::Artist { id: path.next()?.to_string(), name: String::new() },
        ("youtube.com", "browse") => {
            let id = path.next()?;
            if let Some(list) = id.strip_prefix("VL") {
                Shared::YoutubePlaylist { id: list.to_string() }
            } else if id.starts_with("UC") {
                Shared::Artist { id: id.to_string(), name: String::new() }
            } else {
                Shared::Album { id: id.to_string(), title: String::new(), artist: String::new(), cover: None }
            }
        }
        _ => return None,
    };
    item.valid().then_some(item)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn songs_go_there_and_back() {
        let song = Shared::Song { id: "dQw4w9WgXcQ".into(), title: "Never Gonna Give You Up & more".into(), artist: "Rick Astley".into() };
        let url = link(&song);
        assert_eq!(url, "https://octavianbanarizatic-hub.github.io/c/?s=dQw4w9WgXcQ&t=Never+Gonna+Give+You+Up+%26+more&a=Rick+Astley");
        assert_eq!(parse(&url), Some(song.clone()));
        assert_eq!(message(&song), format!("Never Gonna Give You Up & more – Rick Astley\n{url}"));
    }

    #[test]
    fn albums_and_playlists_go_there_and_back() {
        let album = Shared::Album { id: "MPREb_abc".into(), title: "Discovery".into(), artist: "Daft Punk".into(), cover: Some("IluRBvnYMoY".into()) };
        assert_eq!(parse(&link(&album)), Some(album));
        let list = Shared::Playlist { name: "Road trip 🚗".into(), ids: vec!["dQw4w9WgXcQ".into(), "IluRBvnYMoY".into()] };
        let url = link(&list);
        assert!(url.ends_with("&ids=dQw4w9WgXcQIluRBvnYMoY"));
        assert_eq!(parse(&url), Some(list.clone()));
        assert_eq!(message(&list), format!("Road trip 🚗\n{url}"));
    }

    #[test]
    fn artists_go_there_and_back() {
        let artist = Shared::Artist { id: "UCdp".into(), name: "Daft Punk".into() };
        assert_eq!(parse(&link(&artist)), Some(artist.clone()));
        assert_eq!(message(&artist), format!("Daft Punk\n{}", link(&artist)));
    }

    #[test]
    fn reads_youtube_links() {
        let song = |id: &str| Some(Shared::Song { id: id.into(), title: String::new(), artist: String::new() });
        assert_eq!(parse_youtube("https://youtu.be/dQw4w9WgXcQ?si=abc"), song("dQw4w9WgXcQ"));
        assert_eq!(parse_youtube("Listen to this! https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM"), song("dQw4w9WgXcQ"));
        assert_eq!(parse_youtube("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42"), song("dQw4w9WgXcQ"));
        assert_eq!(parse_youtube("https://m.youtube.com/shorts/dQw4w9WgXcQ"), song("dQw4w9WgXcQ"));
        assert_eq!(parse_youtube("https://youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI&si=x"), Some(Shared::YoutubePlaylist { id: "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI".into() }));
        assert_eq!(parse_youtube("https://music.youtube.com/browse/VLOLAK5uy_abc"), Some(Shared::YoutubePlaylist { id: "OLAK5uy_abc".into() }));
        assert_eq!(parse_youtube("https://music.youtube.com/browse/MPREb_K8qWMWVqXGi"), Some(Shared::Album { id: "MPREb_K8qWMWVqXGi".into(), title: String::new(), artist: String::new(), cover: None }));
        assert_eq!(parse_youtube("https://music.youtube.com/channel/UCRr1xG_2WIDs18a6cIiCxeA?si=1"), Some(Shared::Artist { id: "UCRr1xG_2WIDs18a6cIiCxeA".into(), name: String::new() }));
        // Not YouTube, or not something Cadence can open.
        assert_eq!(parse_youtube("https://vimeo.com/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(parse_youtube("https://www.youtube.com/@someone"), None);
        assert_eq!(parse_youtube("https://youtu.be/short"), None);
        assert_eq!(parse_youtube("no link here"), None);
    }

    #[test]
    fn long_playlists_are_cut() {
        let ids: Vec<String> = (0..MAX_SONGS + 5).map(|i| format!("{i:0>11}")).collect();
        let Some(Shared::Playlist { ids: back, .. }) = parse(&link(&Shared::Playlist { name: "Big".into(), ids })) else { panic!() };
        assert_eq!(back.len(), MAX_SONGS);
    }

    #[test]
    fn other_links_are_ignored() {
        assert_eq!(parse("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(parse("http://octavianbanarizatic-hub.github.io/c/?s=dQw4w9WgXcQ"), None);
        assert_eq!(parse("https://octavianbanarizatic-hub.github.io/other/?s=dQw4w9WgXcQ"), None);
        assert_eq!(parse("https://octavianbanarizatic-hub.github.io/c/?s=../../etc"), None);
        assert_eq!(parse("https://octavianbanarizatic-hub.github.io/c/?al=UCnotanalbum"), None);
        assert_eq!(parse("https://octavianbanarizatic-hub.github.io/c/?ids=dQw4w9WgXc"), None);
        assert_eq!(parse("https://octavianbanarizatic-hub.github.io/c/"), None);
        // A playlist without a name still opens.
        let Some(Shared::Playlist { name, .. }) = parse("https://octavianbanarizatic-hub.github.io/c/?ids=dQw4w9WgXcQ") else { panic!() };
        assert_eq!(name, "Shared playlist");
    }
}
