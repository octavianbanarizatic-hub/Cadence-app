//! Search's "yours first", as in Spotify: songs of the user's own that match
//! a search (liked, downloaded, in a playlist, or played), ranked by how much
//! they are the user's, so they come before YouTube Music's results.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::Track;

/// Lower case, without accents (Romanian, Spanish and the other Latin
/// letters people type without them), letters and digits only, one space
/// between words.
pub fn plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().flat_map(char::to_lowercase) {
        let c = match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ă' | 'ā' | 'ą' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'ě' | 'ę' | 'ē' => 'e',
            'í' | 'ì' | 'î' | 'ï' | 'ī' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'ő' | 'ō' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'ů' | 'ű' | 'ū' => 'u',
            'ș' | 'ş' | 'š' | 'ś' => 's',
            'ț' | 'ţ' | 'ť' => 't',
            'ñ' | 'ń' | 'ň' => 'n',
            'ç' | 'č' | 'ć' => 'c',
            'ý' | 'ÿ' => 'y',
            'ž' | 'ź' | 'ż' => 'z',
            'ł' => 'l',
            'ř' => 'r',
            'đ' | 'ď' => 'd',
            'ğ' => 'g',
            c => c,
        };
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with(' ') && !out.is_empty() {
            out.push(' ');
        }
    }
    out.trim_end().to_string()
}

/// One of the user's songs, with what makes it theirs.
#[derive(Default)]
struct Mine {
    track: Option<Track>,
    liked: bool,
    downloaded: bool,
    playlists: u32,
    plays: u32,
}

impl Mine {
    fn score(&self, title_match: bool) -> f64 {
        let mut s = 0.0;
        if self.liked {
            s += 4.0;
        }
        if self.downloaded {
            s += 2.0;
        }
        s += f64::from(self.playlists.min(3)) * 1.5;
        // A song played a lot is a favourite even if it was never liked.
        s += f64::from(self.plays).sqrt();
        // "despacito" should put Despacito before other songs by its artist.
        if title_match {
            s += 3.0;
        }
        s
    }
}

/// Up to `limit` of the user's songs whose title, artist or album has every
/// word of `query`, the most theirs first.
pub fn songs(conn: &Connection, query: &str, limit: usize) -> rusqlite::Result<Vec<Track>> {
    let words: Vec<String> = plain(query).split(' ').filter(|w| !w.is_empty()).map(String::from).collect();
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let mut mine: HashMap<String, Mine> = HashMap::new();
    let mut add = |id: String, data: &str, f: &dyn Fn(&mut Mine)| {
        let entry = mine.entry(id).or_default();
        if entry.track.is_none() {
            entry.track = serde_json::from_str(data).ok();
        }
        f(entry);
    };
    for (id, data) in rows(conn, "SELECT id, data FROM liked")? {
        add(id, &data, &|m| m.liked = true);
    }
    for (id, data) in rows(conn, "SELECT id, data FROM downloads")? {
        add(id, &data, &|m| m.downloaded = true);
    }
    for (id, data) in rows(conn, "SELECT json_extract(data, '$.id'), data FROM playlist_tracks")? {
        add(id, &data, &|m| m.playlists += 1);
    }
    let mut stmt = conn.prepare("SELECT track_id, max(data), count(*) FROM plays GROUP BY track_id")?;
    let plays = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, u32>(2)?)))?;
    for (id, data, n) in plays.flatten() {
        add(id, &data, &|m| m.plays = n);
    }

    let mut found: Vec<(f64, Track)> = mine
        .into_values()
        .filter_map(|m| {
            let t = m.track.clone()?;
            // Podcast episodes have their own tab.
            if t.id.starts_with("pod:") {
                return None;
            }
            let title = plain(&t.title);
            let all = format!("{title} {} {}", plain(&t.artist), plain(t.album.as_deref().unwrap_or("")));
            if !words.iter().all(|w| all.split(' ').any(|part| part.starts_with(w.as_str()))) {
                return None;
            }
            let title_match = words.iter().all(|w| title.split(' ').any(|part| part.starts_with(w.as_str())));
            Some((m.score(title_match), t))
        })
        .collect();
    found.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.title.cmp(&b.1.title)));
    Ok(found.into_iter().take(limit).map(|(_, t)| t).collect())
}

fn rows(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.flatten().filter_map(|(id, data)| Some((id?, data))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, title: &str, artist: &str) -> Track {
        Track { id: id.into(), title: title.into(), artist: artist.into(), ..Default::default() }
    }

    #[test]
    fn plain_text() {
        assert_eq!(plain("Nicolae Guță — Șoferița!"), "nicolae guta soferita");
        assert_eq!(plain("  Beyoncé  "), "beyonce");
        assert_eq!(plain("AC/DC"), "ac dc");
    }

    #[test]
    fn yours_first() {
        let conn = crate::db::open_memory();
        let liked = track("yt:aaaaaaaaaaa", "Șoferița", "Nicolae Guță");
        let played = track("yt:bbbbbbbbbbb", "Gigolo", "Nicolae Guță");
        let other = track("yt:ccccccccccc", "Despacito", "Luis Fonsi");
        crate::db::set_liked(&conn, &liked, true).unwrap();
        crate::db::add_play(&conn, &played, 40).unwrap();
        crate::db::add_play(&conn, &other, 40).unwrap();
        let ids = |q: &str| songs(&conn, q, 5).unwrap().into_iter().map(|t| t.id).collect::<Vec<_>>();
        // Typed without accents, by the artist: the liked one first.
        assert_eq!(ids("guta"), ["yt:aaaaaaaaaaa", "yt:bbbbbbbbbbb"]);
        // A title match beats a liked song that only matches by artist.
        assert_eq!(ids("nicolae gigolo"), ["yt:bbbbbbbbbbb"]);
        assert_eq!(ids("desp"), ["yt:ccccccccccc"]);
        assert!(ids("nothing like this").is_empty());
        assert!(ids("   ").is_empty());
    }
}
