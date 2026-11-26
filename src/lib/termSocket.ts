// A terminal WebSocket that heals itself. The console used to open one socket
// per terminal and never reconnect, so a socket dropped while the browser sat
// idle (laptop sleep, throttled tab, tailscale idle timeout) froze the terminal
// until a page reload. Every server route replays the scrollback on connect, so
// reconnecting is enough: the caller resets the terminal and the replay redraws.
// A route that sends a sync frame (agents) can do better: the socket counts what
// it received and asks for only the rest, so nothing resets and nothing redraws.

import { storedUserToken } from "./chief";

// Mirrors server/wsKeepalive.ts: the server closes with this code when there is
// nothing to stream (no live terminal…). Don't auto-retry it; a later return to
// the tab still tries once, which picks up a resumed agent.
export const WS_CLOSE_FINAL = 4000;

type SocketLike = {
  readyState: number;
  binaryType?: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

type Listenable = {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
};

export type TermSocketOpts = {
  url: string;
  onData: (data: string) => void;
  // reconnect=false on the first open.
  onOpen: (reconnect: boolean) => void;
  // A reconnect is about to replay the whole history: reset the terminal now.
  // Not called when the server resumes where this socket stopped.
  onReplay?: () => void;
  // Called once per outage, when a live socket drops unexpectedly.
  onLost?: () => void;
  create?: (url: string) => SocketLike;
  doc?: Listenable & { hidden: boolean };
  win?: Listenable;
  now?: () => number;
  // A tab hidden at least this long reconnects on return even if the socket
  // looks open: a half-open socket never fires close.
  staleHiddenMs?: number;
  // Added to each retry delay. Lets a terminal off screen wait its turn, so a
  // server restart doesn't make every kept terminal replay at the same moment.
  retryJitter?: () => number;
};

// An RFC 6455 subprotocol is an HTTP token: new WebSocket throws on anything
// else (a space, a comma, a slash). A real user token is base64url.
const PROTOCOL_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

type WsCtor = new (url: string, protocols?: string[]) => unknown;

// A browser WebSocket cannot carry a header, so the stored user token is the
// one offered subprotocol (spec §3): a hardened console checks it on the
// agent, shell and service terminals, and every console echoes it. No usable
// token stored → exactly `new WebSocket(url)`, as before.
export function openTermWs(
  url: string,
  deps: { WebSocket?: WsCtor; storage?: Pick<Storage, "getItem"> | null } = {},
): SocketLike {
  const Ctor = deps.WebSocket ?? (WebSocket as WsCtor);
  const token = storedUserToken(deps.storage);
  return (token !== null && PROTOCOL_RE.test(token) ? new Ctor(url, [token]) : new Ctor(url)) as SocketLike;
}

type SyncFrame = { t: "sync"; epoch: string; offset: number; resumed: boolean };

// Server control frames are binary; terminal output is always text.
function parseSync(data: unknown): SyncFrame | null {
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return null;
  try {
    const m = JSON.parse(new TextDecoder().decode(data as ArrayBuffer)) as Partial<SyncFrame>;
    return m.t === "sync" && typeof m.epoch === "string" && typeof m.offset === "number" ? (m as SyncFrame) : null;
  } catch { return null; }
}

const OPEN = 1;
const CONNECTING = 0;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 10_000;

export class TermSocket {
  private ws: SocketLike | null = null;
  private opened = false;
  private lostAnnounced = false;
  private backoff = BACKOFF_MIN;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private hiddenAt: number | null = null;
  private disposed = false;
  // A reopened socket whose first frame hasn't said yet if it replays in full.
  private replayPending = false;
  // Where our copy of the stream ends, once the route has sent a sync frame.
  private position: { epoch: string; offset: number } | null = null;
  private readonly o: Required<Omit<TermSocketOpts, "onLost" | "onReplay" | "retryJitter" | "doc" | "win">> & Pick<TermSocketOpts, "onLost" | "onReplay" | "retryJitter" | "doc" | "win">;

  constructor(opts: TermSocketOpts) {
    this.o = {
      // The token is read at each connect: a device paired since is used next time.
      create: (url) => openTermWs(url),
      now: () => Date.now(),
      staleHiddenMs: 30_000,
      doc: typeof document !== "undefined" ? document : undefined,
      win: typeof window !== "undefined" ? window : undefined,
      ...opts,
    };
    this.o.doc?.addEventListener("visibilitychange", this.onVisibility);
    this.o.win?.addEventListener("online", this.onOnline);
    this.connect();
  }

  get isOpen(): boolean { return this.ws?.readyState === OPEN; }

  send(msg: object): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(msg));
  }

  // Connect now unless a socket is already open or connecting. For a terminal
  // coming back on screen after a final close or during a retry wait.
  heal(): void { this.healNow(false); }

  dispose(): void {
    this.disposed = true;
    this.clearRetry();
    this.o.doc?.removeEventListener("visibilitychange", this.onVisibility);
    this.o.win?.removeEventListener("online", this.onOnline);
    this.drop();
  }

  private connect(): void {
    if (this.disposed) return;
    this.clearRetry();
    this.drop();
    const ws = this.o.create(this.resumeUrl());
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      const reconnect = this.opened;
      this.opened = true;
      this.backoff = BACKOFF_MIN;
      this.lostAnnounced = false;
      this.replayPending = reconnect;
      this.o.onOpen(reconnect);
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === WS_CLOSE_FINAL) return;
      if (this.opened && !this.lostAnnounced) { this.lostAnnounced = true; this.o.onLost?.(); }
      this.scheduleRetry();
    };
  }

  private resumeUrl(): string {
    const p = this.position;
    if (!p) return this.o.url;
    return `${this.o.url}?epoch=${encodeURIComponent(p.epoch)}&since=${p.offset}`;
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") {
      const sync = parseSync(data);
      if (!sync) return;
      if (this.replayPending && !sync.resumed) this.o.onReplay?.();
      this.replayPending = false;
      this.position = { epoch: sync.epoch, offset: sync.offset };
      return;
    }
    // Text before any sync: the route always replays in full.
    if (this.replayPending) {
      this.replayPending = false;
      this.position = null;
      this.o.onReplay?.();
    }
    if (this.position) this.position.offset += data.length;
    this.o.onData(data);
  }

  // Detach the current socket's handlers before closing, so its close event
  // can't schedule a second reconnect.
  private drop(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* already closed */ }
  }

  private scheduleRetry(): void {
    // A hidden tab waits; the visibility handler reconnects on return.
    if (this.disposed || this.o.doc?.hidden) return;
    const delay = this.backoff + (this.o.retryJitter?.() ?? 0);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    this.retry = setTimeout(() => this.connect(), delay);
  }

  private clearRetry(): void {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
  }

  private onVisibility = (): void => {
    if (this.o.doc?.hidden) { this.hiddenAt = this.o.now(); return; }
    const hiddenFor = this.hiddenAt == null ? 0 : this.o.now() - this.hiddenAt;
    this.hiddenAt = null;
    this.healNow(hiddenFor >= this.o.staleHiddenMs);
  };

  private onOnline = (): void => this.healNow(false);

  private healNow(force: boolean): void {
    if (this.disposed) return;
    const state = this.ws?.readyState;
    if (!force && (state === OPEN || state === CONNECTING)) return;
    this.backoff = BACKOFF_MIN;
    this.connect();
  }
}
