// Building blocks for the right-hand panel: one instruction, a little detail, and the actions.
const panel = document.getElementById("panel")!;

type Screen = { eyebrow?: string; title: string; lede?: string; body?: string; actions?: string };
let shownTitle = "";
export function screen(s: Screen): void {
  panel.innerHTML = `
    ${s.eyebrow ? `<p class="eyebrow">${s.eyebrow}</p>` : ""}
    <h1>${s.title}</h1>
    ${s.lede ? `<p class="lede">${s.lede}</p>` : ""}
    ${s.body ?? ""}
    ${s.actions ? `<div class="actions">${s.actions}</div>` : ""}`;
  // Live screens redraw several times a second; only slide in when the screen itself changes.
  const title = `${s.eyebrow}|${s.title}`;
  if (title === shownTitle) return;
  shownTitle = title;
  panel.classList.remove("enter");
  void panel.offsetWidth;
  panel.classList.add("enter");
}

// The title bar's Back button owns this id; a panel button with it would steal its clicks.
const RESERVED_IDS = new Set(["back", "progress", "badge", "panel", "arm"]);

export function button(id: string, label: string, kind = ""): string {
  if (RESERVED_IDS.has(id)) throw new Error(`Button id "${id}" is reserved`);
  return `<button class="btn ${kind}" id="${id}">${label}</button>`;
}

export function click(id: string, handler: () => void): void {
  document.getElementById(id)?.addEventListener("click", handler);
}

export function shortPort(port: string): string {
  return port.replace("/dev/tty.", "");
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `<div class="issue"><b>Something went wrong</b>${escapeHtml(message)}</div>`;
}

/** Runs `handler` when `key` is pressed outside a text field. Returns an unsubscribe function. */
export function onKey(key: string, handler: () => void): () => void {
  const listener = (event: KeyboardEvent) => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (typing || event.metaKey || event.key !== key) return;
    event.preventDefault();
    handler();
  };
  document.addEventListener("keydown", listener);
  return () => document.removeEventListener("keydown", listener);
}

export function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
