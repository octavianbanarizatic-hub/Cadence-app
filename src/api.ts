import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface Track {
  /** `yt:<videoId>`, `local:<rowid>` or `pod:<episode id>` (a podcast episode) */
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  duration?: number | null;
  /** A remote URL, or `cover/<id>` for artwork embedded in a local file. */
  thumbnail?: string | null;
  /** YouTube Music album (`MPREb_…`) and first-artist (`UC…`) page ids. */
  albumId?: string | null;
  artistId?: string | null;
  /** Each artist of a song with several, with their page id when they have
   *  one. Songs saved before this existed lack it. */
  artists?: { name: string; id: string | null }[];
}

/** What a Cadence link shares (share.rs). Ids are YouTube's own, without `yt:`. */
export type Shared =
  | { kind: "song"; id: string; title: string; artist: string }
  /** `cover` is a song's id; the link's web page shows its thumbnail. */
  | { kind: "album"; id: string; title: string; artist: string; cover: string | null }
  | { kind: "playlist"; name: string; ids: string[] }
  | { kind: "artist"; id: string; name: string }
  /** From a YouTube link: a playlist on YouTube, by its list id. */
  | { kind: "youtubePlaylist"; id: string };

/** Which of YouTube's audio streams a download saves: about 160, 128 or 70 kbps. */
export type DownloadQuality = "high" | "normal" | "low";

/** What the phone's lock screen and notification show (Android only). */
export interface MediaState {
  active: boolean;
  title: string;
  artist: string;
  album: string | null;
  /** An https cover URL, or a local file's `cover/<id>`; the native side can't read media:// URLs. */
  art: string | null;
  duration: number | null;
  position: number;
  playing: boolean;
}

/** Where the music plays on a phone. */
export interface AudioOutput {
  kind: "phone" | "bluetooth" | "headphones" | "speaker";
  /** The device's own name ("Samsung Q70CA 55"), when Android has one worth showing. */
  name?: string | null;
}

export interface ListeningStats {
  seconds: number;
  plays: number;
  tracks: { track: Track; plays: number }[];
  /** `thumbnail` is the cover of their latest song. */
  artists: { name: string; id: string | null; thumbnail: string | null; plays: number }[];
  albums: { title: string; id: string | null; artist: string; thumbnail: string | null; plays: number }[];
}

/** A newer version of the phone app, published on GitHub. */
export interface AppUpdate {
  version: string;
  notes: string;
  /** Bytes. */
  size: number;
}

export interface Release {
  id: string;
  title: string;
  year: string | null;
  thumbnail: string | null;
  /** Search results say whose it is. */
  artist?: string;
}

/** A podcast, as Apple's directory lists it (podcasts.rs). */
export interface Show {
  id: string;
  title: string;
  author: string;
  artwork: string | null;
  feed: string;
}

/** A podcast episode, with where it was left off. */
export interface Episode {
  id: string;
  showId: string;
  showTitle: string;
  title: string;
  description: string;
  /** Unix seconds. */
  published: number | null;
  duration: number | null;
  position: number;
  played: boolean;
}

export interface ShowPage {
  show: Show;
  description: string;
  followed: boolean;
  episodes: Episode[];
}

/** Artists and albums that match a search. */
export interface SearchPages {
  artists: ArtistRef[];
  albums: Release[];
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  /** "Album • 2013" */
  subtitle: string;
  thumbnail: string | null;
  tracks: Track[];
}

export interface ArtistRef {
  id: string;
  name: string;
  thumbnail: string | null;
}

export interface Artist {
  id: string;
  name: string;
  thumbnail: string | null;
  /** The artist's bio. */
  description: string | null;
  /** "129M monthly audience". */
  audience: string | null;
  topSongs: Track[];
  albums: Release[];
  singles: Release[];
  related: ArtistRef[];
}

export interface PlaylistInfo {
  id: number;
  name: string;
  count: number;
  /** The first song's cover, or a photo picked for it (`pcover/<file>`). */
  thumbnail: string | null;
}

export interface Playlist {
  id: number;
  name: string;
  source: string | null;
  tracks: Track[];
  /** A photo picked as the cover (`pcover/<file>`), on phones. */
  cover: string | null;
}

export interface ImportResult {
  playlistId: number;
  name: string;
  added: number;
  /** "Title – Artist" of songs that weren't found on YouTube Music. */
  missing: string[];
  /** Spotify only shares the first 100 songs; the playlist may be longer. */
  maybeTruncated: boolean;
}

/** What importing music files on a phone did. */
export interface MusicImport {
  added: number;
  /** Imported before (the same name and size). */
  existing: number;
  /** Picked files that aren't music Cadence can play. */
  unsupported: number;
  failed: number;
}

export interface YtDlpStatus {
  installed: boolean;
  managed: boolean;
  version: string | null;
  path: string | null;
  jsRuntime: "deno" | "node" | null;
}

export interface LyricLine {
  /** Seconds from the start of the song. */
  time: number;
  text: string;
}

export interface Lyrics {
  synced: LyricLine[] | null;
  plain: string | null;
  instrumental: boolean;
}

export interface DownloadItem {
  track: Track;
  state: "queued" | "downloading" | "done" | "failed" | "removed";
  /** Bytes saved so far; the file size once done. */
  done: number;
  total: number | null;
  error: string | null;
}

export interface BackupSummary {
  /** Seconds since 1970. */
  createdAt: number;
  appVersion: string;
  playlists: number;
  liked: number;
  libraryTracks: number;
  downloads: number;
}

export const api = {
  search: (query: string) => invoke<Track[]>("search", { query }),
  /** Artists and albums that match `query`. */
  searchPages: (query: string) => invoke<SearchPages>("search_pages", { query }),
  /** The user's own songs that match: liked, downloaded, in a playlist, played (yours.rs). */
  yourSongs: (query: string, limit: number) => invoke<Track[]>("your_songs", { query, limit }),
  podcastSearch: (query: string) => invoke<Show[]>("podcast_search", { query }),
  /** A podcast's page by Apple's id, its feed read anew. */
  podcastShow: (id: string) => invoke<ShowPage>("podcast_show", { id }),
  podcastFollow: (id: string, follow: boolean) => invoke<void>("podcast_follow", { id, follow }),
  podcastsFollowed: () => invoke<Show[]>("podcasts_followed"),
  /** Episodes being listened to, then new ones from followed podcasts. */
  podcastNewEpisodes: () => invoke<Episode[]>("podcast_new_episodes"),
  podcastProgress: (id: string, position: number, played: boolean) => invoke<void>("podcast_progress", { id, position, played }),
  /** Where an episode was left off, if Cadence knows the episode. */
  podcastSpot: (id: string) => invoke<{ position: number; played: boolean } | null>("podcast_spot", { id }),
  /** A YouTube playlist's title and songs (up to 500). */
  youtubePlaylist: (id: string) => invoke<{ title: string; tracks: Track[] }>("youtube_playlist", { id }),
  /** Phones: whether the internet connection is Wi-Fi or another one that isn't metered. */
  unmetered: () => invoke<boolean>("unmetered_network"),
  /** Phones: where the music plays; null on desktop. Changes arrive as `window.__cadenceOutput`. */
  audioOutput: () => invoke<AudioOutput | null>("audio_output"),
  /** Phones: opens Android's panel for picking where the music plays. */
  pickAudioOutput: () => invoke<void>("audio_output_pick"),
  prefetch: (id: string) => invoke<boolean>("prefetch", { id }),
  ytdlpStatus: () => invoke<YtDlpStatus>("ytdlp_status"),
  mediaState: (state: MediaState) => invoke<void>("media_state", { state }),
  ytdlpInstall: () => invoke<YtDlpStatus>("ytdlp_install"),
  ytdlpUpdate: () => invoke<YtDlpStatus>("ytdlp_update"),
  libraryFolders: () => invoke<string[]>("library_folders"),
  libraryAddFolder: (path: string) => invoke<string[]>("library_add_folder", { path }),
  libraryRemoveFolder: (path: string) => invoke<string[]>("library_remove_folder", { path }),
  libraryRescan: () => invoke<void>("library_rescan"),
  libraryTracks: (query?: string) => invoke<Track[]>("library_tracks", { query: query || null }),
  /** Phones: picks music files (or a folder) and copies them in; null when nothing was picked. */
  musicImport: (folder: boolean) => invoke<MusicImport | null>("music_import", { folder }),
  /** Phones: deletes an imported song, Cadence's copy included. */
  musicRemove: (id: number) => invoke<void>("music_remove", { id }),
  likedList: () => invoke<Track[]>("liked_list"),
  likedSet: (track: Track, liked: boolean) => invoke<void>("liked_set", { track, liked }),
  /** Likes or unlikes a whole list; returns how many songs changed. */
  likedSetMany: (tracks: Track[], liked: boolean) => invoke<number>("liked_set_many", { tracks, liked }),
  /** Starts a play in the listening history; returns its id. */
  playStart: (track: Track, seconds: number) => invoke<number>("play_start", { track, seconds }),
  playTime: (id: number, seconds: number) => invoke<void>("play_time", { id, seconds }),
  /** Top songs, artists and albums played since `since` (unix seconds). */
  listeningStats: (since: number) => invoke<ListeningStats>("listening_stats", { since }),
  /** Phones: the navigation bar's height in CSS pixels; the page draws behind it. */
  navBarHeight: () => invoke<number>("nav_bar_height"),
  /** This version, and a newer one if it's out (phones and Windows). */
  appUpdateCheck: () => invoke<{ current: string; update: AppUpdate | null }>("app_update_check"),
  /** Downloads the update and opens the installer (on Windows, the setup
   *  program, which restarts Cadence). False when Android first wants Cadence
   *  allowed to install apps (its settings screen opens). */
  appUpdateInstall: () => invoke<boolean>("app_update_install"),
  /** Null when no lyrics were found. */
  lyrics: (track: Track) => invoke<Lyrics | null>("lyrics", { track }),
  /** Swaps the main window for the mini player, or back. */
  miniPlayer: (open: boolean) => invoke<void>("mini_player", { open }),
  downloadsList: () => invoke<DownloadItem[]>("downloads_list"),
  /** Returns how many of the tracks were newly queued. */
  downloadAdd: (tracks: Track[], quality: DownloadQuality = "normal") => invoke<number>("download_add", { tracks, quality }),
  downloadRemove: (id: string) => invoke<void>("download_remove", { id }),
  album: (id: string) => invoke<Album>("album", { id }),
  artist: (id: string) => invoke<Artist>("artist", { id }),
  /** The songs with these YouTube ids, in order; ones YouTube doesn't know are left out. */
  songs: (ids: string[]) => invoke<Track[]>("songs", { ids }),
  /** Phones: opens Android's share sheet with a link to `item`. */
  share: (item: Shared) => invoke<void>("share", { item }),
  /** Phones: shares a JPEG the page drew (a lyrics card) through Android's share sheet. */
  shareImage: (jpeg: Uint8Array) => invoke<void>("share_image", { jpeg: Array.from(jpeg) }),
  /** Phones: what the link that opened the app shares, once. */
  sharedLink: () => invoke<(Shared & { quiet: boolean }) | null>("shared_link"),
  /** The link to `item`; the desktop copies it. */
  shareLink: (item: Shared) => invoke<string>("share_link", { item }),
  /** What a Cadence, YouTube or YouTube Music link pasted into Search opens; null for other text. */
  openLink: (text: string) => invoke<Shared | null>("open_link", { text }),
  /** The desktop: saves a JPEG the page drew (a lyrics card) to `path`. */
  imageSave: (path: string, jpeg: Uint8Array) => invoke<void>("image_save", { path, jpeg: Array.from(jpeg) }),
  /** Songs like `seeds` (YouTube track ids), leaving out the ids in `skip`. */
  recommendations: (seeds: string[], skip: string[]) => invoke<Track[]>("recommendations", { seeds, skip }),
  playlists: () => invoke<PlaylistInfo[]>("playlists_list"),
  playlist: (id: number) => invoke<Playlist>("playlist_get", { id }),
  /** Returns the new playlist's id. */
  playlistCreate: (name: string, tracks: Track[] = []) => invoke<number>("playlist_create", { name, tracks }),
  playlistRename: (id: number, name: string) => invoke<void>("playlist_rename", { id, name }),
  playlistDelete: (id: number) => invoke<void>("playlist_delete", { id }),
  /** Phones: picks a photo as the playlist's cover; false when none was picked. */
  playlistCoverPick: (id: number) => invoke<boolean>("playlist_cover_pick", { id }),
  /** The desktop: a JPEG the page cut square from a chosen photo, as the playlist's cover. */
  playlistCoverSet: (id: number, jpeg: Uint8Array) => invoke<void>("playlist_cover_set", { id, jpeg: Array.from(jpeg) }),
  playlistCoverClear: (id: number) => invoke<void>("playlist_cover_clear", { id }),
  /** Returns how many songs were new to the playlist. */
  playlistAdd: (id: number, tracks: Track[]) => invoke<number>("playlist_add", { id, tracks }),
  playlistSetTracks: (id: number, tracks: Track[]) => invoke<void>("playlist_set_tracks", { id, tracks }),
  playlistImport: (link: string) => invoke<ImportResult>("playlist_import", { link }),
  /** `settings` is the page's settings as JSON. */
  backupCreate: (path: string, settings: string) => invoke<BackupSummary>("backup_create", { path, settings }),
  backupPeek: (path: string) => invoke<BackupSummary>("backup_peek", { path }),
  /** Saves a backup named `name` in Downloads (phones) or Documents (desktop) →
   *  Cadence backups; `auto` keeps only the newest few automatic ones. Returns the folder. */
  backupToFolder: (settings: string, name: string, auto: boolean) => invoke<string>("backup_to_folder", { settings, name, auto }),
  /** Phones: lets the user pick a backup file; its path for backupPeek and backupRestore, or null. */
  backupPick: () => invoke<string | null>("backup_pick"),
  /** Phones: who to check for new releases in the background (JSON), or with `on` false, stop. */
  releasesWatch: (json: string, on: boolean) => invoke<void>("releases_watch", { json, on }),
  /** Phones: whether Cadence may notify; Android 13 and newer ask the first time. */
  notificationsAllow: () => invoke<boolean>("notifications_allow"),
  backupRestore: (path: string, currentSettings: string) =>
    invoke<{ summary: BackupSummary; settings: string; safetyCopy: string }>("backup_restore", { path, currentSettings }),
};

function media(path: string): string {
  return convertFileSrc(path, "media");
}

export function streamUrl(track: Track): string {
  const [source, ref] = splitId(track.id);
  return media(source === "yt" ? `yt/${ref}` : source === "pod" ? `pod/${ref}` : `file/${ref}`);
}

/**
 * Artwork URL for the page. Remote covers go through the back end's cache
 * (Google's image server rate-limits the web view). Pass `direct` for
 * consumers outside the page, such as the OS media overlay.
 */
export function artUrl(track: Track | null | undefined, direct = false): string | null {
  const thumb = track?.thumbnail;
  if (!thumb) return null;
  if (thumb.startsWith("cover/") || thumb.startsWith("pcover/") || thumb.startsWith("pcast/")) return media(thumb);
  return direct ? thumb : media(`img/${thumb}`);
}

const awayListeners: ((away: boolean) => void)[] = [];

/**
 * Runs `fn` when the app goes to the background (true) and comes back (false).
 * On phones the native side reports it: while music is paused in the
 * background the web view is told it is still shown, so that the page isn't
 * frozen (PageHost.kt), and `document.hidden` stays false.
 */
export function onAway(fn: (away: boolean) => void) {
  if (!/Android/i.test(navigator.userAgent)) {
    document.addEventListener("visibilitychange", () => fn(document.hidden));
    return;
  }
  awayListeners.push(fn);
  (window as unknown as { __cadenceAway: (away: boolean) => void }).__cadenceAway = (away) =>
    awayListeners.forEach((f) => f(away));
}

function splitId(id: string): [string, string] {
  const i = id.indexOf(":");
  return [id.slice(0, i), id.slice(i + 1)];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
