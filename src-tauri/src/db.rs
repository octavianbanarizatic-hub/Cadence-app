use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::lyrics::Lyrics;
use crate::Track;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
    path TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS tracks (
    id        INTEGER PRIMARY KEY,
    path      TEXT NOT NULL UNIQUE,
    folder    TEXT NOT NULL,
    title     TEXT NOT NULL,
    artist    TEXT,
    album     TEXT,
    duration  REAL,
    has_cover INTEGER NOT NULL DEFAULT 0,
    mtime     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_folder ON tracks(folder);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
    title, artist, album, content = 'tracks', content_rowid = 'id'
);

CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts(rowid, title, artist, album)
    VALUES (new.id, new.title, new.artist, new.album);
END;
CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
    VALUES ('delete', old.id, old.title, old.artist, old.album);
END;
CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
    INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
    VALUES ('delete', old.id, old.title, old.artist, old.album);
    INSERT INTO tracks_fts(rowid, title, artist, album)
    VALUES (new.id, new.title, new.artist, new.album);
END;

CREATE TABLE IF NOT EXISTS liked (
    id       TEXT PRIMARY KEY,
    data     TEXT NOT NULL,
    added_at INTEGER NOT NULL
);

-- The user's playlists. `source` is the link a playlist was imported from;
-- `cover` a photo picked as its cover (phones), a file in playlist-covers.
CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    source     TEXT,
    created_at INTEGER NOT NULL,
    cover      TEXT
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    data        TEXT NOT NULL,
    PRIMARY KEY (playlist_id, position)
);

-- Songs saved for offline listening; `file` is a name in the downloads folder.
CREATE TABLE IF NOT EXISTS downloads (
    id       TEXT PRIMARY KEY,
    data     TEXT NOT NULL,
    file     TEXT NOT NULL,
    size     INTEGER NOT NULL,
    added_at INTEGER NOT NULL
);

-- Lyrics lookups by track id. `data` is NULL when LRCLIB had none.
CREATE TABLE IF NOT EXISTS lyrics (
    id         TEXT PRIMARY KEY,
    data       TEXT,
    fetched_at INTEGER NOT NULL
);

-- Listening history for the phone's Profile tab: one row per play heard for
-- 30 s or more. `artist` is the first credited artist; `seconds` how long
-- the song was heard, kept up to date while it plays.
CREATE TABLE IF NOT EXISTS plays (
    id        INTEGER PRIMARY KEY,
    track_id  TEXT NOT NULL,
    data      TEXT NOT NULL,
    artist    TEXT NOT NULL,
    artist_id TEXT,
    album     TEXT,
    album_id  TEXT,
    played_at INTEGER NOT NULL,
    seconds   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_at ON plays(played_at);
"#;

/// LRCLIB keeps growing, so a miss is looked up again after a week.
const LYRICS_MISS_TTL_SECS: i64 = 7 * 24 * 3600;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    // The library scan writes from its own connection; wait instead of failing.
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.execute_batch(SCHEMA)?;
    conn.execute_batch(crate::podcasts::SCHEMA)?;
    // Databases made before playlists had covers.
    let has_cover = conn
        .prepare("SELECT 1 FROM pragma_table_info('playlists') WHERE name = 'cover'")?
        .exists([])?;
    if !has_cover {
        conn.execute("ALTER TABLE playlists ADD COLUMN cover TEXT", [])?;
    }
    Ok(conn)
}

pub fn folders(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM folders ORDER BY path COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

pub fn add_folder(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR IGNORE INTO folders(path) VALUES (?1)", params![path])?;
    Ok(())
}

pub fn remove_folder(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM tracks WHERE folder = ?1", params![path])?;
    conn.execute("DELETE FROM folders WHERE path = ?1", params![path])?;
    Ok(())
}

/// Drops a library song, and with it its like, playlist entries and saved
/// lyrics: a later song may get the same id.
pub fn remove_track(conn: &mut Connection, id: i64) -> rusqlite::Result<()> {
    let key = format!("local:{id}");
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM tracks WHERE id = ?1", params![id])?;
    tx.execute("DELETE FROM liked WHERE id = ?1", params![key])?;
    tx.execute("DELETE FROM lyrics WHERE id = ?1", params![key])?;
    tx.execute(
        "DELETE FROM playlist_tracks WHERE json_extract(data, '$.id') = ?1",
        params![key],
    )?;
    tx.commit()
}

pub fn track_path(conn: &Connection, id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT path FROM tracks WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
}

fn row_to_track(r: &rusqlite::Row) -> rusqlite::Result<Track> {
    let id: i64 = r.get("id")?;
    let has_cover: bool = r.get("has_cover")?;
    Ok(Track {
        id: format!("local:{id}"),
        title: r.get("title")?,
        artist: r.get::<_, Option<String>>("artist")?.unwrap_or_default(),
        album: r.get("album")?,
        duration: r.get("duration")?,
        // The front end turns `cover/<id>` into a media:// URL.
        thumbnail: has_cover.then(|| format!("cover/{id}")),
        ..Default::default()
    })
}

/// Builds an FTS5 query that prefix-matches every word the user typed.
fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

pub fn tracks(conn: &Connection, query: Option<&str>) -> rusqlite::Result<Vec<Track>> {
    const COLS: &str = "t.id, t.title, t.artist, t.album, t.duration, t.has_cover";
    match query.and_then(fts_query) {
        Some(q) => {
            let sql = format!(
                "SELECT {COLS} FROM tracks_fts f JOIN tracks t ON t.id = f.rowid \
                 WHERE tracks_fts MATCH ?1 ORDER BY rank LIMIT 1000"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![q], row_to_track)?;
            rows.collect()
        }
        None => {
            let sql = format!(
                "SELECT {COLS} FROM tracks t ORDER BY t.artist COLLATE NOCASE, \
                 t.album COLLATE NOCASE, t.title COLLATE NOCASE"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([], row_to_track)?;
            rows.collect()
        }
    }
}

pub fn liked(conn: &Connection) -> rusqlite::Result<Vec<Track>> {
    let mut stmt = conn.prepare("SELECT data FROM liked ORDER BY added_at DESC")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for data in rows {
        if let Ok(track) = serde_json::from_str(&data?) {
            out.push(track);
        }
    }
    Ok(out)
}

pub fn set_liked(conn: &Connection, track: &Track, liked: bool) -> rusqlite::Result<()> {
    if liked {
        let data = serde_json::to_string(track).unwrap_or_default();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO liked(id, data, added_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![track.id, data, now],
        )?;
    } else {
        conn.execute("DELETE FROM liked WHERE id = ?1", params![track.id])?;
    }
    Ok(())
}

/// Likes or unlikes many songs at once; returns how many changed. New likes
/// keep the list's order at the top of Liked songs; songs already liked
/// keep their place.
pub fn set_liked_many(conn: &mut Connection, tracks: &[Track], liked: bool) -> rusqlite::Result<usize> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let tx = conn.transaction()?;
    let mut changed = 0;
    for (i, track) in tracks.iter().enumerate() {
        changed += if liked {
            let data = serde_json::to_string(track).unwrap_or_default();
            tx.execute(
                "INSERT INTO liked(id, data, added_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING",
                params![track.id, data, now - i as i64],
            )?
        } else {
            tx.execute("DELETE FROM liked WHERE id = ?1", params![track.id])?
        };
    }
    tx.commit()?;
    Ok(changed)
}

/// `Some(None)` is a remembered miss; `None` means not looked up (or expired).
pub fn cached_lyrics(conn: &Connection, id: &str) -> rusqlite::Result<Option<Option<Lyrics>>> {
    let row: Option<(Option<String>, i64)> = conn
        .query_row("SELECT data, fetched_at FROM lyrics WHERE id = ?1", params![id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    Ok(match row {
        Some((Some(data), _)) => serde_json::from_str(&data).ok().map(Some),
        Some((None, at)) if now_secs() - at < LYRICS_MISS_TTL_SECS => Some(None),
        _ => None,
    })
}

pub fn store_lyrics(conn: &Connection, id: &str, lyrics: Option<&Lyrics>) -> rusqlite::Result<()> {
    let data = lyrics.and_then(|l| serde_json::to_string(l).ok());
    conn.execute(
        "INSERT OR REPLACE INTO lyrics(id, data, fetched_at) VALUES (?1, ?2, ?3)",
        params![id, data, now_secs()],
    )?;
    Ok(())
}

/// A playlist in the sidebar list.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistInfo {
    pub id: i64,
    pub name: String,
    pub count: usize,
    /// The first song's cover, or the photo picked for it (`pcover/<file>`).
    pub thumbnail: Option<String>,
    /// The picked photo's file name in playlist-covers.
    #[serde(skip)]
    pub cover: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub source: Option<String>,
    pub tracks: Vec<Track>,
    /// The file name of a photo picked as its cover; the page gets `pcover/<file>`.
    pub cover: Option<String>,
}

/// Newest first.
pub fn playlists(conn: &Connection) -> rusqlite::Result<Vec<PlaylistInfo>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, COUNT(t.position), \
         (SELECT data FROM playlist_tracks WHERE playlist_id = p.id ORDER BY position LIMIT 1), p.cover \
         FROM playlists p LEFT JOIN playlist_tracks t ON t.playlist_id = p.id \
         GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        let first: Option<String> = r.get(3)?;
        Ok(PlaylistInfo {
            id: r.get(0)?,
            name: r.get(1)?,
            count: r.get::<_, i64>(2)? as usize,
            thumbnail: first
                .and_then(|d| serde_json::from_str::<Track>(&d).ok())
                .and_then(|t| t.thumbnail),
            cover: r.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn playlist(conn: &Connection, id: i64) -> rusqlite::Result<Option<Playlist>> {
    let head: Option<(String, Option<String>, Option<String>)> = conn
        .query_row("SELECT name, source, cover FROM playlists WHERE id = ?1", params![id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?;
    let Some((name, source, cover)) = head else { return Ok(None) };
    let mut stmt = conn.prepare("SELECT data FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position")?;
    let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
    let mut tracks = Vec::new();
    for data in rows {
        if let Ok(track) = serde_json::from_str(&data?) {
            tracks.push(track);
        }
    }
    Ok(Some(Playlist { id, name, source, tracks, cover }))
}

/// Sets (or with `None` clears) a playlist's photo; returns the one it had.
pub fn set_playlist_cover(conn: &Connection, id: i64, cover: Option<&str>) -> rusqlite::Result<Option<String>> {
    let old = conn
        .query_row("SELECT cover FROM playlists WHERE id = ?1", params![id], |r| r.get(0))
        .optional()?
        .flatten();
    conn.execute("UPDATE playlists SET cover = ?2 WHERE id = ?1", params![id, cover])?;
    Ok(old)
}

pub fn create_playlist(conn: &Connection, name: &str, source: Option<&str>, tracks: &[Track]) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO playlists(name, source, created_at) VALUES (?1, ?2, ?3)",
        params![name, source, now_secs()],
    )?;
    let id = conn.last_insert_rowid();
    set_playlist_tracks(conn, id, tracks)?;
    Ok(id)
}

pub fn rename_playlist(conn: &Connection, id: i64, name: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE playlists SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

pub fn delete_playlist(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
    Ok(())
}

/// Replaces a playlist's songs; used for adding, removing and reordering.
pub fn set_playlist_tracks(conn: &Connection, id: i64, tracks: &[Track]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", params![id])?;
    {
        let mut insert = tx.prepare("INSERT INTO playlist_tracks(playlist_id, position, data) VALUES (?1, ?2, ?3)")?;
        for (i, t) in tracks.iter().enumerate() {
            insert.execute(params![id, i as i64, serde_json::to_string(t).unwrap_or_default()])?;
        }
    }
    tx.commit()
}

/// Appends songs not already in the playlist. Returns how many were added.
pub fn add_to_playlist(conn: &Connection, id: i64, tracks: &[Track]) -> rusqlite::Result<usize> {
    let Some(mut list) = playlist(conn, id)? else { return Ok(0) };
    let before = list.tracks.len();
    for t in tracks {
        if !list.tracks.iter().any(|x| x.id == t.id) {
            list.tracks.push(t.clone());
        }
    }
    let added = list.tracks.len() - before;
    if added > 0 {
        set_playlist_tracks(conn, id, &list.tracks)?;
    }
    Ok(added)
}

/// A finished download.
pub struct Download {
    pub track: Track,
    pub file: String,
    pub size: u64,
}

/// Newest first.
pub fn downloads(conn: &Connection) -> rusqlite::Result<Vec<Download>> {
    let mut stmt = conn.prepare("SELECT data, file, size FROM downloads ORDER BY added_at DESC")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (data, file, size) = row?;
        if let Ok(track) = serde_json::from_str(&data) {
            out.push(Download { track, file, size: size.max(0) as u64 });
        }
    }
    Ok(out)
}

pub fn add_download(conn: &Connection, track: &Track, file: &str, size: u64) -> rusqlite::Result<()> {
    let data = serde_json::to_string(track).unwrap_or_default();
    conn.execute(
        "INSERT OR REPLACE INTO downloads(id, data, file, size, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![track.id, data, file, size as i64, now_secs()],
    )?;
    Ok(())
}

pub fn remove_download(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
    Ok(())
}

/// Starts a play in the listening history; returns its id for `set_play_seconds`.
pub fn add_play(conn: &Connection, track: &Track, seconds: u32) -> rusqlite::Result<i64> {
    let data = serde_json::to_string(track).unwrap_or_default();
    // "Artist, Other Artist" counts for the first one, whose page id it has.
    let artist = track.artist.split(',').next().unwrap_or("").trim();
    let album = track.album.as_deref().map(str::trim).filter(|a| !a.is_empty());
    conn.execute(
        "INSERT INTO plays(track_id, data, artist, artist_id, album, album_id, played_at, seconds) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![track.id, data, artist, track.artist_id, album, track.album_id, now_secs(), seconds],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn set_play_seconds(conn: &Connection, id: i64, seconds: u32) -> rusqlite::Result<()> {
    conn.execute("UPDATE plays SET seconds = max(seconds, ?2) WHERE id = ?1", params![id, seconds])?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopTrack {
    pub track: Track,
    pub plays: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopArtist {
    pub name: String,
    pub id: Option<String>,
    /// The cover of their latest song, until the page loads their photo.
    pub thumbnail: Option<String>,
    pub plays: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopAlbum {
    pub title: String,
    pub id: Option<String>,
    pub artist: String,
    pub thumbnail: Option<String>,
    pub plays: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningStats {
    pub seconds: i64,
    pub plays: i64,
    pub tracks: Vec<TopTrack>,
    pub artists: Vec<TopArtist>,
    pub albums: Vec<TopAlbum>,
}

/// The most played songs, artists and albums since `since` (unix seconds).
/// Ties go to what was played last.
pub fn listening_stats(conn: &Connection, since: i64, limit: usize) -> rusqlite::Result<ListeningStats> {
    let (seconds, plays) = conn.query_row(
        "SELECT coalesce(sum(seconds), 0), count(*) FROM plays WHERE played_at >= ?1",
        params![since],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let track = |data: String| serde_json::from_str::<Track>(&data).ok();
    // Bare columns next to max() come from the row with the latest play.
    let mut stmt = conn.prepare(
        "SELECT data, count(*) AS n, max(played_at) FROM plays WHERE played_at >= ?1 \
         GROUP BY track_id ORDER BY n DESC, max(played_at) DESC LIMIT ?2",
    )?;
    let tracks = stmt
        .query_map(params![since, limit as i64], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok().and_then(|(data, plays)| Some(TopTrack { track: track(data)?, plays })))
        .collect();
    let mut stmt = conn.prepare(
        "SELECT artist, artist_id, data, count(*) AS n, max(played_at) FROM plays \
         WHERE played_at >= ?1 AND artist != '' \
         GROUP BY lower(artist) ORDER BY n DESC, max(played_at) DESC LIMIT ?2",
    )?;
    let artists = stmt
        .query_map(params![since, limit as i64], |r| {
            Ok(TopArtist {
                name: r.get(0)?,
                id: r.get(1)?,
                thumbnail: track(r.get(2)?).and_then(|t| t.thumbnail),
                plays: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut stmt = conn.prepare(
        "SELECT album, album_id, artist, data, count(*) AS n, max(played_at) FROM plays \
         WHERE played_at >= ?1 AND album IS NOT NULL \
         GROUP BY coalesce(album_id, lower(album) || '/' || lower(artist)) \
         ORDER BY n DESC, max(played_at) DESC LIMIT ?2",
    )?;
    let albums = stmt
        .query_map(params![since, limit as i64], |r| {
            Ok(TopAlbum {
                title: r.get(0)?,
                id: r.get(1)?,
                artist: r.get(2)?,
                thumbnail: track(r.get(3)?).and_then(|t| t.thumbnail),
                plays: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ListeningStats { seconds, plays, tracks, artists, albums })
}

/// Every song ever played, once each: Discover Weekly leaves them out.
pub fn played_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT track_id FROM plays")?;
    let ids = stmt.query_map([], |r| r.get(0))?.collect();
    ids
}

/// An empty database in memory, for other modules' tests.
#[cfg(test)]
pub fn open_memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for (i, (title, artist)) in [("Blue Tone", "Test Artist"), ("High Hum", "Other Band")].iter().enumerate() {
            conn.execute(
                "INSERT INTO tracks(path, folder, title, artist, mtime) VALUES (?1, 'f', ?2, ?3, 0)",
                params![format!("f/{i}.mp3"), title, artist],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn prefix_search_across_fields() {
        let conn = memory_db();
        let hits = tracks(&conn, Some("hum oth")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "High Hum");
        assert_eq!(tracks(&conn, None).unwrap().len(), 2);
    }

    #[test]
    fn removing_a_song_drops_its_likes_and_playlist_entries() {
        let mut conn = memory_db();
        let song = |id: &str| Track { id: id.into(), title: id.into(), ..Default::default() };
        set_liked(&conn, &song("local:1"), true).unwrap();
        set_liked(&conn, &song("local:2"), true).unwrap();
        let list = create_playlist(&conn, "Mix", None, &[song("yt:a"), song("local:1"), song("local:2")]).unwrap();
        remove_track(&mut conn, 1).unwrap();
        assert_eq!(tracks(&conn, None).unwrap().len(), 1);
        let ids = |tracks: Vec<Track>| tracks.into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!(ids(liked(&conn).unwrap()), ["local:2"]);
        assert_eq!(ids(playlist(&conn, list).unwrap().unwrap().tracks), ["yt:a", "local:2"]);
    }

    #[test]
    fn playlist_covers_survive_older_databases() {
        let path = std::env::temp_dir().join(format!("cadence-covers-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        // A database from before covers.
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE playlists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL);")
            .unwrap();
        let conn = open(&path).unwrap();
        let id = create_playlist(&conn, "Mix", None, &[]).unwrap();
        assert_eq!(set_playlist_cover(&conn, id, Some("1-a.jpg")).unwrap(), None);
        assert_eq!(set_playlist_cover(&conn, id, Some("1-b.jpg")).unwrap().as_deref(), Some("1-a.jpg"));
        assert_eq!(playlist(&conn, id).unwrap().unwrap().cover.as_deref(), Some("1-b.jpg"));
        assert_eq!(playlists(&conn).unwrap()[0].cover.as_deref(), Some("1-b.jpg"));
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn odd_queries_do_not_error() {
        let conn = memory_db();
        for q in ["\"", "\"\"", "*", "-", "a\"b", "NOT", "OR AND", "(", ")", "^", ":", "   ", "é", "🎵"] {
            assert!(tracks(&conn, Some(q)).is_ok(), "query {q:?} failed");
        }
    }

    #[test]
    fn lyrics_cache_remembers_hits_and_misses() {
        let conn = memory_db();
        assert_eq!(cached_lyrics(&conn, "yt:a").unwrap(), None);
        let lyrics = Lyrics { synced: None, plain: Some("la la".into()), instrumental: false };
        store_lyrics(&conn, "yt:a", Some(&lyrics)).unwrap();
        assert_eq!(cached_lyrics(&conn, "yt:a").unwrap(), Some(Some(lyrics)));
        store_lyrics(&conn, "yt:b", None).unwrap();
        assert_eq!(cached_lyrics(&conn, "yt:b").unwrap(), Some(None));
        // Old misses are looked up again.
        conn.execute("UPDATE lyrics SET fetched_at = 0 WHERE id = 'yt:b'", []).unwrap();
        assert_eq!(cached_lyrics(&conn, "yt:b").unwrap(), None);
    }

    #[test]
    fn playlists_round_trip() {
        let conn = memory_db();
        let song = |id: &str| Track { id: id.into(), title: id.into(), thumbnail: Some(format!("cover-{id}")), ..Default::default() };
        let id = create_playlist(&conn, "Mix", None, &[song("yt:a"), song("yt:b")]).unwrap();
        assert_eq!(add_to_playlist(&conn, id, &[song("yt:b"), song("yt:c")]).unwrap(), 1);
        let list = playlist(&conn, id).unwrap().unwrap();
        assert_eq!(list.tracks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["yt:a", "yt:b", "yt:c"]);
        set_playlist_tracks(&conn, id, &[song("yt:c"), song("yt:a")]).unwrap();
        rename_playlist(&conn, id, "Renamed").unwrap();
        let info = playlists(&conn).unwrap();
        assert_eq!((info[0].name.as_str(), info[0].count), ("Renamed", 2));
        assert_eq!(info[0].thumbnail.as_deref(), Some("cover-yt:c"));
        delete_playlist(&conn, id).unwrap();
        assert!(playlists(&conn).unwrap().is_empty());
        // Songs go with the playlist.
        let left: i64 = conn.query_row("SELECT count(*) FROM playlist_tracks", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn downloads_round_trip() {
        let conn = memory_db();
        let track = Track {
            id: "yt:abcdefghijk".into(),
            title: "Song".into(),
            artist: "Band".into(),
            album: None,
            duration: Some(200.0),
            thumbnail: None,
            ..Default::default()
        };
        add_download(&conn, &track, "abcdefghijk.m4a", 1234).unwrap();
        let list = downloads(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].track.title.as_str(), list[0].file.as_str(), list[0].size), ("Song", "abcdefghijk.m4a", 1234));
        remove_download(&conn, &track.id).unwrap();
        assert!(downloads(&conn).unwrap().is_empty());
    }

    #[test]
    fn likes_many_at_once() {
        let mut conn = memory_db();
        let song = |id: &str| Track { id: id.into(), title: id.into(), ..Default::default() };
        set_liked(&conn, &song("yt:old"), true).unwrap();
        conn.execute("UPDATE liked SET added_at = 0", []).unwrap();
        assert_eq!(set_liked_many(&mut conn, &[song("yt:a"), song("yt:old"), song("yt:b")], true).unwrap(), 2);
        // The list's order on top; the song liked before keeps its place.
        let ids: Vec<_> = liked(&conn).unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["yt:a", "yt:b", "yt:old"]);
        assert_eq!(set_liked_many(&mut conn, &[song("yt:a"), song("yt:b")], false).unwrap(), 2);
        assert_eq!(liked(&conn).unwrap().len(), 1);
    }

    #[test]
    fn listening_stats_rank_by_plays() {
        let conn = memory_db();
        let song = |id: &str, artist: &str, album: &str| Track {
            id: id.into(),
            title: id.into(),
            artist: artist.into(),
            album: Some(album.into()),
            thumbnail: Some(format!("cover-{id}")),
            ..Default::default()
        };
        let (a, b, c) = (song("yt:a", "Band, Guest", "One"), song("yt:b", "Band", "One"), song("yt:c", "Solo", "Two"));
        for t in [&a, &b, &c, &b, &c, &c] {
            add_play(&conn, t, 30).unwrap();
        }
        let id = add_play(&conn, &a, 30).unwrap();
        set_play_seconds(&conn, id, 200).unwrap();
        // One play a second apart; an old one only counts for all time.
        conn.execute("UPDATE plays SET played_at = iif(id = 1, 100, 1000 + id)", []).unwrap();

        let all = listening_stats(&conn, 0, 10).unwrap();
        assert_eq!((all.plays, all.seconds), (7, 380));
        let ids: Vec<_> = all.tracks.iter().map(|t| (t.track.id.as_str(), t.plays)).collect();
        assert_eq!(ids, [("yt:c", 3), ("yt:a", 2), ("yt:b", 2)]);
        let artists: Vec<_> = all.artists.iter().map(|a| (a.name.as_str(), a.plays)).collect();
        assert_eq!(artists, [("Band", 4), ("Solo", 3)]);
        assert_eq!(all.artists[0].thumbnail.as_deref(), Some("cover-yt:a"));
        let albums: Vec<_> = all.albums.iter().map(|a| (a.title.as_str(), a.plays)).collect();
        assert_eq!(albums, [("One", 4), ("Two", 3)]);

        let recent = listening_stats(&conn, 1000, 1).unwrap();
        assert_eq!(recent.plays, 6);
        assert_eq!(recent.tracks.len(), 1);
        assert_eq!(recent.artists[0].plays, 3);

        let mut played = played_ids(&conn).unwrap();
        played.sort();
        assert_eq!(played, ["yt:a", "yt:b", "yt:c"]);
    }

    #[test]
    fn updates_keep_search_index_in_sync() {
        let conn = memory_db();
        conn.execute("UPDATE tracks SET title = 'Renamed' WHERE title = 'Blue Tone'", []).unwrap();
        assert!(tracks(&conn, Some("blue")).unwrap().is_empty());
        assert_eq!(tracks(&conn, Some("renamed")).unwrap().len(), 1);
        conn.execute("DELETE FROM tracks WHERE title = 'Renamed'", []).unwrap();
        assert!(tracks(&conn, Some("renamed")).unwrap().is_empty());
    }
}
