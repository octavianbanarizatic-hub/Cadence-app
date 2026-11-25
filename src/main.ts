import { emitTo, listen } from "@tauri-apps/api/event";
import { documentDir, join, pictureDir } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  api,
  artUrl,
  formatBytes,
  formatTime,
  onAway,
  type AppUpdate,
  type Artist,
  type Card,
  type Explore,
  type AudioOutput,
  type BackupSummary,
  type DownloadItem,
  type DownloadQuality,
  type ImportResult,
  type ListeningStats,
  type LyricLine,
  type Lyrics,
  type MusicImport,
  type PlaylistInfo,
  type ArtistRef,
  type Release,
  type SearchPages,
  type Episode,
  type Show,
  type Shared,
  type Track,
  type YtDlpStatus,
} from "./api";
import { icon, mark, MARK, type IconName } from "./icons";
import { trackListening } from "./listening";
import { episodeDate, episodeTime, episodeTrack, isEpisode, learn, progress, replay, setSpeed, showOf, speed, SPEEDS, trackPodcasts } from "./podcasts";
import type { MiniCommand, MiniState } from "./mini-link";
import { EQ_BANDS, EQ_PRESETS, MAX_CROSSFADE, Player, shuffled } from "./player";
import { settings } from "./settings";

/**
 * Home, Search, Library and Profile are the phone's tabs and the desktop's
 * sidebar; Settings opens from Profile's gear (and the sidebar's on the
 * desktop). Your music is the songs imported from the phone, or on the desktop
 * the music folders.
 */
type View = "home" | "search" | "library" | "liked" | "music" | "downloads" | "profile" | "settings" | "page";

/** A page opened from a list: an album, artist or playlist. */
type Page =
  | { kind: "album"; id: string }
  | { kind: "artist"; id: string }
  | { kind: "playlist"; id: number }
  | { kind: "localAlbum"; album: string; artist: string }
  | { kind: "localArtist"; artist: string }
  /** A mood or genre from Search's Explore: its playlists. */
  | { kind: "mood"; title: string; params: string; color: string | null }
  /** A playlist someone shared, by its songs' YouTube ids. */
  | { kind: "shared"; name: string; ids: string[] }
  /** A playlist on YouTube, opened from a link shared to Cadence (or pasted into Search). */
  | { kind: "ytlist"; id: string }
  /** One of today's mixes on Home. */
  | { kind: "mix"; index: number }
  /** Discover Weekly or Release Radar on Home. */
  | { kind: "weekly"; which: WeeklyKind }
  /** A podcast, by Apple's id. */
  | { kind: "podcast"; id: string };

const player = new Player();
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
/** Phones get their own layout (phone.css): bottom tabs and a full-screen player.
 *  The desktop's (desktop.css) has a sidebar and a Now Playing panel. */
const phone = /Android/i.test(navigator.userAgent);
document.documentElement.classList.toggle("phone", phone);
document.documentElement.classList.toggle("desktop", !phone);
// Phones fade covers and photos in once they have loaded (phone.css); this
// listens before anything is drawn, so no picture is missed.
document.addEventListener(
  "load",
  (e) => {
    if (e.target instanceof HTMLImageElement) e.target.classList.add("shown");
  },
  true,
);

/** Where the app starts and Back ends up. */
const startView: Exclude<View, "page"> = "home";
// Phones always open on Home; the desktop returns to where it was.
let view: View = phone ? startView : settings.get<View>("view", startView);
if (view === "page") view = startView;
let page: Page | null = null;
/** Where Back goes: earlier views and pages, with their scroll positions. */
const history: { view: View; page: Page | null; scroll: number }[] = [];
let playlists: PlaylistInfo[] = [];
const liked = new Map<string, Track>();
/** Downloads by track id: running, waiting and finished (newest first). */
const downloads = new Map<string, DownloadItem>();
/** Which results the search shows. */
type SearchTab = "songs" | "artists" | "albums" | "podcasts";
const search = { query: "", results: [] as Track[], loading: false, error: "", token: 0, pages: null as SearchPages | null, shows: null as Show[] | null, tab: "songs" as SearchTab };
let engine: YtDlpStatus | null = null;
let installing: { downloaded: number; total: number | null } | null = null;
let scanStatus = "";

// ---- helpers ---------------------------------------------------------------

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function setIcon(el: HTMLElement, name: IconName, size?: number) {
  el.innerHTML = icon(name, size);
}

/** `action` adds a button, such as Undo, and keeps the message up a little longer. */
function toast(message: string, kind: "info" | "error" = "info", action?: { label: string; run: () => void }) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-act";
    btn.textContent = action.label;
    btn.onclick = () => {
      el.remove();
      action.run();
    };
    el.append(btn);
  }
  $("#toasts").append(el);
  const life = action ? 4000 : kind === "error" ? 5000 : 2800;
  setTimeout(() => el.classList.add("out"), life);
  setTimeout(() => el.remove(), life + 400);
}

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: number | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

function artHtml(track: Track, size: "sm" | "lg" = "sm"): string {
  const url = artUrl(track);
  return url
    ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" draggable="false" />`
    : `<span class="art-fallback">${icon("music", size === "lg" ? 28 : 18)}</span>`;
}

// ---- track lists -------------------------------------------------------------

/** Row markup; `offset` is the index of the first track within its list.
 *  With `removeTitle`, an X that removes the row takes the place of ⋮. */
function trackRows(tracks: Track[], offset = 0, removeTitle?: string, handle = false): string {
  return tracks
    .map((t, j) => {
      const i = offset + j;
      const isLiked = liked.has(t.id);
      const gone = unavailable(t);
      return `<div class="track ${gone ? "unavailable" : ""}" data-i="${i}" data-id="${esc(t.id)}">
        <div class="track-art">${artHtml(t)}<span class="track-play">${icon("play", 20)}</span></div>
        <div class="track-main">
          <div class="track-title">${esc(t.title)}</div>
          <div class="track-artist"><span class="dl-slot">${gone ? `<span class="dl" title="Not downloaded">${icon("cloudOff", 14)}</span>` : downloadBadge(t.id)}</span>${artistLinks(t, "Unknown artist")}</div>
        </div>
        <div class="track-album">${linked(t.album, albumTarget(t))}</div>
        <span class="np-bars" title="Playing"><i></i><i></i><i></i></span>
        <button class="icon-btn small like ${isLiked ? "on" : ""}" data-act="like" title="${isLiked ? "Remove from liked songs" : "Like"}">${icon(isLiked ? "heartFilled" : "heart", 18)}</button>
        <div class="track-dur">${t.duration ? formatTime(t.duration) : ""}</div>
        ${
          removeTitle
            ? `<button class="icon-btn small" data-act="remove" title="${removeTitle}">${icon("close", 18)}</button>`
            : `<button class="icon-btn small" data-act="more" title="More">${icon("more", 18)}</button>`
        }
        ${handle ? `<span class="q-handle" title="Drag to move">${icon("drag", 20)}</span>` : ""}
      </div>`;
    })
    .join("");
}

/** Rows are added in pages as the view scrolls, so huge libraries stay fast. */
const PAGE = 200;
let loadMoreRows: (() => void) | null = null;

/** Where a song's artist name leads, encoded for a `data-go` attribute. */
function artistTarget(t: Track): string | null {
  if (t.artistId) return `artist:${t.artistId}`;
  // An episode's "artist" is its podcast.
  if (isEpisode(t)) return showOf(t) ? `podcast:${showOf(t)}` : null;
  if (t.id.startsWith("local:") && t.artist) return `lartist:${t.artist}`;
  return null;
}

function albumTarget(t: Track): string | null {
  if (t.albumId) return `album:${t.albumId}`;
  if (t.id.startsWith("local:") && t.album) return `lalbum:${JSON.stringify([t.album, t.artist])}`;
  return null;
}

/** `text`, clickable when it leads somewhere. */
function linked(text: string | null | undefined, target: string | null): string {
  if (!text) return "";
  return target ? `<span class="link" data-go="${esc(target)}">${esc(text)}</span>` : esc(text);
}

/** A song's artist names. With several artists, each name leads to its own page. */
function artistLinks(t: Track, fallback = ""): string {
  if (!t.artists?.length) return linked(t.artist || fallback, artistTarget(t));
  const names = t.artists.map((a) => (a.id ? linked(a.name, `artist:${a.id}`) : `<span>${esc(a.name)}</span>`));
  return `<span class="artists">${names.join(`<span class="sep">, </span>`)}</span>`;
}

/** Lookups of songs' artists, so each song is asked about once. */
const artistLookups = new Map<string, Promise<Track["artists"]>>();

/** Whether a song may have more artists than the one its `artistId` leads to:
 *  songs saved before artists were kept one by one only know the first. */
function unsureArtists(t: Track): boolean {
  return !t.artists?.length && t.id.startsWith("yt:") && t.artist.includes(", ");
}

/** Looks up the artists of such a song and fills them in. Resolves true when
 *  the song gained its list. */
async function findArtists(t: Track): Promise<boolean> {
  if (!unsureArtists(t)) return false;
  let lookup = artistLookups.get(t.id);
  if (!lookup) {
    lookup = api.songs([t.id.slice(3)]).then(
      ([song]) => song?.artists,
      // Offline, say: ask again next time.
      () => void artistLookups.delete(t.id),
    );
    artistLookups.set(t.id, lookup);
  }
  const artists = await lookup;
  if (!artists?.length) return false;
  t.artists = artists;
  return true;
}

function severalArtists(t: Track): boolean {
  return (t.artists?.length ?? 0) > 1 || unsureArtists(t);
}

/**
 * Follows the album or artist link that was clicked on `song`'s line. An
 * artist line drawn as one link (an older song's) only leads to the first
 * artist, so with several the click asks which.
 */
function openLink(e: MouseEvent, song: Track | null) {
  const link = (e.target as HTMLElement).closest<HTMLElement>("[data-go]");
  const go = link?.dataset.go;
  if (!link || !go) return;
  if (song && go.startsWith("artist:") && !link.closest(".artists") && severalArtists(song)) {
    // Otherwise the document's click handler closes the menu again at once.
    e.stopPropagation();
    void goToArtist(song, e.clientX, e.clientY);
  } else openTarget(go);
}

/** Opens a song's artist page. With several artists, a menu at (x, y) asks which. */
async function goToArtist(t: Track, x?: number, y?: number) {
  await findArtists(t);
  const pages = (t.artists ?? []).filter((a) => a.id);
  if (pages.length > 1) {
    return showMenu(pages.map((a): MenuItem => ({ label: a.name, icon: "person", run: () => openTarget(`artist:${a.id}`) })), x, y, t);
  }
  $("#menu").hidden = true;
  const to = pages.length ? `artist:${pages[0].id}` : artistTarget(t);
  if (to) openTarget(to);
}

function pageFor(target: string): Page | null {
  const i = target.indexOf(":");
  const [kind, rest] = [target.slice(0, i), target.slice(i + 1)];
  if (kind === "artist") return { kind: "artist", id: rest };
  if (kind === "album") return { kind: "album", id: rest };
  if (kind === "playlist") return { kind: "playlist", id: Number(rest) };
  if (kind === "mix") return { kind: "mix", index: Number(rest) };
  if (kind === "weekly" && (rest === "discover" || rest === "radar")) return { kind: "weekly", which: rest };
  if (kind === "podcast") return { kind: "podcast", id: rest };
  if (kind === "ytlist") return { kind: "ytlist", id: rest };
  if (kind === "lartist") return { kind: "localArtist", artist: rest };
  if (kind === "lalbum") {
    const [album, artist] = JSON.parse(rest) as [string, string];
    return { kind: "localAlbum", album, artist };
  }
  return null;
}

/** Each list's handle listeners, so mounting a list again replaces them. */
const handleListeners = new WeakMap<HTMLElement, AbortController>();

interface ListOptions {
  /** Where the list is, for "Playing from" ("Liked songs", a playlist's name). */
  from?: string;
  /** Extra items for a song's menu, such as removing it from a playlist. */
  menu?: (index: number) => MenuItem[];
  /** Phones: what swiping a song to the left does, if anything. */
  swipeLeft?: SwipeAction & { run: (index: number) => void };
  /** Lets rows be dragged to a new position. */
  reorder?: (from: number, to: number) => void;
  /** Called when a row starts playing. */
  onPlay?: (track: Track) => void;
  /** A row plays on its own (then Autoplay takes over), not the list from there. */
  single?: boolean;
  /** Gives each row an X that removes it from the list. */
  remove?: { title: string; run: (index: number) => void };
  /** A short list outside the page (under the full-screen player): it doesn't
   *  take over the page's paging, and its songs aren't looked up ahead. */
  aside?: boolean;
}

/** Renders `tracks` into `el`; clicking a row plays the list from that row. */
function mountTrackList(el: HTMLElement, tracks: Track[], opts: ListOptions = {}) {
  let shown = 0;
  el.innerHTML = "";
  const scroller = $("#view");
  // Phones move songs by a handle on each row (touch screens don't drag and drop).
  const handles = phone && Boolean(opts.reorder);
  el.classList.toggle("sortable", handles);
  const more = () => {
    // Keep adding pages until the list reaches well below the visible area.
    while (shown < tracks.length && el.isConnected) {
      const bottom = el.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
      if (shown > 0 && bottom > 1200) break;
      el.insertAdjacentHTML("beforeend", trackRows(tracks.slice(shown, shown + PAGE), shown, opts.remove?.title, handles));
      shown = Math.min(tracks.length, shown + PAGE);
    }
    if (opts.reorder && !phone) el.querySelectorAll(".track").forEach((r) => r.setAttribute("draggable", "true"));
    markPlaying();
  };
  if (!opts.aside) loadMoreRows = more;
  more();
  // Phones have no hover to start lookups early: look up the first few songs
  // now (fewer on mobile data, as each lookup costs some).
  if (phone && !opts.aside) {
    void api
      .unmetered()
      .catch(() => false)
      .then((wifi) => el.isConnected && player.warmAhead(tracks, wifi ? 3 : 1));
  }

  const rowOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>(".track");
  const onHandle = (e: Event) => Boolean((e.target as HTMLElement).closest(".q-handle"));
  el.onclick = (e) => {
    const row = rowOf(e);
    if (!row || justSwiped() || onHandle(e)) return;
    const i = Number(row.dataset.i);
    const track = tracks[i];
    const go = (e.target as HTMLElement).closest<HTMLElement>("[data-go]")?.dataset.go;
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (go) openLink(e as MouseEvent, track);
    else if (act === "like") {
      const unliking = liked.has(track.id);
      void toggleLike(track).then(() => {
        // A heart clicked by mistake can be put back.
        if (unliking && !liked.has(track.id)) toast("Removed from liked songs", "info", { label: "Undo", run: () => void toggleLike(track) });
      });
    }
    else if (act === "more") openMenu(e as MouseEvent, track, opts.menu?.(i));
    else if (act === "remove") opts.remove?.run(i);
    // Clicking the song that is already playing pauses or resumes it.
    else if (player.current?.id === track.id) player.toggle();
    else {
      opts.onPlay?.(track);
      if (opts.single) player.playList([track], 0, opts.from);
      else player.playList(tracks, i, opts.from);
    }
  };
  el.oncontextmenu = (e) => {
    const row = rowOf(e);
    if (!row) return;
    e.preventDefault();
    if (onHandle(e)) return;
    const i = Number(row.dataset.i);
    openMenu(e, tracks[i], opts.menu?.(i));
  };
  if (phone) {
    let row: HTMLElement | null = null;
    const left = opts.swipeLeft;
    onSwipe(el, {
      begin: (e) => !onHandle(e) && (row = rowOf(e)) !== null,
      move: (dx) => row && (dx < 0 && left ? swipeRow(row, dx, left) : swipeRow(row, Math.max(0, dx), QUEUE_SWIPE)),
      end: (dx) => {
        if (!row) return;
        const i = Number(row.dataset.i);
        if (dx >= SWIPE_MARK) {
          player.addToQueue(tracks[i]);
          toast("Added to queue");
        } else if (left && dx <= -SWIPE_MARK) {
          left.run(i);
        }
        settleRow(row);
      },
    });
  }
  if (handles && opts.reorder) bindHandles(el, scroller, ".track", opts.reorder, undefined, true);
  else handleListeners.get(el)?.abort();
  if (opts.reorder) {
    const reorder = opts.reorder;
    let from = -1;
    const clearMarks = () => el.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
    const target = (e: DragEvent) => {
      const row = rowOf(e);
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { row, after: e.clientY > r.top + r.height / 2 };
    };
    el.ondragstart = (e) => {
      from = Number(rowOf(e)?.dataset.i ?? -1);
      e.dataTransfer?.setData("text/plain", "");
    };
    el.ondragover = (e) => {
      if (from < 0) return;
      e.preventDefault();
      clearMarks();
      const t = target(e);
      t?.row.classList.add(t.after ? "drop-after" : "drop-before");
    };
    el.ondrop = (e) => {
      e.preventDefault();
      clearMarks();
      const t = target(e);
      if (t && from >= 0) {
        let to = Number(t.row.dataset.i) + (t.after ? 1 : 0);
        if (from < to) to--;
        if (to !== from) reorder(from, to);
      }
      from = -1;
    };
    el.ondragend = () => {
      clearMarks();
      from = -1;
    };
  }
  // Resolving a YouTube stream takes a few seconds, so start when the pointer
  // rests on a row; by the time it is clicked the stream is usually ready.
  let hoverTimer: number | undefined;
  let hoverRow: HTMLElement | null = null;
  el.onmouseover = (e) => {
    const row = rowOf(e);
    if (row === hoverRow) return;
    hoverRow = row;
    clearTimeout(hoverTimer);
    if (row) hoverTimer = window.setTimeout(() => player.warm(tracks[Number(row.dataset.i)]), 300);
  };
  el.onmouseleave = () => {
    clearTimeout(hoverTimer);
    hoverRow = null;
  };
}

function markPlaying() {
  const id = player.current?.id;
  document.querySelectorAll(".track.playing, .episode.playing").forEach((r) => r.classList.remove("playing"));
  if (id) {
    document
      .querySelectorAll(`.track[data-id="${CSS.escape(id)}"], .episode[data-id="${CSS.escape(id)}"]`)
      .forEach((r) => r.classList.add("playing"));
  }
}

function emptyState(iconName: IconName, title: string, body: string): string {
  return `<div class="empty">${icon(iconName, 40)}<h2>${title}</h2><p>${body}</p></div>`;
}

// ---- likes -------------------------------------------------------------------

async function toggleLike(track: Track) {
  const on = !liked.has(track.id);
  try {
    await api.likedSet(track, on);
  } catch (e) {
    return toast(String(e), "error");
  }
  if (on) {
    // Newest first, matching the order the back end returns.
    const rest = [...liked].filter(([id]) => id !== track.id);
    liked.clear();
    liked.set(track.id, track);
    for (const [id, t] of rest) liked.set(id, t);
  } else {
    liked.delete(track.id);
  }
  if (on) void autoDownload();
  const hearts = [...document.querySelectorAll<HTMLElement>(`.track[data-id="${CSS.escape(track.id)}"] [data-act="like"]`)];
  hearts.forEach((b) => {
    b.classList.toggle("on", on);
    b.innerHTML = icon(on ? "heartFilled" : "heart", 18);
  });
  updateNowLike();
  // Phones: a liked song's hearts pop gently.
  if (on && phone) {
    if (player.current?.id === track.id) hearts.push($("#now-like"));
    hearts.forEach((b) => pulse(b, "pop"));
  }
  renderSidebar();
  if (view === "liked") void renderLiked();
}

// ---- context menu --------------------------------------------------------------

interface MenuItem {
  label: string;
  run: () => void;
  /** Draw a divider above this item. */
  divider?: boolean;
  /** Leave the menu open; the item replaces its contents (a submenu). */
  keep?: boolean;
  /** Phones show an icon before each item, and sometimes a second line. */
  icon?: IconName;
  sub?: string;
  /** A state that is on, such as a liked song (a red heart). */
  on?: boolean;
}

function openMenu(e: MouseEvent, track: Track, extra: MenuItem[] = []) {
  e.stopPropagation();
  if (isEpisode(track)) return episodeMenu(e, track, extra);
  const isLiked = liked.has(track.id);
  const dl = downloads.get(track.id)?.state;
  const items: MenuItem[] = [
    { label: "Play next", icon: "queue", run: () => (player.playNext(track), toast("Playing next")) },
    { label: "Add to queue", icon: "queueAdd", run: () => (player.addToQueue(track), toast("Added to queue")) },
    { label: "Add to playlist…", icon: "playlistAdd", keep: true, run: () => showMenu(playlistMenu([track])) },
    {
      label: isLiked ? "Remove from liked songs" : "Add to liked songs",
      icon: isLiked ? "heartFilled" : "heart",
      on: isLiked,
      run: () => void toggleLike(track),
    },
  ];
  if (track.id.startsWith("yt:")) {
    const label = dl === "done" ? "Remove download" : dl ? "Cancel download" : "Download";
    items.push({
      label,
      icon: dl === "done" ? "downloadDone" : dl ? "close" : "download",
      sub: dl === "done" ? "Still plays when you're online" : undefined,
      run: () => void (dl ? removeDownload(track) : downloadTracks([track])),
    });
  }
  if (track.id.startsWith("yt:")) {
    const id = track.id.slice(3);
    items.push({ label: "Start radio", icon: "radio", run: () => void startRadio([track], `${track.title} radio`, track) });
    items.push(hideItem(track));
    items.push({ label: "Share", icon: "share", run: () => void share({ kind: "song", id, title: track.title, artist: track.artist }) });
  }
  const toArtist = artistTarget(track);
  const toAlbum = albumTarget(track);
  // With several artists the menu stays open and lists them.
  if (toArtist) items.push({ label: "Go to artist", icon: "person", divider: true, keep: severalArtists(track), run: () => void goToArtist(track) });
  if (toAlbum) items.push({ label: "Go to album", icon: "album", divider: !toArtist, run: () => openTarget(toAlbum) });
  if (extra.length) extra[0] = { ...extra[0], divider: true };
  showMenu([...items, ...extra], e.clientX, e.clientY, track);
}

let menuAt = { x: 0, y: 0 };
/** The song a menu is for; a submenu keeps its parent's. */
let menuHead: Track | undefined;
let inSubmenu = false;

/** Shows `items` at the pointer, or where the menu already is. On phones the
 *  menu is a sheet along the bottom, headed by the song it is for. */
function showMenu(items: MenuItem[], x = menuAt.x, y = menuAt.y, head?: Track) {
  menuAt = { x, y };
  menuHead = head ?? (inSubmenu ? menuHead : undefined);
  head = menuHead;
  const menu = $("#menu");
  const top =
    phone && head
      ? `<div class="sheet-head">
          <div class="sheet-art">${artHtml(head)}</div>
          <div class="sheet-text"><div class="sheet-title">${esc(head.title)}</div><span class="chip-label">${esc(head.artist)}</span></div>
        </div>`
      : "";
  menu.innerHTML =
    top +
    items
      .map((it, i) => {
        // The desktop's menus are smaller, with the icons but not the second lines.
        const line = !it.icon
          ? esc(it.label)
          : phone
            ? `${icon(it.icon, 24)}<span>${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</span>`
            : `${icon(it.icon, 18)}<span>${esc(it.label)}</span>`;
        return `${it.divider ? `<hr />` : ""}<button data-i="${i}" class="${it.on ? "on" : ""}">${line}</button>`;
      })
      .join("");
  menu.classList.toggle("sheet", phone);
  menu.hidden = false;
  const { innerWidth: w, innerHeight: h } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, w - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, h - r.height - 8))}px`;
  menu.onclick = (ev) => {
    ev.stopPropagation();
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("button[data-i]");
    if (!btn) return;
    const item = items[Number(btn.dataset.i)];
    if (!item.keep) menu.hidden = true;
    inSubmenu = !!item.keep;
    item.run();
    inSubmenu = false;
  };
}

/** Opens a menu under the button that was clicked. */
function menuUnder(e: MouseEvent, items: MenuItem[]) {
  // Otherwise the document's click handler closes it again at once.
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showMenu(items, r.left, r.bottom + 6);
}

/**
 * Where `tracks` can go: a new playlist or one of the others (not `skip`,
 * the one they come from). Whole lists can also go to Liked songs (`liked`).
 */
function playlistMenu(tracks: Track[], o: { skip?: number; liked?: boolean } = {}): MenuItem[] {
  const skip = o.skip;
  return [
    ...(o.liked ? [{ label: "Liked songs", icon: "heart", run: () => void likeAll(tracks) } satisfies MenuItem] : []),
    { label: "New playlist…", icon: "add", run: () => void newPlaylist(tracks) },
    ...playlists
      .filter((p) => p.id !== skip)
      .map((p, i): MenuItem => ({ label: p.name, icon: "playlist", divider: i === 0, run: () => void addToPlaylist(p.id, tracks) })),
  ];
}

/** Likes every song in `tracks` at once; Undo takes back the new likes. */
async function likeAll(tracks: Track[]) {
  const fresh = tracks.filter((t, i) => !liked.has(t.id) && tracks.findIndex((u) => u.id === t.id) === i);
  if (!fresh.length) return toast("All of these are in Liked songs already");
  try {
    await api.likedSetMany(fresh, true);
  } catch (e) {
    return toast(String(e), "error");
  }
  await reloadLiked();
  toast(`Added ${count(fresh.length, "song")} to Liked songs`, "info", {
    label: "Undo",
    run: () => void api.likedSetMany(fresh, false).then(reloadLiked, (e) => toast(String(e), "error")),
  });
}

/** Reloads liked songs after a change to many, and redraws every heart and list that shows them. */
async function reloadLiked() {
  try {
    const list = await api.likedList();
    liked.clear();
    for (const t of list) liked.set(t.id, t);
  } catch (e) {
    return toast(`Could not load liked songs: ${e}`, "error");
  }
  document.querySelectorAll<HTMLElement>(".track[data-id]").forEach((row) => {
    const b = row.querySelector<HTMLElement>('[data-act="like"]');
    if (!b) return;
    const on = liked.has(row.dataset.id!);
    b.classList.toggle("on", on);
    b.innerHTML = icon(on ? "heartFilled" : "heart", 18);
  });
  updateNowLike();
  renderShortcuts();
  renderPlaylistGrid();
  if (view === "liked") void renderLiked();
}

document.addEventListener("click", (e) => {
  // composedPath still holds elements a click handler has since re-rendered.
  const path = e.composedPath();
  if (!path.includes($("#menu"))) $("#menu").hidden = true;
  if (!path.includes($("#eq-panel")) && !path.includes($("#btn-eq"))) setEqOpen(false);
  const dl = document.getElementById("dl-panel");
  if (dl && !path.includes(dl) && !path.includes($("#dl-chip"))) dl.hidden = true;
});

// ---- views -----------------------------------------------------------------------

/** Opens one of the sidebar views. Back history starts over. */
function setView(v: Exclude<View, "page">) {
  history.length = 0;
  shownDepth = 0;
  show(v, null);
}

/** How many pages deep the last page shown was, to tell opening one from going back. */
let shownDepth = 0;

/** Phones: the playlist whose songs show drag handles ("Change order"), if any. */
let reordering: number | null = null;

/** Phones: shows or hides a playlist's drag handles, opening it if needed. */
function changeOrder(id: number, on: boolean) {
  reordering = on ? id : null;
  if (on && listSorts[`playlist:${id}`]) {
    // Songs only move in the playlist's own order.
    delete listSorts[`playlist:${id}`];
    settings.set("listSorts", listSorts);
  }
  if (page?.kind === "playlist" && page.id === id) refreshPlaylistPage(id);
  else if (on) openPlaylist(id);
}

/** Phones: "Change order" in a playlist's menus (two songs or more). */
function orderItem(id: number, songs: number): MenuItem[] {
  return phone && songs > 1 ? [{ label: "Change order", icon: "drag", sub: "Drag songs to move them", run: () => changeOrder(id, true) }] : [];
}

function show(v: View, p: Page | null, scroll = 0) {
  view = v;
  page = p;
  if (!(p?.kind === "playlist" && p.id === reordering)) reordering = null;
  // On phones the full-screen player covers the page that is about to open.
  setNowPlayingOpen(false);
  if (v !== "page") settings.set("view", v);
  markNav();
  const el = $("#view");
  el.scrollTop = 0;
  el.style.removeProperty("--page-art");
  // Lets phone.css give album, artist and playlist pages a glowing header.
  el.dataset.view = p ? p.kind : v;
  // Phones: a page opened from another slides in from the right, and Back
  // slides the one before in from the left. Tabs fade (bindTabAnimations).
  const dir = Math.sign(history.length - shownDepth);
  shownDepth = history.length;
  if (phone && dir && !calm()) {
    el.animate([{ opacity: 0, transform: `translateX(${dir * 32}px)` }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE });
  }
  if (v === "home") renderHome();
  else if (v === "search") renderSearch();
  else if (v === "library") renderCollection();
  else if (v === "liked") void renderLiked();
  else if (v === "music") void renderMusic();
  else if (v === "downloads") renderDownloads();
  else if (v === "profile") renderProfile();
  else if (v === "settings") renderSettings();
  else if (p) void renderPage(p).then(() => (el.scrollTop = scroll));
  if (v !== "page") requestAnimationFrame(() => (el.scrollTop = scroll));
}

function openPage(p: Page) {
  history.push({ view, page, scroll: $("#view").scrollTop });
  show("page", p);
}

/** Liked songs opens from Library or Home, and Back returns there. */
function openLiked() {
  history.push({ view, page, scroll: $("#view").scrollTop });
  show("liked", null);
}

/** Phones: Your music opens from Library, or by itself once an import starts copying. */
function openMusic() {
  history.push({ view, page, scroll: $("#view").scrollTop });
  show("music", null);
}

/** Settings opens from the gear on Profile (or the sidebar's on the desktop). */
function openSettings() {
  history.push({ view, page, scroll: $("#view").scrollTop });
  show("settings", null);
}

/** Phones: the downloaded songs open from Settings, and Back returns there. */
function openDownloads() {
  history.push({ view, page, scroll: $("#view").scrollTop });
  show("downloads", null);
}

function openTarget(target: string) {
  const p = pageFor(target);
  if (p) openPage(p);
}

function goBack() {
  const prev = history.pop();
  if (!prev) return;
  show(prev.view, prev.page, prev.scroll);
}

function markNav() {
  // A phone tab stays lit on the pages opened from it; Liked songs and Your
  // music belong to Library and Settings to Profile.
  const root = history[0]?.view ?? view;
  const tab = root === "liked" || root === "music" ? "library" : root === "settings" ? "profile" : root;
  // The desktop's sidebar lights what is open: a view, or a playlist, artist or podcast.
  const open = page && "id" in page ? `${page.kind}:${page.id}` : "";
  document.querySelectorAll<HTMLElement>(".nav-item").forEach((b) => {
    const on = b.classList.contains("tab")
      ? tab === b.dataset.view
      : b.dataset.view
        ? view === b.dataset.view
        : b.dataset.pl
          ? open === `playlist:${b.dataset.pl}`
          : !!open && b.dataset.go === open;
    b.classList.toggle("active", on);
  });
}

// ---- phone layout ------------------------------------------------------------------

/** The full-screen player, opened from the bar above the tabs. */
function setNowPlayingOpen(open: boolean, animate = true) {
  const bar = $(".player");
  const isOpen = bar.classList.contains("expanded");
  if (open && phone && !isOpen) {
    // Grown out of the small bar, when it shows and sits still (a radio
    // started from a menu may open the player while the bar slides in).
    const still = !bar.classList.contains("idle") && !bar.getAnimations().length;
    const from = still ? { bar: bar.getBoundingClientRect(), art: $("#now-art").getBoundingClientRect() } : null;
    bar.classList.add("expanded");
    // It opens at the top, with the cards below for the song playing now,
    // drawn once it has opened so the opening stays smooth.
    bar.scrollTop = 0;
    barRects = from;
    growing = animate && from && !calm() ? growPlayer(from, true) : [];
    if (growing.length) void Promise.all(growing.map((a) => a.finished)).then(renderNpInfo, () => {});
    else renderNpInfo();
  } else if (open && isOpen && shrinking) {
    // Opened again while shrinking back: stay open.
    shrinking.forEach((a) => a.cancel());
    shrinking = null;
  } else if (!open && isOpen && !shrinking) {
    const close = () => {
      bar.classList.remove("expanded");
      bar.scrollTop = 0;
    };
    // Closed right after opening: the growing stops where it is.
    growing.forEach((a) => a.cancel());
    growing = [];
    if (!animate || !barRects || calm()) return close();
    const anims = growPlayer(barRects, false);
    shrinking = anims;
    void Promise.all(anims.map((a) => a.finished)).then(
      () => {
        shrinking = null;
        close();
        anims.forEach((a) => a.cancel());
      },
      () => {},
    );
  }
}

/** Where the small bar and its cover were when the player opened, to shrink back into. */
let barRects: { bar: DOMRect; art: DOMRect } | null = null;
/** The player shrinking back into the small bar, while it does. */
let shrinking: Animation[] | null = null;
/** The player growing out of the bar (its last opening's animations). */
let growing: Animation[] = [];

const EASE = "cubic-bezier(0.2, 0, 0, 1)";

/** Android's "Remove animations": nothing moves (phone.css does the same for CSS). */
function calm(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Plays a CSS animation class on `el` again from the start. */
function rerun(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Plays a CSS animation class on `el` once: the class goes when its own
 *  animation ends, so showing `el` again (or redrawing its icon) doesn't replay it. */
function pulse(el: HTMLElement, cls: string) {
  rerun(el, cls);
  const done = (e: AnimationEvent) => {
    if (e.target !== el) return;
    el.classList.remove(cls);
    el.removeEventListener("animationend", done);
    el.removeEventListener("animationcancel", done);
  };
  el.addEventListener("animationend", done);
  el.addEventListener("animationcancel", done);
}

/**
 * The full-screen player grows out of the small bar (or shrinks back into
 * it): it rises from the bar's place, the cover moves and grows from the
 * bar's little one, and the rest fades in once there is room. Only moves and
 * fades, which the phone's graphics chip runs by itself: a growing clip or
 * rounding corners had to be redrawn every frame, and stuttered on phones.
 */
function growPlayer(from: { bar: DOMRect; art: DOMRect }, opening: boolean): Animation[] {
  const bar = $(".player");
  const art = $("#now-art");
  // The player rises from the bar's top edge; the cover's start allows for that.
  const lift = from.bar.top;
  const to = art.getBoundingClientRect();
  const s = from.art.width / to.width;
  const small = `translate(${from.art.left - to.left}px, ${from.art.top - to.top - lift}px) scale(${s})`;
  const order = <T>(closed: T, open: T) => (opening ? [closed, open] : [open, closed]);
  const timing = { duration: opening ? 320 : 260, easing: EASE };
  const anims = [
    bar.animate(order({ transform: `translateY(${lift}px)` }, { transform: "none" }), timing),
    art.animate(order({ transform: small, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }), timing),
  ];
  const rest = bar.querySelectorAll(".np-close, .np-from, .np-more, .now-text, #now-like, #now-dl, .transport, .extras, .np-info");
  const fade = opening ? { duration: 240, delay: 100, easing: EASE, fill: "backwards" as const } : { duration: 120, easing: EASE, fill: "forwards" as const };
  rest.forEach((el) => anims.push(el.animate(order({ opacity: 0 }, { opacity: 1 }), fade)));
  return anims;
}

/** Android's back button: closes whatever is on top. Returns false when
 *  nothing is left to close, and the app then goes to the background. */
function back(): boolean {
  if (!$("#dialog").hidden) $<HTMLButtonElement>("#dialog-form [data-cancel]")?.click();
  else if (!$("#menu").hidden) $("#menu").hidden = true;
  else if (document.getElementById("dl-panel")?.hidden === false) $("#dl-panel").hidden = true;
  else if (!$("#eq-panel").hidden) setEqOpen(false);
  else if (side) setSidePanel(null);
  else if ($(".player").classList.contains("expanded")) setNowPlayingOpen(false);
  else if (reordering !== null) changeOrder(reordering, false);
  else if (history.length) goBack();
  else if (view !== startView) setView(startView);
  else return false;
  return true;
}

// ---- swipes (phones) ---------------------------------------------------------------

/** When the last swipe ended; the tap the browser may still send is ignored. */
let swipedAt = 0;

function justSwiped(): boolean {
  return performance.now() - swipedAt < 400;
}

/**
 * Follows sideways swipes on `el` by touch, leaving up-and-down moves to
 * scrolling (the element needs `touch-action: pan-y`). `begin` decides
 * whether a touch may swipe; `end` gets the distance and the finger's speed
 * in px/ms when it lifts.
 */
function onSwipe(
  el: HTMLElement,
  o: { begin: (e: PointerEvent) => boolean; move: (dx: number) => void; end: (dx: number, speed: number) => void },
) {
  let s: { id: number; x: number; y: number; on: boolean; lastX: number; lastT: number; speed: number } | null = null;
  el.onpointerdown = (e) => {
    s = null;
    if (e.pointerType === "touch" && o.begin(e)) {
      s = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, lastX: e.clientX, lastT: e.timeStamp, speed: 0 };
    }
  };
  el.onpointermove = (e) => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.on) {
      // Only a clearly sideways move is a swipe; a slightly slanted scroll
      // must not tug rows or the player sideways.
      if (Math.abs(dy) * 1.8 >= Math.abs(dx)) {
        if (Math.abs(dy) > 10) s = null;
        return;
      }
      if (Math.abs(dx) < 16) return;
      s.on = true;
      // A long press opens the song's menu; sliding on means a swipe instead.
      $("#menu").hidden = true;
    }
    if (e.timeStamp > s.lastT) s.speed = (e.clientX - s.lastX) / (e.timeStamp - s.lastT);
    s.lastX = e.clientX;
    s.lastT = e.timeStamp;
    o.move(dx);
  };
  const finish = (e: PointerEvent, cancelled: boolean) => {
    if (!s || e.pointerId !== s.id) return;
    if (s.on) {
      swipedAt = performance.now();
      o.end(cancelled ? 0 : e.clientX - s.x, cancelled ? 0 : s.speed);
    }
    s = null;
  };
  el.onpointerup = (e) => finish(e, false);
  el.onpointercancel = (e) => finish(e, true);
}

/** What a swipe on a song does, as shown in the strip it uncovers. */
interface SwipeAction {
  label: string;
  icon: IconName;
}

/** Swiping a song right queues it, in every list. */
const QUEUE_SWIPE: SwipeAction = { label: "Add to queue", icon: "queue" };

/** How far a song must be swiped for its action to happen. */
const SWIPE_MARK = 96;

/** Moves a song row with the finger over a strip that shows what letting go does. */
function swipeRow(row: HTMLElement, dx: number, action: SwipeAction) {
  const side = dx < 0 ? "left" : "right";
  if (row.dataset.swipe !== side) {
    row.querySelector(".swipe-hint")?.remove();
    row.dataset.swipe = side;
    row.classList.add("swiping");
    row.insertAdjacentHTML("afterbegin", `<div class="swipe-hint ${side}">${icon(action.icon, 22)}<span>${esc(action.label)}</span></div>`);
  }
  // Past the mark the row keeps following, but more slowly.
  const d = Math.abs(dx);
  const x = d <= SWIPE_MARK ? d : SWIPE_MARK + (d - SWIPE_MARK) * 0.3;
  row.style.setProperty("--swipe-x", `${Math.sign(dx) * x}px`);
  row.style.setProperty("--swipe-w", `${x}px`);
  const armed = d >= SWIPE_MARK;
  if (armed !== row.classList.contains("armed")) {
    row.classList.toggle("armed", armed);
    if (armed) navigator.vibrate?.(12);
  }
}

function settleRow(row: HTMLElement) {
  row.classList.add("settling");
  row.style.setProperty("--swipe-x", "0px");
  row.style.setProperty("--swipe-w", "0px");
  setTimeout(() => {
    row.classList.remove("swiping", "armed", "settling");
    row.querySelector(".swipe-hint")?.remove();
    delete row.dataset.swipe;
    row.style.removeProperty("--swipe-x");
    row.style.removeProperty("--swipe-w");
  }, 200);
}

/** Slides the song in the player bar to `x`; resolves when it gets there. */
function slideNow(x: number): Promise<void> {
  const now = $(".now");
  now.classList.add("settling");
  now.style.setProperty("--swipe-x", `${x}px`);
  return new Promise((done) =>
    setTimeout(() => {
      now.classList.remove("settling");
      done();
    }, 180),
  );
}

/**
 * Swiping the song in the player bar (or the big cover) skips, as in Spotify:
 * left for the next song, right for the one before. The song slides out and
 * the new one slides in from the other side.
 */
function bindSwipeToSkip() {
  const now = $(".now");
  onSwipe(now, {
    // A swipe may start on the bar's buttons too; a moving finger doesn't tap them.
    begin: () => !!player.current,
    move: (dx) => now.style.setProperty("--swipe-x", `${dx}px`),
    end: (dx, speed) => {
      const forward = dx < 0;
      const w = now.offsetWidth;
      const far = Math.abs(dx) > w * 0.3 || (Math.abs(speed) > 0.6 && speed < 0 === forward);
      const possible = forward ? player.upcomingIndex() >= 0 : player.hasPrevious;
      if (!dx || !far || !possible) return void slideNow(0);
      void slideNow(forward ? -w : w).then(() => {
        if (forward) player.next();
        else player.prev(false);
        now.style.setProperty("--swipe-x", `${forward ? w / 2 : -w / 2}px`);
        void now.offsetWidth;
        void slideNow(0);
      });
    },
  });
}

/**
 * Dragging the open player down closes it, when it is scrolled to the top
 * (further down, the finger scrolls back up). It follows the finger until it
 * is let go, then closes if it went down far enough (or was flung), or
 * springs back. Touch events, not pointer ones: only a cancelled touchmove
 * keeps the page from scrolling instead.
 */
function bindDragToClose() {
  const bar = $(".player");
  let drag: { x: number; y: number; on: boolean; lastY: number; lastT: number; speed: number } | null = null;
  bar.addEventListener(
    "touchstart",
    (e) => {
      drag = null;
      if (!bar.classList.contains("expanded") || shrinking || e.touches.length > 1 || bar.scrollTop > 0) return;
      if ((e.target as HTMLElement).closest("button, input, .extras")) return;
      const t = e.touches[0];
      drag = { x: t.clientX, y: t.clientY, on: false, lastY: t.clientY, lastT: e.timeStamp, speed: 0 };
    },
    { passive: true },
  );
  bar.addEventListener(
    "touchmove",
    (e) => {
      if (!drag) return;
      const t = e.touches[0];
      const dx = t.clientX - drag.x;
      const dy = t.clientY - drag.y;
      if (!drag.on) {
        // Up scrolls to the cards below; sideways is the cover's swipe to skip.
        if (dy < 0 || (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy))) {
          drag = null;
          return;
        }
        // Held from the first clear move down, or the page would start
        // scrolling; a finger's wobble of a pixel or two is let through.
        if (dy >= 3 && e.cancelable) e.preventDefault();
        if (dy < 10) return;
        drag.on = true;
      }
      if (e.cancelable) e.preventDefault();
      if (e.timeStamp > drag.lastT) drag.speed = (t.clientY - drag.lastY) / (e.timeStamp - drag.lastT);
      drag.lastY = t.clientY;
      drag.lastT = e.timeStamp;
      bar.style.translate = `0 ${Math.max(0, dy)}px`;
    },
    { passive: false },
  );
  const end = (e: TouchEvent) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.on) return;
    swipedAt = performance.now();
    const y = e.changedTouches[0]?.clientY ?? d.lastY;
    const close = e.type === "touchend" && (y - d.y > bar.offsetHeight * 0.3 || d.speed > 0.6);
    bar.classList.add("settling");
    bar.style.translate = close ? `0 ${bar.offsetHeight}px` : "";
    setTimeout(
      () => {
        bar.classList.remove("settling");
        bar.style.translate = "";
        // It has already slid away; no shrinking back into the bar.
        if (close) setNowPlayingOpen(false, false);
      },
      close ? 240 : 200,
    );
  };
  bar.addEventListener("touchend", end);
  bar.addEventListener("touchcancel", end);
}

/** Home: pulling the page down brings new recommendations. */
function bindPullToRefresh() {
  const el = $("#view");
  const ring = document.createElement("div");
  ring.className = "pull";
  ring.innerHTML = spinner(26);
  document.body.append(ring);
  const arc = ring.querySelector("path")!;
  const ARMED = 72;
  let start: number | null = null;
  let pulled = 0;
  const show = (px: number) => {
    ring.classList.toggle("on", px > 0);
    ring.style.translate = `-50% ${Math.min(px, ARMED + 24) - 52}px`;
    // The red arc fills as you pull; it is progress, so the accent rule holds.
    const turn = Math.min(px / ARMED, 0.999) * 2 * Math.PI;
    arc.setAttribute("d", `M12 4A8 8 0 ${turn > Math.PI ? 1 : 0} 1 ${12 + 8 * Math.sin(turn)} ${12 - 8 * Math.cos(turn)}`);
  };
  el.addEventListener(
    "touchstart",
    (e) => {
      const ready = view === "home" && recs.state !== "loading" && el.scrollTop <= 0;
      start = ready ? e.touches[0].clientY : null;
      pulled = 0;
    },
    { passive: true },
  );
  el.addEventListener(
    "touchmove",
    (e) => {
      if (start === null) return;
      const was = pulled;
      pulled = el.scrollTop > 0 ? 0 : Math.max(0, (e.touches[0].clientY - start) * 0.5);
      if (was < ARMED && pulled >= ARMED) navigator.vibrate?.(12);
      show(pulled);
    },
    { passive: true },
  );
  el.addEventListener("touchend", () => {
    if (start === null) return;
    start = null;
    if (pulled >= ARMED) void loadRecommendations();
    show(0);
  });
}

/** What both layouts share: Autoplay, playlist menus, offline lists, the sleep timer and queue tools. */
function bindCommon() {
  player.autoplay = settings.get("autoplay", true);
  bindPlaylistHold();
  // Songs that can't play without internet dim, and lists say so.
  const reconnect = () => {
    if (view === "liked") void renderLiked();
    else if (page?.kind === "playlist") void renderPage(page);
    else if (view === "search") renderResults();
    else if (view === "home") renderRecs();
  };
  window.addEventListener("online", reconnect);
  window.addEventListener("offline", reconnect);
  player.addEventListener("time", checkSleep);
  player.addEventListener("state", checkSleep);
  bindQueueTools();
  $("#np-more").onclick = (e) => player.current && openMenu(e, player.current, [sleepItem()]);
  $("#now-dl").onclick = () => {
    const t = player.current;
    if (t) void (downloads.has(t.id) ? removeDownload(t) : downloadTracks([t]));
  };
  document.querySelectorAll<HTMLElement>("[data-close-panel]").forEach((b) => (b.onclick = () => setSidePanel(null)));
}

const OUTPUTS: Record<AudioOutput["kind"], { label: string; icon: IconName }> = {
  phone: { label: "This phone", icon: "phone" },
  bluetooth: { label: "Bluetooth", icon: "bluetooth" },
  headphones: { label: "Headphones", icon: "headphones" },
  speaker: { label: "Speaker", icon: "speaker" },
};

/**
 * Shows where the music plays. Somewhere else than the phone, its name goes
 * in red under the song in the small bar (like Spotify), and the devices
 * icon in the full-screen player's bottom row turns red with the name beside it.
 */
function showOutput(out: AudioOutput) {
  const kind = OUTPUTS[out.kind] ?? OUTPUTS.speaker;
  const away = out.kind !== "phone";
  const name = esc(out.name || kind.label);
  const device = $("#now-device");
  device.hidden = !away;
  device.innerHTML = away ? `${icon(kind.icon, 14)}<span>${name}</span>` : "";
  device.parentElement!.classList.toggle("away", away);
  for (const id of ["#now-out", "#np-out"]) {
    const button = $(id);
    button.hidden = false;
    button.classList.toggle("away", away);
    button.title = `Playing on ${out.name || kind.label.toLowerCase()}`;
  }
  $("#np-out").innerHTML = icon("devices", 24) + (away ? `<span>${name}</span>` : "");
}

function bindPhone() {
  if (!phone) return;
  (window as unknown as { __cadenceBack: () => boolean }).__cadenceBack = back;
  setFloatNav(floatNav());
  bindTabAnimations();
  // The page draws behind the navigation bar; its bottom parts pad by its height.
  const navBar = (px: number) => document.documentElement.style.setProperty("--nav-bottom", `${px}px`);
  (window as unknown as { __cadenceInsets: (px: number) => void }).__cadenceInsets = navBar;
  void api.navBarHeight().then(navBar, () => {});
  // A shared link tapped while Cadence runs.
  (window as unknown as { __cadenceLink: () => void }).__cadenceLink = () => void openSharedLink();
  // Where the music plays (Outputs.kt): its name under the song, and a
  // button that opens Android's panel to pick another place.
  // A change pushed before the first answer arrives is the newer one.
  let pushed = false;
  (window as unknown as { __cadenceOutput: (out: AudioOutput) => void }).__cadenceOutput = (out) => {
    pushed = true;
    showOutput(out);
  };
  void api.audioOutput().then((out) => out && !pushed && showOutput(out), () => {});
  $("#now-out").onclick = $("#np-out").onclick = () => void api.pickAudioOutput().catch((e) => toast(String(e), "error"));
  // Tapping the bar (anywhere but its buttons) opens the full-screen player.
  // A tap on the artist or album in the full-screen player has just closed
  // it to show their page; that tap must not open it again.
  $(".player").addEventListener("click", (e) => {
    const bar = $(".player");
    const on = e.target as HTMLElement;
    if (!bar.classList.contains("expanded") && !on.closest("button, [data-go]") && !justSwiped()) {
      setNowPlayingOpen(true);
    }
  });
  bindSwipeToSkip();
  bindDragToClose();
  bindNpInfo();
  bindPullToRefresh();
  $(".brand").innerHTML = `${mark(28)}<span>cadence</span>`;
  $("#queue-panel h2").textContent = "Queue";
  $("#np-close").onclick = () => setNowPlayingOpen(false);
  $("#q-play").onclick = () => player.toggle();
  $("#q-prev").onclick = () => player.prev();
  $("#q-next").onclick = () => player.next();
  bindMediaControls();
}

/**
 * Holding a playlist in Library or on Home (right-clicking it on the desktop,
 * in the sidebar too) offers to play it, copy
 * its songs to another playlist or to Liked songs, rename or delete it.
 * Holding Liked songs offers to play it or copy it to a playlist.
 */
function bindPlaylistHold() {
  const hold = (e: MouseEvent) => {
    const artist = (e.target as HTMLElement).closest<HTMLElement>('.pl-tile[data-go^="artist:"], .nav-item.pl[data-go^="artist:"]');
    const followed = following.find((a) => `artist:${a.id}` === artist?.dataset.go);
    if (followed) {
      e.preventDefault();
      navigator.vibrate?.(12);
      return showMenu(
        [
          { label: "Open", icon: "person", run: () => openTarget(`artist:${followed.id}`) },
          { label: "Unfollow", icon: "close", run: () => setFollow(followed, false) },
        ],
        e.clientX,
        e.clientY,
      );
    }
    const target = (e.target as HTMLElement).closest<HTMLElement>(
      '.pl-tile[data-go^="playlist:"], .shortcut[data-go^="playlist:"], .pl-tile[data-liked], .shortcut[data-liked], .nav-item.pl[data-pl], .nav-item.pl[data-view="liked"]',
    );
    if (!target) return;
    const go = target.dataset.go ?? (target.dataset.pl ? `playlist:${target.dataset.pl}` : "");
    const pl = playlists.find((p) => `playlist:${p.id}` === go);
    if (!pl && !target.matches('[data-liked], [data-view="liked"]')) return;
    e.preventDefault();
    navigator.vibrate?.(12);
    const name = pl?.name ?? "Liked songs";
    const songs = async () => (pl ? (await api.playlist(pl.id)).tracks : [...liked.values()]);
    const withSongs = (fn: (tracks: Track[]) => void) => () =>
      void songs().then((tracks) => (tracks.length ? fn(tracks) : toast(`${name} is empty`)), (err) => toast(String(err), "error"));
    const play = (shuffle: boolean) => withSongs((tracks) => (shuffle ? shuffleList(tracks, name) : playFromTop(tracks, name)));
    showMenu(
      [
      { label: "Play", icon: "play", run: play(false) },
      { label: "Shuffle", icon: "shuffle", run: play(true) },
      { label: "Start radio", icon: "radio", run: withSongs((tracks) => void startRadio(tracks, `${name} radio`)) },
      ...(pl ? [pinItem(pl.id)] : []),
      {
        label: pl ? "Add all to…" : "Add all to a playlist…",
        icon: "playlistAdd",
        divider: true,
        keep: true,
        run: withSongs((tracks) => showMenu(playlistMenu(tracks, { skip: pl?.id, liked: !!pl }))),
      },
      ...(pl
        ? [
            { label: "Share", icon: "share", run: withSongs((tracks) => shareTracks(pl.name, tracks)) } satisfies MenuItem,
            autoItem(pl.id),
            ...orderItem(pl.id, pl.count),
            { label: "Rename…", icon: "edit", divider: true, run: () => void renamePlaylist(pl.id, pl.name) } satisfies MenuItem,
            ...coverItems(pl.id, !!pl.thumbnail?.startsWith("pcover/")),
            { label: "Delete playlist", icon: "trash", run: () => void deletePlaylist(pl.id, pl.name) } satisfies MenuItem,
          ]
        : []),
      ],
      e.clientX,
      e.clientY,
    );
  };
  $("#view").addEventListener("contextmenu", hold);
  $("#playlists").addEventListener("contextmenu", hold);
}

/** Spotify-style tabs: a tapped icon gives a little and springs back, and the page fades in. */
function bindTabAnimations() {
  let settle: number | undefined;
  document.querySelectorAll<HTMLElement>(".tabbar .tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      rerun(tab, "tapped");
      const v = $("#view");
      rerun(v, "entering");
      // Only the page the tab opens fades in, not later redraws of it.
      clearTimeout(settle);
      settle = window.setTimeout(() => v.classList.remove("entering"), 400);
    }),
  );
}

// ---- lock screen and notification controls (Android) -------------------------------

/** Where the controls last saw the song, to notice seeks between updates. */
let mediaSent = { position: 0, at: 0, playing: false };

function sendMediaState() {
  const t = player.current;
  const a = player.audio;
  mediaSent = { position: a.currentTime, at: performance.now(), playing: player.playing };
  void api
    .mediaState({
      active: !!t,
      title: t?.title ?? "",
      artist: t?.artist ?? "",
      album: t?.album ?? null,
      art: t?.thumbnail?.startsWith("https://") || t?.thumbnail?.startsWith("cover/") ? t.thumbnail : null,
      duration: isFinite(a.duration) ? a.duration : (t?.duration ?? null),
      position: a.currentTime,
      playing: player.playing,
    })
    .catch((e) => console.error("media controls:", e));
}

function bindMediaControls() {
  // The controls move their position bar on their own; only songs, play and
  // pause, and jumps (a seek) need telling.
  player.addEventListener("track", sendMediaState);
  player.addEventListener("state", sendMediaState);
  player.addEventListener("time", () => {
    const expected = mediaSent.position + (mediaSent.playing ? (performance.now() - mediaSent.at) / 1000 : 0);
    if (Math.abs(player.audio.currentTime - expected) > 2) sendMediaState();
  });
  (window as unknown as { __cadenceMedia: (command: string, arg: number | string | null) => void }).__cadenceMedia = (command, arg) => {
    if (command === "play") player.play();
    else if (command === "pause") player.pause();
    else if (command === "next") player.next();
    else if (command === "prev") player.prev();
    else if (command === "seek" && typeof arg === "number") player.seek(arg);
    else if (command === "playItem" && typeof arg === "string") void playFromCar(arg);
    else if (command === "playSearch" && typeof arg === "string") void playSearch(arg);
  };
}

/**
 * Android Auto: plays a song picked from the library it lists
 * (CadenceBrowser.kt), and the rest of its list after it. `item` reads
 * "liked/<place>/<track id>" or "pl:<playlist id>/<place>/<track id>".
 */
async function playFromCar(item: string) {
  const [list, place, ...rest] = item.split("/");
  const id = rest.join("/");
  const playlistId = list.startsWith("pl:") ? Number(list.slice(3)) : null;
  const tracks = playlistId !== null ? (await api.playlist(playlistId).catch(() => null))?.tracks : [...liked.values()];
  if (!tracks?.length) return;
  // The place, unless the list changed since the car read it.
  const at = tracks[Number(place)]?.id === id ? Number(place) : Math.max(0, tracks.findIndex((t) => t.id === id));
  const from = playlistId !== null ? (playlists.find((p) => p.id === playlistId)?.name ?? "Playlist") : "Liked songs";
  player.playList(tracks, at, from);
}

/** Android Auto by voice ("play … on Cadence"): the best match, then songs like it. */
async function playSearch(query: string) {
  const [first] = query.trim() ? await api.search(query).catch(() => [] as Track[]) : [...liked.values()];
  if (first) player.playList([first], 0, query.trim() ? `“${query.trim()}”` : "Liked songs");
}

// ---- Home and Library -----------------------------------------------------------

function renderHome() {
  $("#view").innerHTML = `
    <header class="view-head">
      <div class="brand-row">${mark(28)}<span>cadence</span></div>
      <h1>Home</h1>
    </header>
    <div class="shortcuts" id="home-shortcuts"></div>
    <div id="home-mixes"></div>
    <div id="home-episodes"></div>
    <div id="home-new"></div>
    <div id="home-recs"></div>`;
  $("#home-shortcuts").onclick = (e) => {
    if ((e.target as HTMLElement).closest("[data-liked]")) openLiked();
  };
  renderShortcuts();
  void renderMixes();
  void renderNewEpisodes();
  void renderNewReleases();
  renderRecs();
}

function playlistArt(p: PlaylistInfo, size: number): string {
  return p.thumbnail ? `<img src="${esc(imgUrl(p.thumbnail))}" alt="" draggable="false" />` : icon("playlist", size);
}

/** Home's top grid: Liked songs and the playlists, a tap away. */
function renderShortcuts() {
  const el = document.getElementById("home-shortcuts");
  if (!el) return;
  const items = [
    ...(liked.size ? [`<button class="shortcut" data-liked><span class="sc-art"><span class="liked-art">${icon("heartFilled", 22)}</span></span><span class="sc-name">Liked songs</span></button>`] : []),
    ...playlists.map(
      (p) => `<button class="shortcut" data-go="playlist:${p.id}"><span class="sc-art">${playlistArt(p, 22)}</span><span class="sc-name">${esc(p.name)}</span></button>`,
    ),
  ].slice(0, 8);
  el.innerHTML = items.join("");
  el.hidden = !items.length;
}

/** Liked songs and every playlist, as a grid of covers. */
function renderCollection() {
  $("#view").innerHTML = `
    <header class="view-head">
      <div class="head-row">
        <h1>Library</h1>
        <button class="icon-btn" id="lib-new" title="New playlist or import">${icon("add", 24)}</button>
      </div>
    </header>
    <div class="pl-grid" id="pl-grid"></div>`;
  $("#lib-new").onclick = playlistNewMenu;
  $("#pl-grid").onclick = (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("[data-liked]")) openLiked();
    else if (el.closest("[data-music]")) openMusic();
    else if (el.closest("#pl-new-tile")) playlistNewMenu(e);
  };
  renderPlaylistGrid();
}

/** Library's grid, and the desktop's sidebar, which lists the same. */
function renderPlaylistGrid() {
  renderSidebar();
  const el = document.getElementById("pl-grid");
  if (!el) return;
  const tile = (attrs: string, art: string, name: string, sub: string, kind = "") =>
    `<button class="pl-tile ${kind}" ${attrs}><span class="pl-art">${art}</span><span class="pl-name">${name}</span><span class="pl-sub">${sub}</span></button>`;
  el.innerHTML = [
    tile("data-liked", `<span class="liked-art">${icon("heartFilled", 40)}</span>`, "Liked songs", count(liked.size, "song")),
    ...(musicCount ? [tile("data-music", `<span class="liked-art music-art">${icon("music", 40)}</span>`, "Your music", count(musicCount, "song"))] : []),
    ...playlists.map((p) =>
      tile(`data-go="playlist:${p.id}"`, playlistArt(p, 36), esc(p.name), (pinned.includes(p.id) ? icon("pin", 13) : "") + count(p.count, "song")),
    ),
    ...following.map((a) =>
      tile(`data-go="artist:${esc(a.id)}"`, a.thumbnail ? `<img src="${esc(imgUrl(a.thumbnail))}" alt="" draggable="false" />` : icon("person", 36), esc(a.name), "Artist", "artist"),
    ),
    ...followedShows.map((s) =>
      tile(`data-go="podcast:${esc(s.id)}"`, s.artwork ? `<img src="${esc(imgUrl(s.artwork))}" alt="" draggable="false" />` : icon("podcast", 36), esc(s.title), "Podcast", "podcast"),
    ),
    `<button class="pl-tile pl-new" id="pl-new-tile"><span class="pl-art">${icon("add", 32)}</span><span class="pl-name">New playlist</span></button>`,
  ].join("");
}

function renderSearch() {
  $("#view").innerHTML = `
    <header class="view-head">
      <h1>Search</h1>
      <label class="search-box">${icon("search", 20)}
        <input id="q" type="search" placeholder="Songs, artists, podcasts" spellcheck="false" autocomplete="off" />
        <button class="search-clear" id="q-clear" type="button" title="Clear search" hidden>${icon("close", 20)}</button>
      </label>
    </header>
    <div id="engine-banner"></div>
    <div id="search-tabs"></div>
    <div id="search-top"></div>
    <div id="results" class="track-list"></div>`;
  const input = $<HTMLInputElement>("#q");
  const clear = $("#q-clear");
  input.value = search.query;
  clear.hidden = !input.value;
  const run = debounce((q: string) => void doSearch(q), 350);
  input.addEventListener("input", () => {
    clear.hidden = !input.value;
    run(input.value);
  });
  clear.onclick = () => {
    input.value = "";
    clear.hidden = true;
    input.focus();
    void doSearch("");
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doSearch(input.value);
  });
  // Phones would pop up the keyboard on every visit.
  if (!phone) input.focus();
  renderEngineBanner();
  renderResults();
}

async function doSearch(q: string) {
  q = q.trim();
  if (q === search.query && search.results.length) return;
  // A Cadence, YouTube or YouTube Music link opens what it links to.
  if (/^https?:\/\//i.test(q)) {
    const item = await api.openLink(q).catch(() => null);
    if (item) return void openShared(item);
  }
  search.query = q;
  search.error = "";
  const token = ++search.token;
  search.pages = null;
  search.shows = null;
  if (!q) {
    search.results = [];
    return renderResults();
  }
  search.loading = true;
  renderResults();
  // Artists, albums and podcasts are found too, shown under their own tabs.
  const none: SearchPages = { artists: [], albums: [] };
  void api.searchPages(q).then(
    (pages) => token === search.token && ((search.pages = pages), renderResults()),
    () => token === search.token && ((search.pages = none), renderResults()),
  );
  void api.podcastSearch(q).then(
    (shows) => token === search.token && ((search.shows = shows), renderResults()),
    () => token === search.token && ((search.shows = []), renderResults()),
  );
  // As in Spotify, your own songs that match come first (liked, downloaded,
  // in playlists, played a lot, your own files), offline too.
  const mine = yourMatches(q);
  try {
    const results = await api.search(q);
    const own = await mine;
    if (token !== search.token) return;
    const ownIds = new Set(own.map((t) => t.id));
    search.results = [...own, ...results.filter((t) => !ownIds.has(t.id))];
    // The top result is the most likely pick; get it ready.
    if (results[0]) player.warm(results[0]);
  } catch (e) {
    const own = await mine;
    if (token !== search.token) return;
    search.results = own;
    if (!own.length) search.error = String(e);
  }
  search.loading = false;
  renderResults();
}

const SEARCH_TABS: { id: SearchTab; name: string }[] = [
  { id: "songs", name: "Songs" },
  { id: "artists", name: "Artists" },
  { id: "albums", name: "Albums" },
  { id: "podcasts", name: "Podcasts" },
];

/** Songs, Artists, Albums and Podcasts, with the red pill on the one shown. */
function renderSearchTabs() {
  const el = document.getElementById("search-tabs");
  if (!el) return;
  if (!search.query) return void (el.innerHTML = "");
  if (!el.firstElementChild) {
    el.innerHTML = `<div class="period search-tabs" role="tablist" style="--n: ${SEARCH_TABS.length}">
      <i class="period-pill"></i>
      ${SEARCH_TABS.map((t) => `<button role="tab" data-tab="${t.id}">${t.name}</button>`).join("")}
    </div>`;
    el.onclick = (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab as SearchTab | undefined;
      if (!tab || tab === search.tab) return;
      search.tab = tab;
      renderResults();
      $("#view").scrollTop = 0;
    };
  }
  const i = SEARCH_TABS.findIndex((t) => t.id === search.tab);
  el.querySelector<HTMLElement>(".period")!.style.setProperty("--i", String(i));
  el.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String((b as HTMLElement).dataset.tab === search.tab)));
}

/** Letters and digits only, for comparing names ("Beyoncé" finds "beyonce"). */
function plain(s: string): string {
  return s.normalize("NFD").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/** Your songs that match a search: liked, downloaded, in playlists, played,
 *  then your own files (imported on a phone, in music folders on the desktop). */
async function yourMatches(q: string): Promise<Track[]> {
  const [saved, files] = await Promise.all([
    api.yourSongs(q, 6).catch(() => [] as Track[]),
    musicCount ? api.libraryTracks(q).then((t) => t.slice(0, 3), () => [] as Track[]) : Promise.resolve([] as Track[]),
  ]);
  const seen = new Set<string>();
  return [...saved, ...files].filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 6);
}

/** Whether a name is what the search asks for (or the search names it). */
function named(name: string): boolean {
  const n = plain(name);
  const q = plain(search.query);
  return n.length >= 3 && (q.includes(n) || (q.length >= 3 && n.startsWith(q)));
}

/** Songs tab: an artist you follow or the artist the search names,
 *  as Spotify's top result, then your playlists whose name matches. */
function renderTopArtist() {
  const el = document.getElementById("search-top");
  if (!el) return;
  if (!search.query || search.tab !== "songs") return void (el.innerHTML = "");
  const yours = following.find((a) => named(a.name));
  const top = search.pages?.artists[0];
  const artist = yours ?? (top && plain(search.query).includes(plain(top.name)) && plain(top.name).length >= 3 ? top : null);
  const q = plain(search.query);
  const lists = playlists.filter((p) => q.length >= 2 && plain(p.name).includes(q)).slice(0, 3);
  const artistRow = artist ? [{ target: `artist:${artist.id}`, art: artist.thumbnail, title: artist.name, sub: yours ? "Artist · Following" : "Artist", round: true }] : [];
  const listRows = lists.map((p) => ({ target: `playlist:${p.id}`, art: p.thumbnail, title: p.name, sub: `Your playlist · ${count(p.count, "song")}` }));
  // Yours first: an artist you follow, your playlists, then any other artist.
  el.innerHTML = pageRows(yours ? [...artistRow, ...listRows] : [...listRows, ...artistRow]);
}

/** Rows that each open an artist or album page. */
function pageRows(rows: { target: string; art: string | null; title: string; sub: string; round?: boolean }[]): string {
  return rows
    .map(
      (r) => `<button class="page-row" data-go="${esc(r.target)}">
        <span class="page-row-art ${r.round ? "round" : ""}">${r.art ? `<img src="${esc(imgUrl(r.art))}" alt="" loading="lazy" draggable="false" />` : icon(r.round ? "person" : "album", 22)}</span>
        <span class="page-row-text"><b>${esc(r.title)}</b><small>${esc(r.sub)}</small></span>
        ${icon("chevronRight", 20)}
      </button>`,
    )
    .join("");
}

/** Artists, Albums and Podcasts tabs. */
function renderPageResults(el: HTMLElement) {
  // The song list's paging must not add songs here.
  loadMoreRows = null;
  if (search.tab === "podcasts") {
    // Podcasts you follow come first, as in Spotify.
    const yours = followedShows.filter((s) => named(s.title));
    const shows = search.shows && [...yours, ...search.shows.filter((s) => !yours.some((y) => y.id === s.id))];
    if (!shows) return void (el.innerHTML = loadingRows(6));
    const rows = shows.map((s) => ({ target: `podcast:${s.id}`, art: s.artwork, title: s.title, sub: s.author ? `Podcast · ${s.author}` : "Podcast" }));
    el.innerHTML = rows.length ? pageRows(rows) : emptyState("podcast", "No results", `No podcasts matched “${esc(search.query)}”.`);
    return;
  }
  const pages = search.pages;
  if (!pages) return void (el.innerHTML = loadingRows(6));
  const rows =
    search.tab === "artists"
      ? [...following.filter((a) => named(a.name)), ...pages.artists.filter((a) => !following.some((f) => f.id === a.id && named(f.name)))].map((a) => ({ target: `artist:${a.id}`, art: a.thumbnail, title: a.name, sub: "Artist", round: true }))
      : pages.albums.map((a) => ({ target: `album:${a.id}`, art: a.thumbnail, title: a.title, sub: [a.artist, a.year].filter(Boolean).join(" · ") }));
  el.innerHTML = rows.length ? pageRows(rows) : emptyState("search", "No results", `No ${search.tab} matched “${esc(search.query)}”.`);
}

function renderResults() {
  const el = document.getElementById("results");
  if (!el) return;
  renderSearchTabs();
  renderTopArtist();
  if (search.query && search.tab !== "songs") {
    renderPageResults(el);
  } else if (search.loading && !search.results.length) {
    el.innerHTML = loadingRows(8);
  } else if (search.error) {
    el.innerHTML = emptyState("search", "Search failed", esc(search.error));
  } else if (!search.query) {
    // Recommendations are on Home.
    renderBrowse(el);
  } else if (!search.results.length) {
    el.innerHTML = noResults(search.query);
    el.querySelector<HTMLElement>("[data-try]")?.addEventListener("click", (e) => {
      const q = (e.currentTarget as HTMLElement).dataset.try!;
      $<HTMLInputElement>("#q").value = q;
      void doSearch(q);
    });
  } else {
    // The song picked plays, then songs like it, as in Spotify.
    mountTrackList(el, search.results, { from: `“${search.query}”`, onPlay: rememberSearch, single: true });
  }
  el.classList.toggle("dim", search.loading && search.results.length > 0 && search.tab === "songs");
}

// ---- search history ---------------------------------------------------------------

/** Songs played from search results, newest first. */
let recentSearches = settings.get<Track[]>("recentSearches", []);

function setRecentSearches(tracks: Track[]) {
  recentSearches = tracks;
  settings.set("recentSearches", tracks);
  if (view === "search" && !search.query) renderResults();
}

function rememberSearch(track: Track) {
  recentSearches = [track, ...recentSearches.filter((t) => t.id !== track.id)].slice(0, 20);
  settings.set("recentSearches", recentSearches);
}

// ---- Explore: charts, new releases, moods and genres --------------------------------

/**
 * Search's Explore, from YouTube Music, kept for the day. `country` is the one
 * picked for the charts; null is where the phone is.
 */
let explore = settings.get<{ day: string; country: string | null; data: Explore | null }>("explore", { day: "", country: null, data: null });
let exploring = false;
let exploreError = "";

/** An Explore card: a chart or mood playlist, or a new album or single. */
function cardItem(c: Card) {
  return { target: c.id.startsWith("MPRE") ? `album:${c.id}` : `ytlist:${c.id}`, art: imgUrl(c.thumbnail), title: c.title, sub: c.sub };
}

/** YouTube Music's tile colors are light; white text needs them darker. */
function moodColor(color: string | null): string {
  return `color-mix(in oklab, ${color ?? "oklch(0.55 0.1 265)"} 58%, black)`;
}

/** With nothing typed: recent searches, then Explore. */
function renderBrowse(el: HTMLElement) {
  const recent = recentSearches;
  el.innerHTML = `${
    recent.length
      ? `<div class="browse-head"><h2>Recent searches</h2><button class="text-btn" id="recent-clear">Clear all</button></div>
        <div class="track-list" id="recent-list"></div>`
      : ""
  }
    <div id="explore"></div>`;
  if (recent.length) {
    const forget = (i: number) => setRecentSearches(recentSearches.filter((t) => t.id !== recent[i].id));
    mountTrackList($("#recent-list"), recent, {
      from: "Recent searches",
      single: true,
      remove: { title: "Remove from recent searches", run: forget },
      swipeLeft: { label: "Remove", icon: "close", run: forget },
    });
    $("#recent-clear").onclick = () => {
      setRecentSearches([]);
      toast("Recent searches cleared", "info", { label: "Undo", run: () => setRecentSearches(recent) });
    };
  }
  drawExplore();
  void loadExplore();
}

/** Fetches Explore once a day, or for another chart country. */
async function loadExplore() {
  const day = new Date().toDateString();
  const country = settings.get<string | null>("chartCountry", null);
  if ((explore.data && explore.day === day && explore.country === country) || exploring) return;
  exploring = true;
  exploreError = "";
  drawExplore();
  try {
    explore = { day, country, data: await api.explore(country) };
    settings.set("explore", explore);
  } catch (e) {
    // Offline, say: keep what was there.
    exploreError = String(e);
  } finally {
    exploring = false;
  }
  // Another country picked while this one loaded: that one next.
  if (!exploreError && settings.get<string | null>("chartCountry", null) !== country) return void loadExplore();
  drawExplore();
}

function drawExplore() {
  const el = document.getElementById("explore");
  if (!el) return;
  const data = explore.data;
  // A country picked just now shows its charts once they've come.
  const fresh = data && explore.country === settings.get<string | null>("chartCountry", null);
  if (!data) {
    el.innerHTML = exploring
      ? `<div class="explore-wait">${spinner(26)}</div>`
      : emptyState("search", "Couldn't load Explore", esc(exploreError));
    return;
  }
  const place = data.countries.find((c) => c.code === data.country)?.name ?? "Global";
  const pick = `<button class="explore-country" id="explore-country" ${exploring && !fresh ? "disabled" : ""}>${esc(place)}${icon("chevronDown", 16)}</button>`;
  const artists = data.topArtists.map((a) => ({ target: `artist:${a.id}`, art: imgUrl(a.thumbnail), title: a.name }));
  el.innerHTML =
    // With no charts the country button still shows, to pick another.
    (cards("Charts", data.charts.map(cardItem), false, true, pick) || `<div class="section-head"><h2>Charts</h2>${pick}</div>`) +
    cards(`Top artists${place === "Global" ? "" : ` in ${esc(place)}`}`, artists, true, true) +
    cards("New releases", data.newReleases.map(cardItem), false, true) +
    data.moods
      .map(
        (g, gi) => `<div class="browse-head"><h2>${esc(g.title)}</h2></div>
        <div class="genres">${g.moods.map((m, i) => `<button class="genre" data-mood="${gi}:${i}" style="--genre: ${moodColor(m.color)}">${esc(m.title)}</button>`).join("")}</div>`,
      )
      .join("");
  el.onclick = (e) => {
    const target = e.target as HTMLElement;
    const mood = target.closest<HTMLElement>("[data-mood]")?.dataset.mood;
    if (mood) {
      const [g, i] = mood.split(":").map(Number);
      const m = data.moods[g]?.moods[i];
      if (m) openPage({ kind: "mood", title: m.title, params: m.params, color: m.color });
    } else if (target.closest("#explore-country")) {
      pickChartCountry(e, target.closest("#explore-country")!, data);
    }
  };
}

/** The charts' country: where the phone is, Global, or any YouTube Music has charts for. */
function pickChartCountry(e: MouseEvent, button: HTMLElement, data: Explore) {
  const chosen = settings.get<string | null>("chartCountry", null);
  const here = data.countries[0];
  const set = (code: string | null) => {
    settings.set("chartCountry", code);
    void loadExplore();
  };
  const others = data.countries
    .filter((c) => c.code !== "ZZ")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c): MenuItem => ({ label: c.name, icon: chosen === c.code ? "check" : undefined, run: () => set(c.code) }));
  // The country picked comes first too, so it needn't be looked for among seventy.
  const picked = data.countries.find((c) => c.code === chosen && c.code !== "ZZ");
  // Under the button: the click was caught by the whole of Explore.
  e.stopPropagation();
  const r = button.getBoundingClientRect();
  showMenu(
    [
      ...(here ? [{ label: `Where you are (${here.name})`, icon: chosen === null ? "check" : undefined, run: () => set(null) } satisfies MenuItem] : []),
      { label: "Global", icon: chosen === "ZZ" ? "check" : undefined, run: () => set("ZZ") },
      ...(picked ? [{ label: picked.name, icon: "check", run: () => set(picked.code) } satisfies MenuItem] : []),
      ...others.map((m, i) => (i === 0 ? { ...m, divider: true } : m)),
    ],
    r.left,
    r.bottom + 6,
  );
}

/** Placeholder rows while a list loads, shaped like songs. */
function loadingRows(n: number): string {
  const widths = [58, 40, 66, 48, 54, 44, 62, 50];
  return `<div class="loading-rows">${widths
    .slice(0, n)
    .map(
      (w, i) =>
        `<div class="sk-row" style="opacity:${1 - i * 0.12}"><span class="sk-art"></span><span class="sk-lines"><b style="width:${w}%"></b><i style="width:${w / 2}%"></i></span></div>`,
    )
    .join("")}</div>`;
}

/** A turning ring whose red arc is the only accent, as in the redesign. */
function spinner(size: number): string {
  return `<svg class="spinner" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="var(--line)" stroke-width="2.6"/><path d="M12 4a8 8 0 0 1 8 8" fill="none" stroke="var(--red)" stroke-width="2.6" stroke-linecap="round"/></svg>`;
}

/** A search that found nothing, with a shorter search to try. */
function noResults(query: string): string {
  const words = query.split(/\s+/);
  const shorter = words.length > 2 ? words.slice(0, 2).join(" ") : "";
  return `<div class="no-results">
      <span class="mono-label">0 results</span>
      <h2>Nothing matches “${esc(query)}”</h2>
      <p>Check the spelling or search with fewer words.</p>
      ${shorter ? `<div class="try">Try <button class="chip-label" data-try="${esc(shorter)}">${esc(shorter)}</button></div>` : ""}
    </div>`;
}

// ---- recommendations ---------------------------------------------------------------

/** Songs for Home, picked once per session (or on refresh). */
const recs = { tracks: [] as Track[], basis: [] as string[], state: "idle" as "idle" | "loading" | "ready" | "error", error: "" };

/** Songs like a few of the user's own (liked, in playlists, playing), that they don't have yet. */
async function loadRecommendations() {
  recs.state = "loading";
  renderRecs();
  const own = new Map<string, Track>();
  const keep = (t: Track | null | undefined) => t?.id.startsWith("yt:") && own.set(t.id, t);
  keep(player.current);
  [...liked.values()].forEach(keep);
  for (const p of playlists) {
    try {
      (await api.playlist(p.id)).tracks.forEach(keep);
    } catch {
      /* a playlist that fails to load just isn't used */
    }
  }
  // Recent likes and the playing song weigh most; the rest add variety.
  const recent = [player.current, ...liked.values()].filter((t): t is Track => !!t && own.has(t.id)).slice(0, 15);
  const pool = shuffled([...new Set([...shuffled(recent).slice(0, 3), ...shuffled([...own.values()])])]);
  const seeds = pool.slice(0, 5);
  recs.basis = [...new Set(seeds.map((t) => t.artist.split(",")[0].trim()).filter(Boolean))];
  renderRecs();
  try {
    recs.tracks = seeds.length ? await api.recommendations(seeds.map((t) => t.id), [...own.keys(), ...player.hidden]) : [];
    recs.state = "ready";
  } catch (e) {
    recs.state = "error";
    recs.error = String(e);
  }
  renderRecs();
}

/** Redraws the recommendations on Home. */
function renderRecs() {
  const el = document.getElementById("home-recs");
  if (el) renderRecommendations(el);
}

function renderRecommendations(el: HTMLElement) {
  if (recs.state === "idle") return void loadRecommendations();
  if (recs.state === "ready" && !recs.tracks.length) {
    el.innerHTML = emptyState(
      "music",
      "Find something to play",
      "Search YouTube Music for any song, artist or album. Like songs or add them to playlists, and picks for you show up here.",
    );
    return;
  }
  const names = recs.basis.slice(0, 3);
  const loading = recs.state === "loading";
  // The artists show as chips, which update first while new picks load.
  const basis = names.length ? `Because you like ${names.map((n) => `<span class="chip-label">${esc(n)}</span>`).join("")}` : "";
  el.innerHTML = `${phone && loading ? `<div class="pull-spinner">${spinner(26)}</div>` : ""}
    <div class="recs-head">
      <div><h2>Recommended for you</h2><p>${basis}</p></div>
      <button class="icon-btn" id="recs-refresh" title="New picks" ${loading ? "disabled" : ""}>${icon("refresh", 20)}</button>
    </div>
    <div id="recs-list"></div>`;
  $("#recs-refresh").onclick = () => void loadRecommendations();
  const list = $("#recs-list");
  if (loading) list.innerHTML = loadingRows(5);
  else if (recs.state === "error") list.innerHTML = emptyState("music", "Couldn't load recommendations", esc(recs.error));
  else mountTrackList(list, recs.tracks, { from: "Recommended for you" });
}

function renderEngineBanner() {
  const el = document.getElementById("engine-banner");
  if (!el) return;
  if (engine?.installed && !engine.jsRuntime) {
    el.innerHTML = `<div class="banner">
        <div>
          <strong>YouTube playback needs a JavaScript runtime</strong>
          <p>yt-dlp uses one to unlock YouTube streams. Install Deno (deno.com) or Node.js (nodejs.org), then restart Cadence. Your own music files play without it.</p>
        </div>
      </div>`;
    return;
  }
  if (!engine || engine.installed) {
    el.innerHTML = "";
    return;
  }
  const pct = installing?.total ? Math.round((installing.downloaded / installing.total) * 100) : null;
  el.innerHTML = `<div class="banner">
      <div>
        <strong>One more step for YouTube playback</strong>
        <p>Cadence uses yt-dlp, a free open-source tool, to play songs. It is downloaded from its official GitHub release and checked against the published checksum.</p>
      </div>
      ${
        installing
          ? `<div class="progress"><div style="width:${pct ?? 30}%"></div></div><span class="muted">${pct != null ? `${pct}%` : "Downloading…"}</span>`
          : `<button class="btn primary" id="install-ytdlp">${icon("download", 18)}Download yt-dlp</button>`
      }
    </div>`;
  document.getElementById("install-ytdlp")?.addEventListener("click", () => void installYtDlp());
}

async function installYtDlp() {
  installing = { downloaded: 0, total: null };
  renderEngineBanner();
  try {
    engine = await api.ytdlpInstall();
    toast(`yt-dlp ${engine.version ?? ""} is ready`);
  } catch (e) {
    toast(`Could not install yt-dlp: ${e}`, "error");
  }
  installing = null;
  renderEngineBanner();
  renderEngineStatus();
}

function renderEngineStatus() {
  const el = $("#engine-status");
  if (!engine) {
    el.textContent = "";
  } else if (engine.installed) {
    el.innerHTML = `<span class="dot ${engine.jsRuntime ? "ok" : "warn"}"></span>yt-dlp ${esc(engine.version)}`;
    el.title = engine.path ?? "";
  } else {
    el.innerHTML = `<span class="dot warn"></span>YouTube not set up`;
  }
  // Phones show the engine on the Settings tab.
  if (view === "settings") renderSettings();
}

/** The desktop's Your music: the music folders and every song in them. */
async function renderFolders() {
  $("#view").innerHTML = `${backBar()}
    <header class="view-head">
      <span class="head-tile music-tile">${icon("music", 34)}</span>
      <h1>Your music</h1>
      <span class="head-count" id="music-count">${count(musicCount, "song")}</span>
      <div class="head-actions">
        <button class="btn primary" id="play-music">${icon("play", 18)}Play</button>${shuffleButton("shuffle-music")}
        <button class="btn add-all" id="add-folder">${icon("folder", 18)}<span>Add a folder</span></button>
        <button class="icon-btn" id="rescan" title="Look for changes in the folders">${icon("refresh", 20)}</button>
      </div>
    </header>
    <div class="folders" id="folders"></div>
    <div class="scan-status" id="scan-status">${esc(scanStatus)}</div>
    <label class="search-box compact">${icon("search", 18)}
      <input id="lib-q" type="search" placeholder="Find in your music" spellcheck="false" autocomplete="off" />
    </label>
    <div class="track-list" id="lib-list"></div>`;
  bindBack();
  $("#add-folder").onclick = () => void addFolder();
  $("#rescan").onclick = () => {
    scanStatus = "Scanning…";
    $("#scan-status").textContent = scanStatus;
    void api.libraryRescan();
  };
  const input = $<HTMLInputElement>("#lib-q");
  input.addEventListener("input", debounce(() => void loadLibraryTracks(input.value), 150));
  showFolders(await api.libraryFolders());
  await loadLibraryTracks("");
}

function showFolders(folders: string[]) {
  const el = document.getElementById("folders");
  if (!el) return;
  el.innerHTML = folders
    .map((f) => `<span class="chip" title="${esc(f)}">${icon("folder", 16)}<span>${esc(f)}</span><button data-f="${esc(f)}" title="Remove folder">${icon("close", 14)}</button></span>`)
    .join("");
  el.onclick = async (e) => {
    const f = (e.target as HTMLElement).closest<HTMLElement>("button[data-f]")?.dataset.f;
    if (!f) return;
    showFolders(await api.libraryRemoveFolder(f));
    void loadLibraryTracks($<HTMLInputElement>("#lib-q")?.value ?? "");
  };
}

/** Picks a music folder and starts scanning it. True once one was added. */
async function addFolder(): Promise<boolean> {
  const picked = await open({ directory: true, multiple: false, title: "Add a music folder" });
  if (typeof picked !== "string") return false;
  try {
    showFolders(await api.libraryAddFolder(picked));
    scanStatus = "Scanning…";
    const status = document.getElementById("scan-status");
    if (status) status.textContent = scanStatus;
    return true;
  } catch (e) {
    toast(String(e), "error");
    return false;
  }
}

async function loadLibraryTracks(query: string) {
  const el = document.getElementById("lib-list");
  if (!el) return;
  const tracks = await api.libraryTracks(query.trim());
  if (!query.trim()) {
    musicCount = tracks.length;
    renderPlaylistGrid();
    const n = document.getElementById("music-count");
    if (n) n.textContent = count(musicCount, "song");
  }
  // Play and Shuffle play what the list shows.
  const from = "Your music";
  const play = document.getElementById("play-music");
  if (play) play.onclick = () => playFromTop(tracks, from);
  const shuffle = document.getElementById("shuffle-music");
  if (shuffle) shuffle.onclick = () => shuffleList(tracks, from);
  if (!tracks.length) {
    el.innerHTML = query.trim()
      ? emptyState("search", "No matches", "None of your songs match that.")
      : emptyState("folder", "No songs of your own yet", "Add a folder with music files (MP3, FLAC, WAV, OGG, M4A), like songs you can't find on YouTube. Cadence plays them from where they are.");
    return;
  }
  mountTrackList(el, tracks, { from });
}

// ---- your music -------------------------------------------------------------------

/** How many songs of your own there are (imported on a phone, in the music
 *  folders on the desktop); Library shows a tile for them. */
let musicCount = 0;
let musicImporting = false;
/** How far copying has got, while an import runs. */
let musicProgress: { done: number; total: number } | null = null;

async function refreshMusicCount() {
  musicCount = (await api.libraryTracks().catch(() => [])).length;
  renderPlaylistGrid();
}

/** The line under Your music's title: the song count, or the import's progress. */
function musicStatus(): string {
  const p = musicProgress;
  if (!p) return count(musicCount, "song");
  return p.done < p.total ? `Importing ${p.done + 1} of ${p.total}…` : "Reading song details…";
}

function importMenu(e: MouseEvent) {
  menuUnder(e, [
    { label: "Import songs…", icon: "music", sub: "Pick music files on this phone", run: () => void importMusic(false) },
    { label: "Import a folder…", icon: "folder", sub: "Every song in it, and in the folders inside", run: () => void importMusic(true) },
  ]);
}

/**
 * Phones: picks music files (or a folder) in Android's file picker and copies
 * them into Cadence. Once copying starts, Your music opens to show them.
 */
async function importMusic(folder: boolean) {
  if (musicImporting) return toast("Still importing, one moment");
  musicImporting = true;
  const stop = await listen<{ done: number; total: number }>("music-import", (e) => {
    const first = !musicProgress;
    musicProgress = e.payload;
    // An empty Your music has no line for the progress yet; redrawn, it does.
    if (first) void (view === "music" ? renderMusic() : openMusic());
    const el = document.getElementById("music-count");
    if (el) el.textContent = musicStatus();
  });
  try {
    const r = await api.musicImport(folder);
    if (r) toast(importNote(r, folder), r.added || r.existing ? "info" : "error");
  } catch (e) {
    toast(String(e), "error");
  } finally {
    stop();
    musicImporting = false;
    musicProgress = null;
    await refreshMusicCount();
    if (view === "music") void renderMusic();
  }
}

function importNote(r: MusicImport, folder: boolean): string {
  if (!r.added && !r.existing && !r.failed) return folder ? "No music files in that folder" : "Cadence can't play those files";
  const notes = [r.added ? `Added ${count(r.added, "song")}` : "No new songs"];
  if (r.existing) notes.push(`${r.existing} already here`);
  if (r.unsupported) notes.push(`${count(r.unsupported, "file")} not playable`);
  if (r.failed) notes.push(`${r.failed} couldn't be copied`);
  return notes.join(" · ");
}

/** Phones: the songs imported from the phone's own files. The desktop has its folders. */
async function renderMusic() {
  if (!phone) return renderFolders();
  const tracks = await api.libraryTracks().catch(() => []);
  if (view !== "music") return;
  musicCount = tracks.length;
  const from = "Your music";
  // Empty, the page is the title and the empty state's import buttons.
  $("#view").innerHTML = `${backBar()}
    <header class="view-head">
      ${tracks.length || musicProgress ? `<span class="head-tile music-tile">${icon("music", 34)}</span>` : ""}
      <h1>Your music</h1>
      ${tracks.length || musicProgress ? `<span class="head-count" id="music-count">${musicStatus()}</span>` : ""}
      ${
        tracks.length
          ? `<div class="head-actions">
              <button class="btn primary" id="play-music">${icon("play", 18)}Play</button>${shuffleButton("shuffle-music")}
              <button class="btn add-all" id="music-add" title="Import songs">${icon("add", 18)}<span>Import</span></button>
            </div>`
          : ""
      }
    </header>
    <div class="track-list" id="music-list"></div>`;
  bindBack();
  const el = $("#music-list");
  if (!tracks.length) {
    el.innerHTML = `${emptyState("music", "No songs of your own yet", "Import music files from this phone, like songs you can't find on YouTube. Cadence keeps its own copy of each.")}
      <div class="empty-actions">
        <button class="btn primary" data-import="files">${icon("music", 18)}Import songs</button>
        <button class="btn outline" data-import="folder">${icon("folder", 18)}Import a folder</button>
      </div>`;
    el.onclick = (e) => {
      const kind = (e.target as HTMLElement).closest<HTMLElement>("[data-import]")?.dataset.import;
      if (kind) void importMusic(kind === "folder");
    };
    return;
  }
  $("#music-add").onclick = importMenu;
  mountTrackList(el, tracks, {
    from,
    menu: (i) => [{ label: "Delete from Cadence", icon: "trash", sub: "The file on your phone stays", divider: true, run: () => void removeMusic(tracks[i]) }],
  });
  $("#play-music").onclick = () => player.playList(tracks, 0, from);
  bindShuffle("shuffle-music", tracks, from);
}

async function removeMusic(t: Track) {
  const ok = await confirmBox({
    title: "Delete this song?",
    body: `“${esc(t.title)}” leaves Cadence, with its like and its place in your playlists. The original file on your phone stays.`,
    ok: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.musicRemove(Number(t.id.slice("local:".length)));
  } catch (e) {
    return toast(String(e), "error");
  }
  if (liked.has(t.id)) await reloadLiked();
  await refreshPlaylists();
  await refreshMusicCount();
  if (view === "music") void renderMusic();
}

async function renderLiked() {
  const tracks = [...liked.values()];
  // Liked songs opens from Library or Home (or the sidebar), and Back returns there.
  $("#view").innerHTML = `${backBar()}
    <header class="view-head">
      <span class="head-tile">${icon("heartFilled", 34)}</span>
      <h1>Liked songs</h1>
      <span class="head-count">${count(tracks.length, "song")}</span>
      <div class="head-actions">
        <button class="btn dl-all" id="download-liked" title="Download all" hidden>${icon("download", 18)}<span>Download all</span></button>
        ${
          tracks.length
            ? `<button class="btn primary" id="play-liked">${icon("play", 18)}Play</button>${shuffleButton("shuffle-liked")}
              <button class="btn add-all" id="liked-to-playlist" title="Add all to a playlist">${icon("playlistAdd", 18)}<span>Add all to a playlist</span></button>`
            : ""
        }
      </div>
    </header>
    ${offlineBanner()}
    ${tracks.length > 1 ? listTools() : ""}
    <div class="track-list" id="liked-list"></div>`;
  bindBack();
  const el = $("#liked-list");
  if (!tracks.length) {
    el.innerHTML = emptyState("heart", "No liked songs yet", "Tap the heart on any song to save it here.");
    return;
  }
  const from = "Liked songs";
  // What the list shows, found and sorted; Play and Shuffle play it.
  const shown: Track[] = [];
  bindListTools("liked", tracks, "Recently added", (list) => {
    shown.splice(0, shown.length, ...list);
    if (!list.length) return void (el.innerHTML = emptyState("search", "No songs match", "Try another word."));
    mountTrackList(el, shown, {
      from,
      swipeLeft: {
        label: "Unlike",
        icon: "unlike",
        run: (i) => {
          const t = shown[i];
          void toggleLike(t);
          toast("Removed from liked songs", "info", { label: "Undo", run: () => void toggleLike(t) });
        },
      },
    });
  });
  $("#play-liked").onclick = () => playFromTop(shown, from);
  $("#liked-to-playlist").onclick = (e) => menuUnder(e, playlistMenu(tracks));
  bindShuffle("shuffle-liked", shown, from);
  $("#download-liked").onclick = () => void downloadTracks(notDownloaded([...liked.values()]));
  updateDownloadLiked();
}

/** A Shuffle button beside Play. */
function shuffleButton(id: string): string {
  return `<button class="btn outline shuffle-toggle ${player.shuffle ? "on" : ""}" id="${id}">${shuffleInner(18)}</button>`;
}

/** A Shuffle button's icon and name: with smart shuffle on, the spark and "Smart". */
function shuffleInner(size: number): string {
  return player.smart ? `${icon("smartShuffle", size)}<span class="lbl">Smart</span>` : `${icon("shuffle", size)}<span class="lbl">Shuffle</span>`;
}

/** Off, shuffle, smart shuffle, as Spotify's button, saying which. */
function cycleShuffle() {
  player.cycleShuffle();
  toast(player.smart ? "Smart shuffle on · songs like these are mixed in" : player.shuffle ? "Shuffle on" : "Shuffle off");
}

function bindShuffle(id: string, tracks: Track[], from: string) {
  document.getElementById(id)?.addEventListener("click", () => shuffleList(tracks, from));
}

/**
 * A list page's Shuffle, as in Spotify: with that list playing it's a switch,
 * and the song playing carries on while the ones after it are mixed (or put
 * back in order). Otherwise it plays the list, shuffled.
 */
function shuffleList(tracks: Track[], from: string) {
  if (!tracks.length) return;
  const current = player.current;
  if (current && player.from === from && tracks.some((t) => t.id === current.id)) return cycleShuffle();
  player.setShuffle(true);
  player.playList(tracks, Math.floor(Math.random() * tracks.length), from);
}

/** Play on a list page: from the top, or from a random song when shuffle is on. */
function playFromTop(tracks: Track[], from: string) {
  if (tracks.length) player.playList(tracks, player.shuffle ? Math.floor(Math.random() * tracks.length) : 0, from);
}

/** Offline, a YouTube song that isn't downloaded can't play. */
function unavailable(t: Track): boolean {
  return !navigator.onLine && t.id.startsWith("yt:") && downloads.get(t.id)?.state !== "done";
}

function offlineBanner(): string {
  if (navigator.onLine) return "";
  return `<div class="offline-banner" role="status">${icon("offline", 22)}<span><b>You're offline</b><small>Only downloaded songs will play</small></span></div>`;
}

// ---- downloads -----------------------------------------------------------------

/** YouTube songs among `tracks` that are neither saved nor on their way. */
function notDownloaded(tracks: Track[]): Track[] {
  return tracks.filter((t) => t.id.startsWith("yt:") && !downloads.has(t.id));
}

function downloadBadge(id: string): string {
  const d = downloads.get(id);
  if (!d) return "";
  if (d.state === "done") return `<span class="dl done" title="Downloaded">${icon("check", 14)}</span>`;
  if (d.state === "downloading" && d.total) return `<span class="dl busy" title="Downloading">${Math.floor((d.done / d.total) * 100)}%</span>`;
  return `<span class="dl busy" title="Waiting to download">${icon("download", 14)}</span>`;
}

async function downloadTracks(tracks: Track[]) {
  if (!engine?.installed && tracks.some((t) => t.id.startsWith("yt:"))) return toast("Downloading needs yt-dlp. Set it up from the Search page first.", "error");
  try {
    const added = await api.downloadAdd(tracks, settings.get<DownloadQuality>("downloadQuality", "normal"));
    if (added) toast(added === 1 ? "Downloading" : `Downloading ${added} ${tracks.every(isEpisode) ? "episodes" : "songs"}`);
  } catch (e) {
    toast(String(e), "error");
  }
}

async function removeDownload(track: Track) {
  try {
    await api.downloadRemove(track.id);
  } catch (e) {
    toast(String(e), "error");
  }
}

function updateDownloadLiked() {
  const btn = document.getElementById("download-liked");
  if (btn) btn.hidden = notDownloaded([...liked.values()]).length === 0;
}

function onDownload(item: DownloadItem) {
  const id = item.track.id;
  const was = downloads.get(id)?.state;
  if (item.state === "removed" || item.state === "failed") {
    downloads.delete(id);
    if (item.state === "failed") toast(`Couldn't download ${item.track.title}: ${item.error}`, "error");
  } else if (item.state === "done" && was !== "done") {
    // Newest first, matching the order the back end returns.
    const rest = [...downloads].filter(([k]) => k !== id);
    downloads.clear();
    downloads.set(id, item);
    for (const [k, v] of rest) downloads.set(k, v);
  } else {
    downloads.set(id, item);
  }
  document
    .querySelectorAll(`.track[data-id="${CSS.escape(id)}"] .dl-slot`)
    .forEach((slot) => (slot.innerHTML = downloadBadge(id)));
  if (isEpisode(item.track)) refreshEpisodeRows();
  updateDownloadLiked();
  updateDlChip();
  // Progress alone doesn't change the sidebar's line, or Settings'.
  if (item.state !== was) {
    renderSidebar();
    const note = document.querySelector("#open-downloads small");
    if (note) note.textContent = downloadsNote();
  }
  if (id === player.current?.id) updateNowExtras();
  if (view !== "downloads") return;
  // Progress only moves a bar; anything else changes what is listed.
  const row = document.querySelector<HTMLElement>(`.dl-row[data-id="${CSS.escape(id)}"]`);
  if (item.state === "downloading" && was === "downloading" && row) updatePendingRow(row, item);
  else renderDownloads();
}

function updatePendingRow(row: HTMLElement, d: DownloadItem) {
  const pct = d.total ? (d.done / d.total) * 100 : 0;
  row.querySelector<HTMLElement>(".dl-bar > div")!.style.width = `${pct}%`;
  // Phones show a ring that fills, like the redesign's progress.
  row.querySelector<SVGElement>(".dl-ring .arc")?.setAttribute("stroke-dasharray", `${(37.7 * pct) / 100} 37.7`);
  const status = row.querySelector(".dl-status")!;
  if (d.state === "queued") status.textContent = "Waiting";
  else if (phone) status.textContent = d.total ? `Downloading · ${Math.floor(pct)}%` : "Downloading";
  else status.textContent = d.total ? `${formatBytes(d.done)} of ${formatBytes(d.total)}` : "Starting…";
}

/** Downloads swiped away on a phone, kept for a few seconds in case of Undo. */
const removing = new Map<string, number>();

function renderDownloads() {
  const items = [...downloads.values()].filter((d) => !removing.has(d.track.id));
  const saved = items.filter((d) => d.state === "done");
  const pending = items.filter((d) => d.state !== "done");
  const tracks = saved.map((d) => d.track);
  const bytes = saved.reduce((n, d) => n + d.done, 0);
  const scroll = $("#view").scrollTop;
  const ring = `<svg class="dl-ring" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--line)" stroke-width="2.4"/><circle class="arc" cx="8" cy="8" r="6" fill="none" stroke="var(--red)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="0 37.7" transform="rotate(-90 8 8)"/></svg>`;
  const sub = tracks.length ? `<p class="view-sub">${count(tracks.length, "song")} · ${formatBytes(bytes)} · plays without an internet connection</p>` : "";
  // Phones put the summary between the title and the buttons, and open the page from Settings.
  $("#view").innerHTML = `${phone ? backBar() : ""}
    <header class="view-head">
      <h1>Downloads</h1>
      ${phone ? sub : ""}
      <div class="head-actions">${tracks.length ? `<button class="btn primary" id="play-downloads">${icon("play", 18)}${phone ? "Play" : "Play all"}</button>${shuffleButton("shuffle-downloads")}` : ""}</div>
    </header>
    ${phone ? "" : sub}
    ${
      pending.length
        ? `<section class="dl-pending">
        <h2>${phone ? `In progress · ${pending.length}` : "Downloading"}</h2>
        ${pending
          .map(
            (d) => `<div class="dl-row" data-id="${esc(d.track.id)}">
            <div class="q-art">${artHtml(d.track)}</div>
            <div class="q-text"><div class="q-title">${esc(d.track.title)}</div><div class="q-artist">${phone ? `${ring}<span class="dl-status"></span>` : esc(d.track.artist)}</div></div>
            <div class="dl-progress"><div class="dl-bar"><div></div></div>${phone ? "" : `<span class="dl-status"></span>`}</div>
            <button class="icon-btn tiny" data-cancel title="Cancel">${icon("close", 16)}</button>
          </div>`,
          )
          .join("")}
      </section>${phone && tracks.length ? `<h2 class="section-label">Downloaded</h2>` : ""}`
        : ""
    }
    <div class="track-list" id="dl-list"></div>`;
  document.querySelectorAll<HTMLElement>(".dl-row").forEach((row) => updatePendingRow(row, downloads.get(row.dataset.id!)!));
  document.querySelector<HTMLElement>(".dl-pending")?.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".dl-row");
    if (row && (e.target as HTMLElement).closest("[data-cancel]")) void removeDownload(downloads.get(row.dataset.id!)!.track);
  });
  const el = $("#dl-list");
  if (!tracks.length) {
    el.innerHTML = pending.length
      ? ""
      : phone
        ? emptyState("download", "Nothing downloaded yet", "Tap ⋮ on any song and choose Download to keep it for listening without internet. Liked songs can all be downloaded at once.")
        : emptyState("download", "No downloads yet", "Right-click a song and choose Download to keep it for offline listening. Liked songs can all be downloaded at once.");
  } else {
    const from = "Downloads";
    mountTrackList(el, tracks, {
      from,
      swipeLeft: { label: "Remove", icon: "trash", run: (i) => removeLater(tracks[i]) },
    });
    $("#play-downloads").onclick = () => player.playList(tracks, 0, from);
    bindShuffle("shuffle-downloads", tracks, from);
  }
  bindBack();
  $("#view").scrollTop = scroll;
}

/** Settings' line under "Downloaded songs": how many, and the space they take. */
function downloadsNote(): string {
  const saved = [...downloads.values()].filter((d) => d.state === "done");
  if (!saved.length) return "Nothing downloaded yet";
  return `${count(saved.length, "song")} · ${formatBytes(saved.reduce((n, d) => n + d.done, 0))}`;
}

/** Hides a download at once but deletes it only once Undo has had its chance. */
function removeLater(track: Track) {
  const id = track.id;
  clearTimeout(removing.get(id));
  removing.set(
    id,
    window.setTimeout(() => {
      removing.delete(id);
      void removeDownload(track);
    }, 4400),
  );
  if (view === "downloads") renderDownloads();
  toast("Download removed", "info", {
    label: "Undo",
    run: () => {
      clearTimeout(removing.get(id));
      removing.delete(id);
      if (view === "downloads") renderDownloads();
    },
  });
}

// ---- downloads in progress (phones) ---------------------------------------------

/** Downloads still to finish, the one being saved first. */
function pendingDownloads(): DownloadItem[] {
  const pending = [...downloads.values()].filter((d) => d.state === "queued" || d.state === "downloading");
  return pending.sort((a, b) => Number(b.state === "downloading") - Number(a.state === "downloading"));
}

function downloadPct(d: DownloadItem): number {
  return d.state === "downloading" && d.total ? Math.min(100, (d.done / d.total) * 100) : 0;
}

/**
 * Phones: while songs download, a chip in the top-right corner shows how
 * many are left, with a ring for the one being saved. Tapped, it opens a
 * small panel with each song's progress (dl-panel).
 */
function updateDlChip() {
  if (!phone) return;
  let chip = document.getElementById("dl-chip");
  if (!chip) {
    chip = document.createElement("button");
    chip.id = "dl-chip";
    chip.className = "dl-chip";
    chip.title = "Downloads";
    const panel = document.createElement("div");
    panel.id = "dl-panel";
    panel.className = "dl-panel";
    panel.hidden = true;
    chip.onclick = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) renderDlPanel();
    };
    panel.onclick = (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".dlp-row");
      const d = row && downloads.get(row.dataset.id!);
      if (d && (e.target as HTMLElement).closest("[data-cancel]")) void removeDownload(d.track);
    };
    document.body.append(chip, panel);
  }
  const pending = pendingDownloads();
  chip.hidden = !pending.length;
  if (!pending.length) {
    $("#dl-panel").hidden = true;
    return;
  }
  const pct = downloadPct(pending[0]);
  chip.innerHTML = `<span class="dl-chip-ring">
      <svg class="ring" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11" fill="none" stroke="var(--line)" stroke-width="2.4"/><circle cx="13" cy="13" r="11" fill="none" stroke="var(--red)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${(69.1 * pct) / 100} 69.1" transform="rotate(-90 13 13)"/></svg>
      ${icon("download", 14)}
    </span><b>${pending.length}</b>`;
  if (!$("#dl-panel").hidden) renderDlPanel();
}

/** The panel under the chip: each download with a bar. Progress only moves bars; other changes redraw it. */
function renderDlPanel() {
  const panel = $("#dl-panel");
  const pending = pendingDownloads();
  const status = (d: DownloadItem) => (d.state === "queued" ? "Waiting" : d.total ? `${Math.floor(downloadPct(d))}%` : "Starting…");
  const ids = pending.map((d) => d.track.id).join("\n");
  if (panel.dataset.ids !== ids) {
    panel.dataset.ids = ids;
    panel.innerHTML = `<div class="dlp-head">Downloading · ${pending.length}</div>
      <div class="dlp-list">${pending
        .map(
          (d) => `<div class="dlp-row" data-id="${esc(d.track.id)}">
          <div class="q-art">${artHtml(d.track)}</div>
          <div class="dlp-text">
            <div class="dlp-title">${esc(d.track.title)}</div>
            <div class="dlp-line"><div class="dl-bar"><div></div></div><span class="dlp-status"></span></div>
          </div>
          <button class="icon-btn tiny" data-cancel title="Cancel">${icon("close", 16)}</button>
        </div>`,
        )
        .join("")}</div>`;
  }
  for (const d of pending) {
    const row = panel.querySelector<HTMLElement>(`.dlp-row[data-id="${CSS.escape(d.track.id)}"]`)!;
    row.querySelector<HTMLElement>(".dl-bar > div")!.style.width = `${downloadPct(d)}%`;
    row.querySelector(".dlp-status")!.textContent = status(d);
  }
}

// ---- album, artist and playlist pages --------------------------------------------

function imgUrl(thumbnail: string | null | undefined): string | null {
  return artUrl({ thumbnail } as Track);
}

function totalTime(tracks: Track[]): string {
  const s = tracks.reduce((n, t) => n + (t.duration ?? 0), 0);
  if (!s) return "";
  if (s < 60) return `${Math.round(s)} sec`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/** Runs of emoji, which phones set smaller than the big title around them. */
const EMOJI = /\p{Extended_Pictographic}(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u{1F1E6}-\u{1F1FF}]|\s(?=\p{Extended_Pictographic}))*|[\u{1F1E6}-\u{1F1FF}]{2}/gu;

/** Phones set big titles smaller the longer they are, or the longer their
 *  longest word is: a word can't wrap, so it would break between letters
 *  (capitals are wider, so they count for more). */
function titleLength(title: string): string {
  const word = Math.max(0, ...title.split(/\s+/).map((w) => w.length * (/[a-z]/.test(w) ? 1 : 1.25)));
  if (title.length > 26 || word > 13) return "long";
  if (title.length > 13 || word > 10) return "mid";
  return "short";
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function backBar(): string {
  return history.length
    ? `<div class="page-bar"><button class="icon-btn" id="back" title="Back (Alt+←)">${icon("back", 22)}</button></div>`
    : "";
}

interface HeroOptions {
  art: string | null;
  fallback: IconName;
  round?: boolean;
  label: string;
  title: string;
  /** Markup; may contain links. */
  meta: string;
  tracks: Track[];
  /** Extra buttons after the standard ones. */
  extra?: string;
}

function hero(o: HeroOptions): string {
  const art = o.art ? `<img src="${esc(o.art)}" alt="" draggable="false" />` : `<span class="art-fallback">${icon(o.fallback, 56)}</span>`;
  const hasYouTube = o.tracks.some((t) => t.id.startsWith("yt:"));
  return `${backBar()}
    ${offlineBanner()}
    <section class="hero">
      <div class="hero-art ${o.round ? "round" : ""}">${art}</div>
      <div class="hero-text">
        <div class="hero-label">${o.label}</div>
        <h1 title="${esc(o.title)}" data-len="${titleLength(o.title.replace(EMOJI, ""))}">${esc(o.title).replace(EMOJI, (e) => `<span class="emoji">${e}</span>`)}</h1>
        <div class="hero-meta">${o.meta}</div>
        <div class="hero-actions">
          ${o.tracks.length ? `<button class="btn primary" data-hero="play">${icon("play", 18)}Play</button>
          <button class="icon-btn shuffle-toggle ${player.shuffle ? "on" : ""}" data-hero="shuffle" title="Shuffle">${shuffleInner(22)}</button>
          <button class="icon-btn" data-hero="playlist" title="Add all to a playlist or Liked songs">${icon("playlistAdd", 22)}</button>
          ${hasYouTube ? `<button class="icon-btn" data-hero="download" title="Download all">${icon("download", 22)}</button>` : ""}` : ""}
          ${o.extra ?? ""}
        </div>
      </div>
    </section>`;
}

function bindHero(tracks: Track[], from: string) {
  const on = (name: string, fn: (e: MouseEvent) => void) =>
    document.querySelector<HTMLElement>(`[data-hero="${name}"]`)?.addEventListener("click", fn);
  if (playOnOpen && playOnOpen === page) {
    playOnOpen = null;
    if (tracks.length) player.playList(tracks, 0, from);
  }
  on("play", () => playFromTop(tracks, from));
  on("shuffle", () => shuffleList(tracks, from));
  on("playlist", (e) => menuUnder(e, playlistMenu(tracks, { skip: page?.kind === "playlist" ? page.id : undefined, liked: true })));
  on("download", () => {
    const todo = notDownloaded(tracks);
    if (todo.length) void downloadTracks(todo);
    else toast("All of these are downloaded already");
  });
}

/**
 * Album or artist cards in a grid, or with `row` in one row that scrolls
 * sideways. `action` is a button beside the title.
 */
function cards(title: string, items: { target: string; art: string | null; title: string; sub?: string | null; badge?: string }[], round = false, row = false, action = ""): string {
  if (!items.length) return "";
  return `<section class="page-section">
    ${action ? `<div class="section-head"><h2>${title}</h2>${action}</div>` : `<h2>${title}</h2>`}
    <div class="cards ${row ? "row" : ""}">${items
      .map(
        (c) => `<button class="card ${round ? "round" : ""}" data-go="${esc(c.target)}" title="${esc(c.title)}">
          <div class="card-art">${c.art ? `<img src="${esc(c.art)}" alt="" loading="lazy" draggable="false" />` : `<span class="art-fallback">${icon(round ? "person" : "album", 32)}</span>`}${c.badge ? `<span class="card-badge">${esc(c.badge)}</span>` : ""}</div>
          <div class="card-title">${esc(c.title)}</div>
          ${c.sub ? `<div class="card-sub">${esc(c.sub)}</div>` : ""}
        </button>`,
      )
      .join("")}</div>
  </section>`;
}

let pageToken = 0;

async function renderPage(p: Page) {
  const token = ++pageToken;
  const el = $("#view");
  el.innerHTML = `${backBar()}<section class="hero loading"><div class="hero-art skeleton"></div><div class="hero-text"><div class="skeleton line"></div><div class="skeleton line short"></div></div></section>
    <div class="loading-rows">${"<div class='skeleton'></div>".repeat(6)}</div>`;
  bindBack();
  try {
    const html = await pageHtml(p);
    if (token !== pageToken) return;
    el.innerHTML = html.markup;
    bindBack();
    html.mount();
    void tintPage(token);
  } catch (e) {
    if (token !== pageToken) return;
    el.innerHTML = `${backBar()}${emptyState("music", "Couldn't open this page", esc(String(e)))}`;
    bindBack();
  }
}

function bindBack() {
  document.getElementById("back")?.addEventListener("click", goBack);
}

/** A page's markup, plus the step that brings its lists to life. */
async function pageHtml(p: Page): Promise<{ markup: string; mount: () => void }> {
  const list = `<div class="track-list" id="page-list"></div>`;
  if (p.kind === "mood") {
    const shelves = await api.mood(p.params);
    const lists = shelves.reduce((n, s) => n + s.cards.length, 0);
    return {
      markup:
        hero({ art: null, fallback: "music", label: "Browse", title: p.title, meta: count(lists, "playlist"), tracks: [] }) +
        shelves.map((s) => cards(esc(s.title), s.cards.map(cardItem), false, true)).join(""),
      mount: () => {},
    };
  }
  if (p.kind === "podcast") {
    const s = await api.podcastShow(p.id);
    learn(s.episodes);
    const followBtn = `<button class="btn pod-follow ${s.followed ? "on" : ""}" data-hero="follow">${s.followed ? "Following" : "Follow"}</button>`;
    const meta = [esc(s.show.author), count(s.episodes.length, "episode")].filter(Boolean).join(" · ");
    const about = s.description ? `<p class="pod-about" id="pod-about">${esc(s.description)}</p>` : "";
    return {
      markup: hero({ art: imgUrl(s.show.artwork), fallback: "podcast", label: "Podcast", title: s.show.title, meta, tracks: [], extra: followBtn }) + about + `<div class="episode-list" id="page-list"></div>`,
      mount: () => {
        mountEpisodes($("#page-list"), s.episodes, false);
        bindShowFollow(s.show, s.followed);
        document.getElementById("pod-about")?.addEventListener("click", (e) => (e.currentTarget as HTMLElement).classList.toggle("open"));
      },
    };
  }
  // On an album's own page every row would repeat its name.
  const albumList = `<div class="track-list same-album" id="page-list"></div>`;
  if (p.kind === "album") {
    const a = await api.album(p.id);
    const meta = [linked(a.artist, a.artistId ? `artist:${a.artistId}` : null), esc(a.subtitle), count(a.tracks.length, "song"), totalTime(a.tracks)];
    const extra = shareButton();
    return {
      markup: hero({ art: imgUrl(a.thumbnail), fallback: "album", label: "Album", title: a.title, meta: meta.filter(Boolean).join(" · "), tracks: a.tracks, extra }) + albumList,
      mount: () => {
        mountTrackList($("#page-list"), a.tracks, { from: a.title });
        bindHero(a.tracks, a.title);
        const cover = a.tracks.find((t) => t.id.startsWith("yt:"))?.id.slice(3) ?? null;
        onShare(() => void share({ kind: "album", id: a.id, title: a.title, artist: a.artist, cover }));
      },
    };
  }
  if (p.kind === "artist") {
    const a = await api.artist(p.id);
    const releases = (r: Release[]) => r.map((x) => ({ target: `album:${x.id}`, art: imgUrl(x.thumbnail), title: x.title, sub: x.year }));
    const meta = [a.albums.length ? count(a.albums.length, "album") : "", a.singles.length ? count(a.singles.length, "single") : ""];
    const extra = followButton(a.id) + `<button class="icon-btn" data-hero="more" title="More">${icon("more", 22)}</button>`;
    const markup =
      hero({ art: imgUrl(a.thumbnail), fallback: "person", round: true, label: "Artist", title: a.name, meta: meta.filter(Boolean).join(" · "), tracks: a.topSongs, extra }) +
      (a.topSongs.length ? `<section class="page-section"><h2>Top songs</h2>${list}</section>` : "") +
      cards("Albums", releases(a.albums)) +
      cards("Singles &amp; EPs", releases(a.singles)) +
      cards("Fans also like", a.related.map((r) => ({ target: `artist:${r.id}`, art: imgUrl(r.thumbnail), title: r.name })), true);
    return {
      markup,
      mount: () => {
        if (a.topSongs.length) mountTrackList($("#page-list"), a.topSongs, { from: a.name });
        bindHero(a.topSongs, a.name);
        bindFollow({ id: a.id, name: a.name, thumbnail: a.thumbnail });
        document.querySelector<HTMLElement>('[data-hero="more"]')?.addEventListener("click", (e) =>
          menuUnder(e, [
            { label: "Start radio", icon: "radio", run: () => void startRadio(a.topSongs, `${a.name} radio`) },
            { label: "Share", icon: "share", run: () => void share({ kind: "artist", id: a.id, name: a.name }) },
          ]),
        );
      },
    };
  }
  if (p.kind === "localAlbum") {
    const tracks = (await api.libraryTracks()).filter((t) => t.album === p.album && (!p.artist || t.artist === p.artist));
    const meta = [linked(p.artist, p.artist ? `lartist:${p.artist}` : null), "In your library", count(tracks.length, "song"), totalTime(tracks)];
    return {
      markup: hero({ art: artUrl(tracks[0]), fallback: "album", label: "Album", title: p.album, meta: meta.filter(Boolean).join(" · "), tracks }) + albumList,
      mount: () => {
        mountTrackList($("#page-list"), tracks, { from: p.album });
        bindHero(tracks, p.album);
      },
    };
  }
  if (p.kind === "localArtist") {
    const tracks = (await api.libraryTracks()).filter((t) => t.artist === p.artist);
    const albums = new Map<string, Track>();
    for (const t of tracks) if (t.album && !albums.has(t.album)) albums.set(t.album, t);
    const albumCards = [...albums.values()].map((t) => ({ target: albumTarget(t)!, art: artUrl(t), title: t.album! }));
    const meta = ["In your library", count(tracks.length, "song"), count(albums.size, "album")];
    return {
      markup:
        hero({ art: artUrl(tracks.find((t) => t.thumbnail)), fallback: "person", round: true, label: "Artist", title: p.artist, meta: meta.join(" · "), tracks }) +
        cards("Albums", albumCards) +
        `<section class="page-section"><h2>Songs</h2>${list}</section>`,
      mount: () => {
        mountTrackList($("#page-list"), tracks, { from: p.artist });
        bindHero(tracks, p.artist);
      },
    };
  }
  if (p.kind === "shared" || p.kind === "ytlist" || p.kind === "mix" || p.kind === "weekly") {
    const { name, tracks, missing } =
      p.kind === "shared"
        ? await api.songs(p.ids).then((tracks) => ({ name: p.name, tracks, missing: p.ids.length - tracks.length }))
        : p.kind === "ytlist"
          ? await api.youtubePlaylist(p.id).then((r) => ({ name: r.title, tracks: r.tracks, missing: 0 }))
          : p.kind === "mix"
            ? mixList(p.index)
            : weeklyList(p.which);
    const meta = [count(tracks.length, "song"), totalTime(tracks), missing ? `${missing} not found` : ""];
    const extra = `<button class="icon-btn" data-hero="save" title="Save to your playlists">${icon("save", 22)}</button>`;
    const label = { shared: "Shared playlist", ytlist: "YouTube playlist", mix: "Daily mix", weekly: "Made for you" }[p.kind];
    return {
      markup:
        hero({ art: artUrl(tracks.find((t) => t.thumbnail)), fallback: "playlist", label, title: name, meta: meta.filter(Boolean).join(" · "), tracks, extra }) +
        list,
      mount: () => {
        if (tracks.length) mountTrackList($("#page-list"), tracks, { from: name });
        else $("#page-list").innerHTML = emptyState("playlist", "None of these songs were found", "They may have been taken off YouTube Music.");
        bindHero(tracks, name);
        const save = document.querySelector<HTMLButtonElement>('[data-hero="save"]');
        save?.addEventListener("click", () => void saveShared(name, tracks, save));
      },
    };
  }
  const pl = await api.playlist(p.id);
  // Nothing left to put in order (songs removed meanwhile).
  if (reordering === pl.id && pl.tracks.length < 2) reordering = null;
  const extra = `<button class="icon-btn" data-hero="more" title="More">${icon("more", 22)}</button>`;
  const meta = [count(pl.tracks.length, "song"), totalTime(pl.tracks)].filter(Boolean).join(" · ") || "Empty";
  return {
    markup:
      hero({ art: pl.cover ? imgUrl(pl.cover) : artUrl(pl.tracks.find((t) => t.thumbnail)), fallback: "playlist", label: pl.source ? "Imported playlist" : "Playlist", title: pl.name, meta, tracks: pl.tracks, extra }) +
      (reordering === pl.id
        ? `<div class="order-bar"><span>${icon("drag", 20)}Drag the dots to move songs</span><button class="btn primary" id="order-done">Done</button></div>`
        : pl.tracks.length > 1
          ? listTools()
          : "") +
      list,
    mount: () => {
      const el = $("#page-list");
      // What the list shows, found and sorted; the hero's Play plays it.
      const shown: Track[] = [];
      if (!pl.tracks.length) {
        el.innerHTML = emptyState("playlist", "This playlist is empty", phone ? "Tap ⋮ on any song and choose Add to playlist." : "Right-click any song and choose Add to playlist.");
      } else {
        const save = (tracks: Track[]) => void savePlaylist(pl.id, tracks);
        const without = (i: number) => pl.tracks.filter((t) => t !== shown[i]);
        bindListTools(`playlist:${pl.id}`, pl.tracks, "Custom order", (list) => {
          shown.splice(0, shown.length, ...list);
          if (!list.length) return void (el.innerHTML = emptyState("search", "No songs match", "Try another word."));
          mountTrackList(el, shown, {
            from: pl.name,
            menu: (i) => [{ label: "Remove from this playlist", icon: "trash", run: () => save(without(i)) }],
            swipeLeft: {
              label: "Remove",
              icon: "trash",
              run: (i) => {
                save(without(i));
                toast(`Removed from ${pl.name}`, "info", { label: "Undo", run: () => save(pl.tracks) });
              },
            },
            // Dragging only makes sense in the playlist's own order. Phones show
            // handles only after "Change order", so a stray touch can't move songs.
            reorder:
              (!phone || reordering === pl.id) && list.length === pl.tracks.length && list.every((t, i) => t === pl.tracks[i])
                ? (from, to) => {
                    const tracks = pl.tracks.slice();
                    const [moved] = tracks.splice(from, 1);
                    tracks.splice(to, 0, moved);
                    save(tracks);
                  }
                : undefined,
          });
        });
      }
      bindHero(shown, pl.name);
      document.getElementById("order-done")?.addEventListener("click", () => changeOrder(pl.id, false));
      document.querySelector<HTMLElement>('[data-hero="more"]')?.addEventListener("click", (e) =>
        menuUnder(e, [
          ...(pl.tracks.length
            ? [
                { label: "Add all to…", icon: "playlistAdd", keep: true, run: () => showMenu(playlistMenu(pl.tracks, { skip: pl.id, liked: true })) } satisfies MenuItem,
                { label: "Start radio", icon: "radio", run: () => void startRadio(pl.tracks, `${pl.name} radio`) } satisfies MenuItem,
                { label: "Share", icon: "share", run: () => shareTracks(pl.name, pl.tracks) } satisfies MenuItem,
                autoItem(pl.id),
              ]
            : []),
          pinItem(pl.id),
          ...orderItem(pl.id, pl.tracks.length),
          { label: "Rename…", icon: "edit", divider: pl.tracks.length > 0, run: () => void renamePlaylist(pl.id, pl.name) },
          ...coverItems(pl.id, !!pl.cover),
          { label: "Delete playlist", icon: "trash", run: () => void deletePlaylist(pl.id, pl.name) },
        ]),
      );
    },
  };
}

const QUALITIES: { id: DownloadQuality; name: string; note: string }[] = [
  { id: "high", name: "High", note: "About 160 kbps · bigger files" },
  { id: "normal", name: "Normal", note: "About 128 kbps" },
  { id: "low", name: "Data saver", note: "About 70 kbps · smallest files" },
];

/** The engine, playback, the tab bar's look (phones), download quality, your own music and backups. */
function renderSettings() {
  const ready = !!engine?.installed;
  const quality = settings.get<DownloadQuality>("downloadQuality", "normal");
  const row = (id: string, iconName: IconName, title: string, sub: string) =>
    `<button class="setting" id="${id}">${icon(iconName, 24)}<span><b>${title}</b><small>${sub}</small></span>${icon("chevronRight", 20)}</button>`;
  const toggle = (id: string, iconName: IconName, title: string, sub: string, on: boolean) =>
    `<button class="setting" id="${id}" role="switch" aria-checked="${on}">${icon(iconName, 24)}
      <span><b>${title}</b><small>${sub}</small></span><i class="switch"></i>
    </button>`;
  $("#view").innerHTML = `
    ${backBar()}
    <header class="view-head"><h1>Settings</h1></header>
    <h2 class="section-label">Download engine</h2>
    <div class="box engine-box">
      <div class="engine-line">
        <b>yt-dlp</b><span class="mono">${esc(engine?.version ?? "")}</span>
        <span class="pill ${ready ? "ok" : "warn"}"><i></i>${ready ? "Ready" : "Not set up"}</span>
      </div>
      <button class="btn outline" id="ytdlp-update">${icon("refresh", 18)}Check for updates</button>
    </div>
    <h2 class="section-label">Playback</h2>
    <div class="box">
      <label class="setting range-setting">${icon("crossfade", 24)}
        <span><b>Crossfade</b><small id="xf-value"></small></span>
        <input type="range" class="slider" id="xf" min="0" max="${MAX_CROSSFADE}" step="1" value="${player.crossfade}" aria-label="Crossfade seconds" />
      </label>
      ${toggle("fade-pause", "fade", "Fade on play and pause", "Music fades in and out instead of stopping at once", player.fadePause)}
      ${toggle("autoplay", "autoplay", "Autoplay", "When a song or list ends, similar songs keep playing", player.autoplay)}
    </div>
    ${
      phone
        ? `<h2 class="section-label">Look</h2>
    <div class="box">
      ${toggle("float-nav", "floatBar", "Floating tab bar", "The tabs join the playing song in one see-through bubble", floatNav())}
    </div>`
        : ""
    }
    ${phone ? `<h2 class="section-label">Downloads</h2><div class="box">${row("open-downloads", "downloadDone", "Downloaded songs", downloadsNote())}</div>` : ""}
    <h2 class="section-label">Download quality</h2>
    <div class="box" id="dl-quality">
      ${QUALITIES.map(
        (q) => `<button class="setting choice" data-quality="${q.id}" aria-pressed="${q.id === quality}">
          <i class="tick">${icon("check", 22)}</i><span><b>${q.name}</b><small>${q.note}</small></span>
        </button>`,
      ).join("")}
    </div>
    <p class="setting-note">Applies to new downloads. Songs you already saved keep their quality.</p>
    <h2 class="section-label">Automatic downloads</h2>
    <div class="box">
      ${toggle("auto-liked", "download", "Download liked songs", "Songs you like download by themselves", settings.get("autoDownloadLiked", false))}
      ${phone ? toggle("auto-data", "mobileData", "Use mobile data", "Also download when you're not on Wi-Fi. Songs can take a lot of data", autoOnData()) : ""}
    </div>
    <p class="setting-note">${
      phone
        ? "Playlists can download by themselves too: hold one in Library, or tap ⋮ on its page, and pick Download automatically."
        : "Playlists can download by themselves too: right-click one, or click ⋯ on its page, and pick Download automatically."
    }</p>
    <h2 class="section-label">Your music</h2>
    ${
      phone
        ? `<div class="box">
      ${row("import-files", "music", "Import songs…", "Add music files from this phone")}
      ${row("import-folder", "folder", "Import a folder…", "Every song in a folder and the folders inside it")}
    </div>
    <p class="setting-note">Cadence keeps its own copy of each song, so it stays even if the original moves. Find them in Library, under Your music.</p>`
        : `<div class="box">
      ${row("add-folder", "folder", "Add a folder…", "Every song in it, and in the folders inside")}
      ${row("open-music", "music", "Your music", count(musicCount, "song"))}
    </div>
    <p class="setting-note">Songs play from where they are, and changes in the folders show up by themselves.</p>`
    }
    ${
      phone
        ? `<h2 class="section-label">Notifications</h2>
    <div class="box">
      ${toggle("release-alerts", "bell", "New releases", "When artists and podcasts you follow put out something new", settings.get("releaseAlerts", true))}
    </div>`
        : ""
    }
    <h2 class="section-label">Hidden songs</h2>
    <div class="box">
      ${row("hidden-songs", "hide", "Songs you don't want to hear", hiddenSongs.length ? count(hiddenSongs.length, "song") : "None yet · ⋮ on a song → Don't play this song")}
    </div>
    <h2 class="section-label">Backup</h2>
    <div class="box">
      ${toggle("auto-backup", "restore", "Back up automatically", autoBackupNote(), settings.get("autoBackup", true))}
      ${row("backup", "upload", "Back up now", phone ? "Save playlists, likes and stats in Downloads" : "Save playlists and likes to a file")}
      ${row("restore", "restore", "Restore from a backup…", "Load playlists and likes from a file")}
    </div>
    <h2 class="section-label">App</h2>
    <div class="box engine-box" id="app-box"></div>`;
  renderAppBox();
  if (!appVersion) void checkAppUpdate(false);
  const xf = $<HTMLInputElement>("#xf");
  const showCrossfade = () => {
    $("#xf-value").textContent = player.crossfade ? `${player.crossfade} s between songs` : "Off";
    xf.style.setProperty("--p", `${(player.crossfade / MAX_CROSSFADE) * 100}%`);
  };
  xf.oninput = () => {
    player.setCrossfade(Number(xf.value));
    showCrossfade();
  };
  showCrossfade();
  const bindToggle = (id: string, flip: () => boolean) => {
    const el = $(`#${id}`);
    el.onclick = () => el.setAttribute("aria-checked", String(flip()));
  };
  bindToggle("fade-pause", () => (player.setFadePause(!player.fadePause), player.fadePause));
  bindToggle("autoplay", () => (player.setAutoplay(!player.autoplay), player.autoplay));
  if (phone) bindToggle("float-nav", () => setFloatNav(!floatNav()));
  if (phone) {
    bindToggle("auto-data", () => {
      const on = !autoOnData();
      settings.set("autoDownloadData", on);
      if (on) void autoDownload();
      return on;
    });
  }
  bindToggle("auto-liked", () => {
    const on = !settings.get("autoDownloadLiked", false);
    settings.set("autoDownloadLiked", on);
    if (on) void autoDownload();
    return on;
  });
  bindBack();
  $("#dl-quality").onclick = (e) => {
    const picked = (e.target as HTMLElement).closest<HTMLElement>("[data-quality]");
    if (!picked) return;
    settings.set("downloadQuality", picked.dataset.quality);
    document.querySelectorAll("#dl-quality [data-quality]").forEach((b) => b.setAttribute("aria-pressed", String(b === picked)));
  };
  if (phone) {
    $("#import-files").onclick = () => void importMusic(false);
    $("#import-folder").onclick = () => void importMusic(true);
  } else {
    $("#add-folder").onclick = () => void addFolder().then((added) => added && openMusic());
    $("#open-music").onclick = openMusic;
  }
  if (phone) $("#open-downloads").onclick = openDownloads;
  bindToggle("auto-backup", () => {
    const on = !settings.get("autoBackup", true);
    settings.set("autoBackup", on);
    if (on) void autoBackup();
    return on;
  });
  if (phone) {
    bindToggle("release-alerts", () => {
      const on = !settings.get("releaseAlerts", true);
      settings.set("releaseAlerts", on);
      watchReleases();
      if (on) void api.notificationsAllow().then((ok) => ok || toast("Turn on notifications for Cadence in Android's settings"), () => {});
      return on;
    });
  }
  $("#hidden-songs").onclick = (e) => {
    if (!hiddenSongs.length) return toast("No hidden songs. Tap ⋮ on a song and pick Don't play this song");
    menuUnder(
      e,
      hiddenSongs.map((t): MenuItem => ({ label: `${t.title} · ${t.artist}`, icon: "restore", sub: "Tap to hear it again", run: () => unhideSong(t) })),
    );
  };
  $("#backup").onclick = () => void backUp();
  $("#restore").onclick = () => void restoreBackup();
  const update = $<HTMLButtonElement>("#ytdlp-update");
  update.onclick = async () => {
    const before = engine?.version;
    update.disabled = true;
    update.lastChild!.textContent = "Checking…";
    try {
      engine = await api.ytdlpUpdate();
      toast(engine.version === before ? "yt-dlp is up to date" : `yt-dlp updated to ${engine.version}`);
    } catch (e) {
      toast(String(e), "error");
    }
    renderEngineStatus();
  };
}

// ---- app updates -------------------------------------------------------------------

/** This version and a newer one, once GitHub has been asked. */
let appVersion: { current: string; update: AppUpdate | null } | null = null;
/** Set while an update downloads; shows on Settings' button. */
let updating: string | null = null;
/** Android's "install unknown apps" screen is open; installing resumes on return. */
let installPending = false;

/** Asks GitHub for a newer version. `offer` shows the update dialog, once per version. */
async function checkAppUpdate(offer: boolean) {
  try {
    appVersion = await api.appUpdateCheck();
  } catch (e) {
    if (!offer) toast(String(e), "error");
    return;
  }
  renderAppBox();
  const next = appVersion.update;
  if (!offer || !next || settings.get("updateOffered", "") === next.version) return;
  settings.set("updateOffered", next.version);
  void openDialog({
    title: `Cadence ${next.version} is out`,
    body: `${next.notes ? `${releaseNotes(next.notes)}<br><br>` : ""}Update now? It's ${formatBytes(next.size)}, and your music and playlists stay.`,
    ok: "Update",
    cancel: "Later",
    onSubmit: async (_, status) => installAppUpdate(status),
  });
}

/** A release's notes, written in GitHub's Markdown, as the dialog shows them:
 *  **bold** stays bold and "- " lines become bullets. */
function releaseNotes(text: string): string {
  return esc(text.trim())
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/^[-*] /gm, "• ")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

/** Downloads the update and opens Android's installer, or on Windows runs the
 *  setup program, which closes Cadence and starts it again. True once the
 *  installer (or Android's permission screen) is up. */
async function installAppUpdate(status: (text: string) => void): Promise<boolean> {
  const stop = await listen<{ downloaded: number; total: number }>("update-progress", (e) => {
    const { downloaded, total } = e.payload;
    status((updating = total ? `Downloading… ${Math.floor((downloaded / total) * 100)}%` : `Downloading… ${formatBytes(downloaded)}`));
    renderAppBox();
  });
  // Windows: the setup program is running and closes Cadence in a moment.
  let installing = false;
  try {
    status((updating = "Downloading…"));
    renderAppBox();
    const opened = await api.appUpdateInstall();
    if (!opened) {
      installPending = true;
      toast("Allow Cadence to install updates, then come back");
    } else if (!phone) {
      installing = true;
      toast("Installing the update · Cadence restarts by itself");
    }
    return true;
  } finally {
    stop();
    updating = installing ? "Installing…" : null;
    renderAppBox();
  }
}

/** Settings' App box: the version, and checking for or installing an update. */
function renderAppBox() {
  const el = document.getElementById("app-box");
  if (!el) return;
  const next = appVersion?.update;
  el.innerHTML = `
    <div class="engine-line">
      <b>Cadence</b><span class="mono">${esc(appVersion?.current ?? "")}</span>
      ${appVersion ? `<span class="pill ${next ? "warn" : "ok"}"><i></i>${next ? `${esc(next.version)} is out` : "Up to date"}</span>` : ""}
    </div>
    <button class="btn ${next ? "primary" : "outline"}" id="app-update" ${updating ? "disabled" : ""}>
      ${icon(next ? "download" : "refresh", 18)}<span>${updating ?? (next ? `Update to ${esc(next.version)}` : "Check for updates")}</span>
    </button>`;
  const btn = $<HTMLButtonElement>("#app-update");
  btn.onclick = async () => {
    btn.disabled = true;
    if (!next) {
      btn.lastElementChild!.textContent = "Checking…";
      await checkAppUpdate(false);
      if (appVersion && !appVersion.update) toast("Cadence is up to date");
      return;
    }
    await installAppUpdate((text) => (btn.lastElementChild!.textContent = text)).catch((e) => toast(String(e), "error"));
  };
}

/** Phones: whether the tabs float with the playing song in one bubble. */
function floatNav(): boolean {
  return settings.get("floatNav", false);
}

function setFloatNav(on: boolean): boolean {
  settings.set("floatNav", on);
  document.documentElement.classList.toggle("float-nav", phone && on);
  return on;
}

// ---- Profile ---------------------------------------------------------------------

const PERIODS = [
  { id: "week", name: "Week", days: 7, note: "the last 7 days" },
  { id: "month", name: "Month", days: 30, note: "the last 30 days" },
  { id: "year", name: "Year", days: 365, note: "the last 12 months" },
  { id: "all", name: "All time", days: 0, note: "all" },
] as const;
type Period = (typeof PERIODS)[number]["id"];

/** Artist photos by page id. The history only has song covers, so photos are looked up once. */
const artistPhotos = new Map(Object.entries(settings.get<Record<string, string | null>>("artistPhotos", {})));

/** Your listening: minutes, top artists, songs and albums for a period. Settings is the gear. */
function renderProfile() {
  const period = settings.get<Period>("profilePeriod", "month");
  $("#view").innerHTML = `
    <header class="view-head">
      <div class="head-row">
        <h1>Profile</h1>
        <button class="icon-btn" id="open-settings" title="Settings">${icon("settings", 24)}</button>
      </div>
    </header>
    <div class="period" id="period" role="tablist">
      <i class="period-pill"></i>
      ${PERIODS.map((p) => `<button role="tab" data-period="${p.id}" aria-selected="${p.id === period}">${p.name}</button>`).join("")}
    </div>
    <button class="year-btn" id="year-btn">${icon("year", 22)}<span><b>Your ${new Date().getFullYear()} in music</b><small>A card to share, with your top artist and songs</small></span>${icon("chevronRight", 20)}</button>
    <div id="stats"></div>`;
  $("#open-settings").onclick = openSettings;
  $("#year-btn").onclick = () => void showYear();
  const bar = $("#period");
  const pick = (id: Period) => {
    bar.style.setProperty("--i", String(PERIODS.findIndex((p) => p.id === id)));
    bar.querySelectorAll("[data-period]").forEach((b) => b.setAttribute("aria-selected", String(b.getAttribute("data-period") === id)));
  };
  bar.onclick = (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-period]")?.dataset.period as Period | undefined;
    if (!id || id === settings.get("profilePeriod", "month")) return;
    settings.set("profilePeriod", id);
    pick(id);
    void loadStats(id);
  };
  pick(period);
  void loadStats(period);
}

// ---- your year in music -------------------------------------------------------------

/** Profile's "Your 2026 in music": the year so far on a story-sized card
 *  (1080×1920), drawn like the lyrics cards, to share as a picture. */
async function showYear() {
  const year = new Date().getFullYear();
  const since = Math.floor(new Date(year, 0, 1).getTime() / 1000);
  const s = await api.listeningStats(since).catch((e) => (toast(String(e), "error"), null));
  if (!s) return;
  if (!s.plays) return toast(`Nothing played in ${year} yet`);
  let card: HTMLCanvasElement;
  try {
    card = await drawYear(s, year);
  } catch (e) {
    return toast(String(e), "error");
  }
  const blob = await new Promise<Blob | null>((done) => card.toBlob(done, "image/jpeg", 0.92));
  if (!blob) return toast("Couldn't make the picture", "error");
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  await openDialog({
    title: `Your ${year} in music`,
    // A data link: the app's content rules let pictures come from those, not from blobs.
    body: `<img class="year-card" src="${card.toDataURL("image/jpeg", 0.85)}" alt="" />`,
    ok: phone ? "Share" : "Save picture",
    cancel: "Close",
    onSubmit: async () => {
      await sharePicture(jpeg, `Cadence ${year} in music`);
      return true;
    },
  });
}

/** The year card: minutes listened, the top artist with their photo, and the
 *  top five songs, on the top song's color fading into near-black. */
async function drawYear(s: ListeningStats, year: number): Promise<HTMLCanvasElement> {
  await Promise.all(['800 80px "Bricolage Grotesque"', '700 40px "Bricolage Grotesque"', '500 30px "DM Mono"'].map((f) => document.fonts.load(f)));
  const W = 1080;
  const H = 1920;
  const pad = 88;
  const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = canvas.getContext("2d")!;
  const top = s.tracks[0]?.track;
  const cover = top ? artUrl(top) : null;
  const [r, g, b] = (cover && (await artColor(cover))) || [190, 60, 70];
  const bg = ctx.createLinearGradient(0, 0, W * 0.5, H);
  bg.addColorStop(0, `rgb(${r * 0.62}, ${g * 0.62}, ${b * 0.62})`);
  bg.addColorStop(0.55, "#0b0d14");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // Red glows from the bottom corner, as the minutes card on Profile does.
  const glow = ctx.createRadialGradient(W, H, 0, W, H, W);
  glow.addColorStop(0, "rgba(229, 52, 60, 0.35)");
  glow.addColorStop(1, "rgba(229, 52, 60, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "top";
  const text = (t: string, font: string, color: string, x: number, y: number, width = W - pad - x) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(fit(ctx, t, width), x, y);
  };
  const dim = "rgba(238, 240, 246, 0.72)";
  ctx.drawImage(markCanvas(64), pad, 92);
  text("cadence", '800 46px "Bricolage Grotesque"', "#eef0f6", pad + 80, 100);
  text("YOUR YEAR IN MUSIC", '500 32px "DM Mono"', dim, pad, 236);
  text(String(year), '800 230px "Bricolage Grotesque"', "#ffffff", pad - 8, 270);
  text(Math.round(s.seconds / 60).toLocaleString(), '800 150px "Bricolage Grotesque"', "#ffffff", pad, 540);
  text(`MINUTES LISTENED · ${count(s.plays, "play").toUpperCase()}`, '500 30px "DM Mono"', dim, pad, 700);
  // The top artist, round, beside their name.
  const artist = s.artists[0];
  if (artist) {
    const photoUrl = imgUrl((artist.id && artistPhotos.get(artist.id)) || artist.thumbnail);
    const photo = photoUrl ? await loadImage(photoUrl) : null;
    const size = 240;
    const y = 800;
    ctx.save();
    ctx.beginPath();
    ctx.arc(pad + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = "#1c1f2b";
    ctx.fill();
    ctx.clip();
    if (photo) ctx.drawImage(photo, pad, y, size, size);
    ctx.restore();
    const x = pad + size + 40;
    text("TOP ARTIST", '500 30px "DM Mono"', "rgba(240, 120, 125, 1)", x, y + 46);
    text(artist.name, '800 72px "Bricolage Grotesque"', "#ffffff", x, y + 88);
    text(count(artist.plays, "play"), '500 30px "DM Mono"', dim, x, y + 176);
  }
  // The top five songs, each with its cover.
  text("TOP SONGS", '500 30px "DM Mono"', "rgba(240, 120, 125, 1)", pad, 1120);
  const rows = s.tracks.slice(0, 5);
  for (const [i, row] of rows.entries()) {
    const y = 1180 + i * 130;
    text(String(i + 1), '500 40px "DM Mono"', i ? dim : "rgba(240, 120, 125, 1)", pad, y + 30);
    const url = artUrl(row.track);
    const art = url ? await loadImage(url) : null;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(pad + 64, y, 104, 104, 14);
    ctx.fillStyle = "#1c1f2b";
    ctx.fill();
    ctx.clip();
    if (art) ctx.drawImage(art, pad + 64, y, 104, 104);
    ctx.restore();
    text(row.track.title, '700 44px "Bricolage Grotesque"', "#ffffff", pad + 196, y + 10);
    text(row.track.artist.toUpperCase(), '500 28px "DM Mono"', dim, pad + 196, y + 64);
  }
  return canvas;
}

let statsToken = 0;

async function loadStats(period: Period) {
  const token = ++statsToken;
  const p = PERIODS.find((x) => x.id === period)!;
  const since = p.days ? Math.floor(Date.now() / 1000) - p.days * 86400 : 0;
  const el = $("#stats");
  el.classList.add("dim");
  try {
    const stats = await api.listeningStats(since);
    if (token !== statsToken || !el.isConnected) return;
    renderStats(el, stats, p.days ? `in ${p.note}` : "so far");
  } catch (e) {
    if (token === statsToken) el.innerHTML = emptyState("music", "Couldn't load your listening", esc(String(e)));
  }
  el.classList.remove("dim");
}

function renderStats(el: HTMLElement, s: ListeningStats, when: string) {
  if (!s.plays) {
    el.innerHTML = emptyState(
      "music",
      "Nothing here yet",
      `Songs you listen to for 30 seconds or more count here. Nothing was played ${when === "so far" ? "yet" : when}.`,
    );
    return;
  }
  // Each part rises in a moment after the one before it.
  let step = 0;
  const rise = () => `rise" style="--d: ${step++}`;
  const photo = (a: ListeningStats["artists"][number]) => imgUrl((a.id && artistPhotos.get(a.id)) || a.thumbnail);
  const artist = (a: ListeningStats["artists"][number], i: number, big = false) => {
    const art = photo(a);
    const tag = a.id ? `button data-go="artist:${esc(a.id)}"` : "div";
    return `<${tag} class="${big ? "top-artist" : "artist-chip"} ${rise()}">
      <span class="ta-photo" ${a.id ? `data-photo="${esc(a.id)}"` : ""}>${art ? `<img src="${esc(art)}" alt="" draggable="false" />` : icon("person", big ? 40 : 24)}</span>
      <span class="ta-rank">${i + 1}</span>
      <span class="ta-text"><b>${esc(a.name)}</b><small>${count(a.plays, "play")}</small></span>
    </${tag.split(" ")[0]}>`;
  };
  const [top, ...rest] = s.artists;
  el.innerHTML = `
    <section class="stat-hero ${rise()}">
      <span class="stat-label">Minutes listened</span>
      <b class="stat-num" id="stat-minutes">0</b>
      <span class="stat-sub">${count(s.plays, "play")} ${when}</span>
    </section>
    ${top ? `<h2 class="section-label ${rise()}">Top artists</h2>${artist(top, 0, true)}<div class="artist-row">${rest.map((a, i) => artist(a, i + 1)).join("")}</div>` : ""}
    <h2 class="section-label ${rise()}">Top songs</h2>
    <div class="track-list top-songs" id="top-songs"></div>
    ${
      s.albums.length
        ? `<h2 class="section-label ${rise()}">Top albums</h2>
      <div class="top-albums">${s.albums
        .map((a, i) => {
          const target = a.id ? `album:${a.id}` : null;
          const art = imgUrl(a.thumbnail);
          return `<${target ? `button data-go="${esc(target)}"` : "div"} class="top-album ${rise()}">
            <span class="al-art">${art ? `<img src="${esc(art)}" alt="" loading="lazy" draggable="false" />` : icon("album", 32)}<span class="ta-rank">${i + 1}</span></span>
            <b>${esc(a.title)}</b><small>${esc(a.artist)} · ${count(a.plays, "play")}</small>
          </${target ? "button" : "div"}>`;
        })
        .join("")}</div>`
        : ""
    }`;
  const tracks = s.tracks.map((t) => t.track);
  const list = $("#top-songs");
  mountTrackList(list, tracks, { from: "Your top songs" });
  // Each song gets its rank and a bar for how often it played, next to the top one.
  const most = s.tracks[0]?.plays ?? 1;
  list.querySelectorAll<HTMLElement>(".track").forEach((row, i) => {
    const plays = s.tracks[i].plays;
    row.classList.add("rise");
    row.style.setProperty("--d", String(step + i));
    row.style.setProperty("--w", String(plays / most));
    row.insertAdjacentHTML("afterbegin", `<span class="ts-rank">${i + 1}</span>`);
    row.querySelector(".track-main")?.insertAdjacentHTML("beforeend", `<span class="ts-plays"><i></i>${count(plays, "play")}</span>`);
  });
  countUp($("#stat-minutes"), Math.round(s.seconds / 60));
  void loadArtistPhotos(el, s.artists);
}

/** Counts a number up from zero, slowing towards the end. */
function countUp(el: HTMLElement, to: number, ms = 1100) {
  const start = performance.now();
  const frame = (now: number) => {
    if (!el.isConnected) return;
    const k = Math.min(1, (now - start) / ms);
    el.textContent = Math.round(to * (1 - (1 - k) ** 3)).toLocaleString();
    if (k < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Swaps song covers for the artists' own photos as they arrive. */
async function loadArtistPhotos(el: HTMLElement, artists: ListeningStats["artists"]) {
  const missing = artists.filter((a) => a.id && !artistPhotos.has(a.id));
  if (!missing.length) return;
  await Promise.all(
    missing.map(async (a) => {
      try {
        artistPhotos.set(a.id!, (await api.artist(a.id!)).thumbnail);
      } catch {
        /* the song cover stays */
      }
    }),
  );
  settings.set("artistPhotos", Object.fromEntries(artistPhotos));
  for (const a of missing) {
    const url = imgUrl(artistPhotos.get(a.id!));
    const slot = el.querySelector<HTMLElement>(`[data-photo="${CSS.escape(a.id!)}"]`);
    if (!url || !slot) continue;
    // It loads before it is in the page, so the load listener that marks
    // pictures `shown` (phone.css fades them in) never sees it.
    const img = Object.assign(new Image(), { src: url, alt: "", draggable: false, className: "fade-in shown" });
    img.onload = () => slot.replaceChildren(img);
  }
}

// ---- finding and sorting in lists ------------------------------------------------

type SortBy = "custom" | "title" | "artist" | "album";

/** How each list is sorted ("liked", "playlist:3"); not set means its own order. */
const listSorts = settings.get<Record<string, SortBy>>("listSorts", {});

/** A box that finds songs in the list below, and a button that sorts it. */
function listTools(): string {
  return `<div class="list-tools">
    <label class="find-box">${icon("search", 18)}<input id="find" type="search" placeholder="Find in this list" spellcheck="false" autocomplete="off" /></label>
    <button class="icon-btn" id="sort-btn" title="Sort">${icon("sort", 22)}</button>
  </div>`;
}

/**
 * Shows `tracks` through `show`, then again each time the find box or the
 * sort changes. `own` names the list's own order ("Recently added").
 */
function bindListTools(key: string, tracks: Track[], own: string, show: (shown: Track[]) => void) {
  const find = document.querySelector<HTMLInputElement>("#find");
  const sortBtn = document.getElementById("sort-btn");
  const apply = () => show(arrange(tracks, listSorts[key] ?? "custom", find?.value ?? ""));
  if (find && sortBtn) {
    find.oninput = debounce(apply, 150);
    const mark = () => sortBtn.classList.toggle("on", (listSorts[key] ?? "custom") !== "custom");
    mark();
    sortBtn.onclick = (e) => {
      const options: [SortBy, string, IconName][] = [
        ["custom", own, "playlist"],
        ["title", "Title", "music"],
        ["artist", "Artist", "person"],
        ["album", "Album", "album"],
      ];
      menuUnder(
        e,
        options.map(([id, label, iconName]): MenuItem => ({
          label,
          icon: iconName,
          on: (listSorts[key] ?? "custom") === id,
          run: () => {
            if (id === "custom") delete listSorts[key];
            else listSorts[key] = id;
            settings.set("listSorts", listSorts);
            mark();
            apply();
          },
        })),
      );
    };
  }
  apply();
}

/** The songs whose title, artist or album has every word of `query`, sorted by `by`. */
function arrange(tracks: Track[], by: SortBy, query: string): Track[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = words.length
    ? tracks.filter((t) => {
        const text = `${t.title} ${t.artist} ${t.album ?? ""}`.toLowerCase();
        return words.every((w) => text.includes(w));
      })
    : tracks.slice();
  if (by !== "custom") {
    const order = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
    const field = (t: Track) => (by === "title" ? t.title : by === "artist" ? t.artist : (t.album ?? ""));
    out.sort((a, b) => order.compare(field(a), field(b)) || order.compare(a.title, b.title));
  }
  return out;
}

// ---- daily mixes -----------------------------------------------------------------

interface Mix {
  name: string;
  /** The artists heard most in it, the one it's made around first. */
  artists: string[];
  tracks: Track[];
}

/** Today's mixes, made once a day from what you play and like. */
let mixes = settings.get<{ day: string; mixes: Mix[] }>("dailyMixes", { day: "", mixes: [] });
let mixing = false;

function mixList(index: number): { name: string; tracks: Track[]; missing: number } {
  const mix = mixes.mixes[index];
  if (!mix) throw new Error("A new mix is made each day; this one is gone.");
  return { name: mix.name, tracks: mix.tracks, missing: 0 };
}

/**
 * Home's Made for you: Discover Weekly, Release Radar, then today's mixes, in a
 * row; each made the first time Home shows once it's due.
 */
async function renderMixes() {
  const draw = () => {
    const el = document.getElementById("home-mixes");
    if (!el) return;
    const lists = WEEKLY.flatMap((w) => {
      const list = weekly[w.kind];
      return list?.tracks.length ? [{ target: `weekly:${w.kind}`, art: imgUrl(list.tracks[0].thumbnail), title: topArtists(list.tracks).join(", "), badge: w.name }] : [];
    });
    const items = mixes.mixes.map((m, i) => ({ target: `mix:${i}`, art: imgUrl(m.tracks[0]?.thumbnail), title: m.artists.join(", "), badge: m.name }));
    el.innerHTML = cards("Made for you", [...lists, ...items], false, true);
  };
  draw();
  for (const w of WEEKLY) void makeWeekly(w, draw);
  const day = new Date().toDateString();
  if (mixes.day === day || mixing) return;
  mixing = true;
  try {
    const made = await makeMixes();
    // Offline, say: keep yesterday's.
    if (made.length) {
      mixes = { day, mixes: made };
      settings.set("dailyMixes", mixes);
      draw();
    }
  } finally {
    mixing = false;
  }
}

/** The first artist of a song, for grouping. */
function mainArtist(t: Track): string {
  return (t.artists?.[0]?.name ?? t.artist.split(",")[0]).trim();
}

/**
 * Up to four mixes, each made around one of the ten artists you play most this
 * month (then the ones you've liked most), a different few each day: a few of
 * your songs by them, and songs like those from YouTube Music's radio, mixed.
 */
async function makeMixes(): Promise<Mix[]> {
  const stats = await api.listeningStats(Math.floor(Date.now() / 1000) - 30 * 86400).catch(() => null);
  const songs = new Map<string, Track[]>();
  const add = (t: Track) => {
    const name = mainArtist(t);
    if (!t.id.startsWith("yt:") || !name) return;
    const list = songs.get(name) ?? [];
    if (!list.some((s) => s.id === t.id)) list.push(t);
    songs.set(name, list);
  };
  stats?.tracks.forEach((s) => add(s.track));
  [...liked.values()].forEach(add);
  const plays = new Map(stats?.artists.map((a) => [a.name, a.plays]) ?? []);
  const artists = [...songs.keys()].sort((a, b) => (plays.get(b) ?? 0) * 10 + songs.get(b)!.length - ((plays.get(a) ?? 0) * 10 + songs.get(a)!.length));
  // A new set each day: from your top ten, the ones yesterday's mixes weren't made around go first.
  const before = new Set(mixes.mixes.map((m) => m.artists[0]));
  const pool = shuffled(artists.slice(0, 10));
  const order = [...pool.filter((a) => !before.has(a)), ...pool.filter((a) => before.has(a))];
  const used = new Set<string>();
  const out: Mix[] = [];
  for (const artist of order) {
    if (out.length === 4) break;
    const own = shuffled(songs.get(artist)!).filter((t) => !used.has(t.id) && !player.hidden.has(t.id)).slice(0, 8);
    if (!own.length) continue;
    const radio = await api.recommendations(own.slice(0, 3).map((t) => t.id), [...used, ...own.map((t) => t.id), ...player.hidden]).catch(() => [] as Track[]);
    if (radio.length < 10) continue;
    // One of your songs, then two new ones, and so on.
    const tracks: Track[] = [];
    const theirs = radio.slice(0, 32);
    while (own.length || theirs.length) {
      if (own.length) tracks.push(own.shift()!);
      tracks.push(...theirs.splice(0, 2));
    }
    tracks.forEach((t) => used.add(t.id));
    const count = new Map<string, number>();
    for (const t of tracks) count.set(mainArtist(t), (count.get(mainArtist(t)) ?? 0) + 1);
    const others = [...count.keys()].filter((a) => a !== artist).sort((a, b) => count.get(b)! - count.get(a)!);
    out.push({ name: `Daily Mix ${out.length + 1}`, artists: [artist, ...others.slice(0, 2)], tracks });
  }
  return out;
}

// ---- Discover Weekly and Release Radar -------------------------------------------

type WeeklyKind = "discover" | "radar";

/** As in Spotify: Discover Weekly comes on Mondays, Release Radar on Fridays. */
const WEEKLY: { kind: WeeklyKind; name: string; weekday: number; make: () => Promise<Track[] | null> }[] = [
  { kind: "discover", name: "Discover Weekly", weekday: 1, make: makeDiscover },
  { kind: "radar", name: "Release Radar", weekday: 5, make: makeRadar },
];

interface WeeklyList {
  /** The day it was made for: its Monday or Friday. */
  week: string;
  tracks: Track[];
}

/**
 * This week's lists, and the albums and singles Release Radar has seen
 * (YouTube Music gives a release's year, not its date: one not seen before is new).
 */
let weekly = settings.get<{ discover?: WeeklyList; radar?: WeeklyList; seen: string[]; used?: string[] }>("weekly", { seen: [] });
const making = new Set<WeeklyKind>();
/** When making each last failed (offline, say): it waits a few hours to try again. */
const weeklyFailed = new Map<WeeklyKind, number>();

/** Whether `w` should be made now: its day has come round, and it didn't just fail. */
function weeklyDue(w: (typeof WEEKLY)[number]): boolean {
  return weekly[w.kind]?.week !== lastWeekday(w.weekday) && Date.now() - (weeklyFailed.get(w.kind) ?? 0) > 3 * 3600_000;
}

/** The last `weekday` (0 is Sunday), today included. */
function lastWeekday(weekday: number): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() - weekday + 7) % 7));
  return d.toDateString();
}

/** Whether a mix or weekly list is due, when the app comes back to Home. */
function madeForYouDue(): boolean {
  return mixes.day !== new Date().toDateString() || WEEKLY.some(weeklyDue);
}

function weeklyList(which: WeeklyKind): { name: string; tracks: Track[]; missing: number } {
  const list = weekly[which];
  const w = WEEKLY.find((w) => w.kind === which)!;
  if (!list) throw new Error(`${w.name} isn't made yet.`);
  return { name: w.name, tracks: list.tracks, missing: 0 };
}

/**
 * Makes `w` when its day has come round; offline, last week's stays. With
 * nothing to put in it (no new releases at all, say), it's empty till next week.
 */
async function makeWeekly(w: (typeof WEEKLY)[number], done: () => void) {
  const week = lastWeekday(w.weekday);
  if (!weeklyDue(w) || making.has(w.kind)) return;
  making.add(w.kind);
  try {
    const tracks = await w.make();
    if (!tracks) {
      weeklyFailed.set(w.kind, Date.now());
      return;
    }
    // An empty one keeps last week's songs on Home, but counts as made.
    weekly = { ...weekly, [w.kind]: { week, tracks: tracks.length ? tracks : (weekly[w.kind]?.tracks ?? []) } };
    settings.set("weekly", weekly);
    done();
  } finally {
    making.delete(w.kind);
  }
}

/** The artists heard most in a list, for its card. */
function topArtists(tracks: Track[], n = 3): string[] {
  const count = new Map<string, number>();
  for (const t of tracks) count.set(mainArtist(t), (count.get(mainArtist(t)) ?? 0) + 1);
  return [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)!).slice(0, n);
}

/**
 * Thirty songs you've never played (nor liked or hidden), like the ones you
 * play most this month and some you've liked; two at most by one artist.
 */
async function makeDiscover(): Promise<Track[] | null> {
  const [stats, played] = await Promise.all([
    api.listeningStats(Math.floor(Date.now() / 1000) - 30 * 86400).catch(() => null),
    api.playedIds().catch(() => null),
  ]);
  if (!played) return null;
  const seen = new Set<string>();
  const seeds = shuffled([...(stats?.tracks.map((s) => s.track) ?? []), ...shuffled([...liked.values()]).slice(0, 20)]).filter(
    (t) => t.id.startsWith("yt:") && !seen.has(t.id) && seen.add(t.id),
  );
  const skip = new Set([...played, ...liked.keys(), ...player.hidden]);
  const picks: Track[] = [];
  const by = new Map<string, number>();
  let reached = false;
  // Six seeds a time, as YouTube Music's radio takes them, until there are enough.
  for (let i = 0; i < seeds.length && i < 24 && picks.length < 30; i += 6) {
    const radio = await api.recommendations(seeds.slice(i, i + 6).map((t) => t.id), [...skip]).then(
      (r) => ((reached = true), r),
      () => [] as Track[],
    );
    for (const t of radio) {
      const artist = mainArtist(t).toLowerCase();
      if (picks.length === 30 || skip.has(t.id) || (by.get(artist) ?? 0) >= 2) continue;
      by.set(artist, (by.get(artist) ?? 0) + 1);
      skip.add(t.id);
      picks.push(t);
    }
  }
  // Seeds, but YouTube Music couldn't be reached: try again later.
  if (seeds.length && !reached) return null;
  return shuffled(picks);
}

/**
 * New songs from the artists you follow and the ones you play most this
 * month: singles whole, an album's first two songs; thirty at most.
 */
async function makeRadar(): Promise<Track[] | null> {
  const stats = await api.listeningStats(Math.floor(Date.now() / 1000) - 30 * 86400).catch(() => null);
  const artists = new Map<string, string>();
  for (const a of stats?.artists ?? []) if (a.id) artists.set(a.id, a.name);
  for (const a of following.slice(0, 20)) artists.set(a.id, a.name);
  const pages = await Promise.all([...artists.keys()].slice(0, 30).map((id) => api.artist(id).catch(() => null)));
  if (pages.every((p) => !p)) return null;
  const year = new Date().getFullYear();
  const seen = new Set(weekly.seen);
  const recent = (r: Release) => Number(r.year) >= year - 1;
  // Unseen ones first (none the first week), topped up with each artist's two
  // newest, ones that weren't in last week's first; mixed, so a quiet week still changes.
  const releases = (p: Artist | null) => [...(p?.singles ?? []), ...(p?.albums ?? [])].filter(recent);
  const used = new Set(weekly.used);
  const unseen = weekly.seen.length ? pages.flatMap((p) => releases(p).filter((r) => !seen.has(r.id))) : [];
  const newest = pages.flatMap((p) => [...releases(p).filter((r) => !used.has(r.id)), ...releases(p).filter((r) => used.has(r.id))].slice(0, 2));
  // This year's unseen before last year's: an artist new to the list brings all of both.
  const thisYear = (r: Release) => Number(r.year) === year;
  const fresh = [
    ...shuffled(unseen.filter(thisYear)),
    ...shuffled(unseen.filter((r) => !thisYear(r))),
    ...shuffled(newest.filter((r) => !unseen.some((u) => u.id === r.id))),
  ];
  const albums = await Promise.all(fresh.slice(0, 20).map((r) => api.album(r.id).catch(() => null)));
  if (fresh.length && albums.every((a) => !a)) return null;
  const lists = albums.map((a) => (a ? (a.subtitle.startsWith("Album") ? a.tracks.slice(0, 2) : a.tracks).filter((t) => !player.hidden.has(t.id)) : []));
  // A song from each release in turn, so one album doesn't fill it.
  const tracks: Track[] = [];
  const ids = new Set<string>();
  for (let i = 0; lists.some((l) => i < l.length) && tracks.length < 30; i++) {
    for (const l of lists) if (l[i] && tracks.length < 30 && !ids.has(l[i].id)) ids.add(l[i].id) && tracks.push(l[i]);
  }
  // Once it's made, everything on the pages counts as seen; the newest are kept.
  if (tracks.length) {
    const all = pages.flatMap((p) => (p ? [...p.singles, ...p.albums].map((r) => r.id) : []));
    weekly = { ...weekly, seen: [...new Set([...all, ...weekly.seen])].slice(0, 3000), used: fresh.slice(0, 20).map((r) => r.id) };
  }
  return tracks;
}

// ---- radio, sleep timer, queue and pins -----------------------------------------

/**
 * Plays songs like `seeds` (YouTube Music's radio for up to six of them,
 * mixed). With `first`, that song plays now and the radio after it.
 */
async function startRadio(seeds: Track[], name: string, first?: Track) {
  const ids = shuffled(seeds.filter((t) => t.id.startsWith("yt:"))).slice(0, 6).map((t) => t.id);
  if (!ids.length) return toast("Radio needs songs from YouTube Music", "error");
  if (first && player.current?.id === first.id) {
    // The song playing goes on; the radio follows it.
    player.from = name;
    updateNowExtras();
  } else if (first) {
    player.playList([first], 0, name);
    setNowPlayingOpen(true);
  } else toast("Starting radio…");
  try {
    const songs = await api.recommendations(ids, [...(first ? [first.id] : []), ...player.hidden]);
    if (!songs.length) return toast("No radio for this one yet", "error");
    if (!first) player.playList(songs, 0, name);
    else if (player.current?.id === first.id) player.setUpcoming(songs);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** When the sleep timer stops the music (ms since 1970), "end" for the end of the song, or null. */
let sleepAt: number | "end" | null = null;
let sleepTimer: number | undefined;

const SLEEP_TIMES: [string, number | "end"][] = [
  ["15 minutes", 15],
  ["30 minutes", 30],
  ["45 minutes", 45],
  ["1 hour", 60],
  ["End of this song", "end"],
];

function sleepItem(): MenuItem {
  return {
    label: "Sleep timer",
    icon: "moon",
    sub: sleepNote() ?? "Stops the music after a while",
    on: sleepAt !== null,
    keep: true,
    run: () =>
      showMenu([
        ...SLEEP_TIMES.map(([label, at]): MenuItem => ({ label, icon: "moon", run: () => setSleep(at) })),
        ...(sleepAt !== null ? [{ label: "Turn off", icon: "close", divider: true, run: () => setSleep(null) } satisfies MenuItem] : []),
      ]),
  };
}

function setSleep(at: number | "end" | null) {
  clearTimeout(sleepTimer);
  player.stopAtEnd = at === "end";
  sleepAt = typeof at === "number" ? Date.now() + at * 60_000 : at;
  // A timer in a page that's in the background can be late; the song's
  // time updates check too (checkSleep).
  if (typeof at === "number") sleepTimer = window.setTimeout(checkSleep, at * 60_000);
  toast(at === null ? "Sleep timer off" : at === "end" ? "The music stops after this song" : `The music stops in ${at === 60 ? "1 hour" : `${at} minutes`}`);
  showSleep();
}

function checkSleep() {
  if (typeof sleepAt === "number" && Date.now() >= sleepAt) {
    sleepAt = null;
    player.pause();
  }
  // "End of this song" is done once the player has used it up.
  if (sleepAt === "end" && !player.stopAtEnd) sleepAt = null;
  showSleep();
}

/** "Stops in 23 min", or null with no timer. */
function sleepNote(): string | null {
  if (sleepAt === "end") return "Stops after this song";
  if (typeof sleepAt !== "number") return null;
  return `Stops in ${Math.max(1, Math.ceil((sleepAt - Date.now()) / 60_000))} min`;
}

/** Now Playing's small line over the list's name shows a moon and the time left. */
function showSleep() {
  // The desktop's Now Playing panel says it in its header.
  const head = document.getElementById("np-panel-from");
  if (head) head.textContent = sleepNote() ?? (player.from || "Now playing");
  const from = document.getElementById("np-from");
  const label = from?.querySelector("span");
  if (!from || !label) return;
  from.classList.toggle("sleeping", sleepAt !== null);
  from.hidden = !player.from && sleepAt === null;
  if (sleepAt === null) return void (label.textContent = "Playing from");
  const left = sleepAt === "end" ? "after this song" : `in ${Math.max(1, Math.ceil((sleepAt - Date.now()) / 60_000))} min`;
  label.innerHTML = `${icon("moon", 12)} Stops ${left}`;
}

/** Pinned playlists, which come first on Home and in Library. */
let pinned = settings.get<number[]>("pinnedPlaylists", []);

function pinItem(id: number): MenuItem {
  const on = pinned.includes(id);
  return {
    label: on ? "Unpin" : "Pin to the top",
    icon: "pin",
    on,
    run: () => {
      pinned = on ? pinned.filter((p) => p !== id) : [...pinned, id];
      settings.set("pinnedPlaylists", pinned);
      void refreshPlaylists();
    },
  };
}

/** Queue: Save makes the songs from the playing one on a playlist; Clear can be undone. */
function bindQueueTools() {
  const save = $("#queue-save");
  save.hidden = false;
  save.onclick = () => {
    const songs = player.queue.slice(Math.max(0, player.index));
    if (songs.length) void newPlaylist(songs);
  };
  $("#queue-clear").onclick = () => {
    const upcoming = player.queue.slice(player.index + 1);
    if (!upcoming.length) return;
    player.clearUpcoming();
    toast("Queue cleared", "info", { label: "Undo", run: () => player.setUpcoming(upcoming) });
  };
}

// ---- automatic downloads ---------------------------------------------------------

/** Playlists whose songs download by themselves (on phones, on Wi-Fi unless mobile data is allowed). */
let autoLists = settings.get<number[]>("autoDownloadLists", []);

/** Phones: whether automatic downloads may use mobile data too (Settings). */
function autoOnData(): boolean {
  return settings.get("autoDownloadData", false);
}

function autoItem(id: number): MenuItem {
  const on = autoLists.includes(id);
  return {
    label: "Download automatically",
    icon: "download",
    sub: autoOnData() ? (on ? "On · new songs download by themselves" : "New songs download by themselves") : on ? "On · new songs download on Wi-Fi" : "New songs download on Wi-Fi",
    on,
    run: () => {
      autoLists = on ? autoLists.filter((l) => l !== id) : [...autoLists, id];
      settings.set("autoDownloadLists", autoLists);
      toast(on ? "Stopped downloading automatically" : phone && !autoOnData() ? "Downloads automatically on Wi-Fi" : "Downloads automatically");
      if (!on) void autoDownload();
    },
  };
}

let autoRunning = false;

/**
 * Downloads liked songs and the chosen playlists' songs that aren't saved
 * yet, on phones on Wi-Fi only unless Settings allows mobile data. Runs when
 * the app opens or comes back, when the connection changes, and when songs
 * are liked or added.
 */
async function autoDownload() {
  if (autoRunning || !engine?.installed) return;
  const likedOn = settings.get("autoDownloadLiked", false);
  if (!likedOn && !autoLists.length) return;
  autoRunning = true;
  try {
    if (!autoOnData() && !(await api.unmetered())) return;
    const tracks = likedOn ? [...liked.values()] : [];
    for (const id of autoLists) {
      // A deleted playlist is just skipped.
      tracks.push(...(await api.playlist(id).then((p) => p.tracks, () => [])));
    }
    const todo = notDownloaded(tracks);
    if (todo.length) await api.downloadAdd(todo, settings.get<DownloadQuality>("downloadQuality", "normal"));
  } catch {
    // Tried again next time.
  } finally {
    autoRunning = false;
  }
}

// ---- following artists -----------------------------------------------------------

/** Followed artists, latest first. */
let following = settings.get<ArtistRef[]>("following", []);
/** Albums and singles from followed artists, as Home last showed them;
 *  `key` says who was followed then. */
let newReleases = settings.get<{ at: number; key: string; items: (Release & { by: string })[] }>("newReleases", { at: 0, key: "", items: [] });

function followButton(id: string): string {
  const on = following.some((a) => a.id === id);
  return `<button class="icon-btn follow ${on ? "on" : ""}" data-hero="follow" title="${on ? "Following" : "Follow"}">${icon(on ? "personCheck" : "personAdd", 22)}</button>`;
}

function bindFollow(artist: ArtistRef) {
  const btn = document.querySelector<HTMLElement>('[data-hero="follow"]');
  if (!btn) return;
  btn.onclick = () => {
    const on = !following.some((a) => a.id === artist.id);
    setFollow(artist, on);
    btn.classList.toggle("on", on);
    btn.title = on ? "Following" : "Follow";
    setIcon(btn, on ? "personCheck" : "personAdd", 22);
    toast(on ? `Following ${artist.name}` : `Stopped following ${artist.name}`);
  };
}

function setFollow(artist: ArtistRef, on: boolean) {
  following = following.filter((a) => a.id !== artist.id);
  if (on) following.unshift(artist);
  settings.set("following", following);
  renderPlaylistGrid();
  watchReleases();
}

/**
 * Home: albums and singles from followed artists, from this year and last.
 * The list is kept for six hours, then looked up again (one artist page each,
 * for the 20 artists followed last).
 */
async function renderNewReleases() {
  const draw = () => {
    const el = document.getElementById("home-new");
    if (!el) return;
    const items = newReleases.items.map((r) => ({ target: `album:${r.id}`, art: imgUrl(r.thumbnail), title: r.title, sub: [r.by, r.year].filter(Boolean).join(" · ") }));
    el.innerHTML = following.length ? cards("New from artists you follow", items, false, true) : "";
  };
  const artists = following.slice(0, 20);
  const key = artists.map((a) => a.id).join(",");
  if (newReleases.key !== key) newReleases = { at: 0, key, items: [] };
  draw();
  if (!key || Date.now() - newReleases.at < 6 * 3600_000) return;
  const thisYear = new Date().getFullYear();
  const lists = await Promise.all(
    artists.map((a) =>
      api.artist(a.id).then(
        (page) => [...page.singles, ...page.albums].filter((r) => Number(r.year) >= thisYear - 1).map((r) => ({ ...r, by: a.name })),
        () => null,
      ),
    ),
  );
  // Offline: keep what was there.
  if (lists.every((l) => l === null)) return;
  // Each artist's newest first, taking turns, then the newest year first.
  const items: (Release & { by: string })[] = [];
  for (let i = 0; lists.some((l) => l && i < l.length); i++) for (const l of lists) if (l?.[i]) items.push(l[i]);
  items.sort((a, b) => Number(b.year) - Number(a.year));
  newReleases = { at: Date.now(), key, items: items.slice(0, 20) };
  settings.set("newReleases", newReleases);
  draw();
}

// ---- podcasts -------------------------------------------------------------------

let followedShows: Show[] = [];

async function refreshFollowedShows() {
  followedShows = await api.podcastsFollowed().catch(() => followedShows);
  renderPlaylistGrid();
  watchReleases();
}

/**
 * Phones: hands Android the artists and podcasts you follow, so it can check
 * for new releases twice a day and notify, with Cadence closed too
 * (Releases.kt). The first time there's someone to watch, Android 13 and
 * newer ask whether Cadence may notify.
 */
function watchReleases() {
  if (!phone) return;
  const on = settings.get("releaseAlerts", true) && (following.length > 0 || followedShows.length > 0);
  const json = JSON.stringify({
    artists: following.map((a) => ({ id: a.id, name: a.name })),
    shows: followedShows.map((s) => ({ id: s.id, title: s.title, feed: s.feed })),
  });
  void api.releasesWatch(json, on).catch(() => {});
  if (on && !settings.get("askedNotifications", false)) {
    settings.set("askedNotifications", true);
    void api.notificationsAllow().catch(() => false);
  }
}

function bindShowFollow(show: Show, followed: boolean) {
  const btn = document.querySelector<HTMLElement>('[data-hero="follow"]');
  if (!btn) return;
  let on = followed;
  btn.onclick = async () => {
    on = !on;
    btn.classList.toggle("on", on);
    btn.textContent = on ? "Following" : "Follow";
    try {
      await api.podcastFollow(show.id, on);
      toast(on ? `Following ${show.title}` : `Stopped following ${show.title}`);
      await refreshFollowedShows();
    } catch (e) {
      toast(String(e), "error");
    }
  };
}

/** Episode rows: title, a few lines about it, then date, time left and a bar. */
function episodeRows(eps: Episode[], withShow: boolean): string {
  return eps
    .map((e, i) => {
      const spot = progress.get(e.id) ?? e;
      const pct = !spot.played && e.duration && spot.position > 5 ? Math.min(100, (spot.position / e.duration) * 100) : 0;
      const id = `pod:${e.id}`;
      return `<div class="episode ${spot.played ? "played" : ""}" data-i="${i}" data-id="${esc(id)}">
        ${withShow ? `<div class="ep-show"><span class="ep-art"><img src="${esc(artUrl(episodeTrack(e)) ?? "")}" alt="" loading="lazy" draggable="false" /></span><span>${esc(e.showTitle)}</span></div>` : ""}
        <div class="ep-title">${esc(e.title)}</div>
        ${e.description ? `<div class="ep-desc">${esc(e.description)}</div>` : ""}
        <div class="ep-foot">
          <span class="ep-meta"><span class="dl-slot">${downloadBadge(id)}</span>${[episodeDate(e.published), episodeTime(e)].filter(Boolean).map(esc).join(" · ")}</span>
          ${pct ? `<span class="ep-bar"><i style="width: ${pct}%"></i></span>` : ""}
          <span class="ep-actions">
            <button class="icon-btn small" data-act="more" title="More">${icon("more", 20)}</button>
            <button class="ep-play" data-act="play" title="Play">${icon(player.current?.id === id && player.playing ? "pause" : "play", 20)}</button>
          </span>
        </div>
      </div>`;
    })
    .join("");
}

/** Lists showing episodes, so their rows can be drawn again as things change. */
const episodeLists = new Map<HTMLElement, { eps: Episode[]; withShow: boolean }>();

/** Renders episodes into `el`; tapping one plays it, from where it was left off. */
function mountEpisodes(el: HTMLElement, eps: Episode[], withShow: boolean) {
  for (const k of episodeLists.keys()) if (!k.isConnected) episodeLists.delete(k);
  episodeLists.set(el, { eps, withShow });
  el.innerHTML = episodeRows(eps, withShow);
  markPlaying();
  el.onclick = (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".episode");
    // The list as drawn now: Home's can lose episodes marked as played.
    const e = row && episodeLists.get(el)?.eps[Number(row.dataset.i)];
    if (!e) return;
    const track = episodeTrack(e);
    const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "more") return episodeMenu(ev, track);
    const heard = progress.get(e.id)?.played;
    replay(e.id);
    if (player.current?.id !== track.id) return player.playList([track], 0, e.showTitle);
    if (!heard) return player.toggle();
    player.seek(0);
    if (!player.playing) player.toggle();
  };
}

/** Play or pause on each episode row, as the player goes. */
function updateEpisodeButtons() {
  const id = player.playing ? player.current?.id : undefined;
  document.querySelectorAll<HTMLElement>(".episode").forEach((row) => {
    const btn = row.querySelector<HTMLElement>(".ep-play");
    const name = row.dataset.id === id ? "pause" : "play";
    if (btn && btn.dataset.shows !== name) {
      setIcon(btn, name, 20);
      btn.dataset.shows = name;
    }
  });
}

/** Draws episode rows again: played, time left, downloads, the one playing. */
function refreshEpisodeRows() {
  for (const [el, list] of episodeLists) {
    if (!el.isConnected) {
      episodeLists.delete(el);
      continue;
    }
    // Home lists episodes still to hear: one marked as played leaves it.
    if (list.withShow) list.eps = list.eps.filter((e) => !progress.get(e.id)?.played);
    el.innerHTML = episodeRows(list.eps, list.withShow);
    if (list.withShow && !list.eps.length) el.closest(".page-section")?.remove();
  }
  markPlaying();
}

function episodeMenu(e: MouseEvent, track: Track, extra: MenuItem[] = []) {
  e.stopPropagation();
  const id = track.id.slice(4);
  const spot = progress.get(id);
  const dl = downloads.get(track.id)?.state;
  const show = showOf(track);
  const playing = player.current?.id === track.id;
  const items: MenuItem[] = [
    ...(playing ? [] : [{ label: "Add to queue", icon: "queueAdd", run: () => (player.addToQueue(track), toast("Added to queue")) } satisfies MenuItem]),
    {
      label: dl === "done" ? "Remove download" : dl ? "Cancel download" : "Download",
      icon: dl === "done" ? "downloadDone" : dl ? "close" : "download",
      run: () => void (dl ? removeDownload(track) : downloadTracks([track])),
    },
    {
      label: spot?.played ? "Mark as not played" : "Mark as played",
      icon: "check",
      on: !!spot?.played,
      run: () => {
        const before = { position: spot?.position ?? 0, played: !!spot?.played };
        const set = (s: { position: number; played: boolean }) => {
          progress.set(id, s);
          void api.podcastProgress(id, s.position, s.played).catch(() => {});
          refreshEpisodeRows();
        };
        set(before.played ? { position: before.position, played: false } : { position: 0, played: true });
        toast(before.played ? "Marked as not played" : "Marked as played", "info", {
          label: "Undo",
          run: () => {
            set(before);
            // Home took it off its list; bring it back.
            if (view === "home") void renderNewEpisodes();
          },
        });
      },
    },
  ];
  if (playing) items.push(speedItem());
  if (show) items.push({ label: "Go to podcast", icon: "podcast", divider: true, run: () => openTarget(`podcast:${show}`) });
  showMenu([...items, ...extra], e.clientX, e.clientY, track);
}

function speedItem(): MenuItem {
  return { label: "Playback speed", icon: "speed", sub: `${speed()}×`, keep: true, run: () => showMenu(speedItems()) };
}

function speedItems(): MenuItem[] {
  return SPEEDS.map((r): MenuItem => ({ label: `${r}×`, icon: "speed", on: r === speed(), run: () => (setSpeed(player, r), showEpisodeControls(true)) }));
}

function speedMenu(e: MouseEvent) {
  e.stopPropagation();
  showMenu(speedItems(), e.clientX, e.clientY, player.current ?? undefined);
}

function skipBy(seconds: number) {
  const a = player.audio;
  const end = isFinite(a.duration) ? a.duration : Infinity;
  player.seek(Math.min(end - 1, a.currentTime + seconds));
}

/** Episodes: back 15 s and ahead 30 s around play, and the speed in place of shuffle. */
function showEpisodeControls(on: boolean) {
  const prev = $("#btn-prev");
  const next = $("#btn-next");
  const shuffle = $("#btn-shuffle");
  $(".player").classList.toggle("episode", on);
  if (on) {
    prev.innerHTML = `${icon("rewind", 26)}<span class="skip-n">15</span>`;
    next.innerHTML = `${icon("forward", 26)}<span class="skip-n">30</span>`;
    shuffle.innerHTML = `<span class="speed">${speed()}×</span>`;
    prev.title = "Back 15 seconds";
    next.title = "Ahead 30 seconds";
    shuffle.title = "Playback speed";
  } else if (prev.querySelector(".skip-n")) {
    setIcon(prev, "prev", 22);
    setIcon(next, "next", 22);
    setIcon(shuffle, player.smart ? "smartShuffle" : "shuffle", 22);
    shuffle.dataset.shows = player.smart ? "smartShuffle" : "shuffle";
    prev.title = "Previous";
    next.title = "Next";
    shuffle.title = "Shuffle";
  }
}

/** Home: episodes being listened to, then new ones from followed podcasts. */
async function renderNewEpisodes() {
  const eps = await api.podcastNewEpisodes().catch(() => [] as Episode[]);
  const el = document.getElementById("home-episodes");
  if (!el) return;
  learn(eps);
  if (!eps.length) return void (el.innerHTML = "");
  el.innerHTML = `<section class="page-section"><h2>Your episodes</h2><div class="episode-list" id="home-ep-list"></div></section>`;
  mountEpisodes($("#home-ep-list"), eps.slice(0, 6), true);
}

// ---- sharing --------------------------------------------------------------------

/** A page opened from a shared link, which starts playing once it shows. */
let playOnOpen: Page | null = null;
/** A link carries at most this many songs (share.rs). */
const SHARE_MAX = 300;

function shareButton(): string {
  return `<button class="icon-btn" data-hero="share" title="Share">${icon("share", 22)}</button>`;
}

function onShare(fn: () => void) {
  document.querySelector<HTMLElement>('[data-hero="share"]')?.addEventListener("click", fn);
}

/** Opens Android's share sheet with a link other Cadence users can open.
 *  The desktop copies the link instead. */
async function share(item: Shared) {
  try {
    if (phone) return await api.share(item);
    await navigator.clipboard.writeText(await api.shareLink(item));
    toast("Link copied · paste it anywhere");
  } catch (e) {
    toast(String(e), "error");
  }
}

/** Shares a list of songs as a playlist. Songs from your own files can't go along. */
function shareTracks(name: string, tracks: Track[]) {
  const ids = tracks.filter((t) => t.id.startsWith("yt:")).map((t) => t.id.slice(3));
  if (!ids.length) return toast("Only songs from YouTube Music can be shared", "error");
  const own = tracks.length - ids.length;
  if (ids.length > SHARE_MAX) toast(`Only the first ${SHARE_MAX} songs go along`);
  else if (own) toast(`${count(own, "song")} from your own files can't go along`);
  void share({ kind: "playlist", name, ids });
}

/** Opens what the link that opened the app shares (or a YouTube link shared
 *  to it), and starts playing it. An artist's page just opens. */
async function openSharedLink() {
  const item = await api.sharedLink().catch((e) => (toast(String(e), "error"), null));
  if (item) await openShared(item, item.quiet);
}

/** Opens a shared item (on the desktop, a link pasted into Search) and plays
 *  it; `quiet` (a new release notification) only opens its page. */
async function openShared(item: Shared, quiet = false) {
  $("#menu").hidden = true;
  setSidePanel(null);
  if (item.kind === "song") {
    const [found] = await api.songs([item.id]).catch(() => [] as Track[]);
    const track: Track = found ?? { id: `yt:${item.id}`, title: item.title || "Shared song", artist: item.artist };
    player.playList([track], 0, "Shared with you");
    setNowPlayingOpen(true);
    return;
  }
  if (item.kind === "artist") return openPage({ kind: "artist", id: item.id });
  const p: Page =
    item.kind === "album"
      ? { kind: "album", id: item.id }
      : item.kind === "youtubePlaylist"
        ? { kind: "ytlist", id: item.id }
        : { kind: "shared", name: item.name, ids: item.ids };
  playOnOpen = quiet ? null : p;
  openPage(p);
}

/** Keeps a shared playlist as one of your own; its button then shows a tick. */
async function saveShared(name: string, tracks: Track[], button: HTMLButtonElement) {
  if (!tracks.length || button.disabled) return;
  button.disabled = true;
  try {
    const id = await api.playlistCreate(name, tracks);
    await refreshPlaylists();
    setIcon(button, "check", 22);
    toast("Saved to your playlists", "info", { label: "Open", run: () => openPlaylist(id) });
  } catch (e) {
    button.disabled = false;
    toast(String(e), "error");
  }
}

// ---- playlists ---------------------------------------------------------------------

async function refreshPlaylists() {
  try {
    playlists = await api.playlists();
    // Pinned playlists come first, in the order they were pinned.
    const rank = (p: PlaylistInfo) => (pinned.includes(p.id) ? pinned.indexOf(p.id) : pinned.length);
    playlists.sort((a, b) => rank(a) - rank(b));
  } catch (e) {
    toast(`Could not load playlists: ${e}`, "error");
  }
  // Library and Home list them, and the desktop's sidebar.
  renderPlaylistGrid();
  renderShortcuts();
}

/**
 * The desktop's sidebar under Your Library, as in Spotify: Liked songs,
 * Downloads and Your music, then the playlists (pinned first), the artists
 * and the podcasts you follow.
 */
function renderSidebar() {
  if (phone) return;
  const row = (attrs: string, art: string, name: string, sub: string, round = false) =>
    `<button class="nav-item pl" ${attrs} title="${name}">
      <span class="pl-art ${round ? "round" : ""}">${art}</span>
      <span class="pl-text"><span class="pl-name">${name}</span><span class="pl-sub">${sub}</span></span>
    </button>`;
  const img = (url: string | null, fallback: IconName) => (url ? `<img src="${esc(imgUrl(url))}" alt="" draggable="false" />` : icon(fallback, 18));
  const saving = pendingDownloads().length;
  const saved = [...downloads.values()].filter((d) => d.state === "done").length;
  $("#playlists").innerHTML = [
    row(`data-view="liked"`, `<span class="liked-art">${icon("heartFilled", 18)}</span>`, "Liked songs", `Playlist · ${count(liked.size, "song")}`),
    row(`data-view="downloads"`, `<span class="liked-art dl-art">${icon("download", 18)}</span>`, "Downloads", saving ? `Downloading · ${saving} left` : count(saved, "song")),
    row(`data-view="music"`, `<span class="liked-art music-art">${icon("music", 18)}</span>`, "Your music", musicCount ? count(musicCount, "song") : "Songs on this computer"),
    ...playlists.map((p) =>
      row(`data-pl="${p.id}"`, playlistArt(p, 18), esc(p.name), `${pinned.includes(p.id) ? icon("pin", 12) : ""}Playlist · ${count(p.count, "song")}`),
    ),
    ...following.map((a) => row(`data-go="artist:${esc(a.id)}"`, img(a.thumbnail, "person"), esc(a.name), "Artist", true)),
    ...followedShows.map((s) => row(`data-go="podcast:${esc(s.id)}"`, img(s.artwork, "podcast"), esc(s.title), `Podcast${s.author ? ` · ${esc(s.author)}` : ""}`)),
  ].join("");
  markNav();
}

function openPlaylist(id: number) {
  // Back returns to where the playlist was opened from.
  openPage({ kind: "playlist", id });
}

function playlistNewMenu(e: MouseEvent) {
  menuUnder(e, [
    { label: "New playlist…", icon: "add", run: () => void newPlaylist() },
    { label: "Import from a link…", icon: "restore", run: () => void importPlaylist() },
  ]);
}

/** A playlist's menu items for its cover. */
function coverItems(id: number, custom: boolean): MenuItem[] {
  return [
    { label: "Change cover…", icon: "image", sub: "Pick a photo from your phone", run: () => void changeCover(id) },
    ...(custom ? [{ label: "Use the first song's cover", icon: "restore", run: () => void changeCover(id, true) } satisfies MenuItem] : []),
  ];
}

/** Opens the photo picker for a playlist's cover, or with `clear` goes back to the first song's. */
async function changeCover(id: number, clear = false) {
  try {
    if (clear) await api.playlistCoverClear(id);
    else if (!phone) {
      const jpeg = await pickCover();
      if (!jpeg) return;
      await api.playlistCoverSet(id, jpeg);
    } else if (!(await api.playlistCoverPick(id))) return;
  } catch (e) {
    return toast(String(e), "error");
  }
  await refreshPlaylists();
  refreshPlaylistPage(id);
}

/**
 * The desktop: a photo picked in the file dialog, cut square from its middle
 * and scaled to 640 px as a JPEG, as Android's photo picker does on phones
 * (Pictures.kt). Null when none was picked.
 */
function pickCover(): Promise<Uint8Array | null> {
  return new Promise((done) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      try {
        const bitmap = await createImageBitmap(file);
        const side = Math.min(bitmap.width, bitmap.height);
        const size = Math.min(640, side);
        const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
        canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
        done(blob ? new Uint8Array(await blob.arrayBuffer()) : null);
      } catch {
        toast("That picture can't be used", "error");
        done(null);
      }
    };
    input.oncancel = () => done(null);
    input.click();
  });
}

/** Re-renders the page if it shows this playlist, keeping the scroll spot. */
function refreshPlaylistPage(id: number) {
  if (page?.kind === "playlist" && page.id === id) show("page", page, $("#view").scrollTop);
}

async function savePlaylist(id: number, tracks: Track[]) {
  try {
    await api.playlistSetTracks(id, tracks);
  } catch (e) {
    return toast(String(e), "error");
  }
  await refreshPlaylists();
  refreshPlaylistPage(id);
}

async function newPlaylist(tracks: Track[] = []) {
  const name = await askText({ title: "New playlist", placeholder: "My playlist", ok: "Create" });
  if (name == null) return;
  try {
    const id = await api.playlistCreate(name, tracks);
    await refreshPlaylists();
    if (tracks.length) toast(`Added to ${name}`);
    else openPlaylist(id);
  } catch (e) {
    toast(String(e), "error");
  }
}

async function addToPlaylist(id: number, tracks: Track[]) {
  const name = playlists.find((p) => p.id === id)?.name ?? "the playlist";
  try {
    const added = await api.playlistAdd(id, tracks);
    await refreshPlaylists();
    refreshPlaylistPage(id);
    if (added && autoLists.includes(id)) void autoDownload();
    if (!added) toast(tracks.length === 1 ? `Already in ${name}` : `All of these are already in ${name}`);
    else toast(added === tracks.length ? `Added to ${name}` : `Added ${count(added, "song")} to ${name}; the rest were already there`);
  } catch (e) {
    toast(String(e), "error");
  }
}

async function renamePlaylist(id: number, current: string) {
  const name = await askText({ title: "Rename playlist", value: current, ok: "Rename" });
  if (name == null || name === current) return;
  try {
    await api.playlistRename(id, name);
    await refreshPlaylists();
    refreshPlaylistPage(id);
  } catch (e) {
    toast(String(e), "error");
  }
}

async function deletePlaylist(id: number, name: string) {
  const ok = await confirmBox({ title: `Delete “${name}”?`, body: "The playlist goes away; the songs themselves stay wherever else they are.", ok: "Delete", danger: true });
  if (!ok) return;
  try {
    await api.playlistDelete(id);
  } catch (e) {
    return toast(String(e), "error");
  }
  pinned = pinned.filter((p) => p !== id);
  settings.set("pinnedPlaylists", pinned);
  autoLists = autoLists.filter((l) => l !== id);
  settings.set("autoDownloadLists", autoLists);
  await refreshPlaylists();
  // Phones stay in Library, where playlists live.
  if (page?.kind === "playlist" && page.id === id) setView("library");
  toast(`Deleted ${name}`);
}

/** Set while an import runs; receives the back end's progress. */
let importStatus: ((p: { done: number; total: number }) => void) | null = null;

async function importPlaylist() {
  let result: ImportResult | null = null;
  await openDialog({
    title: "Import a playlist",
    body: "Paste a link to a YouTube, YouTube Music or Spotify playlist. Spotify albums work too.",
    input: { placeholder: "https://open.spotify.com/playlist/…" },
    ok: "Import",
    onSubmit: async (link, status) => {
      status(/spotify/i.test(link) ? "Reading the playlist from Spotify…" : "Reading the playlist from YouTube…");
      importStatus = (p) => status(`Finding the songs on YouTube Music: ${p.done} of ${p.total}`);
      try {
        result = await api.playlistImport(link);
        await refreshPlaylists();
        openPlaylist(result.playlistId);
        return true;
      } finally {
        importStatus = null;
      }
    },
  });
  // Only now: the summary reuses the dialog the import was shown in.
  const r = result as ImportResult | null;
  if (!r) return;
  if (r.missing.length || r.maybeTruncated) await importSummary(r);
  else toast(`Imported ${count(r.added, "song")} into ${r.name}`);
}

async function importSummary(r: ImportResult) {
  const notes: string[] = [`${count(r.added, "song")} imported into “${esc(r.name)}”.`];
  if (r.maybeTruncated) notes.push("Spotify only shares the first 100 songs of a playlist without signing in, so the rest weren't included.");
  if (r.missing.length) {
    const shown = r.missing.slice(0, 12).map((m) => `<li>${esc(m)}</li>`).join("");
    const more = r.missing.length > 12 ? `<li>…and ${r.missing.length - 12} more</li>` : "";
    notes.push(`${count(r.missing.length, "song")} couldn't be found on YouTube Music:</p><ul class="dialog-list">${shown}${more}</ul><p>`);
  }
  await openDialog({ title: "Import finished", body: notes.join(" "), ok: "OK", cancel: false });
}

// ---- backup ------------------------------------------------------------------------

const BACKUP_FILTER = [{ name: "Cadence backup", extensions: ["cadence-backup"] }];

function backupContents(s: BackupSummary): string {
  return [count(s.playlists, "playlist"), count(s.liked, "liked song"), count(s.libraryTracks, "library song"), count(s.downloads, "download record")].join(", ");
}

async function backUp() {
  // Phones save it in Downloads → Cadence backups, where the file picker finds it again.
  if (phone) {
    try {
      await api.backupToFolder(settings.exportAll(), `Cadence backup ${stamp(true)}.cadence-backup`, false);
      toast("Backup saved in Downloads → Cadence backups");
    } catch (e) {
      toast(`Backup failed: ${e}`, "error");
    }
    return;
  }
  const name = `Cadence backup ${new Date().toISOString().slice(0, 10)}.cadence-backup`;
  const path = await save({ title: "Save a backup", defaultPath: await join(await documentDir(), name), filters: BACKUP_FILTER });
  if (!path) return;
  try {
    const s = await api.backupCreate(path, settings.exportAll());
    toast(`Backed up ${backupContents(s)}`);
  } catch (e) {
    toast(`Backup failed: ${e}`, "error");
  }
}

async function restoreBackup() {
  // Android's file picker hands out links Rust can't read; the plugin copies the file picked.
  const path = phone
    ? await api.backupPick().catch((e) => (toast(String(e), "error"), null))
    : await open({ title: "Restore a backup", multiple: false, directory: false, defaultPath: await documentDir(), filters: BACKUP_FILTER });
  if (typeof path !== "string") return;
  let s: BackupSummary;
  try {
    s = await api.backupPeek(path);
  } catch (e) {
    return toast(String(e), "error");
  }
  const when = new Date(s.createdAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const ok = await confirmBox({
    title: "Restore this backup?",
    body: `It's from ${esc(when)} and has ${backupContents(s)}.</p><p>It replaces your current playlists, liked songs, library list and settings. What you have now is saved first, so you can go back to it. Downloaded songs that aren't on this ${phone ? "phone" : "PC"} need downloading again.`,
    ok: "Restore",
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api.backupRestore(path, settings.exportAll());
    player.pause();
    settings.importAll(r.settings);
    // Shown after the reload below, which brings every view up to date.
    settings.set("restoredFrom", r.safetyCopy);
    location.reload();
  } catch (e) {
    toast(String(e), "error");
  }
}

/** Automatic backups: one a week, made when the app opens or comes back. */
const BACKUP_EVERY = 7 * 86400_000;

/** Today's date (and with `time`, the time) as it goes in backup names. */
function stamp(time = false): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return time ? `${day} ${p(d.getHours())}-${p(d.getMinutes())}` : day;
}

/** Makes this week's backup in Downloads (phones) or Documents (desktop) →
 *  Cadence backups, keeping the last four (backup_to_folder). Quiet: a
 *  failed one is tried again next time. */
async function autoBackup() {
  if (!settings.get("autoBackup", true) || Date.now() - settings.get("lastAutoBackup", 0) < BACKUP_EVERY) return;
  try {
    await api.backupToFolder(settings.exportAll(), `Cadence auto backup ${stamp()}.cadence-backup`, true);
    settings.set("lastAutoBackup", Date.now());
    const note = document.querySelector("#auto-backup small");
    if (note) note.textContent = autoBackupNote();
  } catch {
    // Tried again next time.
  }
}

function autoBackupNote(): string {
  const last = settings.get("lastAutoBackup", 0);
  const where = phone ? "Downloads → Cadence backups" : "Documents → Cadence backups";
  const when = last ? ` · last on ${new Date(last).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : "";
  return `Every week, in ${where}; the last 4 are kept${when}`;
}

// ---- songs you don't want to hear ---------------------------------------------------

/** "Don't play this song": radio, mixes, recommendations, Autoplay and smart
 *  shuffle leave these out. Kept in the settings, so backups have them. */
let hiddenSongs = settings.get<Track[]>("hiddenSongs", []);
hiddenSongs.forEach((t) => player.hidden.add(t.id));

function setHiddenSongs(list: Track[]) {
  hiddenSongs = list;
  settings.set("hiddenSongs", list);
  player.hidden.clear();
  list.forEach((t) => player.hidden.add(t.id));
  const note = document.querySelector("#hidden-songs small");
  if (note) note.textContent = list.length ? count(list.length, "song") : "None yet · ⋮ on a song → Don't play this song";
}

function hideItem(track: Track): MenuItem {
  const on = player.hidden.has(track.id);
  return on
    ? { label: "Allow this song again", icon: "restore", run: () => unhideSong(track) }
    : { label: "Don't play this song", icon: "hide", sub: "Radio, mixes and suggestions leave it out", run: () => hideSong(track) };
}

function hideSong(track: Track) {
  setHiddenSongs([{ ...track, artists: undefined }, ...hiddenSongs.filter((t) => t.id !== track.id)]);
  // Gone from what's coming up too, if Cadence picked it; the songs you chose stay.
  for (let i = player.queue.length - 1; i > player.index; i--) {
    if (player.queue[i].id === track.id && (player.isAutoplayed(i) || player.isSuggested(i))) player.removeAt(i);
  }
  if (recs.tracks.some((t) => t.id === track.id)) {
    recs.tracks = recs.tracks.filter((t) => t.id !== track.id);
    renderRecs();
  }
  if (player.current?.id === track.id) player.next();
  toast("You won't hear this song in radio, mixes or suggestions", "info", { label: "Undo", run: () => unhideSong(track, false) });
}

function unhideSong(track: Track, say = true) {
  setHiddenSongs(hiddenSongs.filter((t) => t.id !== track.id));
  if (say) toast(`“${track.title}” can play again`);
}

// ---- dialogs ----------------------------------------------------------------------

interface DialogOptions {
  title: string;
  /** Markup. */
  body?: string;
  input?: { value?: string; placeholder?: string };
  ok: string;
  /** False hides Cancel; a string renames it. */
  cancel?: boolean | string;
  danger?: boolean;
  /**
   * Runs on OK with the input's text and a way to show progress. Return
   * true to close; a thrown error is shown in the dialog.
   */
  onSubmit?: (value: string, status: (text: string) => void) => Promise<boolean>;
}

/** Resolves with the input's text (or "" without one) on OK, null on cancel. */
function openDialog(o: DialogOptions): Promise<string | null> {
  const backdrop = $("#dialog");
  const form = $<HTMLFormElement>("#dialog-form");
  form.innerHTML = `
    <h2>${esc(o.title)}</h2>
    ${o.body ? `<p>${o.body}</p>` : ""}
    ${o.input ? `<input type="text" name="value" value="${esc(o.input.value)}" placeholder="${esc(o.input.placeholder)}" spellcheck="false" autocomplete="off" />` : ""}
    <div class="dialog-status" hidden></div>
    <div class="dialog-actions">
      ${o.cancel === false ? "" : `<button type="button" class="btn" data-cancel>${esc(typeof o.cancel === "string" ? o.cancel : "Cancel")}</button>`}
      <button type="submit" class="btn ${o.danger ? "danger" : "primary"}">${esc(o.ok)}</button>
    </div>`;
  backdrop.hidden = false;
  const input = form.querySelector<HTMLInputElement>("input");
  const status = form.querySelector<HTMLElement>(".dialog-status")!;
  (input ?? form.querySelector<HTMLButtonElement>("[type=submit]"))!.focus();
  input?.select();
  return new Promise((resolve) => {
    let busy = false;
    const close = (value: string | null) => {
      backdrop.hidden = true;
      form.onsubmit = null;
      backdrop.onmousedown = null;
      form.onkeydown = null;
      resolve(value);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      const value = input?.value.trim() ?? "";
      if (input && !value) return input.focus();
      if (!o.onSubmit) return close(value);
      busy = true;
      form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button[type=submit], input").forEach((b) => (b.disabled = true));
      const show = (text: string, error = false) => {
        status.hidden = false;
        status.textContent = text;
        status.classList.toggle("error", error);
      };
      try {
        if (await o.onSubmit(value, show)) return close(value);
      } catch (err) {
        show(String(err), true);
      }
      busy = false;
      form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button[type=submit], input").forEach((b) => (b.disabled = false));
      input?.focus();
    };
    form.querySelector("[data-cancel]")?.addEventListener("click", () => close(null));
    // Closing mid-import only hides the dialog; the import still finishes.
    backdrop.onmousedown = (e) => e.target === backdrop && close(null);
    form.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(null);
      }
    };
  });
}

function askText(o: { title: string; value?: string; placeholder?: string; ok: string }): Promise<string | null> {
  return openDialog({ title: o.title, input: { value: o.value, placeholder: o.placeholder }, ok: o.ok });
}

async function confirmBox(o: { title: string; body: string; ok: string; danger?: boolean }): Promise<boolean> {
  return (await openDialog(o)) !== null;
}

// ---- side panel ----------------------------------------------------------------

/** The right-hand panel shows the queue or the lyrics, one at a time. */
/** What the right-hand column shows: the queue, the lyrics, or (desktop) Now Playing. */
type Side = "queue" | "lyrics" | "now" | null;
let side: Side = null;

function setSidePanel(next: Side) {
  side = next;
  $("#queue-panel").hidden = next !== "queue";
  $("#lyrics-panel").hidden = next !== "lyrics";
  $("#now-panel").hidden = next !== "now";
  $("#btn-queue").classList.toggle("on", next === "queue");
  $("#btn-lyrics").classList.toggle("on", next === "lyrics");
  $("#btn-now").classList.toggle("on", next === "now");
  settings.set("sidePanel", next);
  if (next === "queue") renderQueue();
  if (next === "lyrics") void loadLyrics();
  if (next === "now") renderNowPanel();
}

// ---- Now Playing panel (desktop) ---------------------------------------------------

/**
 * Spotify's Now Playing view: the cover, the song with its like and download
 * buttons, where it plays from (or the sleep timer), and the next songs.
 */
function renderNowPanel() {
  const body = $("#np-body");
  if ($("#now-panel").hidden) return;
  const t = player.current;
  if (!t) return void (body.innerHTML = `<p class="muted pad">Nothing playing.</p>`);
  const dl = downloads.get(t.id)?.state;
  const canSave = t.id.startsWith("yt:") || isEpisode(t);
  const on = liked.has(t.id);
  const next = player.queue.slice(player.index + 1, player.index + 4);
  showSleep();
  body.innerHTML = `
    <div class="np-cover">${artHtml(t, "lg")}</div>
    <div class="np-song">
      <div class="np-text">
        <div class="np-title" data-len="${titleLength(t.title)}">${linked(t.title, albumTarget(t))}</div>
        <div class="np-artist">${artistLinks(t)}</div>
      </div>
      ${isEpisode(t) ? "" : `<button class="icon-btn like ${on ? "on" : ""}" data-np="like" title="${on ? "Remove from liked songs" : "Like"}">${icon(on ? "heartFilled" : "heart", 22)}</button>`}
      ${canSave ? `<button class="icon-btn ${dl === "done" ? "on" : ""}" data-np="download" title="${dl === "done" ? "Downloaded · click to remove" : dl ? "Downloading · click to cancel" : "Download"}">${icon(dl === "done" ? "downloadDone" : dl ? "close" : "download", 22)}</button>` : ""}
    </div>
    ${
      next.length
        ? `<section class="np-card">
            <header><h3>Next in queue</h3><button class="text-btn" data-np="queue">Open queue</button></header>
            ${next
              .map(
                (n, j) => `<div class="q-item" data-np-next="${player.index + 1 + j}">
                  <div class="q-art">${artHtml(n)}</div>
                  <div class="q-text"><div class="q-title">${esc(n.title)}</div><div class="q-artist">${esc(n.artist)}</div></div>
                </div>`,
              )
              .join("")}
          </section>`
        : ""
    }`;
  body.onclick = (e) => {
    const el = e.target as HTMLElement;
    const act = el.closest<HTMLElement>("[data-np]")?.dataset.np;
    const nextAt = el.closest<HTMLElement>("[data-np-next]")?.dataset.npNext;
    if (el.closest("[data-go]")) openLink(e, t);
    else if (act === "like") void toggleLike(t);
    else if (act === "download") void (downloads.has(t.id) ? removeDownload(t) : downloadTracks([t]));
    else if (act === "queue") setSidePanel("queue");
    else if (nextAt) player.jump(Number(nextAt));
  };
}

function toggleSidePanel(panel: Exclude<Side, null>) {
  setSidePanel(side === panel ? null : panel);
}

// ---- queue panel ---------------------------------------------------------------

function renderQueue() {
  const panel = $("#queue-panel");
  if (panel.hidden) return;
  const list = $("#queue-list");
  // A song is being dragged; the list is redrawn when it is let go.
  if (list.classList.contains("sorting")) return;
  if (!player.queue.length) {
    list.innerHTML = `<p class="muted pad">The queue is empty.</p>`;
    return;
  }
  // After the playing song: the songs queued by hand, then the rest of the list.
  // Phones name the list the rest comes from, as in "Next from Liked songs".
  const nextUp = player.from ? `Next from ${esc(player.from)}` : "Next up";
  const label = (i: number) => {
    if (i === player.index) return `<div class="q-label">Now playing</div>`;
    if (i <= player.index) return "";
    if (player.isAutoplayed(i)) {
      return player.isAutoplayed(i - 1) && i - 1 > player.index ? "" : `<div class="q-label">Autoplay · similar songs</div>`;
    }
    if (i === player.index + 1 && player.isQueued(i)) return `<div class="q-label">Next in queue</div>`;
    if (!player.isQueued(i) && (i === player.index + 1 || player.isQueued(i - 1))) return `<div class="q-label">${nextUp}</div>`;
    return "";
  };
  list.innerHTML = player.queue
    .map(
      (t, i) => `${label(i)}<div class="q-item ${i === player.index ? "current" : ""} ${i < player.index ? "past" : ""}" draggable="true" data-i="${i}">
        <div class="q-art">${artHtml(t)}</div>
        <div class="q-text"><div class="q-title">${esc(t.title)}</div><div class="q-artist">${player.isSuggested(i) ? `<span class="q-spark" title="Smart shuffle suggestion">${icon("sparkle", 13)}</span>` : ""}${esc(t.artist)}</div></div>
        ${i === player.index ? `<span class="np-bars" title="Playing"><i></i><i></i><i></i></span>` : `<button class="icon-btn tiny" data-remove title="Remove">${icon("close", 16)}</button>`}
        <span class="q-handle" title="Drag to move">${icon("drag", 20)}</span>
      </div>`,
    )
    .join("");
  // Follow the playing song, but don't yank the list while the user edits it.
  if (player.index !== queueScrolledTo) {
    queueScrolledTo = player.index;
    list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }
}

let queueScrolledTo = -1;

/** Where a dragged queue item lands: before or after the hovered item. */
function dropTarget(e: DragEvent): { item: HTMLElement; after: boolean } | null {
  const item = (e.target as HTMLElement).closest<HTMLElement>(".q-item");
  if (!item) return null;
  const r = item.getBoundingClientRect();
  return { item, after: e.clientY > r.top + r.height / 2 };
}

/** The queue position a song dragged from `from` goes to when dropped on `t`. */
function dropIndex(from: number, t: { item: HTMLElement; after: boolean }): number {
  const to = Number(t.item.dataset.i) + (t.after ? 1 : 0);
  // Removing the item first shifts everything after it up by one.
  return from < to ? to - 1 : to;
}

/**
 * Phones: a song (`item`, in `list`) is dragged by its handle, since touch
 * screens don't do the desktop's drag and drop; the queue and playlists use
 * this. `scroller` scrolls near its edges. `drop` gets the song's old and new
 * position; `cancel` runs when it ends where it started. With `floating`, the
 * tabs and the player bar lie over the scroller's bottom, so scrolling starts
 * above them.
 */
function bindHandles(
  list: HTMLElement,
  scroller: HTMLElement,
  itemSel: string,
  drop: (from: number, to: number) => void,
  cancel?: () => void,
  floating = false,
) {
  handleListeners.get(list)?.abort();
  const listening = new AbortController();
  handleListeners.set(list, listening);
  const opts = { signal: listening.signal };
  /** The song last dropped: no new drag until the list is drawn again (its save may be on the way). */
  let dropped: HTMLElement | null = null;
  let drag: {
    from: number;
    to: number;
    item: HTMLElement;
    id: number;
    startY: number;
    startScroll: number;
    y: number;
    frame: number;
    /** The other songs and their middles, in list coordinates, before any moved. */
    others: { el: HTMLElement; i: number; mid: number }[];
  } | null = null;
  /** Keeps the lifted song under the finger; the others make room where it would land. */
  const follow = () => {
    if (!drag) return;
    const d = drag;
    d.item.style.translate = `0 ${d.y - d.startY + scroller.scrollTop - d.startScroll}px`;
    const y = d.y - scroller.getBoundingClientRect().top + scroller.scrollTop;
    d.to = d.from;
    for (const o of d.others) {
      if (o.i < d.from && y < o.mid) d.to = Math.min(d.to, o.i);
      if (o.i > d.from && y > o.mid) d.to = Math.max(d.to, o.i);
    }
    const h = d.item.offsetHeight;
    for (const o of d.others) {
      const shift = d.from < o.i && o.i <= d.to ? -h : d.to <= o.i && o.i < d.from ? h : 0;
      o.el.style.translate = shift ? `0 ${shift}px` : "";
    }
  };
  /** Lets go of the song without moving it, e.g. when the list was drawn again mid-drag. */
  const abandon = () => {
    if (!drag) return;
    cancelAnimationFrame(drag.frame);
    list.classList.remove("sorting");
    for (const el of [drag.item, ...drag.others.map((o) => o.el)]) el.style.translate = "";
    drag.item.classList.remove("lifted");
    drag = null;
  };
  listening.signal.addEventListener("abort", abandon);
  const autoScroll = () => {
    if (!drag) return;
    if (!drag.item.isConnected) return abandon();
    const r = scroller.getBoundingClientRect();
    let bottom = r.bottom;
    if (floating) {
      for (const over of document.querySelectorAll<HTMLElement>(".player, .tabbar")) {
        const box = over.getBoundingClientRect();
        if (box.height && box.top > r.top) bottom = Math.min(bottom, box.top);
      }
    }
    const edge = drag.y < r.top + 60 ? -1 : drag.y > bottom - 60 ? 1 : 0;
    if (edge) {
      scroller.scrollTop += edge * 10;
      follow();
    }
    drag.frame = requestAnimationFrame(autoScroll);
  };
  // Listeners, not on… properties: song lists use those for swipes.
  list.addEventListener(
    "pointerdown",
    (e) => {
      const handle = (e.target as HTMLElement).closest(".q-handle");
      const item = handle?.closest<HTMLElement>(itemSel);
      if (!handle || !item || dropped?.isConnected) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      item.classList.add("lifted");
      list.classList.add("sorting");
      const top = scroller.getBoundingClientRect().top - scroller.scrollTop;
      const others = [...list.querySelectorAll<HTMLElement>(itemSel)]
        .filter((el) => el !== item)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { el, i: Number(el.dataset.i), mid: r.top - top + r.height / 2 };
        });
      const from = Number(item.dataset.i);
      const at = { startY: e.clientY, y: e.clientY, startScroll: scroller.scrollTop };
      drag = { from, to: from, item, id: e.pointerId, ...at, others, frame: requestAnimationFrame(autoScroll) };
      navigator.vibrate?.(12);
    },
    opts,
  );
  list.addEventListener(
    "pointermove",
    (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.y = e.clientY;
      follow();
    },
    opts,
  );
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { from, to, item, others, frame } = drag;
    cancelAnimationFrame(frame);
    drag = null;
    list.classList.remove("sorting");
    item.classList.remove("lifted");
    if (e.type === "pointerup" && to !== from) {
      // Put the song where it was dropped now; the list is drawn again later.
      const target = others.find((o) => o.i === to)?.el;
      target?.[to > from ? "after" : "before"](item);
      dropped = item;
      drop(from, to);
    } else cancel?.();
    for (const el of [item, ...others.map((o) => o.el)]) el.style.translate = "";
  };
  list.addEventListener("pointerup", end, opts);
  list.addEventListener("pointercancel", end, opts);
}

function bindQueue() {
  const list = $("#queue-list");
  list.onclick = (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".q-item");
    if (!item || (e.target as HTMLElement).closest(".q-handle")) return;
    const i = Number(item.dataset.i);
    if ((e.target as HTMLElement).closest("[data-remove]")) player.removeAt(i);
    else player.jump(i);
  };
  let dragFrom = -1;
  list.addEventListener("dragstart", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".q-item");
    dragFrom = item ? Number(item.dataset.i) : -1;
    e.dataTransfer?.setData("text/plain", "");
  });
  const clearMarks = () =>
    list.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
  list.addEventListener("dragover", (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    clearMarks();
    const t = dropTarget(e);
    t?.item.classList.add(t.after ? "drop-after" : "drop-before");
  });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    clearMarks();
    const t = dropTarget(e);
    if (t && dragFrom >= 0) player.move(dragFrom, dropIndex(dragFrom, t));
    dragFrom = -1;
  });
  list.addEventListener("dragend", () => {
    clearMarks();
    dragFrom = -1;
  });
  if (phone) bindHandles(list, list, ".q-item", (from, to) => player.move(from, to), renderQueue);
  $("#queue-clear").onclick = () => player.clearUpcoming();
}

// ---- lyrics panel ----------------------------------------------------------------

type LyricsState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; lyrics: Lyrics | null };

/** Lookups for this session; the back end keeps them on disk as well. */
const lyricsCache = new Map<string, Lyrics | null>();
const lyricsView = {
  trackId: "",
  token: 0,
  lines: null as LyricLine[] | null,
  active: -1,
  /** Whether the active line has been scrolled into the middle. */
  centered: false,
  /** Auto-scroll waits while the user scrolls the lyrics themselves. */
  holdUntil: 0,
  frame: 0,
};

async function loadLyrics(force = false) {
  if ($("#lyrics-panel").hidden) return;
  const t = player.current;
  if (!t) {
    lyricsView.trackId = "";
    lyricsView.token++;
    return renderLyrics(null);
  }
  if (isEpisode(t)) {
    lyricsView.trackId = t.id;
    lyricsView.token++;
    renderLyrics(null);
    $("#lyrics-body").innerHTML = lyricsNote("podcast", "No lyrics here", "Podcasts don't have lyrics.");
    return;
  }
  if (t.id === lyricsView.trackId && !force) {
    // Reopened on the same song: just catch up with the playback position.
    lyricsView.centered = false;
    return startLyricsLoop();
  }
  lyricsView.trackId = t.id;
  // Any lookup still running is for an earlier song now.
  const token = ++lyricsView.token;
  const cached = lyricsCache.get(t.id);
  if (cached !== undefined && !force) return renderLyrics({ kind: "ready", lyrics: cached });
  renderLyrics({ kind: "loading" });
  try {
    const lyrics = await api.lyrics(t);
    lyricsCache.set(t.id, lyrics);
    if (token === lyricsView.token) renderLyrics({ kind: "ready", lyrics });
  } catch (e) {
    if (token === lyricsView.token) renderLyrics({ kind: "error", message: String(e) });
  }
}

function lyricsNote(iconName: IconName, title: string, body: string): string {
  return `<div class="lyrics-note">${icon(iconName, 32)}<h3>${title}</h3><p>${body}</p></div>`;
}

function renderLyrics(state: LyricsState | null) {
  const body = $("#lyrics-body");
  lyricsView.lines = null;
  lyricsView.active = -1;
  lyricsView.centered = false;
  lyricsView.holdUntil = 0;
  body.scrollTop = 0;
  body.classList.toggle("synced", false);
  if (!state) {
    body.innerHTML = lyricsNote("lyrics", "Nothing playing", "Play a song to see its lyrics here.");
  } else if (state.kind === "loading") {
    body.innerHTML = `<div class="lyrics-loading">${[70, 55, 85, 40, 65, 75, 50]
      .map((w) => `<div class="skeleton" style="width:${w}%"></div>`)
      .join("")}</div>`;
  } else if (state.kind === "error") {
    body.innerHTML = `${lyricsNote("lyrics", "Couldn't load lyrics", esc(state.message))}
      <div class="lyrics-retry"><button class="btn" id="lyrics-retry">${icon("refresh", 18)}Try again</button></div>`;
    $("#lyrics-retry").onclick = () => void loadLyrics(true);
  } else if (!state.lyrics) {
    body.innerHTML = lyricsNote("lyrics", "No lyrics found", "LRCLIB doesn't have lyrics for this song yet.");
  } else if (state.lyrics.synced?.length) {
    lyricsView.lines = state.lyrics.synced;
    body.classList.add("synced");
    // A line without words is an instrumental break.
    body.innerHTML = state.lyrics.synced
      .map((l, i) => `<p class="lyric ${l.text ? "" : "gap"}" data-i="${i}">${esc(l.text) || "♪"}</p>`)
      .join("");
    startLyricsLoop();
  } else if (state.lyrics.plain) {
    body.innerHTML = `<div class="lyrics-plain">${state.lyrics.plain
      .split("\n")
      .map((l) => `<p>${esc(l) || "&nbsp;"}</p>`)
      .join("")}</div>`;
  } else {
    body.innerHTML = lyricsNote("music", "Instrumental", "This song has no lyrics.");
  }
}

/** Index of the line being sung at `time`, or -1 before the first line. */
function lyricIndexAt(lines: LyricLine[], time: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function syncLyrics() {
  const lines = lyricsView.lines;
  if (!lines || $("#lyrics-panel").hidden) return;
  const body = $("#lyrics-body");
  const i = lyricIndexAt(lines, player.audio.currentTime);
  if (i !== lyricsView.active) {
    const rows = body.children;
    for (let j = 0; j < rows.length; j++) {
      rows[j].classList.toggle("active", j === i);
      rows[j].classList.toggle("past", j < i);
    }
    lyricsView.active = i;
    lyricsView.centered = false;
  }
  if (!lyricsView.centered && Date.now() >= lyricsView.holdUntil) {
    lyricsView.centered = true;
    const row = body.children[Math.max(i, 0)] as HTMLElement | undefined;
    if (row) {
      body.scrollTo({ top: row.offsetTop - body.clientHeight / 2 + row.offsetHeight / 2, behavior: "smooth" });
    }
  }
}

/** Follows playback every frame while synced lyrics are on screen. */
function startLyricsLoop() {
  syncLyrics();
  if (lyricsView.frame) return;
  const tick = () => {
    lyricsView.frame = 0;
    if (!player.playing || !lyricsView.lines || $("#lyrics-panel").hidden) return;
    syncLyrics();
    lyricsView.frame = requestAnimationFrame(tick);
  };
  lyricsView.frame = requestAnimationFrame(tick);
}

function bindLyrics() {
  const body = $("#lyrics-body");
  const hold = () => {
    lyricsView.holdUntil = Date.now() + 4000;
    lyricsView.centered = false;
  };
  body.addEventListener("wheel", hold, { passive: true });
  // Dragging the scrollbar; clicks on a line are handled below.
  body.addEventListener("pointerdown", (e) => {
    if (!(e.target as HTMLElement).closest(".lyric")) hold();
  });
  body.onclick = (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".lyric");
    const line = row && lyricsView.lines?.[Number(row.dataset.i)];
    if (!line) return;
    lyricsView.holdUntil = 0;
    player.seek(line.time);
  };
  bindLyricsCards();
}

// ---- below the full-screen player (phones) -----------------------------------------

/** Artist pages for "About the artist", looked up once per session. */
const npArtists = new Map<string, Promise<Artist | null>>();
/** What the cards under the full-screen player show: the song, its synced
 *  lyrics and the line the lyrics card is on. */
const npInfo = { trackId: "", lines: null as LyricLine[] | null, active: -2 };

function npOpen(): boolean {
  return phone && $(".player").classList.contains("expanded");
}

/** Fills the cards under the full-screen player for the playing song, once
 *  per song while the player is open: lyrics, the artist and more of their songs. */
function renderNpInfo() {
  const t = player.current;
  if (!npOpen() || !t) return;
  if (t.id === npInfo.trackId) {
    // The artist may have been followed on their page since.
    const follow = $("#np-artist").querySelector<HTMLElement>(".np-follow");
    if (follow) setNpFollow(follow, following.some((f) => f.id === follow.dataset.id));
    return syncNpLyrics();
  }
  npInfo.trackId = t.id;
  npInfo.lines = null;
  npInfo.active = -2;
  for (const id of ["#np-lyrics", "#np-artist", "#np-more-by"]) $(id).hidden = true;
  if (isEpisode(t)) return;
  void npLyrics(t);
  void npArtist(t);
}

async function npLyrics(t: Track) {
  let lyrics = lyricsCache.get(t.id);
  if (lyrics === undefined) {
    try {
      lyrics = await api.lyrics(t);
      lyricsCache.set(t.id, lyrics);
    } catch {
      // Offline, say: opening the player again tries again.
      if (npInfo.trackId === t.id) npInfo.trackId = "";
      return;
    }
  }
  if (npInfo.trackId !== t.id || !lyrics) return;
  const synced = lyrics.synced?.length ? lyrics.synced : null;
  // Plain lyrics lose their blank lines; synced ones keep each line's place.
  const lines = synced ? synced.map((l) => l.text) : (lyrics.plain ?? "").split("\n").filter((l) => l.trim());
  if (!lines.some((l) => l.trim())) return;
  npInfo.lines = synced;
  npInfo.active = -2;
  const box = $("#np-lyrics-lines");
  box.style.translate = "";
  box.innerHTML = lines.map((l) => `<p>${esc(l) || "♪"}</p>`).join("");
  // Lyrics without times don't follow the song: all of them are lit.
  $("#np-lyrics").classList.toggle("plain", !synced);
  $("#np-lyrics").hidden = false;
  syncNpLyrics();
}

/** Moves the lyrics card along with the song: the line being sung stays
 *  second from the top, the ones before it lit, the ones to come dim. */
function syncNpLyrics() {
  const lines = npInfo.lines;
  if (!lines || !npOpen() || $("#np-lyrics").hidden) return;
  const i = lyricIndexAt(lines, player.audio.currentTime);
  if (i === npInfo.active) return;
  npInfo.active = i;
  const box = $("#np-lyrics-lines");
  const rows = box.children;
  for (let j = 0; j < rows.length; j++) {
    rows[j].classList.toggle("active", j === i);
    rows[j].classList.toggle("past", j < i);
  }
  const top = rows[Math.max(i - 1, 0)] as HTMLElement | undefined;
  box.style.translate = `0 ${-(top?.offsetTop ?? 0)}px`;
}

function npArtistPage(id: string): Promise<Artist | null> {
  let page = npArtists.get(id);
  if (!page) {
    // A failed lookup is tried again the next time.
    page = api.artist(id).catch(() => (npArtists.delete(id), null));
    npArtists.set(id, page);
  }
  return page;
}

async function npArtist(t: Track) {
  const id = t.artists?.find((a) => a.id)?.id ?? t.artistId;
  if (!id) return;
  const a = await npArtistPage(id);
  if (npInfo.trackId !== t.id) return;
  if (!a) {
    npInfo.trackId = "";
    return;
  }
  const go = `data-go="artist:${esc(a.id)}"`;
  const on = following.some((f) => f.id === a.id);
  const photo = imgUrl(a.thumbnail);
  const card = $("#np-artist");
  card.innerHTML = `<div class="np-artist-photo" ${go}>${photo ? `<img src="${esc(photo)}" alt="" draggable="false" />` : ""}<h3>About the artist</h3></div>
    <div class="np-artist-body">
      <div class="np-artist-name" ${go}><b>${esc(a.name)}</b>${a.audience ? `<span>${esc(a.audience)}</span>` : ""}</div>
      <button class="btn outline np-follow" data-id="${esc(a.id)}"></button>
      ${a.description ? `<p class="np-bio">${esc(a.description)}</p>` : ""}
    </div>`;
  const follow = card.querySelector<HTMLElement>(".np-follow")!;
  setNpFollow(follow, on);
  follow.onclick = () => {
    const now = !following.some((f) => f.id === a.id);
    setFollow({ id: a.id, name: a.name, thumbnail: a.thumbnail }, now);
    setNpFollow(follow, now);
    toast(now ? `Following ${a.name}` : `Stopped following ${a.name}`);
  };
  card.hidden = false;
  const songs = a.topSongs.filter((s) => s.id !== t.id).slice(0, 5);
  if (!songs.length) return;
  $("#np-more-title").textContent = `More by ${a.name}`;
  mountTrackList($("#np-more-list"), songs, { from: a.name, aside: true });
  $("#np-more-by").hidden = false;
}

function setNpFollow(btn: HTMLElement, on: boolean) {
  btn.classList.toggle("on", on);
  btn.textContent = on ? "Following" : "Follow";
}

function bindNpInfo() {
  // The lyrics card opens the lyrics full screen.
  $("#np-lyrics").onclick = () => toggleSidePanel("lyrics");
  $("#np-info").addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest(".track")) return;
    const go = el.closest<HTMLElement>("[data-go]")?.dataset.go;
    if (go) openTarget(go);
    else el.closest(".np-bio")?.classList.toggle("open");
  });
  $("#np-share").onclick = () => {
    const t = player.current;
    if (!t) return;
    if (!t.id.startsWith("yt:")) return toast("Only songs from YouTube Music can be shared", "error");
    void share({ kind: "song", id: t.id.slice(3), title: t.title, artist: t.artist });
  };
}

// ---- lyrics cards ----------------------------------------------------------------

/** Lyric lines picked for a card, by their place in the lyrics. */
const picked = new Set<number>();
const MAX_PICKED = 5;

/** Holding a line (right-clicking it on the desktop) starts picking; taps
 *  then add or drop lines (up to five). */
function bindLyricsCards() {
  const body = $("#lyrics-body");
  const lines = () => [...body.querySelectorAll<HTMLElement>("p")];
  const lineAt = (e: Event) => {
    const p = (e.target as HTMLElement).closest<HTMLElement>("p");
    return p && body.contains(p) && p.textContent?.trim() && p.textContent.trim() !== "♪" ? lines().indexOf(p) : -1;
  };
  const show = () => {
    lines().forEach((p, i) => p.classList.toggle("picked", picked.has(i)));
    body.classList.toggle("picking", picked.size > 0);
    $("#lyrics-pick").hidden = !picked.size;
    // The desktop saves the card as a picture rather than sharing it.
    $("#lyrics-pick-share").textContent = !phone ? "Save as picture" : picked.size > 1 ? `Share ${picked.size} lines` : "Share";
    // Keep the lines still while picking.
    lyricsView.holdUntil = picked.size ? Infinity : 0;
  };
  const toggle = (i: number) => {
    if (picked.has(i)) picked.delete(i);
    else if (picked.size < MAX_PICKED) picked.add(i);
    else toast(`Up to ${MAX_PICKED} lines`);
    show();
  };
  body.addEventListener("contextmenu", (e) => {
    const i = lineAt(e);
    if (i < 0) return;
    e.preventDefault();
    navigator.vibrate?.(12);
    if (!picked.has(i)) toggle(i);
  });
  // While picking, a tap picks instead of jumping to the line.
  body.addEventListener(
    "click",
    (e) => {
      if (!picked.size) return;
      e.stopImmediatePropagation();
      const i = lineAt(e);
      if (i >= 0) toggle(i);
    },
    true,
  );
  const cancel = () => {
    picked.clear();
    show();
  };
  $("#lyrics-pick-cancel").onclick = cancel;
  $("#lyrics-pick-share").onclick = () => {
    const text = lines()
      .filter((_, i) => picked.has(i))
      .map((p) => p.textContent!.trim());
    const track = player.current;
    cancel();
    if (track) void shareLyrics(track, text);
  };
  // A new song brings new lyrics.
  player.addEventListener("track", cancel);
}

/** Draws a card with the lines, the cover and the song, and shares it as a
 *  picture (the desktop saves it where the user picks). */
async function shareLyrics(track: Track, lines: string[]) {
  try {
    const W = 1080;
    const H = 1350;
    const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
    const ctx = canvas.getContext("2d")!;
    const url = artUrl(track);
    const cover = url ? await loadImage(url) : null;
    const [r, g, b] = (url && (await artColor(url))) || [190, 60, 70];
    // The cover's color fading into near-black, as on Now Playing.
    const bg = ctx.createLinearGradient(0, 0, W * 0.4, H);
    bg.addColorStop(0, `rgb(${r * 0.62}, ${g * 0.62}, ${b * 0.62})`);
    bg.addColorStop(1, "#0b0d14");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const pad = 88;
    if (cover) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(pad, 96, 168, 168, 20);
      ctx.clip();
      ctx.drawImage(cover, pad, 96, 168, 168);
      ctx.restore();
    }
    const textX = cover ? pad + 168 + 32 : pad;
    ctx.fillStyle = "#eef0f6";
    ctx.textBaseline = "top";
    ctx.font = '700 46px "Bricolage Grotesque", sans-serif';
    ctx.fillText(fit(ctx, track.title, W - pad - textX), textX, 128);
    ctx.fillStyle = "rgba(238, 240, 246, 0.72)";
    ctx.font = '500 32px "DM Mono", monospace';
    ctx.fillText(fit(ctx, track.artist.toUpperCase(), W - pad - textX), textX, 192);
    // The lines, as big as fits between the header and the mark.
    const top = 360;
    const bottom = H - 200;
    let size = 84;
    let wrapped: string[] = [];
    for (; size >= 40; size -= 4) {
      ctx.font = `800 ${size}px "Bricolage Grotesque", sans-serif`;
      wrapped = lines.flatMap((l) => wrap(ctx, l, W - pad * 2));
      if (wrapped.length * size * 1.12 <= bottom - top) break;
    }
    ctx.fillStyle = "#ffffff";
    // A short quote sits a little above the middle rather than at the top.
    const start = top + Math.max(0, (bottom - top - wrapped.length * size * 1.12) * 0.4);
    wrapped.forEach((l, i) => ctx.fillText(l, pad, start + i * size * 1.12));
    // Cadence's mark (src/icons.ts) and name.
    ctx.drawImage(markCanvas(60), pad, H - 132);
    ctx.fillStyle = "#eef0f6";
    ctx.font = '800 44px "Bricolage Grotesque", sans-serif';
    ctx.fillText("cadence", pad + 76, H - 121);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.92));
    if (!blob) throw new Error("Couldn't make the picture");
    await sharePicture(new Uint8Array(await blob.arrayBuffer()), `${track.title} lyrics`);
  } catch (e) {
    toast(String(e), "error");
  }
}

/** Shares a JPEG the page drew through Android's share sheet; the desktop
 *  saves it where the user picks, named `name`. */
async function sharePicture(jpeg: Uint8Array, name: string) {
  if (phone) return await api.shareImage(jpeg);
  const file = name.replace(/[\\/:*?"<>|]/g, "").trim() || "Cadence";
  const path = await save({
    title: "Save the picture",
    defaultPath: await join(await pictureDir().catch(() => documentDir()), `${file}.jpg`),
    filters: [{ name: "JPEG picture", extensions: ["jpg"] }],
  });
  if (!path) return;
  await api.imageSave(path, jpeg);
  toast("Picture saved");
}

/** Cadence's mark drawn `size` px wide; its gaps are cut out, so it sits on any background. */
function markCanvas(size: number): HTMLCanvasElement {
  const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
  const ctx = canvas.getContext("2d")!;
  ctx.scale(size / 72, size / 72);
  ctx.translate(-14, -14);
  const cut = ([x, y, r]: readonly number[]) => {
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  };
  ctx.lineCap = "round";
  ctx.lineWidth = 5;
  ctx.strokeStyle = MARK.ring;
  ctx.stroke(new Path2D(MARK.farRing));
  cut(MARK.planetGap);
  ctx.fillStyle = MARK.planetColor;
  ctx.fill(new Path2D(MARK.planet), "evenodd");
  ctx.stroke(new Path2D(MARK.nearRing));
  cut(MARK.moonGap);
  ctx.fillStyle = MARK.moonColor;
  ctx.beginPath();
  ctx.arc(MARK.moon[0], MARK.moon[1], MARK.moon[2], 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  return img.decode().then(
    () => img,
    () => null,
  );
}

/** `text` cut with an ellipsis to fit `width`. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let t = text;
  while (t && ctx.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** `text` broken into lines no wider than `width`. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(fit(ctx, line, width));
  return out;
}

// ---- mini player -----------------------------------------------------------------

/** Set once the mini player has loaded, until it closes again. */
let miniOpen = false;

function sendMiniState() {
  if (!miniOpen) return;
  const a = player.audio;
  const root = document.documentElement.style;
  const state: MiniState = {
    track: player.current,
    playing: player.playing,
    loading: player.loading,
    time: a.currentTime,
    duration: isFinite(a.duration) ? a.duration : (player.current?.duration ?? 0),
    liked: !!player.current && liked.has(player.current.id),
    art: root.getPropertyValue("--art") || null,
  };
  void emitTo("mini", "mini-state", state);
}

async function openMini() {
  setEqOpen(false);
  $("#menu").hidden = true;
  try {
    await api.miniPlayer(true);
  } catch (e) {
    toast(`Could not open the mini player: ${e}`, "error");
  }
}

async function bindMini() {
  $("#btn-mini").onclick = () => void openMini();
  await listen<MiniCommand>("mini-command", (e) => {
    const c = e.payload;
    if (c.action === "ready") miniOpen = true;
    else if (c.action === "toggle") player.toggle();
    else if (c.action === "next") player.next();
    else if (c.action === "prev") player.prev();
    else if (c.action === "seek") player.seek(c.time);
    else if (c.action === "like" && player.current) void toggleLike(player.current);
    sendMiniState();
  });
  await listen("mini-closed", () => {
    miniOpen = false;
  });
}

// ---- equalizer ---------------------------------------------------------------

function setEqOpen(open: boolean) {
  const panel = $("#eq-panel");
  if (panel.hidden === !open) return;
  panel.hidden = !open;
  $("#btn-eq").classList.toggle("on", open);
  if (open) renderEq();
}

function bandLabel(f: number) {
  return f >= 1000 ? `${f / 1000}k` : String(f);
}

function renderEq() {
  const gains = player.eqGains;
  const active = Object.entries(EQ_PRESETS).find(([, g]) => g.every((v, i) => v === gains[i]))?.[0];
  $("#eq-panel").innerHTML = `
    <header><h2>Equalizer</h2><button class="text-btn" data-preset="Flat">Reset</button></header>
    <div class="presets">${Object.keys(EQ_PRESETS)
      .map((p) => `<button class="chip-btn ${p === active ? "on" : ""}" data-preset="${p}">${p}</button>`)
      .join("")}</div>
    <div class="bands">
      <div class="band preamp">
        <span class="db" id="pre-val">${player.preampGain > 0 ? "+" : ""}${player.preampGain}</span>
        <input type="range" class="vslider" id="preamp" min="-12" max="12" step="1" value="${player.preampGain}" />
        <span class="hz">Pre</span>
      </div>
      ${EQ_BANDS.map(
        (f, i) => `<div class="band">
          <span class="db">${gains[i] > 0 ? "+" : ""}${gains[i]}</span>
          <input type="range" class="vslider" data-band="${i}" min="-12" max="12" step="1" value="${gains[i]}" />
          <span class="hz">${bandLabel(f)}</span>
        </div>`,
      ).join("")}
    </div>`;
  const panel = $("#eq-panel");
  panel.oninput = (e) => {
    const input = e.target as HTMLInputElement;
    const v = Number(input.value);
    const label = input.previousElementSibling as HTMLElement;
    label.textContent = `${v > 0 ? "+" : ""}${v}`;
    if (input.id === "preamp") player.setPreamp(v);
    else player.setEqBand(Number(input.dataset.band), v);
    panel.querySelectorAll(".chip-btn.on").forEach((c) => c.classList.remove("on"));
  };
  panel.onclick = (e) => {
    const preset = (e.target as HTMLElement).closest<HTMLElement>("[data-preset]")?.dataset.preset;
    if (!preset) return;
    player.setEq(EQ_PRESETS[preset]);
    if (preset === "Flat") player.setPreamp(0);
    renderEq();
  };
}

// ---- player bar ------------------------------------------------------------------

let seeking = false;

/** The song the player bar last showed, to notice a new one. */
let shownTrack = "";

function updateNowPlaying() {
  const t = player.current;
  // Phones: a new song's name fades up into place, and its cover fades in as
  // it loads (phone.css). A swipe already slides the new song in.
  if (phone && t && shownTrack && t.id !== shownTrack && !justSwiped() && !calm()) {
    $(".now-text").animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE });
  }
  shownTrack = t?.id ?? "";
  $("#now-title").innerHTML = t ? linked(t.title, albumTarget(t)) : "Nothing playing";
  $("#now-title").dataset.len = titleLength(t?.title ?? "");
  const showArtists = () => {
    $("#now-artist").innerHTML = t ? artistLinks(t) : "";
    // Phones give each of several artists a chip of their own.
    $("#now-artist").classList.toggle("several", !!t?.artists?.length);
  };
  showArtists();
  if (t) void findArtists(t).then((found) => found && player.current === t && showArtists());
  $("#now-art").innerHTML = t ? artHtml(t, "lg") : "";
  // Episodes aren't liked; the buttons around play skip within them.
  $("#now-like").hidden = !t || isEpisode(t);
  $(".player").classList.toggle("idle", !t);
  showEpisodeControls(isEpisode(t));
  updateNowExtras();
  if (!t) setNowPlayingOpen(false);
  updateNowLike();
  document.title = t ? `${t.title} · ${t.artist}` : "Cadence";
  if (t) $("#time-dur").textContent = formatTime(t.duration);
  markPlaying();
  void updateAccent(t);
}

/** Where the song is playing from, and whether it is downloaded. */
function updateNowExtras() {
  const t = player.current;
  const from = $("#np-from");
  from.hidden = !player.from && sleepAt === null;
  from.querySelector("b")!.textContent = player.from;
  const btn = $("#now-dl");
  const dl = t && downloads.get(t.id)?.state;
  btn.hidden = !t?.id.startsWith("yt:") && !isEpisode(t);
  btn.classList.toggle("on", dl === "done");
  btn.title = dl === "done" ? "Downloaded · tap to remove" : dl ? "Downloading · tap to cancel" : "Download";
  setIcon(btn, dl === "done" ? "downloadDone" : dl ? "close" : "download", 22);
  renderNowPanel();
}

function updateNowLike() {
  const t = player.current;
  const on = !!t && liked.has(t.id);
  const btn = $("#now-like");
  btn.classList.toggle("on", on);
  setIcon(btn, on ? "heartFilled" : "heart", 20);
  const panelLike = document.querySelector<HTMLElement>('#np-body [data-np="like"]');
  if (panelLike) {
    panelLike.classList.toggle("on", on);
    setIcon(panelLike, on ? "heartFilled" : "heart", 22);
  }
  sendMiniState();
}

function updateState() {
  for (const play of [$("#btn-play"), $("#q-play")]) {
    const label = player.playing ? "Pause" : "Play";
    // Phones: play and pause turn into each other with a little give.
    if (phone && play.title && play.title !== label) pulse(play, "swap");
    setIcon(play, player.playing ? "pause" : "play", 28);
    play.classList.toggle("loading", player.loading && player.playing);
    play.title = label;
  }
  const shuffle = $("#btn-shuffle");
  shuffle.classList.toggle("on", player.shuffle);
  // Episodes have the speed there instead (showEpisodeControls).
  if (!isEpisode(player.current)) {
    const name = player.smart ? "smartShuffle" : "shuffle";
    if (shuffle.dataset.shows !== name) {
      setIcon(shuffle, name, 22);
      shuffle.dataset.shows = name;
    }
    shuffle.title = player.smart ? "Smart shuffle" : "Shuffle";
  }
  document.querySelectorAll<HTMLElement>(".shuffle-toggle").forEach((b) => {
    b.classList.toggle("on", player.shuffle);
    if (b.dataset.smart !== String(player.smart)) {
      b.innerHTML = shuffleInner(b.dataset.hero ? 22 : 18);
      b.dataset.smart = String(player.smart);
    }
  });
  const repeat = $("#btn-repeat");
  setIcon(repeat, player.repeat === "one" ? "repeatOne" : "repeat", 20);
  repeat.classList.toggle("on", player.repeat !== "off");
  repeat.title = { off: "Repeat off", all: "Repeat all", one: "Repeat one" }[player.repeat];
  const muted = player.audio.muted || player.audio.volume === 0;
  setIcon($("#btn-mute"), muted ? "mute" : "volume", 20);
  const vol = $<HTMLInputElement>("#volume");
  vol.value = String(Math.round((player.audio.muted ? 0 : player.audio.volume) * 100));
  vol.style.setProperty("--p", `${vol.value}%`);
}

function updateTime() {
  const a = player.audio;
  const dur = isFinite(a.duration) ? a.duration : (player.current?.duration ?? 0);
  if (!seeking) {
    const seek = $<HTMLInputElement>("#seek");
    const p = dur ? (a.currentTime / dur) * 1000 : 0;
    seek.value = String(p);
    seek.style.setProperty("--p", `${p / 10}%`);
    $("#time-cur").textContent = formatTime(a.currentTime);
    if (phone) {
      $("#q-progress").style.width = `${p / 10}%`;
      $("#q-time").textContent = `${formatTime(a.currentTime)} / ${formatTime(dur || null)}`;
    }
  }
  $("#time-dur").textContent = formatTime(dur || null);
}

/** Tints the UI with the dominant color of the current artwork. */
let accentToken = 0;

async function updateAccent(track: Track | null) {
  const url = artUrl(track);
  const root = document.documentElement;
  // Artwork loads at different speeds; only the latest track may set the color.
  const token = ++accentToken;
  const reset = () => {
    if (token !== accentToken) return;
    root.style.removeProperty("--art");
    sendMiniState();
  };
  if (!url) return reset();
  const color = await artColor(url);
  if (token !== accentToken) return;
  if (!color) return reset();
  const [r, g, b] = color;
  // The app keeps its red; the cover only tints the glow behind the player.
  root.style.setProperty("--art", `rgb(${r}, ${g}, ${b})`);
  sendMiniState();
}

/** The most colorful tone of a cover, lifted to read on a dark background;
 *  null for black-and-white art or art that won't load. */
async function artColor(url: string): Promise<[number, number, number] | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const c = document.createElement("canvas");
  c.width = c.height = 24;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, 24, 24);
  const data = ctx.getImageData(0, 0, 24, 24).data;
  let best = { score: -1, r: 0, g: 0, b: 0 };
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max ? (max - min) / max : 0;
    const score = sat * (1 - Math.abs(max / 255 - 0.7));
    if (score > best.score) best = { score, r, g, b };
  }
  if (best.score < 0.15) return null;
  const lift = Math.max(0, 170 - Math.max(best.r, best.g, best.b));
  return [best.r + lift, best.g + lift, best.b + lift];
}

/** A page's header glows with its cover's color. */
async function tintPage(token: number) {
  const view = $("#view");
  view.style.removeProperty("--page-art");
  // A mood has no cover; it glows with its tile's color.
  if (page?.kind === "mood") return view.style.setProperty("--page-art", moodColor(page.color));
  const src = view.querySelector<HTMLImageElement>(".hero-art img")?.src;
  const color = src ? await artColor(src) : null;
  if (color && token === pageToken) view.style.setProperty("--page-art", `rgb(${color.join(", ")})`);
}

function bindPlayerBar() {
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon as IconName, el.classList.contains("nav-item") ? 20 : 22));
  });
  $("#btn-play").onclick = () => player.toggle();
  $("#btn-next").onclick = () => (isEpisode(player.current) ? skipBy(30) : player.next());
  $("#btn-prev").onclick = () => (isEpisode(player.current) ? skipBy(-15) : player.prev());
  $("#btn-shuffle").onclick = (e) => {
    if (isEpisode(player.current)) return speedMenu(e);
    cycleShuffle();
  };
  $("#btn-repeat").onclick = () => player.cycleRepeat();
  $("#btn-mute").onclick = () => player.toggleMute();
  $("#btn-queue").onclick = () => toggleSidePanel("queue");
  $("#btn-now").onclick = () => toggleSidePanel("now");
  $("#np-panel-more").onclick = (e) => player.current && openMenu(e, player.current, [sleepItem()]);
  $("#btn-lyrics").onclick = () => toggleSidePanel("lyrics");
  $("#btn-eq").onclick = () => setEqOpen(Boolean($("#eq-panel").hidden));
  $("#now-like").onclick = () => player.current && void toggleLike(player.current);

  const seek = $<HTMLInputElement>("#seek");
  seek.addEventListener("input", () => {
    seeking = true;
    const dur = player.audio.duration || player.current?.duration || 0;
    seek.style.setProperty("--p", `${Number(seek.value) / 10}%`);
    $("#time-cur").textContent = formatTime((Number(seek.value) / 1000) * dur);
  });
  seek.addEventListener("change", () => {
    const dur = player.audio.duration || player.current?.duration || 0;
    player.seek((Number(seek.value) / 1000) * dur);
    seeking = false;
  });

  const vol = $<HTMLInputElement>("#volume");
  vol.addEventListener("input", () => player.setVolume(Number(vol.value) / 100));
  vol.addEventListener("wheel", (e) => {
    e.preventDefault();
    player.setVolume(player.audio.volume + (e.deltaY < 0 ? 0.05 : -0.05));
  });

  player.addEventListener("track", () => {
    updateNowPlaying();
    // Otherwise the last song's time shows until the new one reports in.
    updateTime();
    void loadLyrics();
    renderNpInfo();
    sendMiniState();
  });
  player.addEventListener("state", () => {
    updateState();
    if (player.playing) startLyricsLoop();
    sendMiniState();
  });
  player.addEventListener("time", () => {
    updateTime();
    sendMiniState();
    // Covers seeking while paused; during playback the frame loop does this.
    syncLyrics();
    syncNpLyrics();
  });
  player.addEventListener("queue", () => {
    renderQueue();
    renderNowPanel();
    markPlaying();
  });
  player.addEventListener("error", (e) => toast((e as CustomEvent<string>).detail, "error"));
}

function bindKeys() {
  // A clicked button keeps focus, and Space would then press it again on top
  // of the play/pause shortcut. Drop focus after mouse clicks; keyboard users
  // who tab to a button still get its normal Space/Enter behavior.
  document.addEventListener("pointerup", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (btn) requestAnimationFrame(() => btn.blur());
  });

  if (import.meta.env.PROD) {
    // Hide the browser's own right-click menu (Reload, Print, …) outside text fields.
    document.addEventListener("contextmenu", (e) => {
      if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
    });
  }

  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    const typing = target.matches("input[type=search], input[type=text], textarea");
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      $("#menu").hidden = true;
      setEqOpen(false);
    }
    if (!$("#dialog").hidden) return;
    if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      return goBack();
    }
    if (ctrl && e.key.toLowerCase() === "f") {
      e.preventDefault();
      if (view === "music") $<HTMLInputElement>("#lib-q")?.focus();
      else if (document.getElementById("find")) $<HTMLInputElement>("#find").focus();
      else if (view === "search") $<HTMLInputElement>("#q")?.focus();
      else setView("search");
      return;
    }
    // Browser shortcuts that make no sense in an app (reload loses playback).
    if (import.meta.env.PROD && (e.key === "F5" || (ctrl && ["r", "p"].includes(e.key.toLowerCase())))) {
      e.preventDefault();
      return;
    }
    if (typing) return;
    // Sliders handle their own arrow keys; a focused button handles Space.
    const slider = target.matches("input[type=range]");
    const button = target.closest("button") !== null;
    if (e.key === " ") {
      if (button) return;
      e.preventDefault();
      player.toggle();
    } else if (slider && e.key.startsWith("Arrow")) {
      return;
    } else if (e.key.toLowerCase() === "l" && !ctrl && !e.altKey) toggleSidePanel("lyrics");
    else if (e.key === "ArrowRight" && ctrl) player.next();
    else if (e.key === "ArrowLeft" && (e.ctrlKey || e.metaKey)) player.prev();
    else if (e.key === "ArrowRight") player.seek(player.audio.currentTime + 5);
    else if (e.key === "ArrowLeft") player.seek(player.audio.currentTime - 5);
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      player.setVolume(player.audio.volume + 0.05);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      player.setVolume(player.audio.volume - 0.05);
    }
  });
}

// ---- boot --------------------------------------------------------------------------

async function boot() {
  bindPlayerBar();
  bindQueue();
  bindLyrics();
  bindKeys();
  bindCommon();
  bindPhone();
  trackListening(player);
  trackPodcasts(player, refreshEpisodeRows);
  // Episode rows show a pause button on the one playing.
  player.addEventListener("state", updateEpisodeButtons);
  await bindMini();
  document.querySelectorAll<HTMLElement>(".nav-item[data-view]").forEach((b) => {
    b.onclick = () => setView(b.dataset.view as Exclude<View, "page">);
  });
  // The desktop's Your Library: each opens with Back to where it was opened from.
  $("#playlists").addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".nav-item");
    if (el?.dataset.pl) openPlaylist(Number(el.dataset.pl));
    else if (el?.dataset.go) openTarget(el.dataset.go);
    else if (el?.dataset.view) {
      history.push({ view, page, scroll: $("#view").scrollTop });
      show(el.dataset.view as View, null);
    }
  });
  $("#app-menu").onclick = openSettings;
  $("#playlist-new").onclick = playlistNewMenu;
  // Links outside track lists: page headers, album and artist cards, the player bar.
  for (const area of [$("#view"), $(".now-text")]) {
    area.addEventListener("click", (e) => {
      const el = e.target as HTMLElement;
      if (!el.closest(".track")) openLink(e, area === $("#view") ? null : player.current);
    });
  }
  // The mouse's back button.
  document.addEventListener("mouseup", (e) => {
    if (e.button === 3) {
      e.preventDefault();
      goBack();
    }
  });
  $("#view").addEventListener("scroll", () => loadMoreRows?.(), { passive: true });
  // A cover that still fails to load shows the music-note placeholder instead
  // of the browser's broken-image icon.
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (img instanceof HTMLImageElement && img.parentElement?.matches(".track-art, .q-art, .now-art, .page-row-art, .card-art, .pl-art")) {
        img.replaceWith(Object.assign(document.createElement("span"), { className: "art-fallback", innerHTML: icon("music", 18) }));
      }
    },
    true,
  );

  updateNowPlaying();
  updateState();
  updateTime();
  // Phones: the song left in the player bar is the likeliest first play, and
  // a lookup takes seconds there. It also gets YouTube's player prepared.
  if (phone && player.current) player.warm(player.current);
  // On a phone the panels are full-screen sheets; never open one on launch.
  setSidePanel(phone ? null : settings.get<Side>("sidePanel", settings.get("queueOpen", false) ? "queue" : null));

  await listen<{ folder: string; done: number; total: number; finished: boolean }>("library-scan", (e) => {
    const p = e.payload;
    scanStatus = p.finished ? "" : `Scanning ${p.folder} · ${p.done} of ${p.total} files`;
    const el = document.getElementById("scan-status");
    if (el) el.textContent = scanStatus;
    if (p.finished && view === "music") void loadLibraryTracks($<HTMLInputElement>("#lib-q")?.value ?? "");
    else if (p.finished) void refreshMusicCount();
  });
  await listen<string>("library-scan-error", (e) => toast(`Library scan failed: ${e.payload}`, "error"));
  await listen<{ downloaded: number; total: number | null }>("ytdlp-progress", (e) => {
    installing = e.payload;
    renderEngineBanner();
  });
  await listen<string>("ytdlp-updated", async (e) => {
    engine = await api.ytdlpStatus();
    renderEngineStatus();
    renderEngineBanner();
    toast(`yt-dlp updated to ${e.payload}`);
  });

  await listen<DownloadItem>("download", (e) => onDownload(e.payload));

  try {
    for (const t of await api.likedList()) liked.set(t.id, t);
  } catch (e) {
    toast(`Could not load liked songs: ${e}`, "error");
  }
  try {
    for (const d of await api.downloadsList()) downloads.set(d.track.id, d);
    updateDlChip();
  } catch (e) {
    toast(`Could not load downloads: ${e}`, "error");
  }
  await refreshPlaylists();
  await refreshMusicCount();
  await refreshFollowedShows();
  await listen<{ done: number; total: number }>("import-progress", (e) => importStatus?.(e.payload));
  const safetyCopy = settings.get<string | null>("restoredFrom", null);
  if (safetyCopy) {
    localStorage.removeItem("cadence.restoredFrom");
    void openDialog({
      title: "Backup restored",
      body: `What you had before is saved as <code>${esc(safetyCopy)}</code>. To go back to it, restore that file.`,
      ok: "OK",
      cancel: false,
    });
  }
  setView(view as Exclude<View, "page">);
  updateNowLike();
  if (phone) void openSharedLink();

  engine = await api.ytdlpStatus();
  renderEngineStatus();
  renderEngineBanner();

  void autoDownload();
  window.addEventListener("online", () => void autoDownload());
  // After the app has settled; a backup takes a moment.
  setTimeout(() => void autoBackup(), 8000);
  void checkAppUpdate(true);
  if (phone) {
    (navigator as Navigator & { connection?: EventTarget }).connection?.addEventListener("change", () => void autoDownload());
    onAway((away) => !away && void autoDownload());
    onAway((away) => !away && void autoBackup());
    // Back on a new day with Home showing: today's mixes.
    onAway((away) => !away && view === "home" && madeForYouDue() && void renderMixes());
    // Back from allowing installs from Cadence: carry on with the update.
    onAway((away) => {
      if (away || !installPending) return;
      installPending = false;
      void installAppUpdate(() => {}).catch((e) => toast(String(e), "error"));
    });
  }
}

void boot();
