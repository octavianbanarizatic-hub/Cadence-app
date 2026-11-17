//! Running yt-dlp, which resolves YouTube video ids into direct audio stream
//! URLs. How it runs depends on the platform (see `desktop` and `android`);
//! reading its output is shared.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Track;

#[cfg(target_os = "android")]
mod android;
#[cfg(desktop)]
mod desktop;

#[cfg(target_os = "android")]
pub use android::YtDlp;
#[cfg(desktop)]
pub use desktop::YtDlp;

/// YouTube changes often and old yt-dlp releases stop working, so the copy
/// Cadence manages is checked for updates this often.
const UPDATE_INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Passed on every run, before the run's own arguments.
const BASE_ARGS: &[&str] = &["--no-warnings", "--ignore-config"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub managed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// The JavaScript runtime yt-dlp will use for YouTube, if any.
    pub js_runtime: Option<&'static str>,
}

/// A direct audio stream plus the request headers yt-dlp says it needs.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub mime: &'static str,
    pub size: Option<u64>,
    pub resolved_at: std::time::Instant,
}

/// Which of YouTube's audio streams to take. Playback always uses `Normal`;
/// downloads use the quality picked in Settings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    /// Opus at about 160 kbps where YouTube has it.
    High,
    /// m4a/AAC at about 128 kbps, which plays in every webview Tauri uses;
    /// Opus/WebM is the fallback.
    #[default]
    Normal,
    /// About 50 to 70 kbps, to save space.
    Low,
}

impl Quality {
    fn format(self) -> &'static str {
        match self {
            Quality::High => "bestaudio",
            Quality::Normal => "bestaudio[ext=m4a]/bestaudio",
            Quality::Low => "bestaudio[abr<=80]/worstaudio",
        }
    }
}

/// The JSON a run printed, or the most useful line of its error output.
fn parse_output(success: bool, stdout: &[u8], stderr: &str) -> Result<Value, String> {
    if !success {
        let line = stderr
            .lines()
            .rev()
            .find(|l| l.contains("ERROR"))
            .unwrap_or(stderr.trim());
        return Err(line.trim().to_string());
    }
    serde_json::from_slice(stdout).map_err(|e| format!("bad yt-dlp output: {e}"))
}

impl YtDlp {
    pub async fn resolve(&self, video_id: &str, quality: Quality) -> Result<Resolved, String> {
        let url = format!("https://www.youtube.com/watch?v={video_id}");
        let info = self.run_json(&["-j", "--no-playlist", "-f", quality.format(), &url]).await?;
        let stream_url = info["url"].as_str().ok_or("no stream URL in yt-dlp output")?;
        let headers = info["http_headers"]
            .as_object()
            .map(|h| {
                h.iter()
                    .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        let mime = match info["ext"].as_str() {
            Some("webm") => "audio/webm",
            Some("mp3") => "audio/mpeg",
            Some("ogg" | "opus") => "audio/ogg",
            _ => "audio/mp4",
        };
        Ok(Resolved {
            url: stream_url.to_string(),
            headers,
            mime,
            size: info["filesize"].as_u64(),
            resolved_at: std::time::Instant::now(),
        })
    }

    /// Plain YouTube search, used when the YouTube Music API is unavailable.
    pub async fn search(&self, query: &str) -> Result<Vec<Track>, String> {
        let target = format!("ytsearch25:{query}");
        let info = self.run_json(&["-J", "--flat-playlist", &target]).await?;
        let entries = info["entries"].as_array().cloned().unwrap_or_default();
        Ok(entries
            .iter()
            .filter_map(|e| {
                let id = e["id"].as_str()?;
                Some(Track {
                    id: format!("yt:{id}"),
                    title: e["title"].as_str()?.to_string(),
                    artist: e["channel"]
                        .as_str()
                        .or(e["uploader"].as_str())
                        .unwrap_or("")
                        .to_string(),
                    album: None,
                    duration: e["duration"].as_f64(),
                    thumbnail: Some(format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg")),
                    ..Default::default()
                })
            })
            .collect())
    }

    /// The title and songs of a YouTube (or YouTube Music) playlist. Very long
    /// lists, like endless mixes, are cut at 500 songs.
    pub async fn playlist(&self, list_id: &str) -> Result<(String, Vec<Track>), String> {
        let url = format!("https://www.youtube.com/playlist?list={list_id}");
        let info = self
            .run_json(&["-J", "--flat-playlist", "--playlist-end", "500", &url])
            .await?;
        let title = info["title"].as_str().unwrap_or("Imported playlist").to_string();
        let tracks = info["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| {
                let id = e["id"].as_str().filter(|id| id.len() == 11)?;
                let channel = e["channel"].as_str().or(e["uploader"].as_str()).unwrap_or("");
                Some(Track {
                    id: format!("yt:{id}"),
                    // Upload noise like "(Official Video)" helps nobody in a playlist.
                    title: crate::lyrics::clean_title(e["title"].as_str()?),
                    artist: channel.trim_end_matches(" - Topic").trim_end_matches("VEVO").to_string(),
                    duration: e["duration"].as_f64(),
                    thumbnail: Some(format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg")),
                    ..Default::default()
                })
            })
            .collect();
        Ok((title, tracks))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_output() {
        assert_eq!(parse_output(true, br#"{"a":1}"#, "").unwrap()["a"], 1);
        let err = "WARNING: slow\nERROR: [youtube] abc: Video unavailable\n";
        assert_eq!(parse_output(false, b"", err).unwrap_err(), "ERROR: [youtube] abc: Video unavailable");
        assert_eq!(parse_output(false, b"", "  boom \n").unwrap_err(), "boom");
        assert!(parse_output(true, b"not json", "").is_err());
    }
}
