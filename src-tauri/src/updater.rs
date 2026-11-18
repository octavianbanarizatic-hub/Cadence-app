//! App updates. New versions are published in the releases of the public
//! Cadence-app repository on GitHub (Cadence-releases until 1.0.0), with an
//! APK for phones and a setup program for Windows (since 1.1.0). The app
//! compares the latest release with its own version and, when asked,
//! downloads its file. Phones hand the APK to Android's installer, which only
//! puts it over the installed app when it is signed with the same key; the
//! desktop runs the setup program, which replaces Cadence and starts it again.

use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const REPO: &str = "octavianbanarizatic-hub/Cadence-app";

/// How this platform's file in a release ends.
#[cfg(not(desktop))]
const ASSET: &str = ".apk";
#[cfg(desktop)]
const ASSET: &str = "-setup.exe";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    /// The release's description, shown before updating.
    pub notes: String,
    #[serde(skip)]
    pub url: String,
    pub size: u64,
    /// GitHub's SHA-256 of the file, when it lists one.
    #[serde(skip)]
    pub sha256: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub current: String,
    /// Set when a newer version is out.
    pub update: Option<Release>,
}

fn version_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .map_while(|p| p.parse().ok())
        .collect()
}

fn is_newer(candidate: &str, current: &str) -> bool {
    let (a, b) = (version_parts(candidate), version_parts(current));
    !a.is_empty() && a > b
}

/// The latest release from GitHub's API answer, with its file whose name
/// ends with `asset`.
fn parse_release(json: &Value, asset: &str) -> Option<Release> {
    let version = json["tag_name"].as_str()?.trim_start_matches(['v', 'V']).to_string();
    let asset = json["assets"]
        .as_array()?
        .iter()
        .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(asset)))?;
    let url = asset["browser_download_url"].as_str()?.to_string();
    // Only ever download from the release repository itself.
    if !url.starts_with(&format!("https://github.com/{REPO}/releases/download/")) {
        return None;
    }
    Some(Release {
        version,
        notes: json["body"].as_str().unwrap_or("").trim().to_string(),
        url,
        size: asset["size"].as_u64().unwrap_or(0),
        sha256: asset["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).map(str::to_lowercase),
    })
}

pub async fn check(http: &reqwest::Client, current: &str) -> Result<Check, String> {
    let resp = http
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Cadence")
        .send()
        .await
        .map_err(|_| "Couldn't reach GitHub. Check your internet connection.".to_string())?;
    // No release published yet.
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Check { current: current.into(), update: None });
    }
    let json: Value = resp
        .error_for_status()
        .map_err(|e| format!("Couldn't check for updates: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Couldn't check for updates: {e}"))?;
    let update = parse_release(&json, ASSET).filter(|r| is_newer(&r.version, current));
    Ok(Check { current: current.into(), update })
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: u64,
}

/// Downloads `release` into `dir` (once; a finished file is reused) and
/// returns the file's path. Sends `update-progress` events along the way.
pub async fn download(app: &AppHandle, http: &reqwest::Client, release: &Release, dir: &Path) -> Result<PathBuf, String> {
    let io = |e: std::io::Error| format!("Couldn't save the update: {e}");
    // Named from the version's numbers only, whatever the release's tag holds.
    let version = version_parts(&release.version).iter().map(u64::to_string).collect::<Vec<_>>().join(".");
    let dest = dir.join(format!("Cadence-{version}{ASSET}"));
    if release.size > 0 && tokio::fs::metadata(&dest).await.is_ok_and(|m| m.len() == release.size) {
        return Ok(dest);
    }
    // Older downloads are no use any more.
    let _ = tokio::fs::remove_dir_all(dir).await;
    tokio::fs::create_dir_all(dir).await.map_err(io)?;
    let resp = http
        .get(&release.url)
        .header("User-Agent", "Cadence")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Download failed: {e}"))?;
    let total = resp.content_length().unwrap_or(release.size);
    let part = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&part).await.map_err(io)?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut body = resp.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| format!("Download failed: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(io)?;
        downloaded += chunk.len() as u64;
        let _ = app.emit("update-progress", Progress { downloaded, total });
    }
    file.flush().await.map_err(io)?;
    drop(file);
    if let Some(expected) = &release.sha256 {
        if format!("{:x}", hasher.finalize()) != *expected {
            let _ = tokio::fs::remove_file(&part).await;
            return Err("The download was damaged. Try again.".into());
        }
    }
    tokio::fs::rename(&part, &dest).await.map_err(io)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compares_versions() {
        assert!(is_newer("v0.5.1", "0.5.0"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("v0.5.0", "0.5.0"));
        assert!(!is_newer("0.4.9", "0.5.0"));
        assert!(!is_newer("nightly", "0.5.0"));
    }

    #[test]
    fn parses_latest_release() {
        let url = format!("https://github.com/{REPO}/releases/download/v0.5.1/Cadence-0.5.1.apk");
        let json = json!({
            "tag_name": "v0.5.1",
            "body": " Fixes \n",
            "assets": [
                { "name": "notes.txt", "browser_download_url": "x", "size": 1 },
                { "name": "Cadence-0.5.1.apk", "browser_download_url": url, "size": 42, "digest": "sha256:ABC" }
            ]
        });
        let r = parse_release(&json, ".apk").unwrap();
        assert_eq!((r.version.as_str(), r.notes.as_str(), r.size), ("0.5.1", "Fixes", 42));
        assert_eq!((r.url.as_str(), r.sha256.as_deref()), (url.as_str(), Some("abc")));
        // Files from anywhere else are ignored.
        let elsewhere = json!({ "tag_name": "v9", "assets": [{ "name": "a.apk", "browser_download_url": "https://evil.example/a.apk" }] });
        assert_eq!(parse_release(&elsewhere, ".apk"), None);
    }

    #[test]
    fn each_platform_takes_its_own_file() {
        let base = format!("https://github.com/{REPO}/releases/download/v1.1.0");
        let json = json!({
            "tag_name": "v1.1.0",
            "assets": [
                { "name": "Cadence-1.1.0-setup.exe", "browser_download_url": format!("{base}/Cadence-1.1.0-setup.exe"), "size": 3 },
                { "name": "Cadence-1.1.0.apk", "browser_download_url": format!("{base}/Cadence-1.1.0.apk"), "size": 40 }
            ]
        });
        assert_eq!(parse_release(&json, ".apk").unwrap().size, 40);
        assert_eq!(parse_release(&json, "-setup.exe").unwrap().size, 3);
        // 1.0.x releases had no setup program: the desktop finds no update there.
        let phone_only = json!({ "tag_name": "v1.0.1", "assets": [{ "name": "Cadence-1.0.1.apk", "browser_download_url": format!("{base}/x.apk") }] });
        assert_eq!(parse_release(&phone_only, "-setup.exe"), None);
    }
}
