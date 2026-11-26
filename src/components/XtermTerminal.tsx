// src/components/XtermTerminal.tsx
"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import s from "./XtermTerminal.module.css";
import { useTheme } from "../lib/theme";
import { keySeq, ctrlCode, type TermKey } from "../lib/term-keys";
import { useIsMobile } from "../lib/useIsMobile";
import { touchScrollStart, touchScrollMove, flingVelocity, type TouchScrollState, type FlingSample } from "../lib/touch-scroll";
import { TermSocket } from "../lib/termSocket";
import { TermPool, poolCap } from "../lib/termPool";
import { forgetComposer } from "../lib/composer";
import { uploadFile, UPLOAD_ACCEPT } from "../lib/upload";
import { geistMono } from "../app/fonts";

// Terminal glyph metrics per breakpoint. A phone gets a larger, looser font so
// FitAddon picks a sane (smaller) column count and the text stays readable —
// the same reason the webterm reference runs ttyd at a big font size. Desktop
// stays tight and dense to pack more columns into a wide pane.
const TERM_FONT_PX = (mobile: boolean) => (mobile ? 10 : 13);
// Deliberate tightening on top of CORRECT metrics (the old -6/-4 compensated
// for broken measurement; see #7/#9). The mono face reads slightly airy at
// 13px on desktop, so pull cells 1px closer. Mobile (10px) stays
// natural: its glyph ink nearly fills the advance, so any squeeze touches.
const TERM_TRACKING = (mobile: boolean) => (mobile ? 0 : -1);
const TERM_LINE_HEIGHT = (mobile: boolean) => (mobile ? 1.0 : 1.4);

// Two xterm palettes (concrete hex — xterm renders to canvas/DOM and can't read
// CSS vars). The neutrals mirror the globals.css tokens: `background` must stay
// equal to --term-bg so the canvas matches the surrounding chrome (the panel on
// desktop, the canvas on a phone: see termTheme). Red, green, yellow and blue are
// the status tokens (--err, --ok, --warn, --turn); magenta and cyan are muted to
// sit with them. Switched live on theme change.
const DARK_TERM: ITheme = {
  background: "#0a0a0a",
  foreground: "#ededed",
  cursor: "#ededed",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#333333",
  black: "#1b1b1c",
  red: "#f05252",
  green: "#3fb35a",
  yellow: "#e5a23a",
  blue: "#3d8bff",
  magenta: "#b78ae6",
  cyan: "#4cb5b5",
  white: "#ededed",
  brightBlack: "#6e6e6e",
  brightRed: "#f47a7a",
  brightGreen: "#5ec776",
  brightYellow: "#f0b95c",
  brightBlue: "#6aa6ff",
  brightMagenta: "#c9a3ef",
  brightCyan: "#6fc9c9",
  brightWhite: "#fafafa",
};
// The desktop pane is the panel colour (--bg-1), one step up from the canvas.
const DARK_PANEL = "#111112";

// Light terminal: near-white bg, dark text. ANSI colours darkened/desaturated for
// contrast on a light surface. Convention for light themes: `white` is a mid-grey
// and `brightWhite` is the darkest ink (used for bold/emphasis); `brightBlack`
// stays light-grey so Claude Code's dim output still recedes.
const LIGHT_TERM: ITheme = {
  background: "#ffffff",
  foreground: "#171717",
  cursor: "#171717",
  cursorAccent: "#ffffff",
  selectionBackground: "#dcdcdc",
  black: "#171717",
  red: "#d42a2a",
  green: "#1d8a3d",
  yellow: "#b06d00",
  blue: "#0a6be0",
  magenta: "#8a3fc7",
  cyan: "#137a7a",
  white: "#5c5c5c",
  brightBlack: "#8f8f8f",
  brightRed: "#e04545",
  brightGreen: "#28a04c",
  brightYellow: "#c98400",
  brightBlue: "#2f84ef",
  brightMagenta: "#a05ad6",
  brightCyan: "#1f9090",
  brightWhite: "#0a0a0a",
};

// The palette for a look: light is white everywhere; dark sits on the panel on desktop
// and on the canvas on a phone (the phone screens have no panel).
function termTheme(look: TermLook): ITheme {
  if (look.theme === "light") return LIGHT_TERM;
  return look.mobile ? DARK_TERM : { ...DARK_TERM, background: DARK_PANEL, cursorAccent: DARK_PANEL };
}

// Wire a minimal find overlay (Cmd/Ctrl+F) onto a terminal host. Enter finds
// next, Shift+Enter previous, Esc closes and returns focus to the terminal.
// Returns a cleanup fn.
function wireSearch(host: HTMLDivElement, term: Terminal, search: SearchAddon): () => void {
  const opts = { regex: false, wholeWord: false, caseSensitive: false };
  const bar = document.createElement("div");
  bar.className = s.searchBar;
  const input = document.createElement("input");
  input.type = "text"; input.placeholder = "Find…"; input.spellcheck = false;
  bar.appendChild(input);
  bar.style.display = "none";
  host.appendChild(bar);

  const open = () => { bar.style.display = "flex"; input.focus(); input.select(); };
  const close = () => { bar.style.display = "none"; search.clearDecorations(); term.focus(); };

  input.addEventListener("input", () => { if (input.value) search.findNext(input.value, opts); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) search.findPrevious(input.value, opts); else search.findNext(input.value, opts); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); open(); }
  };
  host.addEventListener("keydown", onKeyDown, true);

  return () => {
    host.removeEventListener("keydown", onKeyDown, true);
    bar.remove();
  };
}

// Enable copying selected text. Claude Code's TUI turns on mouse tracking, so a
// plain click-drag is delivered to the app instead of selecting — holding Shift
// while dragging makes xterm bypass mouse reporting and select locally. And
// because xterm paints to a canvas there's no DOM selection for the browser's
// own Cmd/Ctrl+C to copy, so we copy `term.getSelection()` ourselves: on select
// (mouseup) and via Cmd+C / Ctrl+Shift+C. Plain Ctrl+C is left alone so it still
// sends SIGINT. A brief "Copied" flash confirms it. Returns a cleanup fn.
function wireCopy(host: HTMLDivElement, term: Terminal): () => void {
  const toast = document.createElement("div");
  toast.className = s.copyToast;
  toast.textContent = "Copied";
  host.appendChild(toast);
  let hideT: ReturnType<typeof setTimeout> | undefined;
  const flash = () => {
    toast.classList.add(s.copyToastShow);
    if (hideT) clearTimeout(hideT);
    hideT = setTimeout(() => toast.classList.remove(s.copyToastShow), 900);
  };

  const copy = async (): Promise<void> => {
    const sel = term.getSelection();
    if (!sel) return;
    try {
      await navigator.clipboard.writeText(sel);
    } catch {
      // Fallback for a non-secure context or denied clipboard permission.
      const ta = document.createElement("textarea");
      ta.value = sel; ta.style.position = "fixed"; ta.style.opacity = "0";
      host.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch { /* give up silently */ }
      ta.remove(); term.focus();
    }
    flash();
  };

  // Copy as soon as a selection is completed with the mouse.
  const onMouseUp = () => { if (term.hasSelection()) void copy(); };
  host.addEventListener("mouseup", onMouseUp);

  // Explicit shortcut. Require Cmd (mac) or Ctrl+Shift (elsewhere) so plain
  // Ctrl+C stays SIGINT. Capture phase + stopPropagation so xterm's textarea
  // doesn't also receive the keystroke.
  const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== "c") return;
    const wantsCopy = (isMac && e.metaKey && !e.ctrlKey && !e.altKey) || (e.ctrlKey && e.shiftKey);
    if (wantsCopy && term.hasSelection()) { e.preventDefault(); e.stopPropagation(); void copy(); }
  };
  host.addEventListener("keydown", onKeyDown, true);

  return () => {
    host.removeEventListener("mouseup", onMouseUp);
    host.removeEventListener("keydown", onKeyDown, true);
    if (hideT) clearTimeout(hideT);
    toast.remove();
  };
}

// Wire image paste / file drop / attach-button capture onto a terminal host.
// Returns a cleanup fn. Text paste is left untouched — we only act when an
// image is present. The uploaded file's path is typed at the cursor (no Enter).
// The upload itself is lib/upload.ts, shared with the composer.
function wireUploads(host: HTMLDivElement, term: Terminal, sendInput: (data: string) => void, uploadPath: string): () => void {
  const uploadAndInject = async (file: File) => {
    const r = await uploadFile(uploadPath, file);
    if ("path" in r) sendInput(r.path + " ");
    else term.writeln(`\x1b[2m[upload failed: ${r.error}]\x1b[0m`);
  };

  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) { e.preventDefault(); void uploadAndInject(file); return; }
      }
    }
    // no image → let xterm handle the (text) paste normally
  };
  const onDragOver = (e: DragEvent) => { e.preventDefault(); };
  const onDrop = (e: DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) { e.preventDefault(); files.forEach((f) => void uploadAndInject(f)); }
  };

  const input = document.createElement("input");
  input.type = "file"; input.accept = UPLOAD_ACCEPT; input.style.display = "none";
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) void uploadAndInject(f);
    input.value = "";
  });
  const btn = document.createElement("button");
  btn.type = "button"; btn.title = "Attach an image or a file"; btn.setAttribute("aria-label", "Attach an image or a file");
  // The composer's paperclip (a line icon, never an emoji glyph).
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.3-5.3a2.1 2.1 0 0 1 3 3L6.6 10.9a1 1 0 0 1-1.5-1.5L10 4.5"/></svg>';
  btn.className = s.attachBtn;
  btn.addEventListener("click", () => input.click());

  host.addEventListener("paste", onPaste);
  host.addEventListener("dragover", onDragOver);
  host.addEventListener("drop", onDrop);
  host.appendChild(input);
  host.appendChild(btn);

  return () => {
    host.removeEventListener("paste", onPaste);
    host.removeEventListener("dragover", onDragOver);
    host.removeEventListener("drop", onDrop);
    input.remove();
    btn.remove();
  };
}

// Mobile key-helper bar: a row of Esc/Tab/Ctrl/arrows/⏎. Visible only ≤768px
// (CSS). Sends escape/control sequences over the same WebSocket as keyboard
// input. `Ctrl` is a sticky modifier: tap it, then the next printable key on the
// soft keyboard is sent as its control code. Returns cleanup.
//
// The bar is appended as a flex sibling *below* the terminal (into host's flex
// wrapper), not as an absolute overlay inside the terminal — so it can never sit
// on top of the prompt/input line. xterm's FitAddon then fits rows into the
// terminal's own (bar-free) box; there's no bottom-padding reservation to get
// wrong on mobile browsers.
function wireMobileKeys(host: HTMLDivElement, term: Terminal, send: (data: string) => void): () => void {
  let ctrlArmed = false;

  const bar = document.createElement("div");
  bar.className = s.keyBar;

  const ctrlBtn = document.createElement("button");
  const setArmed = (v: boolean) => { ctrlArmed = v; ctrlBtn.dataset.armed = String(v); };

  const mk = (label: string, onTap: () => void) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.className = s.keyBtn;
    // pointerdown + preventDefault so the tap doesn't steal focus from the
    // terminal's textarea (which would dismiss the soft keyboard).
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); onTap(); });
    return b;
  };

  ctrlBtn.type = "button"; ctrlBtn.textContent = "Ctrl"; ctrlBtn.className = s.keyBtn;
  ctrlBtn.dataset.armed = "false";
  ctrlBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); setArmed(!ctrlArmed); });

  const send_ = (k: TermKey) => () => send(keySeq(k));
  bar.append(
    mk("Esc", send_("esc")),
    mk("Tab", send_("tab")),
    ctrlBtn,
    mk("←", send_("left")),
    mk("↓", send_("down")),
    mk("↑", send_("up")),
    mk("→", send_("right")),
    mk("⏎", send_("enter")),
  );
  // Sibling below the terminal (see note above), falling back to host if the
  // wrapper is somehow absent.
  (host.parentElement ?? host).appendChild(bar);

  // When Ctrl is armed, convert the next printable keystroke into its control
  // code and swallow it; otherwise let xterm handle keys normally.
  const handler = (e: KeyboardEvent): boolean => {
    if (ctrlArmed && e.type === "keydown" && e.key.length === 1) {
      const code = ctrlCode(e.key);
      if (code) { send(code); setArmed(false); return false; }
    }
    return true;
  };
  term.attachCustomKeyEventHandler(handler);

  return () => {
    term.attachCustomKeyEventHandler(() => true);
    bar.remove();
  };
}

// Bridge one-finger vertical drags to synthetic WheelEvents. xterm 6 replaced
// the natively-scrollable viewport with VS Code's ScrollableElement, which only
// reacts to wheel events and scrollbar drags — it has no touch handling at all,
// so on a phone the buffer can't be scrolled without this. Dispatching a wheel
// event on the screen element reuses every existing scroll path: scrollback
// scrolling, alt-buffer arrow-key emulation, and — for TUIs that own their
// scrolling, like Claude Code's chat — SGR mouse-wheel reports to the app.
// A release fling keeps momentum via an rAF decay loop. Returns a cleanup fn.
function wireTouchScroll(host: HTMLDivElement): () => void {
  const screen = host.querySelector<HTMLElement>(".xterm-screen") ?? host;
  let state: TouchScrollState | null = null;
  let samples: FlingSample[] = [];
  let lastX = 0, lastY = 0;
  let raf = 0;

  const dispatch = (deltaY: number) => {
    screen.dispatchEvent(new WheelEvent("wheel", {
      deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: lastX, clientY: lastY,
      bubbles: true, cancelable: true,
    }));
  };

  const stopFling = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  const fling = (v0: number) => {
    let v = v0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      v *= Math.pow(0.94, dt / 16); // exponential decay, frame-rate independent
      if (Math.abs(v) < 0.05) { raf = 0; return; }
      dispatch(v * dt);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const onTouchStart = (e: TouchEvent) => {
    stopFling();
    if (e.touches.length !== 1) { state = null; return; }
    const t = e.touches[0];
    lastX = t.clientX; lastY = t.clientY;
    state = touchScrollStart(t.clientY);
    samples = [{ t: performance.now(), y: t.clientY }];
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!state || e.touches.length !== 1) return;
    // Always claim single-finger moves over the terminal — otherwise the first
    // (unprevented) move can start browser pull-to-refresh/overscroll instead.
    e.preventDefault();
    const t = e.touches[0];
    lastX = t.clientX; lastY = t.clientY;
    const now = performance.now();
    samples.push({ t: now, y: t.clientY });
    if (samples.length > 8) samples.shift();
    const r = touchScrollMove(state, t.clientY);
    state = r.state;
    if (r.deltaY !== null) dispatch(r.deltaY);
  };
  const onTouchEnd = () => {
    if (state?.dragging) {
      const v = flingVelocity(samples, performance.now());
      if (Math.abs(v) > 0.1) fling(v);
    }
    state = null;
    samples = [];
  };

  host.addEventListener("touchstart", onTouchStart, { passive: true });
  host.addEventListener("touchmove", onTouchMove, { passive: false });
  host.addEventListener("touchend", onTouchEnd);
  host.addEventListener("touchcancel", onTouchEnd);

  return () => {
    stopFling();
    host.removeEventListener("touchstart", onTouchStart);
    host.removeEventListener("touchmove", onTouchMove);
    host.removeEventListener("touchend", onTouchEnd);
    host.removeEventListener("touchcancel", onTouchEnd);
  };
}

// How long a kept terminal off screen may wait before it reconnects (see
// TermSocketOpts.retryJitter).
const PARKED_RETRY_JITTER_MS = 8_000;

// Where kept terminals live while off screen: in the document, hidden with CSS.
let parking: HTMLDivElement | null = null;
function parkingLot(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement("div");
    parking.style.display = "none";
    parking.setAttribute("aria-hidden", "true");
    document.body.appendChild(parking);
  }
  return parking;
}

type TermLook = { theme: "light" | "dark"; mobile: boolean };

// One xterm and its socket. It owns its DOM, so it can move between a React slot
// and the parking lot with the buffer, the socket and the scroll position intact.
class TermSession {
  private readonly wrap = document.createElement("div");
  private readonly host = document.createElement("div");
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly sock: TermSocket;
  private readonly cleanups: (() => void)[] = [];
  private parked = false;
  private disposed = false;
  private mobile: boolean;

  constructor(o: { wsPath: string; uploadPath?: string; readOnly: boolean; look: TermLook; slot: HTMLElement }) {
    const { wsPath, uploadPath, readOnly, look, slot } = o;
    this.mobile = look.mobile;
    this.wrap.className = s.wrap;
    this.host.className = s.terminal;
    this.wrap.appendChild(this.host);
    slot.appendChild(this.wrap);
    const host = this.host;
    const term = this.term = new Terminal({
      convertEol: true,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      // Concrete stack, NOT var(--font-mono): xterm feeds this string to canvas
      // font APIs, which can't resolve CSS vars — measurement then falls back
      // and cell width comes out wrong (the mobile double-spacing bug).
      fontFamily: `${geistMono.style.fontFamily}, ui-monospace, 'SF Mono', Menlo, monospace`,
      fontSize: TERM_FONT_PX(look.mobile),
      letterSpacing: TERM_TRACKING(look.mobile),
      // Geist Mono is a variable font. Render body text at the regular
      // weight and cap "bold" at 500 — Claude Code bolds headers, labels and the
      // ⏺ markers heavily, so the default 700 made the whole view read as a dense
      // wall. Paired with grayscale font-smoothing (see the CSS module) this
      // thins the strokes so counters (the holes in a/e/o) stay open.
      fontWeight: 400,
      fontWeightBold: 500,
      // Add leading so wrapped/dense code stays trackable and continuation lines
      // don't blend into the next logical block.
      lineHeight: TERM_LINE_HEIGHT(look.mobile),
      // Agent sessions blow past xterm's 1000-line default fast, losing the top
      // of long turns. The server ring buffer keeps 2MB; widen the client window
      // to match so scrollback is actually navigable.
      scrollback: 5000,
      // No minimumContrastRatio on purpose. With truecolor unlocked (see the PTY
      // env in server/agents/terminal.ts) Claude Code renders diffs as bright
      // syntax text on darker bars, so contrast is already good — and a forced
      // contrast floor would brighten the intentionally-dim line numbers and
      // trailing comments, flattening the dimming hierarchy we want to keep.
      // Neutral background and text (A · Inset), restrained semantic accents.
      theme: termTheme(look),
    });
    const search = new SearchAddon();
    term.loadAddon(this.fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    try { this.fit.fit(); } catch { /* host detached */ }

    this.cleanups.push(wireSearch(host, term, search));
    this.cleanups.push(wireCopy(host, term));
    // Touch scrolling for every terminal (read-only service logs included).
    // Listeners only ever fire on touch devices, so no isMobile gate.
    this.cleanups.push(wireTouchScroll(host));

    // Shown while the socket is down. Not written into the terminal: a resumed
    // stream continues the TUI's output exactly, and stray lines would shift it.
    const lost = document.createElement("div");
    lost.className = s.copyToast;
    lost.textContent = "Reconnecting…";
    host.appendChild(lost);
    this.cleanups.push(() => lost.remove());

    const proto = location.protocol === "https:" ? "wss" : "ws";
    // Reconnects on its own (dropped socket, return to an idle tab, network
    // back). Agents resume where the socket stopped; other routes replay in full.
    this.sock = new TermSocket({
      url: `${proto}://${location.host}${wsPath}`,
      onData: (data) => term.write(data),
      onReplay: () => term.reset(),
      onOpen: () => { lost.classList.remove(s.copyToastShow); this.refit(); },
      onLost: () => lost.classList.add(s.copyToastShow),
      retryJitter: () => (this.visible() ? 0 : Math.random() * PARKED_RETRY_JITTER_MS),
    });
    // Typed input, and xterm's own replies to the stream (focus, cursor reports).
    // A terminal off screen sends neither: nobody types there, and its replies
    // must not reach the agent or count as input (server/master/draft.ts).
    const sendInput = (data: string) => { if (!readOnly) this.sock.send({ t: "input", data }); };
    const onData = term.onData((data) => { if (this.visible()) sendInput(data); });
    this.cleanups.push(() => onData.dispose());

    const ro = new ResizeObserver(() => this.refit());
    ro.observe(host);
    this.cleanups.push(() => ro.disconnect());

    // Cell metrics were measured at open(). If the Geist Mono webfont is
    // still downloading at that point, the measurement used the fallback font —
    // once it swaps in, its (narrower) glyphs sit in fallback-sized cells and
    // the whole terminal reads as letter-spaced. Re-measure when the font is
    // actually ready: same-value option sets are no-ops in xterm, so bounce
    // fontSize to force a metric recompute, then re-fit and tell the PTY.
    if (typeof document !== "undefined" && "fonts" in document) {
      const px = TERM_FONT_PX(look.mobile);
      void Promise.resolve(document.fonts.load(`${px}px ${geistMono.style.fontFamily}`))
        .then(() => {
          if (this.disposed) return;
          term.options.fontSize = px + 1;
          term.options.fontSize = TERM_FONT_PX(this.mobile);
          this.refit();
        })
        .catch(() => { /* font API unavailable/blocked — fallback metrics stay */ });
    }
    // Uploads don't pass the visibility check: the user started one, and its
    // path still belongs in this agent's input if they switched away meanwhile.
    if (!readOnly && uploadPath) this.cleanups.push(wireUploads(host, term, sendInput, uploadPath));
    if (!readOnly) this.cleanups.push(wireMobileKeys(host, term, sendInput));
  }

  // On screen now? False while parked, and inside any display:none parent (the
  // Shell tab while off-tab, the terminal behind the Docs panel).
  private visible(): boolean {
    return !this.parked && this.host.clientWidth > 0;
  }

  // Fit to the box and tell the PTY. Only a terminal on screen does this: several
  // viewers share one PTY, and a hidden terminal has no box to measure.
  private refit(): void {
    if (!this.visible()) return;
    try { this.fit.fit(); } catch { /* host detached */ }
    this.sock.send({ t: "resize", cols: this.term.cols, rows: this.term.rows });
  }

  show(slot: HTMLElement, look: TermLook): void {
    this.parked = false;
    if (this.wrap.parentElement !== slot) slot.appendChild(this.wrap);
    this.setLook(look);
    this.refit();
    this.sock.heal();
  }

  // Off screen, still receiving. A slot that lost the terminal to a newer slot
  // has nothing to give back.
  park(slot: HTMLElement): void {
    if (this.wrap.parentElement !== slot) return;
    this.parked = true; // first: moving a focused terminal fires a focus report
    parkingLot().appendChild(this.wrap);
  }

  setLook(look: TermLook): void {
    // Option sets to the current value are no-ops in xterm.
    this.term.options.theme = termTheme(look);
    if (look.mobile === this.mobile) return;
    // Resize the glyph when the viewport crosses the mobile breakpoint — bigger
    // on a phone for readability, denser on desktop. Done live (no reconnect).
    this.mobile = look.mobile;
    this.term.options.fontSize = TERM_FONT_PX(look.mobile);
    this.term.options.letterSpacing = TERM_TRACKING(look.mobile);
    this.term.options.lineHeight = TERM_LINE_HEIGHT(look.mobile);
    this.refit();
  }

  dispose(): void {
    this.disposed = true;
    this.parked = true;
    for (const c of this.cleanups.reverse()) c();
    this.sock.dispose();
    this.term.dispose();
    this.wrap.remove();
  }
}

// The agent terminals kept alive across switches (see lib/termPool.ts).
const agentTerminals = new TermPool<TermSession>(() =>
  poolCap(process.env.NEXT_PUBLIC_AGENT_TERMINAL_POOL, window.matchMedia("(max-width: 768px)").matches));

// The agent is gone for good: free its kept terminal.
export function dropAgentTerminal(agentId: string): void {
  agentTerminals.drop(agentId);
  forgetComposer(agentId);
}

// `keepKey` puts the terminal in the pool of kept agent terminals: leaving the
// screen hides it instead of closing it. Without one, unmounting ends it.
export function XtermTerminal({ wsPath, uploadPath, readOnly = false, keepKey }: { wsPath: string; uploadPath?: string; readOnly?: boolean; keepKey?: string }) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<TermSession | null>(null);
  const { theme } = useTheme();
  const isMobile = useIsMobile();
  // Read at creation time without making the effect depend on them (that would
  // tear down the terminal). Live changes are handled by the effect below.
  const lookRef = useRef<TermLook>({ theme, mobile: isMobile });
  lookRef.current = { theme, mobile: isMobile };

  // A layout effect, so a kept terminal is back in place before the browser paints.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const create = () => new TermSession({ wsPath, uploadPath, readOnly, look: lookRef.current, slot });
    const session = keepKey ? agentTerminals.acquire(keepKey, create) : create();
    session.show(slot, lookRef.current);
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      if (keepKey) {
        session.park(slot);
        agentTerminals.release(keepKey);
      } else {
        session.dispose();
      }
    };
  }, [wsPath, uploadPath, readOnly, keepKey]);

  // Theme flip or breakpoint crossing: no reconnect, the buffer and the PTY stay
  // intact. Kept terminals off screen catch up in show().
  useEffect(() => {
    sessionRef.current?.setLook({ theme, mobile: isMobile });
  }, [theme, isMobile]);

  // The session's own DOM goes in here: terminal plus the mobile key bar that
  // wireMobileKeys appends below it. `display: contents` gives the slot no box.
  return <div className={s.slot} ref={slotRef} />;
}
