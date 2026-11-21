import { api, artUrl, streamUrl, type Track } from "./api";
import { settings } from "./settings";

export type Repeat = "off" | "all" | "one";

export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Bass boost": [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  Vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  Rock: [4, 3, 2, 0, -1, 0, 2, 3, 4, 4],
  Electronic: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5],
  Acoustic: [3, 2, 1, 1, 2, 2, 3, 3, 2, 1],
};

/** How long before a song ends the next one starts loading, in seconds. */
const PRELOAD_AHEAD = 30;
/** The longest crossfade Settings offers, in seconds. */
export const MAX_CROSSFADE = 12;
/** How long play and pause fade, when that is on, in seconds. */
const PAUSE_FADE = 0.4;

/** `items` in a random order (Fisher–Yates). */
export function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Plays a queue of tracks through two <audio> elements that take turns,
 * both routed into one Web Audio graph: sources → a fade gain each → preamp →
 * 10 EQ bands → output. While one plays, the other loads the next song, which
 * starts the moment the current one ends so there is no gap between them, or
 * a few seconds early with a crossfade.
 *
 * Events: `track` (current track changed), `state` (play/pause/loading),
 * `time`, `queue`, `error` (detail: message).
 */
export class Player extends EventTarget {
  private readonly elements = [new Audio(), new Audio()];
  /** Index into `elements` of the one that is playing (or about to). */
  private active = 0;
  /** Id of the track loaded in the spare element, ready to take over. */
  private preloaded: string | null = null;
  /** A track whose preload failed; it loads the normal way instead. */
  private preloadFailed: string | null = null;
  private gaplessTimer: number | undefined;
  queue: Track[] = [];
  index = -1;
  /** Where the queue's list came from, shown as "Playing from" on phones. */
  from = "";
  shuffle = settings.get("shuffle", false);
  /**
   * Smart shuffle, as in Spotify (phones): with shuffle on, songs like the
   * list's are mixed into the songs to come, one after every three of the
   * list's, marked as suggestions. Turning it off takes them out again.
   */
  smart: boolean = this.shuffle && settings.get<boolean>("smartShuffle", false);
  repeat: Repeat = settings.get("repeat", "off");
  loading = false;

  /** Seconds songs overlap as one fades into the next; 0 is off. */
  crossfade = settings.get("crossfade", 0);
  /** Whether play and pause fade in and out instead of cutting. */
  fadePause = settings.get("fadePause", false);
  /** Set while a pause fades out; the element pauses when it ends. */
  private pauseTimer: number | undefined;

  private ctx: AudioContext | null = null;
  /** One per element, for fades. */
  private fades: GainNode[] = [];
  private preamp: GainNode | null = null;
  private filters: BiquadFilterNode[] = [];
  private eq = settings.get("eq", EQ_PRESETS.Flat);
  private preampDb = settings.get("preamp", 0);
  private history: number[] = [];
  /**
   * Shuffle, as in Spotify, mixes the songs still to come in the queue itself,
   * so the queue shows the order they will play in. This is the list in its
   * own order, put back when shuffle goes off.
   */
  private unshuffled: Track[] | null = null;
  private errorStreak = 0;
  /** The song given a second go after its stream failed, this play (`onError`). */
  private retried: string | null = null;
  private warmed = new Map<string, number>();
  private prefetchTimer: number | undefined;
  private ahead: Track[] = [];
  private aheadRunning = false;
  /** Songs queued by hand; they play before the rest of the list. */
  private queued = new WeakSet<Track>();
  /**
   * Phones: when the list runs out, songs like the last one keep playing, as
   * in Spotify's Autoplay. The page turns it on; desktops leave it off.
   */
  autoplay = false;

  /** Songs the user asked never to hear ("Don't play this song"): Autoplay and
   *  smart shuffle leave them out. The page keeps it up to date. */
  hidden = new Set<string>();
  /** Songs Autoplay added; the queue shows them under their own heading. */
  private autoplayed = new WeakSet<Track>();
  /** Smart shuffle's suggestions, and more like the list waiting their turn. */
  private suggested = new WeakSet<Track>();
  private suggestions: Track[] = [];
  private suggesting = false;
  private warmingSuggestions = false;
  private filling = false;
  /** The sleep timer's "end of this song": the music stops when it ends. */
  stopAtEnd = false;
  /** Bumped by `playList`, so songs that arrive for an old list are dropped. */
  private listGen = 0;

  constructor() {
    super();
    const volume = settings.get("volume", 0.8);
    for (const el of this.elements) {
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.volume = volume;
      this.bindElement(el);
    }
    this.restoreQueue();
    this.setupMediaSession();
  }

  /** The element that is playing. Its events drive the UI; the spare's don't. */
  get audio(): HTMLAudioElement {
    return this.elements[this.active];
  }

  private get spare(): HTMLAudioElement {
    return this.elements[1 - this.active];
  }

  private bindElement(el: HTMLAudioElement) {
    const live = (fn: () => void) => () => {
      if (el === this.audio) fn();
    };
    el.addEventListener("play", live(() => this.emit("state")));
    el.addEventListener(
      "pause",
      live(() => {
        clearTimeout(this.gaplessTimer);
        this.emit("state");
      }),
    );
    el.addEventListener("waiting", live(() => this.setLoading(true)));
    el.addEventListener(
      "playing",
      live(() => {
        this.setLoading(false);
        this.errorStreak = 0;
        // Resolve the next YouTube stream while this one plays.
        clearTimeout(this.prefetchTimer);
        this.prefetchTimer = window.setTimeout(() => {
          const next = this.queue[this.upcomingIndex()];
          if (next) this.warm(next);
        }, 2000);
      }),
    );
    el.addEventListener("canplay", live(() => this.setLoading(false)));
    el.addEventListener(
      "timeupdate",
      live(() => {
        this.emit("time");
        this.updatePositionState();
        this.prepareNext();
      }),
    );
    el.addEventListener("seeking", live(() => clearTimeout(this.gaplessTimer)));
    el.addEventListener("durationchange", live(() => this.emit("time")));
    el.addEventListener("ended", () => {
      // The previous song finishing its last moments after the next took over.
      if (el !== this.audio) return this.release(el);
      this.advance(true);
    });
    el.addEventListener("error", () => {
      if (el === this.audio) return void this.onError();
      if (el === this.spare && this.preloaded) {
        this.preloadFailed = this.preloaded;
        this.preloaded = null;
        this.release(el);
      }
    });
  }

  /** Stops an element and lets go of its stream. */
  private release(el: HTMLAudioElement) {
    el.pause();
    if (el.hasAttribute("src")) {
      el.removeAttribute("src");
      el.load();
    }
  }

  /**
   * Near the end of a song: loads the next one into the spare element, then
   * starts it right as this one finishes. Runs on every time update.
   */
  private prepareNext() {
    const a = this.audio;
    if (a.paused || a.loop || this.stopAtEnd || !isFinite(a.duration)) return;
    const remaining = a.duration - a.currentTime;
    if (remaining > PRELOAD_AHEAD) return;
    const next = this.upcomingIndex();
    const track = this.queue[next];
    if (!track) return;
    // Plans change (queue edits, shuffle, repeat); keep the spare in step.
    if (this.preloaded !== track.id && this.preloadFailed !== track.id && this.spare.paused) {
      this.preloaded = track.id;
      this.spare.src = streamUrl(track);
      this.spare.loop = false;
    }
    clearTimeout(this.gaplessTimer);
    const ready = this.preloaded === track.id && this.spare.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    // Crossfade: the next song starts early and the two fade across. Short
    // songs fade for a quarter of their length at most.
    const fade = this.ctx && this.pauseTimer === undefined ? Math.min(this.crossfade, a.duration / 4) : 0;
    if (fade > 0 && remaining <= fade && ready) {
      this.load(next, true, true, true);
      this.fadeTo(this.audio, 0, 0);
      this.fadeTo(this.audio, 1, fade);
      this.fadeTo(a, 0, remaining);
      return;
    }
    // Time updates come a few times a second; a timer hits the end exactly.
    // Starting right on time measured best with test tones: about 2 ms of
    // silence and no overlap. Starting earlier makes the songs overlap by a
    // whole audio chunk (~20 ms), because a buffered element starts at once
    // while the outgoing one is still draining its last chunk.
    if (remaining < 1.5 && ready) {
      this.gaplessTimer = window.setTimeout(() => {
        if (this.audio === a && !a.paused && this.upcomingIndex() === next) this.load(next, true, true, true);
      }, remaining * 1000);
    }
  }

  get current(): Track | null {
    return this.queue[this.index] ?? null;
  }

  /** False as soon as a pause starts fading out. */
  get playing(): boolean {
    return !this.audio.paused && this.pauseTimer === undefined;
  }

  // ---- queue -------------------------------------------------------------

  /** Replaces the queue with `tracks` and starts at `start`. `from` names
   *  where the list came from ("Liked songs", a playlist's name). */
  playList(tracks: Track[], start: number, from = "") {
    this.from = from;
    this.listGen++;
    this.history = [];
    if (this.shuffle && tracks[start]) {
      // The song asked for plays first; the rest follow mixed.
      this.unshuffled = tracks.slice();
      this.queue = [tracks[start], ...shuffled(tracks.filter((_, i) => i !== start))];
      start = 0;
    } else {
      this.unshuffled = null;
      this.queue = tracks.slice();
    }
    this.suggestions = [];
    this.load(start, true);
    this.saveQueue();
    this.emit("queue");
  }

  /** Puts `track` first in line, ahead of songs queued earlier. */
  playNext(track: Track) {
    if (this.index < 0) return this.playList([track], 0);
    this.queue.splice(this.index + 1, 0, this.queuedCopy(track));
    this.queueChanged();
  }

  /**
   * Queues `track` as in Spotify: after the songs queued before it, but ahead
   * of the rest of the list that is playing.
   */
  addToQueue(track: Track) {
    if (this.index < 0) return this.playList([track], 0);
    let at = this.index + 1;
    while (at < this.queue.length && this.queued.has(this.queue[at])) at++;
    this.queue.splice(at, 0, this.queuedCopy(track));
    this.queueChanged();
  }

  /** Whether queue item `i` was queued by hand (not part of the list playing). */
  isQueued(i: number): boolean {
    const t = this.queue[i];
    return !!t && this.queued.has(t);
  }

  /** Whether queue item `i` was added by Autoplay. */
  isAutoplayed(i: number): boolean {
    const t = this.queue[i];
    return !!t && this.autoplayed.has(t);
  }

  /** A copy, so the mark can't land on the same song elsewhere in the list. */
  private queuedCopy(track: Track): Track {
    const copy = { ...track };
    this.queued.add(copy);
    return copy;
  }

  removeAt(i: number) {
    if (i === this.index) return;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    this.queueChanged();
  }

  move(from: number, to: number) {
    if (from === to) return;
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    // A song moved in among the queued songs joins them; one moved out leaves.
    const before = to - 1 === this.index || (to - 1 > this.index && this.isQueued(to - 1));
    if (to > this.index && before && (this.queued.has(t) || this.isQueued(to - 1) || this.isQueued(to + 1))) {
      this.queued.add(t);
    } else {
      this.queued.delete(t);
    }
    this.queueChanged();
  }

  /** Replaces the songs after the playing one (Start radio; Undo after Clear). */
  setUpcoming(tracks: Track[]) {
    if (this.index < 0) return this.playList(tracks, 0, this.from);
    this.queue = [...this.queue.slice(0, this.index + 1), ...tracks];
    this.unshuffled = null;
    this.queueChanged();
  }

  clearUpcoming() {
    this.queue = this.current ? [this.current] : [];
    this.index = this.current ? 0 : -1;
    this.queueChanged();
  }

  jump(i: number) {
    if (i >= 0 && i < this.queue.length) this.load(i, true);
  }

  private queueChanged() {
    this.saveQueue();
    this.emit("queue");
  }

  // ---- transport ---------------------------------------------------------

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (!this.current) return;
    // Pressed again while a pause fades out: fade back in.
    if (this.pauseTimer !== undefined) {
      this.cancelPauseFade();
      this.fadeTo(this.audio, 1, PAUSE_FADE);
      this.emit("state");
      return;
    }
    if (!this.audio.paused) return;
    void this.ensureGraph();
    this.fadeTo(this.audio, this.fadePause ? 0 : 1, 0);
    if (this.fadePause) this.fadeTo(this.audio, 1, PAUSE_FADE);
    // After a restart the restored queue has no source loaded yet.
    if (!this.audio.src) this.load(this.index, true);
    else void this.audio.play().catch(() => {});
  }

  pause() {
    // A song still fading out under a crossfade stops too.
    if (!this.spare.paused) this.release(this.spare);
    const a = this.audio;
    if (!this.fadePause || !this.ctx || a.paused) return a.pause();
    if (this.pauseTimer !== undefined) return;
    this.fadeTo(a, 0, PAUSE_FADE);
    this.pauseTimer = window.setTimeout(() => {
      this.pauseTimer = undefined;
      a.pause();
    }, PAUSE_FADE * 1000);
    this.emit("state");
  }

  private cancelPauseFade() {
    clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
  }

  setCrossfade(seconds: number) {
    this.crossfade = Math.min(MAX_CROSSFADE, Math.max(0, seconds));
    settings.set("crossfade", this.crossfade);
  }

  setFadePause(on: boolean) {
    this.fadePause = on;
    settings.set("fadePause", on);
  }

  setAutoplay(on: boolean) {
    this.autoplay = on;
    settings.set("autoplay", on);
    if (on) void this.fillUp();
  }

  /**
   * Autoplay: once the last song of the list plays, adds the playing song's
   * radio to the end. Resolves to whether songs were added.
   */
  private async fillUp(): Promise<boolean> {
    const seed = this.current;
    const left = this.queue.length - 1 - this.index;
    if (!this.autoplay || this.filling || this.repeat !== "off" || left > 0 || !seed?.id.startsWith("yt:")) return false;
    this.filling = true;
    const gen = this.listGen;
    try {
      const more = (await api.recommendations([seed.id], [...this.queue.map((t) => t.id), ...this.hidden])).slice(0, 25);
      if (gen !== this.listGen || !more.length) return false;
      more.forEach((t) => this.autoplayed.add(t));
      this.queue.push(...more);
      this.queueChanged();
      return true;
    } catch {
      // Offline, say: the list just ends.
      return false;
    } finally {
      this.filling = false;
    }
  }

  /** Ramps an element's fade gain to `to` over `seconds` (at once for 0). */
  private fadeTo(el: HTMLAudioElement, to: number, seconds: number) {
    const gain = this.fades[this.elements.indexOf(el)]?.gain;
    if (!this.ctx || !gain) return;
    const t = this.ctx.currentTime;
    gain.cancelScheduledValues(t);
    gain.setValueAtTime(seconds > 0 ? gain.value : to, t);
    if (seconds > 0) gain.linearRampToValueAtTime(to, t + seconds);
  }

  next() {
    this.advance(false);
  }

  /** Whether `prev` has a song to go back to. */
  get hasPrevious(): boolean {
    return this.history.length > 0 || this.index > 0;
  }

  /** Goes back a song. Late in a song it restarts it instead, unless `restart` is false. */
  prev(restart = true) {
    if ((restart && this.audio.currentTime > 3) || this.index < 0) {
      this.audio.currentTime = 0;
      return;
    }
    const back = this.history.pop();
    if (back !== undefined) this.load(back, true, false);
    else if (this.index > 0) this.load(this.index - 1, true, false);
    else this.audio.currentTime = 0;
  }

  seek(seconds: number) {
    if (isFinite(seconds)) this.audio.currentTime = Math.max(0, seconds);
  }

  setVolume(v: number) {
    const volume = Math.min(1, Math.max(0, v));
    for (const el of this.elements) {
      el.volume = volume;
      el.muted = false;
    }
    settings.set("volume", volume);
    this.emit("state");
  }

  toggleMute() {
    const muted = !this.audio.muted;
    for (const el of this.elements) el.muted = muted;
    this.emit("state");
  }

  /**
   * Turns shuffle on or off without touching the song that plays: on, the
   * songs still to come are mixed (songs queued by hand stay next, Autoplay's
   * stay last); off, the list goes back to its own order from this song on.
   */
  setShuffle(on: boolean) {
    if (on === this.shuffle) return;
    this.shuffle = on;
    settings.set("shuffle", on);
    if (!on && this.smart) {
      this.smart = false;
      settings.set("smartShuffle", false);
      this.dropSuggestions();
    }
    if (this.index >= 0) {
      if (on) this.mix();
      else this.unmix();
      this.queueChanged();
    }
    this.emit("state");
  }

  /** Phones: off, shuffle, smart shuffle, off again, as Spotify's button. */
  cycleShuffle() {
    if (!this.shuffle) this.setShuffle(true);
    else if (!this.smart) this.setSmart(true);
    else this.setShuffle(false);
  }

  setSmart(on: boolean) {
    if (on && !this.shuffle) this.setShuffle(true);
    if (on === this.smart) return;
    this.smart = on;
    settings.set("smartShuffle", on);
    if (on) void this.suggest();
    else this.dropSuggestions();
    this.emit("state");
  }

  /** Whether queue item `i` is one of smart shuffle's suggestions. */
  isSuggested(i: number): boolean {
    const t = this.queue[i];
    return !!t && this.suggested.has(t);
  }

  /** Takes smart shuffle's suggestions still to come out of the queue. */
  private dropSuggestions() {
    const before = this.queue.length;
    const current = this.current;
    this.queue = this.queue.filter((t, i) => i <= this.index || !this.suggested.has(t));
    this.index = current ? this.queue.indexOf(current) : this.index;
    this.suggestions = [];
    if (this.queue.length !== before) this.queueChanged();
  }

  /**
   * Smart shuffle: puts a suggestion after every three of the list's songs
   * still to come (the next 30 or so; more as the list plays on). Songs
   * like the list's come from YouTube Music's radio for a few of its songs.
   */
  private async suggest() {
    this.warmSuggestions();
    if (!this.smart || this.suggesting || this.index < 0) return;
    const gen = this.listGen;
    const slots = () => {
      // Where suggestions go, as places in the queue (queued and Autoplay's songs aside).
      const at: number[] = [];
      let run = 0;
      for (let i = this.index + 1; i < this.queue.length && i < this.index + 40; i++) {
        const t = this.queue[i];
        if (this.queued.has(t) || this.autoplayed.has(t)) continue;
        if (this.suggested.has(t)) run = 0;
        else if (++run === 3) {
          const next = this.queue[i + 1];
          if (!next || !this.suggested.has(next)) at.push(i + 1);
          run = 0;
        }
      }
      return at;
    };
    if (!slots().length) return;
    this.suggesting = true;
    try {
      if (this.suggestions.length < slots().length) {
        const list = (this.unshuffled ?? this.queue).filter((t) => t.id.startsWith("yt:") && !this.suggested.has(t) && !this.autoplayed.has(t));
        if (!list.length) return;
        const more = await api.recommendations(shuffled(list).slice(0, 5).map((t) => t.id), [...this.queue.map((t) => t.id), ...this.hidden]);
        if (gen !== this.listGen || !this.smart) return;
        const known = new Set([...this.queue, ...this.suggestions].map((t) => t.id));
        this.suggestions.push(...shuffled(more.filter((t) => !known.has(t.id))));
      }
      // From the back, so the places ahead stay where they were.
      const at = slots();
      for (const i of at.reverse()) {
        const t = this.suggestions.shift();
        if (!t) continue;
        const copy = { ...t };
        this.suggested.add(copy);
        this.queue.splice(i, 0, copy);
      }
      if (at.length) {
        this.queueChanged();
        this.warmSuggestions();
      }
    } catch {
      // Offline, say: it's plain shuffle until the next song.
    } finally {
      this.suggesting = false;
    }
  }

  /**
   * Looks up the next two suggestions ahead of time, one after the other:
   * they are songs never played, so skipping to one would otherwise wait for
   * yt-dlp. (The song right after the playing one is looked up anyway.)
   */
  private warmSuggestions() {
    if (!this.smart || this.warmingSuggestions) return;
    const soon = this.queue.slice(this.index + 1, this.index + 9).filter((t) => this.suggested.has(t)).slice(0, 2);
    if (!soon.length) return;
    this.warmingSuggestions = true;
    void (async () => {
      for (const t of soon) await this.lookUp(t);
      this.warmingSuggestions = false;
    })();
  }

  private mix() {
    this.unshuffled = this.queue.slice();
    const next = this.queue.slice(this.index + 1);
    let queuedCount = 0;
    while (queuedCount < next.length && this.queued.has(next[queuedCount])) queuedCount++;
    const rest = next.slice(queuedCount);
    const list = rest.filter((t) => !this.autoplayed.has(t));
    const autoplay = rest.filter((t) => this.autoplayed.has(t));
    this.queue = [...this.queue.slice(0, this.index + 1), ...next.slice(0, queuedCount), ...shuffled(list), ...autoplay];
  }

  private unmix() {
    const own = this.unshuffled;
    this.unshuffled = null;
    if (!own) return;
    const current = this.current!;
    // Songs removed meanwhile stay out; songs added meanwhile (queued by
    // hand, Autoplay's) keep their place relative to the playing song.
    const inQueue = new Set(this.queue);
    const known = new Set(own);
    const list = own.filter((t) => inQueue.has(t) && t !== current);
    const added = this.queue.slice(this.index + 1).filter((t) => !known.has(t));
    const queuedNext = added.filter((t) => this.queued.has(t));
    const autoplay = added.filter((t) => !this.queued.has(t));
    // Where the playing song sits in the list's own order (a song queued by
    // hand isn't in it: the list then goes on from where it was).
    let at = own.indexOf(current);
    if (at < 0) at = own.indexOf(this.queue.slice(0, this.index).reverse().find((t) => known.has(t)) ?? current);
    const before = list.filter((t) => own.indexOf(t) <= at);
    const after = list.filter((t) => own.indexOf(t) > at);
    this.history = [];
    this.queue = [...before, current, ...queuedNext, ...after, ...autoplay];
    this.index = before.length;
  }

  cycleRepeat() {
    const order: Repeat[] = ["off", "all", "one"];
    this.repeat = order[(order.indexOf(this.repeat) + 1) % order.length];
    settings.set("repeat", this.repeat);
    // The element loops by itself, which is seamless.
    this.audio.loop = this.repeat === "one";
    this.emit("state");
  }

  /** The index that `next` would play, or -1 when the queue is finished.
   *  Shuffle already mixed the queue, so it's always the next one along. */
  upcomingIndex(): number {
    if (!this.queue.length) return -1;
    if (this.index + 1 < this.queue.length) return this.index + 1;
    return this.repeat === "all" ? 0 : -1;
  }

  private advance(auto: boolean) {
    if (auto && this.stopAtEnd) {
      // The sleep timer: this song was the last.
      this.stopAtEnd = false;
      this.audio.pause();
      this.audio.currentTime = 0;
      this.emit("state");
      return;
    }
    if (auto && this.repeat === "one") {
      this.audio.currentTime = 0;
      void this.audio.play();
      return;
    }
    const next = this.upcomingIndex();
    if (next < 0) {
      this.audio.pause();
      this.audio.currentTime = 0;
      // Autoplay couldn't add songs earlier (it was off, or offline); try again.
      if (auto) void this.fillUp().then((added) => added && this.advance(false));
      return;
    }
    this.load(next, true);
  }

  /**
   * Makes queue item `i` the current song. When the spare element already
   * holds it, that element takes over without loading anything. `gapless`
   * lets the outgoing element play out its last moments instead of cutting
   * it off.
   */
  private load(i: number, autoplay: boolean, remember = true, gapless = false) {
    const track = this.queue[i];
    if (!track) return;
    if (remember && this.index >= 0 && this.index !== i) this.history.push(this.index);
    this.index = i;
    // Each play of a song may get one second go (onError).
    this.retried = null;
    // Once it plays, a queued song is just part of the list.
    this.queued.delete(track);
    clearTimeout(this.gaplessTimer);
    this.cancelPauseFade();
    const outgoing = this.audio;
    if (this.preloaded === track.id && this.spare.hasAttribute("src")) {
      this.active = 1 - this.active;
      if (this.audio.currentTime) this.audio.currentTime = 0;
      if (!gapless) this.release(outgoing);
    } else {
      this.release(this.spare);
      this.audio.src = streamUrl(track);
    }
    this.preloaded = null;
    this.preloadFailed = null;
    // Full volume, whatever fade this element was last part of.
    this.fadeTo(this.audio, 1, 0);
    this.audio.loop = this.repeat === "one";
    this.setLoading(this.audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
    if (autoplay) {
      void this.ensureGraph();
      this.audio.play().catch(() => {});
    }
    this.updateMediaSession();
    this.saveQueue();
    this.emit("track");
    this.emit("queue");
    void this.fillUp();
    void this.suggest();
  }

  private setLoading(on: boolean) {
    if (this.loading === on) return;
    this.loading = on;
    this.emit("state");
  }

  /**
   * Resolves a YouTube stream ahead of time (yt-dlp takes a few seconds), so
   * it starts almost immediately when played. Cheap to call repeatedly.
   */
  warm(track: Track) {
    void this.lookUp(track);
  }

  private async lookUp(track: Track) {
    if (!track.id.startsWith("yt:")) return;
    const last = this.warmed.get(track.id) ?? 0;
    // The back end keeps resolved streams for hours; re-warming is rarely needed.
    if (Date.now() - last < 30 * 60 * 1000) return;
    this.warmed.set(track.id, Date.now());
    // `false` means the back end was busy and skipped it; allow a retry.
    const started = await api.prefetch(track.id).catch(() => false);
    if (!started) this.warmed.delete(track.id);
  }

  /**
   * Phones: looks up the first songs a page shows, one after another, so
   * tapping one of them starts it at once. A newer page's songs replace
   * those still waiting.
   */
  warmAhead(tracks: Track[], count: number) {
    this.ahead = tracks.filter((t) => t.id.startsWith("yt:")).slice(0, count);
    if (this.aheadRunning) return;
    this.aheadRunning = true;
    void (async () => {
      for (let t = this.ahead.shift(); t; t = this.ahead.shift()) await this.lookUp(t);
      this.aheadRunning = false;
    })();
  }

  private async onError() {
    const track = this.current;
    if (!track || !this.audio.src) return;
    this.setLoading(false);
    // A failed element still reports itself as playing; make the UI agree.
    this.audio.pause();
    // The media element hides the reason; ask the stream endpoint directly.
    let message = "This track could not be played.";
    let works = false;
    try {
      const res = await fetch(this.audio.src, { headers: { Range: "bytes=0-1" } });
      if (!res.ok) message = (await res.text()) || message;
      else works = true;
    } catch {
      /* keep the generic message */
    }
    // Asked again, the stream answered (YouTube sometimes refuses a new link
    // for a while): give the song one more go instead of skipping it.
    if (works && this.current === track && this.retried !== track.id) {
      this.retried = track.id;
      const at = this.audio.currentTime;
      this.audio.src = streamUrl(track);
      if (at) this.audio.currentTime = at;
      this.setLoading(true);
      this.audio.play().catch(() => {});
      return;
    }
    this.emit("error", `${track.title}: ${message}`);
    this.errorStreak++;
    // Skipping ahead cannot help when YouTube playback is not set up at all.
    const fatal = /not installed/i.test(message);
    if (!fatal && this.errorStreak < 3 && this.upcomingIndex() >= 0) {
      setTimeout(() => this.current === track && this.advance(false), 1500);
    }
  }

  // ---- equalizer ---------------------------------------------------------

  private async ensureGraph() {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "playback" });
      const preamp = ctx.createGain();
      this.preamp = preamp;
      this.fades = this.elements.map((el) => {
        const fade = ctx.createGain();
        ctx.createMediaElementSource(el).connect(fade).connect(preamp);
        return fade;
      });
      this.filters = EQ_BANDS.map((freq, i) => {
        const f = ctx.createBiquadFilter();
        f.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
        f.frequency.value = freq;
        f.Q.value = 1.1;
        return f;
      });
      let node: AudioNode = this.preamp;
      for (const f of this.filters) node = node.connect(f);
      node.connect(ctx.destination);
      this.ctx = ctx;
      this.applyEq();
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  get eqGains(): number[] {
    return this.eq.slice();
  }

  get preampGain(): number {
    return this.preampDb;
  }

  setEqBand(band: number, db: number) {
    this.eq[band] = db;
    this.applyEq();
  }

  setEq(gains: number[]) {
    this.eq = gains.slice();
    this.applyEq();
  }

  setPreamp(db: number) {
    this.preampDb = db;
    this.applyEq();
  }

  private applyEq() {
    settings.set("eq", this.eq);
    settings.set("preamp", this.preampDb);
    if (!this.ctx || !this.preamp) return;
    const t = this.ctx.currentTime;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(this.eq[i] ?? 0, t, 0.02));
    this.preamp.gain.setTargetAtTime(Math.pow(10, this.preampDb / 20), t, 0.02);
  }

  // ---- persistence & OS integration --------------------------------------

  private saveQueue() {
    // A shuffled queue keeps the list's own order too, as places in the queue.
    const own = this.unshuffled?.map((t) => this.queue.indexOf(t)).filter((i) => i >= 0);
    const suggested = this.queue.flatMap((t, i) => (i < 1000 && this.suggested.has(t) ? [i] : []));
    settings.set("queue", {
      tracks: this.queue.slice(0, 1000),
      index: this.index,
      from: this.from,
      own: own && own.every((i) => i < 1000) ? own : undefined,
      suggested: suggested.length ? suggested : undefined,
    });
  }

  private restoreQueue() {
    const saved = settings.get<{ tracks: Track[]; index: number; from?: string; own?: number[]; suggested?: number[] } | null>("queue", null);
    if (saved?.tracks?.length) {
      this.queue = saved.tracks;
      this.index = Math.min(Math.max(saved.index, 0), saved.tracks.length - 1);
      this.from = saved.from ?? "";
      if (this.shuffle && saved.own) this.unshuffled = saved.own.map((i) => this.queue[i]).filter(Boolean);
      for (const i of saved.suggested ?? []) if (this.queue[i]) this.suggested.add(this.queue[i]);
    }
  }

  private setupMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.setActionHandler("play", () => this.play());
    ms.setActionHandler("pause", () => this.pause());
    ms.setActionHandler("nexttrack", () => this.next());
    ms.setActionHandler("previoustrack", () => this.prev());
    ms.setActionHandler("seekto", (d) => d.seekTime != null && this.seek(d.seekTime));
  }

  /** Lets the OS media overlay show a progress bar. */
  private updatePositionState() {
    const a = this.audio;
    if (!navigator.mediaSession?.setPositionState || !isFinite(a.duration) || a.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: a.duration,
        position: Math.min(a.currentTime, a.duration),
        playbackRate: a.playbackRate,
      });
    } catch {
      /* rejected while metadata is still loading */
    }
  }

  private updateMediaSession() {
    const t = this.current;
    if (!navigator.mediaSession || !t) return;
    const art = artUrl(t, true);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album ?? "",
      artwork: art ? [{ src: art, sizes: "400x400" }] : [],
    });
  }

  private emit(type: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
