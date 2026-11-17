import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { artUrl, formatTime } from "./api";
import { icon, type IconName } from "./icons";
import type { MiniCommand, MiniState } from "./mini-link";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let state: MiniState | null = null;
/** When `state` arrived, to move the progress bar on between updates. */
let receivedAt = 0;
let shownTrack: string | null = null;
/** Seek position while the bar is being dragged. */
let dragTime: number | null = null;

function send(command: MiniCommand) {
  void emitTo("main", "mini-command", command);
}

function setIcon(el: HTMLElement, name: IconName, size?: number) {
  el.innerHTML = icon(name, size);
}

function position(): number {
  if (!state) return 0;
  if (dragTime != null) return dragTime;
  const elapsed = state.playing && !state.loading ? (performance.now() - receivedAt) / 1000 : 0;
  return Math.min(state.time + elapsed, state.duration || Infinity);
}

function render() {
  const s = state;
  const t = s?.track ?? null;
  if ((t?.id ?? null) !== shownTrack) {
    shownTrack = t?.id ?? null;
    $("#title").textContent = t?.title ?? "Nothing playing";
    $("#artist").textContent = t?.artist ?? "";
    // Long names are cut off; the tooltip shows them in full.
    $(".mini-text").title = t ? `${t.title}\n${t.artist}` : "";
    const url = artUrl(t);
    $("#art").innerHTML = url
      ? `<img src="${url.replace(/"/g, "&quot;")}" alt="" draggable="false" />`
      : `<span class="art-fallback">${icon("music", 24)}</span>`;
    document.title = t ? `${t.title} · ${t.artist}` : "Cadence mini player";
  }
  const play = $("#play");
  setIcon(play, s?.playing ? "pause" : "play", 24);
  play.title = s?.playing ? "Pause" : "Play";
  play.classList.toggle("loading", !!s?.loading && !!s.playing);
  const like = $("#like");
  like.hidden = !t;
  like.classList.toggle("on", !!s?.liked);
  like.title = s?.liked ? "Remove from liked songs" : "Like";
  setIcon(like, s?.liked ? "heartFilled" : "heart", 18);

  const root = document.documentElement;
  for (const [prop, value] of [
    ["--accent", s?.accent],
    ["--on-accent", s?.onAccent],
  ] as const) {
    if (value) root.style.setProperty(prop, value);
    else root.style.removeProperty(prop);
  }
  renderTime();
}

function renderTime() {
  const dur = state?.duration ?? 0;
  const pos = position();
  $("#fill").style.width = dur ? `${Math.min(100, (pos / dur) * 100)}%` : "0%";
  $("#time").textContent = state?.track ? `${formatTime(pos)} / ${formatTime(dur || null)}` : "";
}

/** Keeps the progress bar moving smoothly between state updates. */
function tick() {
  if (state?.playing || dragTime != null) renderTime();
  requestAnimationFrame(tick);
}

function bindSeek() {
  const bar = $("#seek");
  const timeAt = (e: PointerEvent) => {
    const r = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return ratio * (state?.duration ?? 0);
  };
  bar.addEventListener("pointerdown", (e) => {
    if (!state?.duration) return;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
    dragTime = timeAt(e);
    renderTime();
  });
  bar.addEventListener("pointermove", (e) => {
    if (dragTime == null) return;
    dragTime = timeAt(e);
    renderTime();
  });
  const finish = (e: PointerEvent) => {
    if (dragTime == null) return;
    const time = timeAt(e);
    dragTime = null;
    bar.classList.remove("dragging");
    // Show the new spot right away rather than waiting for the round trip.
    if (state) {
      state.time = time;
      receivedAt = performance.now();
    }
    send({ action: "seek", time });
    renderTime();
  };
  bar.addEventListener("pointerup", finish);
  bar.addEventListener("pointercancel", () => {
    dragTime = null;
    bar.classList.remove("dragging");
  });
}

function expand() {
  void invoke("mini_player", { open: false });
}

async function boot() {
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    setIcon(el, el.dataset.icon as IconName, el.id === "expand" ? 18 : 22);
  });
  $("#play").onclick = () => send({ action: "toggle" });
  $("#prev").onclick = () => send({ action: "prev" });
  $("#next").onclick = () => send({ action: "next" });
  $("#like").onclick = () => send({ action: "like" });
  $("#expand").onclick = expand;
  bindSeek();

  // Same idea as the main window: a clicked button must not keep focus, or
  // Space would press it again on top of the play/pause shortcut.
  document.addEventListener("pointerup", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (btn) requestAnimationFrame(() => btn.blur());
  });
  document.addEventListener("contextmenu", (e) => {
    if (import.meta.env.PROD) e.preventDefault();
  });
  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") expand();
    else if (e.key === " ") {
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      send({ action: "toggle" });
    } else if (e.key === "ArrowRight" && ctrl) send({ action: "next" });
    else if (e.key === "ArrowLeft" && ctrl) send({ action: "prev" });
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const time = Math.max(0, position() + (e.key === "ArrowRight" ? 5 : -5));
      send({ action: "seek", time });
    } else if (import.meta.env.PROD && (e.key === "F5" || (ctrl && ["r", "p"].includes(e.key.toLowerCase())))) {
      e.preventDefault();
    }
  });
  document.addEventListener(
    "error",
    (e) => {
      if (e.target instanceof HTMLImageElement) {
        e.target.replaceWith(Object.assign(document.createElement("span"), { className: "art-fallback", innerHTML: icon("music", 24) }));
      }
    },
    true,
  );

  render();
  await listen<MiniState>("mini-state", (e) => {
    state = e.payload;
    receivedAt = performance.now();
    render();
  });
  send({ action: "ready" });
  requestAnimationFrame(tick);
}

void boot();
