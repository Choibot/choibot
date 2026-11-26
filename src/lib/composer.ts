import { chiefFetch } from "./chief";
// src/lib/composer.ts — the queue behind the composer under each agent
// terminal.
//
// A message the user sends goes to localStorage first, one key per message,
// then a per-agent flusher POSTs the oldest one to /api/agents/:id/input. The
// server types it only when the agent's TUI can take it and dedups by msgId,
// so a resend after a reload or from a second tab is never typed twice. The
// flusher does not look at the terminal WebSocket: the server is the gate.

export type ItemState = "pending" | "sending" | "waiting" | "failed";
// `why`: the cause of a wait or a failure, for a view that says it in its own words.
export type ItemWhy = "starting" | "dialog" | "not-live" | "offline" | "server" | "error";
export type ComposerItem = { id: string; text: string; at: number; seq: number; state: ItemState; note?: string; why?: ItemWhy };
// A message the server typed into the agent. The thread view shows it until
// the agent's session file has it (src/lib/outbox.ts). In memory only: after a
// reload the session file is the one source.
// `busy`: the agent worked when the server typed it, so it is in the agent's wait line.
export type SentItem = { id: string; text: string; at: number; sentAt: number; busy?: true };
export const SENT_KEEP = 20;
export const SENT_MAX_AGE_MS = 10 * 60_000;
const CLAIMED_KEEP = 100;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
type PostResult = { status: number; body: unknown } | { error: string };

export type ComposerEnv = {
  storage: () => StorageLike | null;
  post: (agentId: string, msgId: string, text: string) => Promise<PostResult>;
  now: () => number;
  newId: () => string;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
};

export const QUEUE_PREFIX = "choibot.composer.q.";
export const DRAFT_PREFIX = "choibot.composer.draft.";
// Mirrors MAX_TEXT in server/agents/composer.ts.
export const MAX_TEXT = 32_000;
export const RETRY_STARTING_MS = 1_000;
export const RETRY_NOT_LIVE_MS = 3_000;
export const HINT_MS = 6_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 10_000;

const NOTES = {
  starting: "waiting for agent to start",
  dialog: "the agent asks a question — answer it first",
  notLive: "agent not live — Resume to send",
  offline: "offline — retrying",
} as const;

type Flusher = {
  timer: unknown;
  running: boolean;
  kicked: boolean;
  backoff: number;
  // In-memory state of single items: the head being sent or waited on, and
  // items that failed with an error the user must look at.
  state: Map<string, { state: ItemState; note?: string; why?: ItemWhy }>;
};

const NO_SENT: readonly SentItem[] = [];
const NO_IDS: readonly string[] = [];

// Storage reads and writes never throw (private mode, quota, blocked storage).
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export class Composer {
  private flushers = new Map<string, Flusher>();
  private subs = new Map<string, Set<() => void>>();
  private seq = 0;
  private hints = new Map<string, { text: string; timer: unknown }>();
  private sentItems = new Map<string, SentItem[]>();
  private claimedIds = new Map<string, string[]>();

  constructor(private env: ComposerEnv) {}

  // ---- drafts ----
  draft(agentId: string): string {
    return safe(() => this.env.storage()?.getItem(DRAFT_PREFIX + agentId) ?? "", "");
  }

  setDraft(agentId: string, text: string): void {
    safe(() => {
      const s = this.env.storage();
      if (!s) return;
      if (text) s.setItem(DRAFT_PREFIX + agentId, text); else s.removeItem(DRAFT_PREFIX + agentId);
    }, undefined);
  }

  // ---- hint ----
  // The server's one-line hint from a 200 answer (e.g. "Already a rule (r_1).").
  // Shown for HINT_MS; a new send or a newer hint replaces it.
  hint(agentId: string): string | null {
    return this.hints.get(agentId)?.text ?? null;
  }

  private setHint(agentId: string, text: string | null): void {
    const old = this.hints.get(agentId);
    if (old) { this.env.clearTimer(old.timer); this.hints.delete(agentId); }
    if (text) {
      const timer = this.env.setTimer(() => { this.hints.delete(agentId); this.emit(agentId); }, HINT_MS);
      this.hints.set(agentId, { text, timer });
    }
    this.emit(agentId);
  }

  // ---- sent ----
  // The messages typed into the agent that the thread has not shown as the
  // agent's own entry yet, oldest first.
  sent(agentId: string): readonly SentItem[] {
    return this.sentItems.get(agentId) ?? NO_SENT;
  }

  // The session file has the message: `by` is the id of its entry there. That
  // entry stands for this message only (a second message with the same text
  // needs an entry of its own).
  settle(agentId: string, msgId: string, by?: string): void {
    const list = this.sentItems.get(agentId);
    if (!list || !list.some((x) => x.id === msgId)) return;
    this.sentItems.set(agentId, list.filter((x) => x.id !== msgId));
    if (by) {
      const ids = [...(this.claimedIds.get(agentId) ?? []), by];
      this.claimedIds.set(agentId, ids.slice(-CLAIMED_KEEP));
    }
    this.emit(agentId);
  }

  claimed(agentId: string): readonly string[] {
    return this.claimedIds.get(agentId) ?? NO_IDS;
  }

  private addSent(agentId: string, it: { id: string; text: string; at: number }, busy: boolean): void {
    const now = this.env.now();
    const list = (this.sentItems.get(agentId) ?? []).filter((x) => x.id !== it.id && now - x.sentAt < SENT_MAX_AGE_MS);
    list.push({ id: it.id, text: it.text, at: it.at, sentAt: now, ...(busy ? { busy: true as const } : {}) });
    this.sentItems.set(agentId, list.slice(-SENT_KEEP));
  }

  // ---- queue ----
  // Stored items of one agent, oldest first. Read fresh each time: other tabs
  // add and remove keys too.
  private stored(agentId: string): Omit<ComposerItem, "state" | "note">[] {
    const prefix = `${QUEUE_PREFIX}${agentId}.`;
    const out: Omit<ComposerItem, "state" | "note">[] = [];
    safe(() => {
      const s = this.env.storage();
      if (!s) return;
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        const id = k.slice(prefix.length);
        if (!id || id.includes(".")) continue; // another agent whose id extends this one
        const v = safe(() => JSON.parse(s.getItem(k) ?? "") as { text?: unknown; at?: unknown; seq?: unknown }, null);
        if (!v || typeof v.text !== "string") continue;
        out.push({ id, text: v.text, at: Number(v.at) || 0, seq: Number(v.seq) || 0 });
      }
    }, undefined);
    return out.sort((a, b) => a.at - b.at || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  items(agentId: string): ComposerItem[] {
    const f = this.flushers.get(agentId);
    return this.stored(agentId).map((it) => ({ ...it, state: "pending" as ItemState, ...(f?.state.get(it.id) ?? {}) }));
  }

  // Queue a message. False when it could not be stored (the caller keeps the
  // text in the box: nothing is dropped).
  add(agentId: string, text: string): boolean {
    if (!text.trim()) return false;
    const id = this.env.newId();
    const ok = safe(() => {
      const s = this.env.storage();
      if (!s) return false;
      s.setItem(`${QUEUE_PREFIX}${agentId}.${id}`, JSON.stringify({ text, at: this.env.now(), seq: ++this.seq }));
      return true;
    }, false);
    if (!ok) return false;
    this.setHint(agentId, null);
    this.kick(agentId);
    return true;
  }

  // Remove a queued message. Not while this tab is sending it.
  remove(agentId: string, msgId: string): void {
    const f = this.flushers.get(agentId);
    if (f?.state.get(msgId)?.state === "sending") return;
    this.drop(agentId, msgId);
    this.emit(agentId);
    this.kick(agentId);
  }

  retry(agentId: string, msgId: string): void {
    this.flushers.get(agentId)?.state.delete(msgId);
    this.emit(agentId);
    this.kick(agentId);
  }

  // The agent is gone: drop its draft and queue.
  forget(agentId: string): void {
    const f = this.flushers.get(agentId);
    if (f) { this.env.clearTimer(f.timer); this.flushers.delete(agentId); }
    for (const it of this.stored(agentId)) this.drop(agentId, it.id);
    this.sentItems.delete(agentId);
    this.claimedIds.delete(agentId);
    this.setDraft(agentId, "");
    this.emit(agentId);
  }

  private drop(agentId: string, msgId: string): void {
    safe(() => this.env.storage()?.removeItem(`${QUEUE_PREFIX}${agentId}.${msgId}`), undefined);
    this.flushers.get(agentId)?.state.delete(msgId);
  }

  // Start a flusher for every agent with queued items (page load).
  scan(): void {
    const agents = new Set<string>();
    safe(() => {
      const s = this.env.storage();
      if (!s) return;
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k?.startsWith(QUEUE_PREFIX)) continue;
        const rest = k.slice(QUEUE_PREFIX.length);
        const dot = rest.lastIndexOf(".");
        if (dot > 0) agents.add(rest.slice(0, dot));
      }
    }, undefined);
    for (const a of agents) this.kick(a);
  }

  // Another tab changed storage.
  onStorage(key: string | null): void {
    if (key === null) { for (const a of this.subs.keys()) this.emit(a); this.scan(); return; }
    if (!key.startsWith(QUEUE_PREFIX)) return;
    const rest = key.slice(QUEUE_PREFIX.length);
    const dot = rest.lastIndexOf(".");
    if (dot <= 0) return;
    const agentId = rest.slice(0, dot);
    this.emit(agentId);
    this.kick(agentId);
  }

  // Try now: cancel the wait and reset the backoff. Every agent with a
  // flusher when agentId is omitted (tab visible again, back online).
  kick(agentId?: string): void {
    if (agentId === undefined) { for (const a of this.flushers.keys()) this.kick(a); return; }
    const f = this.flusher(agentId);
    f.backoff = BACKOFF_MIN_MS;
    if (f.running) { f.kicked = true; return; }
    this.env.clearTimer(f.timer);
    f.timer = undefined;
    void this.attempt(agentId);
  }

  subscribe(agentId: string, fn: () => void): () => void {
    let set = this.subs.get(agentId);
    if (!set) { set = new Set(); this.subs.set(agentId, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  private emit(agentId: string): void {
    for (const fn of this.subs.get(agentId) ?? []) fn();
  }

  private flusher(agentId: string): Flusher {
    let f = this.flushers.get(agentId);
    if (!f) {
      f = { timer: undefined, running: false, kicked: false, backoff: BACKOFF_MIN_MS, state: new Map() };
      this.flushers.set(agentId, f);
    }
    return f;
  }

  private schedule(agentId: string, ms: number): void {
    const f = this.flushers.get(agentId);
    if (!f) return;
    this.env.clearTimer(f.timer);
    f.timer = this.env.setTimer(() => { f.timer = undefined; void this.attempt(agentId); }, ms);
  }

  // One attempt: send the oldest queued message, then decide when to try next.
  // Two tabs may send the same head at once: the server types a msgId once.
  private async attempt(agentId: string): Promise<void> {
    const f = this.flushers.get(agentId);
    if (!f || f.running) return;
    f.running = true;
    f.kicked = false;
    let next: number | null = null;
    try {
      next = await this.sendHead(agentId, f);
    } catch {
      next = f.backoff;
      f.backoff = Math.min(f.backoff * 2, BACKOFF_MAX_MS);
    } finally {
      f.running = false;
    }
    if (!this.flushers.has(agentId)) return; // forgotten meanwhile
    if (f.kicked) { f.kicked = false; next = 0; }
    if (next === null) return;
    if (next === 0) void this.attempt(agentId);
    else this.schedule(agentId, next);
  }

  // Returns the wait before the next attempt, 0 for now, null for "idle"
  // (queue empty, or blocked behind a failed item the user must look at).
  private async sendHead(agentId: string, f: Flusher): Promise<number | null> {
    const head = this.stored(agentId)[0];
    if (!head) { f.state.clear(); return null; }
    if (f.state.get(head.id)?.state === "failed") return null;
    // A message that waits for a next try keeps its reason on screen during the try.
    if (f.state.get(head.id)?.state !== "waiting") {
      f.state.set(head.id, { state: "sending" });
      this.emit(agentId);
    }
    const r = await this.env.post(agentId, head.id, head.text);
    const set = (state: ItemState, note: string, why: ItemWhy) => { f.state.set(head.id, { state, note, why }); this.emit(agentId); };
    if ("error" in r) {
      set("waiting", NOTES.offline, "offline");
      const wait = f.backoff;
      f.backoff = Math.min(f.backoff * 2, BACKOFF_MAX_MS);
      return wait;
    }
    const reason = (r.body as { reason?: unknown } | null)?.reason;
    if (r.status === 200) {
      const hint = (r.body as { hint?: unknown } | null)?.hint;
      if (typeof hint === "string" && hint) this.setHint(agentId, hint);
      this.addSent(agentId, head, (r.body as { busy?: unknown } | null)?.busy === true);
      this.drop(agentId, head.id);
      f.backoff = BACKOFF_MIN_MS;
      this.emit(agentId);
      return 0;
    }
    if (r.status === 409 && reason === "starting") {
      // Claude asks a question on the agent's screen: the line waits for the user's answer there.
      if ((r.body as { dialog?: unknown } | null)?.dialog === true) set("waiting", NOTES.dialog, "dialog");
      else set("waiting", NOTES.starting, "starting");
      return RETRY_STARTING_MS;
    }
    if (r.status === 409 && reason === "not-live") { set("waiting", NOTES.notLive, "not-live"); return RETRY_NOT_LIVE_MS; }
    if (r.status === 404 && reason === "agent-gone") { this.forget(agentId); return null; }
    if (r.status >= 500 || r.status === 409 || r.status === 429 || r.status === 0) {
      set("waiting", `server ${r.status} — retrying`, "server");
      const wait = f.backoff;
      f.backoff = Math.min(f.backoff * 2, BACKOFF_MAX_MS);
      return wait;
    }
    const err = (r.body as { error?: unknown } | null)?.error;
    set("failed", `failed: ${typeof err === "string" ? err : `HTTP ${r.status}`}`, "error");
    return null;
  }
}

// ---- browser singleton ----

function newId(): string {
  try { return crypto.randomUUID(); } catch { /* old browser / insecure context */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function post(agentId: string, msgId: string, text: string): Promise<PostResult> {
  try {
    const res = await chiefFetch(`/api/agents/${encodeURIComponent(agentId)}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgId, text }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "network error" };
  }
}

let instance: Composer | null = null;

export function composer(): Composer {
  if (instance) return instance;
  const c = new Composer({
    storage: () => safe(() => window.localStorage, null),
    post,
    now: () => Date.now(),
    newId,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  instance = c;
  window.addEventListener("storage", (e) => c.onStorage(e.key));
  window.addEventListener("online", () => c.kick());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) c.kick(); });
  c.scan();
  return c;
}

export function forgetComposer(agentId: string): void {
  if (typeof window !== "undefined") composer().forget(agentId);
}
