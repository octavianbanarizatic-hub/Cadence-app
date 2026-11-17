//! Lyrics from LRCLIB (lrclib.net), a free and open lyrics database with
//! time-synced lines. Local files that carry lyrics in their tags use those.

use serde::{Deserialize, Serialize};

use crate::Track;

const API: &str = "https://lrclib.net/api";
/// LRCLIB asks clients to identify themselves.
const USER_AGENT: &str = concat!(
    "Cadence/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/octavianbanarizatic-hub/Cadence-app)"
);
/// How far a match's length may be from the song's, in seconds.
const DURATION_SLACK: f64 = 4.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Line {
    /// Seconds from the start of the song.
    pub time: f64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// Time-synced lines, when available.
    pub synced: Option<Vec<Line>>,
    pub plain: Option<String>,
    pub instrumental: bool,
}

/// One LRCLIB record, as returned by `/get` and `/search`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    duration: Option<f64>,
    #[serde(default)]
    instrumental: bool,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
}

impl Record {
    fn into_lyrics(self) -> Option<Lyrics> {
        let synced = self.synced_lyrics.as_deref().and_then(parse_lrc);
        let plain = self.plain_lyrics.filter(|p| !p.trim().is_empty());
        (synced.is_some() || plain.is_some() || self.instrumental).then_some(Lyrics {
            synced,
            plain,
            instrumental: self.instrumental,
        })
    }

    fn has_lyrics(&self) -> bool {
        self.instrumental
            || self.synced_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty())
            || self.plain_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty())
    }
}

/// Parses LRC text (`[mm:ss.xx] line`) into lines sorted by time. A line may
/// carry several timestamps; `[offset:±ms]` is honored and other tags such as
/// `[ar:…]` are skipped. Returns None when nothing is timed.
pub fn parse_lrc(lrc: &str) -> Option<Vec<Line>> {
    let mut offset = 0.0;
    let mut lines = Vec::new();
    for raw in lrc.lines() {
        let mut rest = raw.trim();
        let mut times = Vec::new();
        while let Some(tag) = rest.strip_prefix('[') {
            let Some(end) = tag.find(']') else { break };
            let inner = &tag[..end];
            if let Some(t) = parse_timestamp(inner) {
                times.push(t);
            } else if let Some(ms) = inner.strip_prefix("offset:") {
                // A positive offset makes the lyrics appear sooner.
                offset = ms.trim().parse::<f64>().unwrap_or(0.0) / 1000.0;
            }
            rest = tag[end + 1..].trim_start();
        }
        let text = rest.trim().to_string();
        lines.extend(times.into_iter().map(|time| Line { time, text: text.clone() }));
    }
    if lines.is_empty() {
        return None;
    }
    for line in &mut lines {
        line.time = (line.time - offset).max(0.0);
    }
    lines.sort_by(|a, b| a.time.total_cmp(&b.time));
    Some(lines)
}

/// `mm:ss`, `mm:ss.xx` or `mm:ss:xx` into seconds.
fn parse_timestamp(s: &str) -> Option<f64> {
    let (min, sec) = s.split_once(':')?;
    let min: u32 = min.trim().parse().ok()?;
    // Some files use a colon before the fraction too.
    let sec = sec.replacen(':', ".", 1);
    if !sec.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let sec: f64 = sec.parse().ok()?;
    (sec < 60.0).then_some(min as f64 * 60.0 + sec)
}

/// Lyrics stored in a local file's tags. They are often LRC text, which
/// counts as synced.
pub fn from_tags(path: &str) -> Option<Lyrics> {
    use lofty::prelude::*;
    let file = lofty::read_from_path(path).ok()?;
    let text = file
        .tags()
        .iter()
        .find_map(|t| t.get_string(ItemKey::Lyrics).map(str::to_string))
        .filter(|s| !s.trim().is_empty())?;
    Some(match parse_lrc(&text) {
        Some(lines) => Lyrics { synced: Some(lines), plain: None, instrumental: false },
        None => Lyrics { synced: None, plain: Some(text), instrumental: false },
    })
}

/// Words in brackets that are about the upload, not the song.
const NOISE: &[&str] = &[
    "official", "video", "audio", "lyric", "visuali", "remaster", "hd", "4k", "mv", "m/v", "explicit",
];

/// Strips upload noise such as "(Official Video)" or "[HD]" from a title.
pub fn clean_title(title: &str) -> String {
    let mut out = String::new();
    let mut rest = title;
    while let Some(start) = rest.find(['(', '[']) {
        let close = if rest[start..].starts_with('(') { ')' } else { ']' };
        let Some(len) = rest[start..].find(close) else { break };
        let inner = rest[start + 1..start + len].to_lowercase();
        out.push_str(&rest[..start]);
        if !NOISE.iter().any(|n| inner.contains(n)) {
            out.push_str(&rest[start..=start + len]);
        }
        rest = &rest[start + len + 1..];
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The first credited artist: "A, B & C" → "A". YouTube channel suffixes
/// such as " - Topic" and "VEVO" are dropped.
pub fn primary_artist(artist: &str) -> String {
    let artist = artist.trim().trim_end_matches(" - Topic");
    let artist = artist.strip_suffix("VEVO").unwrap_or(artist);
    let cut = [", ", " & ", " feat. ", " ft. ", " x "]
        .iter()
        .filter_map(|sep| artist.find(sep))
        .min()
        .unwrap_or(artist.len());
    artist[..cut].trim().to_string()
}

/// Title and artist to search for. Plain YouTube uploads are often titled
/// "Artist - Song" with the channel as the artist.
fn search_terms(track: &Track) -> (String, String) {
    let title = clean_title(&track.title);
    if track.album.is_none() {
        if let Some((artist, song)) = title.split_once(" - ") {
            return (song.trim().to_string(), primary_artist(artist));
        }
    }
    (title, primary_artist(&track.artist))
}

/// Picks the record closest in length, preferring ones with synced lyrics.
fn best_match(records: Vec<Record>, duration: Option<f64>) -> Option<Record> {
    records
        .into_iter()
        .filter(Record::has_lyrics)
        .filter(|r| match (duration, r.duration) {
            (Some(want), Some(got)) => (want - got).abs() <= DURATION_SLACK,
            _ => true,
        })
        .min_by(|a, b| {
            let key = |r: &Record| {
                let unsynced = r.synced_lyrics.as_deref().is_none_or(|s| s.trim().is_empty());
                let off = match (duration, r.duration) {
                    (Some(want), Some(got)) => (want - got).abs(),
                    _ => 0.0,
                };
                (unsynced, off)
            };
            let (ka, kb) = (key(a), key(b));
            ka.0.cmp(&kb.0).then(ka.1.total_cmp(&kb.1))
        })
}

async fn get_json<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    path: &str,
    query: &[(&str, String)],
) -> Result<Option<T>, String> {
    let send = || {
        http.get(format!("{API}/{path}"))
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .query(query)
            .send()
    };
    let mut resp = send().await.map_err(|e| format!("Couldn't reach LRCLIB: {e}"))?;
    // LRCLIB answers 503 for a moment when it is overloaded.
    if resp.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        resp = send().await.map_err(|e| format!("Couldn't reach LRCLIB: {e}"))?;
    }
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("LRCLIB is busy right now (HTTP {}).", resp.status().as_u16()));
    }
    resp.json().await.map(Some).map_err(|e| e.to_string())
}

/// Looks the track up on LRCLIB. `Ok(None)` means it has no lyrics there;
/// `Err` is a network or server problem worth retrying later.
pub async fn fetch(http: &reqwest::Client, track: &Track) -> Result<Option<Lyrics>, String> {
    // An exact match on title, artist, album and length is the most reliable.
    if let Some(duration) = track.duration {
        let mut query = vec![
            ("track_name", track.title.clone()),
            ("artist_name", track.artist.clone()),
            ("duration", duration.round().to_string()),
        ];
        if let Some(album) = &track.album {
            query.push(("album_name", album.clone()));
        }
        if let Some(record) = get_json::<Record>(http, "get", &query).await? {
            if let Some(lyrics) = record.into_lyrics() {
                return Ok(Some(lyrics));
            }
        }
    }
    let (title, artist) = search_terms(track);
    let mut query = vec![("track_name", title.clone())];
    if !artist.is_empty() {
        query.push(("artist_name", artist.clone()));
    }
    let records = get_json::<Vec<Record>>(http, "search", &query).await?.unwrap_or_default();
    if let Some(record) = best_match(records, track.duration) {
        return Ok(record.into_lyrics());
    }
    // Last try: a loose full-text search, which tolerates odd artist names.
    let q = format!("{title} {artist}");
    let records = get_json::<Vec<Record>>(http, "search", &[("q", q.trim().to_string())])
        .await?
        .unwrap_or_default();
    Ok(best_match(records, track.duration).and_then(Record::into_lyrics))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(time: f64, text: &str) -> Line {
        Line { time, text: text.into() }
    }

    #[test]
    fn parses_lrc() {
        let lrc = "[ar:Someone]\n[ti:Song]\n[00:12.34] First\n[00:05.1]Zero\n[01:02.500][01:30.00] Chorus\n[02:00.00]\nnot a line";
        assert_eq!(
            parse_lrc(lrc).unwrap(),
            vec![
                line(5.1, "Zero"),
                line(12.34, "First"),
                line(62.5, "Chorus"),
                line(90.0, "Chorus"),
                line(120.0, ""),
            ]
        );
    }

    #[test]
    fn lrc_offset_and_odd_stamps() {
        let lines = parse_lrc("[offset:+500]\n[00:10:50]A\n[00:00.20]B").unwrap();
        assert_eq!(lines, vec![line(0.0, "B"), line(10.0, "A")]);
        assert!(parse_lrc("just some words\n[by:me]").is_none());
        assert!(parse_lrc("[00:99.00] bad seconds").is_none());
    }

    #[test]
    fn cleans_titles() {
        assert_eq!(clean_title("Song (Official Music Video)"), "Song");
        assert_eq!(clean_title("Song [HD] (feat. X)"), "Song (feat. X)");
        assert_eq!(clean_title("Song (Remastered 2011) [Lyric Video]"), "Song");
        assert_eq!(clean_title("Song (Live at Wembley)"), "Song (Live at Wembley)");
        assert_eq!(clean_title("Broken (bracket"), "Broken (bracket");
    }

    #[test]
    fn primary_artists() {
        assert_eq!(primary_artist("The Weeknd & Daft Punk"), "The Weeknd");
        assert_eq!(primary_artist("A, B & C"), "A");
        assert_eq!(primary_artist("Adele - Topic"), "Adele");
        assert_eq!(primary_artist("TaylorSwiftVEVO"), "TaylorSwift");
        assert_eq!(primary_artist("Solo"), "Solo");
    }

    #[test]
    fn splits_plain_youtube_titles() {
        let track = Track {
            id: "yt:x".into(),
            title: "Daft Punk - One More Time (Official Video)".into(),
            artist: "Daft Punk".into(),
            album: None,
            duration: None,
            thumbnail: None,
            ..Default::default()
        };
        assert_eq!(search_terms(&track), ("One More Time".into(), "Daft Punk".into()));
    }

    #[test]
    fn picks_closest_synced_match() {
        let rec = |d: f64, synced: bool| Record {
            duration: Some(d),
            instrumental: false,
            plain_lyrics: Some("words".into()),
            synced_lyrics: synced.then(|| format!("[00:01.00]{d}")),
        };
        let best = best_match(vec![rec(200.0, false), rec(203.0, true), rec(201.0, true), rec(260.0, true)], Some(200.0));
        assert_eq!(best.unwrap().duration, Some(201.0));
        assert!(best_match(vec![rec(260.0, true)], Some(200.0)).is_none());
    }
}
