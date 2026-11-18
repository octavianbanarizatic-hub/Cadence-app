// Messages between the main window, which plays the audio, and the mini player.
import type { Track } from "./api";

/** Sent by the main window as `mini-state` whenever something changes. */
export interface MiniState {
  track: Track | null;
  playing: boolean;
  loading: boolean;
  /** Playback position in seconds when the message was sent. */
  time: number;
  duration: number;
  liked: boolean;
  /** The cover's color, which tints the window; null for none. */
  art: string | null;
}

/** Sent by the mini player as `mini-command`. */
export type MiniCommand =
  | { action: "ready" | "toggle" | "next" | "prev" | "like" }
  | { action: "seek"; time: number };
