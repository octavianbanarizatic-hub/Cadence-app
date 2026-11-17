import { api, onAway, type Track } from "./api";
import type { Player } from "./player";

/** A song counts as played after this many seconds, as on Spotify. */
const COUNTS_AFTER = 30;
/** How often a play's listening time is saved while it goes on. */
const SAVE_EVERY = 15;

/**
 * Keeps the listening history for Profile's top lists: a play is saved once
 * a song has been heard for 30 seconds (or most of a shorter song), and its
 * time keeps growing while it plays. Seeking doesn't count as listening.
 */
export function trackListening(player: Player) {
  let track: Track | null = null;
  let heard = 0;
  let saved = 0;
  let last = 0;
  let play: Promise<number> | null = null;

  const save = () => {
    if (!play || heard - saved < 1) return;
    saved = heard;
    const seconds = Math.round(heard);
    void play.then((id) => (id >= 0 ? api.playTime(id, seconds) : undefined)).catch(() => {});
  };
  const start = (t: Track | null) => {
    save();
    // Podcast episodes aren't music: they stay out of the top lists.
    track = t?.id.startsWith("pod:") ? null : t;
    heard = saved = last = 0;
    play = null;
  };

  player.addEventListener("track", () => start(player.current));
  player.addEventListener("time", () => {
    const t = player.audio.currentTime;
    const step = t - last;
    // Repeat one starts the song over: that's another play.
    if (step < -5 && player.audio.loop && t < 3) start(player.current);
    last = t;
    if (!track || !player.playing || step <= 0 || step > 2) return;
    heard += step;
    const duration = player.audio.duration;
    const enough = isFinite(duration) ? Math.min(COUNTS_AFTER, duration * 0.8) : COUNTS_AFTER;
    if (!play && heard >= enough) {
      saved = heard;
      // A play that couldn't be saved is skipped rather than retried.
      play = api.playStart(track, Math.round(heard)).catch(() => -1);
    } else if (heard - saved >= SAVE_EVERY) {
      save();
    }
  });
  // The phone may close the app while it's in the background.
  onAway((away) => away && save());
}
