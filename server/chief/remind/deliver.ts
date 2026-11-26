// server/chief/remind/deliver.ts — types a due reminder into its agent as
// `[reminder <id>] (set by … on …) <text>`, by the same paths and rules as a
// queue answer (chief spec §5.4):
// - a worker: ComposerGate.inputInternal (typing lock, msgId dedup, the
//   readiness check), only while its record is not `running` and its PTY had
//   no input for 60 s (a worker has no draft tracker, and a reminder is never
//   urgent) and no output for 10 s, checked again inside the typing lock;
// - a closed worker (closing keeps its reminders): reopened, and its stopped
//   session resumed with the line as its first turn (resumeClosed); a closed
//   worker whose session is still up is reopened, then typed as above;
// - the fleet master or a lead: its MasterInbox (busy, draft and quiet
//   holds; a 3 min timeout puts the reminder back to open), pushed
//   surface-neutral as a digest is, so a reminder never moves the master's
//   replies off Telegram;
// - a deleted agent: the fleet master's inbox, naming the agent; with a
//   Coordinator (`orphansTo`), its inbox: such a line is an alert, not chat.
// A session that ended (done/error, not closed) is resumed first, keeping its
// conversation, and a worker's line waits for its SessionStart (3 min bound).
// A resume that throws, or whose session is gone again at the next tick with
// no SessionStart, counts as a failure; MAX_RESUME_FAILURES in a row, or a
// reminder overdue by more than 24 h, fail the reminder instead of resuming.
// A closed worker has no other way back, so the 24 h rule does not apply to
// it: an overdue reminder still reopens it, once (it is open after).
// At least once: the state is `delivering` on disk before the line goes out
// and `delivered` after; a reminder a restart left `delivering` is sent
// again by bootScan (the line carries its id). A 60 s tick finds due ones; an
// agent's idle event and a resumed agent's SessionStart kick its own after
// the output window.
import { resumeClosedWithPrompt, type ResumeClosedDeps } from "../../agents/closed.js";
import type { ComposerGate } from "../../agents/composer.js";
import { isPersistentKind, type AgentRecord, type SessionStore } from "../../agents/store.js";
import type { TerminalManager } from "../../agents/terminal.js";
import type { EventHub } from "../../events.js";
import { withTypingLock } from "../../issues/reply.js";
import { BUSY_TIMEOUT_MS, InboxError, type MasterInbox } from "../../master/inbox.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import { OUTPUT_QUIET_MS } from "../relaunch.js";
import { formatReminderLine } from "./lines.js";
import { isOpenReminder, type Reminder, type ReminderStore } from "./store.js";

export const TICK_MS = 60_000;
// A kick waits out the output window that an idle event or a SessionStart opens.
export const IDLE_KICK_MS = OUTPUT_QUIET_MS + 1_000;
// The longest a resumed worker's line waits for its SessionStart.
export const START_HOLD_MS = BUSY_TIMEOUT_MS;
export const MAX_RESUME_FAILURES = 5;
// Past this, a reminder whose agent is not up fails instead of resuming it.
export const MAX_OVERDUE_MS = 24 * 3_600_000;
// A worker's PTY must have had no input this long before a reminder is typed.
export const WORKER_INPUT_QUIET_MS = 60_000;
export const RETENTION_MS = 30 * 86_400_000;
const PURGE_EVERY_MS = 3_600_000;

export type ReminderDelivererDeps = {
  store: ReminderStore;
  agents: Pick<SessionStore, "load" | "exists">;
  composer: Pick<ComposerGate, "inputInternal">;
  // The MasterInbox of the fleet master or a lead; undefined while it has none.
  inboxFor: (agentId: string) => Pick<MasterInbox, "pushConsole"> | undefined;
  // A tracked PTY or a surviving dtach session.
  isLive: (agentId: string) => Promise<boolean>;
  // Brings an ended session back with its conversation: resumeAgent for a
  // worker, ensureFleet / ensureLead (which hold the inbox) for the others.
  resume: (rec: AgentRecord) => Promise<unknown>;
  // Who gets the reminder of a deleted agent; absent = the fleet master.
  orphansTo?: string;
  // A closed worker whose session is stopped: reopen it and resume the same
  // session with `line` as its first turn (resumeClosedFor). True only when
  // the line went out that way.
  resumeClosed: (agentId: string, line: string) => Promise<boolean>;
  // A closed worker whose session is still up: clear closedAt
  // (agents/closed.ts reopenIfClosed; the rail moves it on agent-reopened).
  reopen: (agentId: string) => Promise<unknown>;
  io: Pick<TerminalManager, "lastInputAt" | "lastOutputAt">;
  hub: Pick<EventHub, "subscribe">;
  now?: () => number;
  tickMs?: number;
  delay?: (fn: () => void, ms: number) => void;
  log?: (s: string) => void;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const defaultDelay = (fn: () => void, ms: number): void => {
  const t = setTimeout(fn, ms);
  t.unref?.();
};

export class ReminderDeliverer {
  private timer?: NodeJS.Timeout;
  private unsub?: () => void;
  private ticking = false;
  private lastPurgeAt = Number.NEGATIVE_INFINITY;
  // Reminder ids being handled now (a tick and a kick never handle one twice).
  private readonly inflight = new Set<string>();
  // Agents with a due open reminder at the last tick: their idle event kicks.
  private dueAgents = new Set<string>();
  // Resumed workers: when, until their SessionStart.
  private readonly awaitingStart = new Map<string, number>();
  private readonly kicks = new Set<string>();
  private readonly now: () => number;
  private readonly log: (s: string) => void;

  constructor(private readonly d: ReminderDelivererDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
  }

  // The 60 s tick and the hub kicks. Never throws; the timer does not keep
  // the process alive. Returns stop.
  start(): () => void {
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, this.d.tickMs ?? TICK_MS);
      this.timer.unref?.();
    }
    this.unsub ??= this.d.hub.subscribe((e) => {
      if (e.type === "agent-hook" && e.event === "SessionStart" && this.awaitingStart.delete(e.agentId)) {
        this.kick(e.agentId);
        void this.clearResumeFailures(e.agentId).catch((err: unknown) => this.log(`[remind] ${e.agentId}: ${errText(err)}`));
      }
      else if (e.type === "agent-status" && e.status === "idle" && this.dueAgents.has(e.agentId)) this.kick(e.agentId);
    });
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsub?.();
    this.unsub = undefined;
  }

  // At boot, after reconcileAgents: a reminder a restart left `delivering`
  // may not have arrived (a MasterInbox queue is in memory), so it goes out
  // again; then one tick. Never rejects.
  async bootScan(): Promise<void> {
    try {
      await this.d.store.mutateAll((list) => {
        if (!list.some((r) => r.state === "delivering")) return null;
        const now = this.now();
        return list.map((r) => (r.state === "delivering" ? { ...r, state: "open" as const, lastError: "restart", updatedAt: now } : r));
      });
    } catch (e) {
      this.log(`[remind] boot scan failed: ${errText(e)}`);
    }
    await this.tick();
  }

  // Every due open reminder, one after the other. Never rejects.
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (now - this.lastPurgeAt >= PURGE_EVERY_MS) {
        this.lastPurgeAt = now;
        await this.purge(now);
      }
      const due = (await this.d.store.list()).filter((r) => r.state === "open" && r.dueAt <= now);
      this.dueAgents = new Set(due.map((r) => r.agentId));
      for (const r of due) await this.deliverLogged(r.id);
    } catch (e) {
      this.log(`[remind] tick failed: ${errText(e)}`);
    } finally {
      this.ticking = false;
    }
  }

  // One agent's due reminders, IDLE_KICK_MS from now (one pending kick per agent).
  private kick(agentId: string): void {
    if (this.kicks.has(agentId)) return;
    this.kicks.add(agentId);
    (this.d.delay ?? defaultDelay)(() => {
      this.kicks.delete(agentId);
      if (!this.unsub) return; // stopped
      void this.kickNow(agentId);
    }, IDLE_KICK_MS);
  }

  private async kickNow(agentId: string): Promise<void> {
    try {
      const now = this.now();
      const due = (await this.d.store.list()).filter((r) => r.agentId === agentId && r.state === "open" && r.dueAt <= now);
      for (const r of due) await this.deliverLogged(r.id);
    } catch (e) {
      this.log(`[remind] kick ${agentId} failed: ${errText(e)}`);
    }
  }

  // Final reminders leave the file 30 days after their last change.
  private async purge(now: number): Promise<void> {
    await this.d.store.mutateAll((list) => {
      const keep = list.filter((r) => isOpenReminder(r) || now - r.updatedAt <= RETENTION_MS);
      return keep.length === list.length ? null : keep;
    });
  }

  private async deliverLogged(id: string): Promise<void> {
    if (this.inflight.has(id)) return;
    this.inflight.add(id);
    try {
      await this.deliverOne(id);
    } catch (e) {
      this.log(`[remind] ${id} failed: ${errText(e)}`);
    } finally {
      this.inflight.delete(id);
    }
  }

  private async deliverOne(id: string): Promise<void> {
    const r = await this.d.store.get(id);
    if (!r || r.state !== "open" || r.dueAt > this.now()) return;
    const rec = await this.d.agents.load(r.agentId);
    if (!rec) {
      // A half-written record (the file is there) waits; a deleted agent's
      // line goes to the fleet master.
      if (await this.d.agents.exists(r.agentId)) return;
      const heir = await this.d.agents.load(this.d.orphansTo ?? FLEET_MASTER_ID);
      if (!heir) return this.note(r.id, this.d.orphansTo ? "no-coordinator" : "no-master");
      return this.toInbox(r, heir);
    }
    if (isPersistentKind(rec.kind)) return this.toInbox(r, rec);
    if (rec.closedAt !== undefined) return this.toClosedWorker(r, rec);
    return this.toWorker(r, rec);
  }

  // `to` is the fleet master or a lead (the target, or the master for a
  // deleted target). The push is not awaited: it may wait minutes in the
  // inbox, and `delivering` keeps the next tick off it.
  private async toInbox(r: Reminder, to: AgentRecord): Promise<void> {
    const inbox = this.d.inboxFor(to.id);
    if (!inbox) return;
    if (!(await this.d.isLive(to.id)) && !(await this.revive(r, to))) return;
    const cur = await this.markDelivering(r.id);
    if (!cur) return;
    // Surface-neutral (null): written on neither surface, like a digest.
    const p = inbox.pushConsole(formatReminderLine(cur, to.id), null, { msgId: cur.id, timeoutMs: BUSY_TIMEOUT_MS, since: cur.dueAt });
    void p.then(
      () => this.finish(cur.id, to.id),
      (e: unknown) => this.back(cur.id, e instanceof InboxError ? e.reason : errText(e)),
    ).catch((e: unknown) => this.log(`[remind] ${cur.id}: ${errText(e)}`));
  }

  private async toWorker(r: Reminder, rec: AgentRecord): Promise<void> {
    if (!(await this.d.isLive(rec.id))) {
      // The session ended (done or error, not closed): resume it with its
      // conversation; the line waits for its SessionStart.
      await this.revive(r, rec);
      return;
    }
    const since = this.awaitingStart.get(rec.id);
    if (since !== undefined) {
      if (this.now() - since < START_HOLD_MS) return;
      this.awaitingStart.delete(rec.id);
    }
    if (await this.busy(rec.id)) return;
    const cur = await this.markDelivering(r.id);
    if (!cur) return;
    let res;
    try {
      res = await this.d.composer.inputInternal(rec.id, { msgId: cur.id, text: formatReminderLine(cur, rec.id) },
        { noResume: true, hold: () => this.busy(rec.id) });
    } catch (e) {
      // The paste may have happened: at least once, so it goes again.
      return this.back(cur.id, errText(e));
    }
    if (res.code === 200) return this.finish(cur.id, rec.id);
    if (res.code === 400) return this.fail(cur.id, res.body.error);
    // 409 starting / busy / not-live: the next tick. 404: the record went
    // meanwhile; the next tick sends it to the master.
    return this.back(cur.id, res.body.reason);
  }

  // A closed worker. Its session still up (a close whose kill missed): reopen
  // it, then the usual paste. Else resume it with the line as its first turn;
  // delivered once that call is done, so the usual path never types the line
  // again, and the agent's other due lines wait for its SessionStart. A
  // resume that throws counts toward MAX_RESUME_FAILURES; one that sent no
  // line (reopened or live again meanwhile) leaves it to the usual path.
  private async toClosedWorker(r: Reminder, rec: AgentRecord): Promise<void> {
    if (await this.d.isLive(rec.id)) {
      await this.d.reopen(rec.id);
      return this.toWorker(r, rec);
    }
    const cur = await this.markDelivering(r.id, { keepFailures: true });
    if (!cur) return;
    let sent: boolean;
    try {
      sent = await this.d.resumeClosed(rec.id, formatReminderLine(cur, rec.id));
    } catch (e) {
      await this.countResumeFailure(cur.id, rec.id, `resume failed: ${errText(e)}`);
      return;
    }
    if (!sent) return this.back(cur.id, "the agent was reopened or live again before its resume");
    this.awaitingStart.set(rec.id, this.now());
    return this.finish(cur.id, rec.id);
  }

  // A turn running, a keystroke in the last 60 s or output in the last 10 s.
  private async busy(id: string): Promise<boolean> {
    const rec = await this.d.agents.load(id);
    if (!rec || rec.status === "running") return true;
    const now = this.now();
    const within = (at: number | undefined, ms: number) => at !== undefined && now - at < ms;
    return within(this.d.io.lastInputAt(id), WORKER_INPUT_QUIET_MS) || within(this.d.io.lastOutputAt(id), OUTPUT_QUIET_MS);
  }

  // The target's session is not up: resume it, unless the reminder is overdue
  // by more than 24 h (failed). A resume this deliverer made that is gone
  // again with no SessionStart counts as a failure first, so a claude that
  // exits at once is not resumed on every tick. True once resumed.
  private async revive(r: Reminder, rec: AgentRecord): Promise<boolean> {
    if (this.now() - r.dueAt > MAX_OVERDUE_MS) {
      await this.fail(r.id, "overdue by more than 24 h and the agent's session is not up");
      return false;
    }
    if (this.awaitingStart.delete(rec.id) && !(await this.countResumeFailure(r.id, rec.id, "the resumed session ended before its SessionStart"))) {
      return false;
    }
    try {
      await this.d.resume(rec);
    } catch (e) {
      await this.countResumeFailure(r.id, rec.id, `resume failed: ${errText(e)}`);
      return false;
    }
    this.awaitingStart.set(rec.id, this.now());
    return true;
  }

  // One more failed resume; MAX_RESUME_FAILURES in a row fail the reminder,
  // else it is (back to) open. True while it stays open.
  private async countResumeFailure(id: string, agentId: string, why: string): Promise<boolean> {
    this.log(`[remind] ${id}: ${agentId}: ${why}`);
    const next = await this.d.store.update(id, (x) => {
      if (x.state !== "open" && x.state !== "delivering") return null;
      const n = (x.resumeFailures ?? 0) + 1;
      return { ...x, resumeFailures: n, lastError: why, state: n >= MAX_RESUME_FAILURES ? "failed" : "open" };
    });
    return next?.state === "open";
  }

  // The resumed agent reached its SessionStart: its count starts again.
  private async clearResumeFailures(agentId: string): Promise<void> {
    await this.d.store.mutateAll((list) => {
      if (!list.some((r) => r.agentId === agentId && r.state === "open" && r.resumeFailures !== undefined)) return null;
      const now = this.now();
      return list.map((r) => {
        if (r.agentId !== agentId || r.state !== "open" || r.resumeFailures === undefined) return r;
        const { resumeFailures: _n, ...rest } = r;
        return { ...rest, updatedAt: now };
      });
    });
  }

  // keepFailures: a closed worker's resume keeps its failure count.
  private markDelivering(id: string, o: { keepFailures?: boolean } = {}): Promise<Reminder | null> {
    return this.d.store.update(id, (x) => {
      if (x.state !== "open") return null;
      const { lastError: _old, resumeFailures: n, ...rest } = x;
      return { ...rest, ...(o.keepFailures && n !== undefined ? { resumeFailures: n } : {}), state: "delivering", attempts: x.attempts + 1 };
    });
  }

  private async finish(id: string, to: string): Promise<void> {
    const now = this.now();
    await this.d.store.update(id, (x) => (x.state === "delivering"
      ? { ...x, state: "delivered", deliveredAt: now, ...(to !== x.agentId ? { deliveredTo: to } : {}) } : null));
  }

  private async back(id: string, why: string): Promise<void> {
    await this.d.store.update(id, (x) => (x.state === "delivering" ? { ...x, state: "open", lastError: why } : null));
  }

  private async fail(id: string, why: string): Promise<void> {
    await this.d.store.update(id, (x) => (x.state === "open" || x.state === "delivering" ? { ...x, state: "failed", lastError: why } : null));
  }

  private async note(id: string, why: string): Promise<void> {
    await this.d.store.update(id, (x) => (x.state === "open" && x.lastError !== why ? { ...x, lastError: why } : null));
  }
}

// index.ts's `resume` dep: the fleet master through ensureFleet and a lead
// through ensureLead (both single-flight, and both hold the agent's inbox
// until its SessionStart); a worker through resumeAgent, under its typing
// lock (the lock a relaunch and the composer's closed-agent resume hold) on
// the record read again there, so a session another path brought back, or a
// worker closed or deleted meanwhile, is left alone.
export function resumeFor(d: {
  agents: Pick<SessionStore, "load">;
  isLive: (id: string) => Promise<boolean>;
  ensureFleet: () => Promise<unknown>;
  ensureLead: (area: string) => Promise<unknown>;
  // The Coordinator's own single-flight start (it holds its inbox too); absent = no Coordinator.
  ensureCoordinator?: () => Promise<unknown>;
  resumeAgent: (rec: AgentRecord) => Promise<unknown>;
}): (rec: AgentRecord) => Promise<unknown> {
  return async (rec) => {
    if (rec.id === FLEET_MASTER_ID) return d.ensureFleet();
    if (rec.kind === "coordinator" && d.ensureCoordinator) return d.ensureCoordinator();
    if (rec.kind === "lead") {
      if (!rec.area) throw new Error(`lead ${rec.id} has no area`);
      return d.ensureLead(rec.area);
    }
    return withTypingLock(rec.id, async () => {
      const cur = await d.agents.load(rec.id);
      if (!cur || cur.closedAt !== undefined || (await d.isLive(rec.id))) return undefined;
      return d.resumeAgent(cur);
    });
  };
}

// index.ts's resumeClosed dep: resumeClosedWithPrompt under the worker's
// typing lock (the lock the composer's closed-agent resume and a relaunch
// hold). True only when the line went out as the first turn of the resumed
// (or cold-started) session: a session another path brought back meanwhile
// ("alive") got no prompt, so false, and the next tick types the line into it.
export function resumeClosedFor(d: ResumeClosedDeps): (agentId: string, line: string) => Promise<boolean> {
  return (agentId, line) => withTypingLock(agentId, async () => {
    let outcome: Awaited<ReturnType<ResumeClosedDeps["resume"]>> | undefined;
    const done = await resumeClosedWithPrompt({ ...d, resume: async (rec, o) => (outcome = await d.resume(rec, o)) }, agentId, line);
    return done && outcome !== "alive";
  });
}
