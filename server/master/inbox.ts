// server/master/inbox.ts — the only way console-made input (Telegram text,
// queue answer lines, event digests) reaches the fleet master's PTY. Delivers
// only when the master is idle, the Master tab holds no unsent draft, the tab
// has been quiet for 30 s, and (digest only) 60 s have passed since the last
// digest. See spec §3 and, for pushConsole, chief-of-staff spec §5.4 step 3.
import type { EventHub } from "../events.js";
import type { InputTracker } from "./draft.js";
import { FLEET_MASTER_ID } from "./paths.js";

export const QUIET_MS = 30_000;
export const DIGEST_GAP_MS = 60_000;
export const BUSY_TIMEOUT_MS = 3 * 60_000;
export const TICK_MS = 1_000;
// How many pushConsole msgIds the inbox remembers to tell a first push from a re-push.
export const SEEN_MSG_IDS_MAX = 1000;

export type Turn = "idle" | "busy";
export type Surface = "tab" | "telegram";
export type BlockReason = "busy" | "draft" | "quiet";
export type InboxRejectReason = "timeout" | "cancelled";

// How a pushConsole promise rejects; `reason` tells the Deliverer what to do.
export class InboxError extends Error {
  constructor(readonly reason: InboxRejectReason) { super(reason); this.name = "InboxError"; }
}

// One queued message. `bridge` marks a pushTelegram message: it never times
// out, never rejects, and is the only kind that posts the "Queued" notice.
type Queued = {
  text: string;
  // null: surface-neutral (a reminder line), like an event digest: it never
  // changes the inbox's surface and is batched only with other neutral ones.
  surface: Surface | null;
  since: number;
  bridge: boolean;
  msgId?: string;
  // False only for a re-push of a msgId pushed before (a Deliverer retry):
  // it never changes the surface (Phase 2a ruling 2a-6-a).
  firstPush: boolean;
  timeoutMs?: number;
  timer?: NodeJS.Timeout;
  inFlight: boolean;  // part of the batch the current send carries
  timedOut: boolean;  // its timer fired while in flight: settles with the send
  cancelled: boolean; // cancel() hit it while in flight: settles with the send
  resolve: () => void;
  reject: (e: InboxError) => void;
};

export type InboxDeps = {
  hub: Pick<EventHub, "subscribe">;
  events: { size(): number; digest(): string | null; clear(): void };
  send: (text: string) => Promise<boolean>;
  tracker: Pick<InputTracker, "onInput" | "hasDraft" | "quietFor">;
  // False while no fleet master exists: tick() then does nothing at all, so the
  // 1 s interval never calls send() (sendToAgent → hasSession) for nothing.
  ready?: () => boolean;
  // True while its agent WAITS for the second sign-in (chief/chiefwait.ts): no session exists,
  // so tick() sends nothing (the "starting" hold never ends in a send to no session), and every
  // message is kept for the start (the bridge tells the person, master/telegram.ts).
  waits?: () => boolean;
  // The agent this inbox feeds; default the fleet master (a lead's inbox passes its own id).
  agentId?: string;
  onQueued?: (reason: "busy" | "draft") => void;
  now?: () => number;
};

export function turnAfterHook(cur: Turn, event: string, source?: string): Turn {
  if (event === "UserPromptSubmit") return "busy";
  if (event === "Stop") return "idle";
  // compact can fire mid-turn, so it does not end one.
  if (event === "SessionStart" && (source === "startup" || source === "resume" || source === "clear")) return "idle";
  return cur;
}

export function waitForHook(
  hub: Pick<EventHub, "subscribe">, agentId: string, event: string, timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { unsub(); resolve(false); }, timeoutMs);
    const unsub = hub.subscribe((e) => {
      if (e.type === "agent-hook" && e.agentId === agentId && e.event === event) {
        clearTimeout(timer);
        unsub();
        resolve(true);
      }
    });
  });
}

export class MasterInbox {
  surface: Surface = "tab";
  private turnState: Turn = "idle";
  private lastSignalAt: number;
  private timeoutArmed = true;
  // Ordered by `since` (ties keep arrival order); in-flight messages stay in it.
  private queue: Queued[] = [];
  private lastDigestAt = Number.NEGATIVE_INFINITY;
  private delivering = false;
  private notified = false;
  // pushConsole msgIds seen, oldest first, at most SEEN_MSG_IDS_MAX.
  private seenMsgIds = new Set<string>();
  private timer?: NodeJS.Timeout;
  private unsub?: () => void;

  private readonly agentId: string;
  // The log prefix: [master] for the fleet master, a lead's own id otherwise.
  private readonly tag: string;

  constructor(private d: InboxDeps) {
    this.agentId = d.agentId ?? FLEET_MASTER_ID;
    this.tag = this.agentId === FLEET_MASTER_ID ? "[master]" : `[${this.agentId}]`;
    this.lastSignalAt = this.now();
  }

  private now(): number { return (this.d.now ?? Date.now)(); }

  start(initial: Turn, opts: { tickMs?: number } = {}): void {
    if (this.unsub) return; // already started
    this.turnState = initial;
    this.lastSignalAt = this.now();
    this.timeoutArmed = true;
    this.unsub = this.d.hub.subscribe((e) => {
      if (e.type === "agent-hook" && e.agentId === this.agentId) this.onHook(e.event, e.source);
    });
    const ms = opts.tickMs ?? TICK_MS;
    if (ms > 0) {
      // No process-wide unhandledRejection handler exists: a rejected send must not crash the console.
      this.timer = setInterval(() => {
        this.tick().catch((e) => console.error(`${this.tag} inbox tick failed:`, e));
      }, ms);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.unsub?.();
    this.unsub = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  onHook(event: string, source?: string): void {
    if (event === "Notification") return;
    this.lastSignalAt = this.now();
    this.timeoutArmed = true; // a real master hook event re-arms the busy timeout
    this.turnState = turnAfterHook(this.turnState, event, source);
  }

  // The master's PTY is about to spawn (or was just spawned): Claude's TUI is
  // not in raw/bracketed-paste mode until SessionStart, so hold delivery as
  // busy. SessionStart startup|resume|clear flips it idle; the armed 3 min
  // busy timeout bounds a lost hook.
  markStarting(): void {
    this.turnState = "busy";
    this.lastSignalAt = this.now();
    this.timeoutArmed = true;
  }

  // busy with no master hook for 3 min counts as idle — once per real hook.
  turn(): Turn {
    if (this.turnState === "busy" && this.timeoutArmed && this.now() - this.lastSignalAt >= BUSY_TIMEOUT_MS) return "idle";
    return this.turnState;
  }

  onWebInput(agentId: string, data: string): void {
    if (agentId !== this.agentId) return;
    if (this.d.tracker.onInput(data).submitted) this.surface = "tab";
  }

  // Resolves once a send that returned true carried the message. Rejects only
  // after a `timeoutMs` (`timeout`) or a cancel (`cancelled`), and the message
  // is then gone from the queue, so a re-push never duplicates it. `since`
  // orders the queue (default: now). `surface` null pushes surface-neutral
  // (a reminder): the line was not written on either surface.
  pushConsole(text: string, surface: Surface | null, opts: { msgId?: string; timeoutMs?: number; since?: number } = {}): Promise<void> {
    return this.enqueue(text, surface, opts, false);
  }

  // The Telegram bridge (MasterBridge.onMessage does not await): never times
  // out and never rejects, however long a Master-tab draft holds it.
  pushTelegram(text: string): void {
    this.enqueue(text, "telegram", {}, true).catch((e) => console.error(`${this.tag} inbox bridge push failed:`, e));
  }

  queuedMessages(): number { return this.queue.length; }

  // True unless `msgId` was pushed before (and is still remembered). A message
  // without a msgId (the Telegram bridge) always counts as a first push; an
  // empty msgId names no message, as in cancel().
  private firstPush(msgId: string | undefined): boolean {
    if (msgId === undefined || msgId === "") return true;
    if (this.seenMsgIds.has(msgId)) return false;
    this.seenMsgIds.add(msgId);
    if (this.seenMsgIds.size > SEEN_MSG_IDS_MAX) {
      const oldest = this.seenMsgIds.values().next();
      if (!oldest.done) this.seenMsgIds.delete(oldest.value);
    }
    return true;
  }

  private enqueue(
    text: string, surface: Surface | null, opts: { msgId?: string; timeoutMs?: number; since?: number }, bridge: boolean,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Without an explicit since a message goes last even if the clock stepped back.
      const since = opts.since ?? Math.max(this.now(), this.queue.at(-1)?.since ?? Number.NEGATIVE_INFINITY);
      const firstPush = this.firstPush(opts.msgId);
      const m: Queued = {
        text, surface, since, bridge, firstPush, inFlight: false, timedOut: false, cancelled: false, resolve, reject,
        ...(opts.msgId !== undefined ? { msgId: opts.msgId } : {}),
      };
      if (opts.timeoutMs !== undefined) {
        m.timeoutMs = opts.timeoutMs;
        m.timer = setTimeout(() => this.onTimeout(m), opts.timeoutMs);
        m.timer.unref?.();
      }
      const i = this.queue.findIndex((q) => q.since > since);
      if (i < 0) this.queue.push(m); else this.queue.splice(i, 0, m);
      if (surface === "telegram" && firstPush) this.surface = "telegram";
    });
  }

  // Undo of a master answer (spec §5.6). Synchronous, so it always finds a
  // message pushed just before under the same item lock. In flight → it settles
  // with that send: true → resolve; false → removed, rejected `cancelled`,
  // never re-sent. Bridge messages have no msgId and are never cancelled; an
  // empty or missing msgId names no message ("absent").
  cancel(msgId: string): "removed" | "in-flight" | "absent" {
    if (typeof msgId !== "string" || msgId === "") return "absent";
    const m = this.queue.find((q) => q.msgId === msgId);
    if (!m) return "absent";
    if (m.inFlight) {
      m.cancelled = true;
      return "in-flight";
    }
    this.drop(m, "cancelled");
    return "removed";
  }

  private onTimeout(m: Queued): void {
    m.timer = undefined;
    if (m.inFlight) m.timedOut = true; // settles with the in-flight send
    else this.drop(m, "timeout");
  }

  private remove(m: Queued): void {
    const i = this.queue.indexOf(m);
    if (i >= 0) this.queue.splice(i, 1);
    if (m.timer) clearTimeout(m.timer);
    m.timer = undefined;
  }

  private drop(m: Queued, reason: InboxRejectReason): void {
    this.remove(m);
    m.reject(new InboxError(reason));
  }

  // The longest run of queued messages that share the oldest one's surface,
  // so tab, telegram and neutral lines never share a batch.
  private nextBatch(): Queued[] {
    const surface = this.queue[0].surface;
    const end = this.queue.findIndex((m) => m.surface !== surface);
    return this.queue.slice(0, end < 0 ? this.queue.length : end);
  }

  blockedBy(): BlockReason | null {
    if (this.turn() !== "idle") return "busy";
    if (this.d.tracker.hasDraft()) return "draft";
    if (!this.d.tracker.quietFor(QUIET_MS)) return "quiet";
    return null;
  }

  async tick(): Promise<void> {
    if (this.delivering) return;
    if (this.d.ready && !this.d.ready()) return;
    if (this.d.waits?.()) return;
    const block = this.blockedBy();
    if (block) {
      if (this.queue.some((m) => m.bridge) && !this.notified && block !== "quiet") {
        this.notified = true;
        this.d.onQueued?.(block);
      }
      return;
    }
    const viaTimeout = this.turnState === "busy";
    this.delivering = true;
    let sent: Queued[] = [];
    try {
      if (this.queue.length) {
        const batch = this.nextBatch();
        for (const m of batch) m.inFlight = true;
        let ok = false;
        try {
          ok = await this.d.send(batch.map((m) => m.text).join("\n\n"));
        } finally {
          for (const m of batch) m.inFlight = false;
          // A failed (false or thrown) send leaves the batch queued, as today,
          // except the messages cancelled or timed out meanwhile. Cancel wins:
          // the Deliverer then drops a withdrawal that waits on this message.
          if (!ok) {
            for (const m of batch) {
              if (m.cancelled) this.drop(m, "cancelled");
              else if (m.timedOut) this.drop(m, "timeout");
            }
          }
        }
        if (!ok) return;
        for (const m of batch) this.remove(m);
        sent = batch;
        if (batch.some((m) => m.bridge)) this.notified = false;
        // A tab line submitted while this text waited flipped surface to tab;
        // the answer to a telegram batch belongs on Telegram. A batch of only
        // re-pushes keeps the surface it finds (ruling 2a-6-a), and so does
        // a neutral batch, as a digest does.
        const fresh = batch.find((m) => m.firstPush);
        if (fresh?.surface) this.surface = fresh.surface;
      } else {
        if (this.now() - this.lastDigestAt < DIGEST_GAP_MS) return;
        const text = this.d.events.digest();
        if (!text) return;
        if (!(await this.d.send(text))) return;
        this.d.events.clear();
        this.lastDigestAt = this.now();
      }
      if (viaTimeout) this.timeoutArmed = false;
      this.turnState = "busy";
      this.lastSignalAt = this.now();
    } finally {
      this.delivering = false;
    }
    // Only after send returned (its typing lock is released) and the state
    // above is final, so a continuation that takes an item lock never runs
    // inside the master's typing lock (spec §5.4).
    for (const m of sent) m.resolve();
  }
}
