import { api, onAway, type Episode, type Track } from "./api";
import type { Player } from "./player";
import { settings } from "./settings";

/** Episodes play in the player as tracks: `pod:<id>`, the show as the artist. */
export function episodeTrack(e: Episode): Track {
  return { id: `pod:${e.id}`, title: e.title, artist: e.showTitle, album: null, duration: e.duration, thumbnail: `pcast/${e.showId}` };
}

export function isEpisode(t: Track | null | undefined): boolean {
  return !!t?.id.startsWith("pod:");
}

/** The show an episode's track belongs to (its artwork names it). */
export function showOf(t: Track): string | null {
  return t.thumbnail?.startsWith("pcast/") ? t.thumbnail.slice(6) : null;
}

/** Where each episode the page knows of was left off, by episode id. */
export const progress = new Map<string, { position: number; played: boolean }>();

/** Remembers what the back end said about these episodes. */
export function learn(episodes: Episode[]) {
  for (const e of episodes) progress.set(e.id, { position: e.position, played: e.played });
}

/** Seconds from the end at which an episode counts as heard. */
const PLAYED_NEAR_END = 20;
/** How often the spot is saved while an episode plays. */
const SAVE_EVERY = 10;

export const SPEEDS = [0.5, 0.8, 1, 1.2, 1.5, 1.8, 2, 2.5, 3];

export function speed(): number {
  return settings.get<number>("podcastSpeed", 1);
}

/**
 * Spotify's podcast habits: an episode starts where it was left off, its
 * spot is saved as it plays (and when it pauses, changes or the app goes
 * away), it counts as heard near the end, and it plays at the speed picked
 * for podcasts while songs keep normal speed. `changed` runs when an
 * episode becomes heard or not, for lists showing it.
 */
export function trackPodcasts(player: Player, changed: () => void) {
  let current: Track | null = null;
  // The episode's last known spot and length: by the time the next track
  // starts, the audio element may already hold that one.
  let pos = 0;
  let end = 0;
  let savedAt = 0;
  // Until the saved spot is restored, the element's time says nothing.
  let resuming = false;

  const save = () => {
    if (!current || resuming) return;
    const id = current.id.slice(4);
    const before = progress.get(id);
    // Heard stays heard: marked as played by hand, or once near the end.
    // Only playing it again from the list (`replay`) or "Mark as not
    // played" makes it new again.
    const played = !!before?.played || (end > 0 && pos > end - PLAYED_NEAR_END);
    savedAt = pos;
    if (before && before.played === played && Math.abs(before.position - pos) < 1) return;
    progress.set(id, { position: pos, played });
    void api.podcastProgress(id, pos, played).catch(() => {});
    if (before?.played !== played) changed();
  };

  player.addEventListener("track", () => {
    save();
    const t = player.current;
    current = isEpisode(t) ? t : null;
    const a = player.audio;
    a.playbackRate = current ? speed() : 1;
    if (!current) return;
    const episode = current;
    const id = episode.id.slice(4);
    pos = savedAt = 0;
    end = episode.duration ?? 0;
    resuming = true;
    const resume = (at: { position: number; played: boolean } | undefined) => {
      if (player.current !== episode) return;
      const go = () => {
        if (player.current !== episode) return;
        if (at && !at.played && at.position > 5) a.currentTime = at.position;
        pos = savedAt = a.currentTime;
        resuming = false;
      };
      if (a.readyState >= HTMLMediaElement.HAVE_METADATA) go();
      else a.addEventListener("loadedmetadata", go, { once: true });
    };
    // Episodes from a list the page loaded are known; one restored at start
    // (the last thing played) is asked about.
    const known = progress.get(id);
    if (known) resume(known);
    else void api.podcastSpot(id).then(
      (spot) => {
        if (spot) progress.set(id, spot);
        resume(spot ?? undefined);
      },
      () => resume(undefined),
    );
  });
  player.addEventListener("time", () => {
    if (!current || resuming) return;
    const a = player.audio;
    pos = a.currentTime;
    if (isFinite(a.duration)) end = a.duration;
    // Saved early once, so Home's "Your episodes" has it straight away.
    if (Math.abs(pos - savedAt) >= SAVE_EVERY || (savedAt < 1 && pos > 2)) save();
  });
  player.addEventListener("state", () => {
    if (current && !player.playing) save();
  });
  onAway((away) => away && save());
}

/** An episode heard before, played again: it starts over and counts as new. */
export function replay(id: string) {
  if (!progress.get(id)?.played) return;
  progress.set(id, { position: 0, played: false });
  void api.podcastProgress(id, 0, false).catch(() => {});
}

/** Sets the speed for podcasts, at once if an episode is playing. */
export function setSpeed(player: Player, rate: number) {
  settings.set("podcastSpeed", rate);
  if (isEpisode(player.current)) player.audio.playbackRate = rate;
}

/** "45 min left", "1 h 5 min", "Played", from where an episode is. */
export function episodeTime(e: Episode): string {
  const spot = progress.get(e.id) ?? e;
  if (spot.played) return "Played";
  const total = e.duration ?? 0;
  const left = total - spot.position;
  const fmt = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.max(1, Math.round((s % 3600) / 60));
    return h ? `${h} h ${m} min` : `${m} min`;
  };
  if (!total) return spot.position > 0 ? "Started" : "";
  return spot.position > 5 ? `${fmt(left)} left` : fmt(total);
}

/** "Today", "Yesterday", "3 days ago", "12 Nov", "12 Nov 2024". */
export function episodeDate(secs: number | null): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}
