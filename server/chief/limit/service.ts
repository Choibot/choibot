// server/chief/limit/service.ts — the usage-limit ticket: one Queue ticket, made by the console,
// that lists each agent that a usage limit of its Claude login blocks now, with quick actions
// (limit/ticket.ts has its data and its words).
//
// sync() keeps the ticket true. It runs at the start, on each event of an agent (a stop, a status,
// a close, a reopen, a delete, a menu that went away), on each write of a limit ticket, and each
// minute (a login's room changes with time). One chain runs it and the presses, so a press sees
// the rows as they are.
//   - The rows: each agent that is not closed and does not work now whose last turn a limit cut
//     (its stop mark, read again from its session file: Claude's own "the limit has reset" clears
//     it; a read that fails keeps the row), each new agent that waits for a login (each login was
//     full), and each agent that the user moved while it was busy, until it moves.
//   - No row: the open ticket closes ("no agent is blocked now").
//   - Rows and no open ticket: a new ticket (a notice). A ticket that closed with no row less than
//     LIMIT_REOPEN_MS ago opens again with no notice (a flap is not a new notice).
//   - A new agent comes to the open ticket: when its notice is older than LIMIT_RENOTIFY_MS, the
//     ticket closes and a new one lists all the rows (one notice). Else the rows change in place.
//   - The user withdrew the ticket: no new ticket until a sync sees no row (limit.quietAt on the
//     withdrawn ticket; the store keeps it, so a restart holds it too).
//
// press() is the user's only (the route is behind gateUser; the Telegram tap counts only from the
// user's own account). It checks all again at press time: the ticket is the open limit ticket, the
// agent is a row of it now, the login is logged in and has room now; right before each act, the
// agent does not work and its block is the row's. "all" takes each row by its own state and says
// how many it took. A second press of the same button does nothing new.
import { createHash } from "node:crypto";
import { DEFAULT_ACCOUNT } from "../../agents/accounts.js";
import { backAt, hasRoom, roomLeft, type LoginUse } from "../../agents/loginuse.js";
import type { StopRead } from "../../agents/stopwhy.js";
import type { AgentRecord } from "../../agents/store.js";
import type { ConsoleEvent } from "../../events.js";
import { onChain } from "../files.js";
import { CONSOLE_AGENT_ID } from "../deploy/ticket.js";
import type { QueueStore } from "../queue/store.js";
import type { QueueItem } from "../queue/types.js";
import {
  LIMIT_ALL, LIMIT_CLOSED, LIMIT_RENOTIFY_MS, LIMIT_REOPEN_MS, LIMIT_REPO, LIMIT_TAG_RE, allText, limitTitle, rowCanContinue, rowCanMove,
  type LimitInfo, type LimitLoginRef, type LimitPress, type LimitRow, type LimitRowState,
} from "./ticket.js";

// A login as the ticket needs it. `name`: as the console shows it (the first part of its e-mail,
// "Main login" or its id). `use`: null when it is not known.
export type LimitLogin = { id: string; name: string; loggedIn: boolean; signedOut: boolean; use: LoginUse | null };

// Continue (agents/api.ts goOnAfterLimit), in the agent's typing lock: the stop mark is read
// again right before the line. sent: the line was typed. running / no-mark / gone: nothing was
// typed (it works, Claude went on by itself, or it is closed). dialog: a menu of Claude is on its
// screen. starting / not-live: its terminal cannot take a line now.
export type GoOnResult = "sent" | "running" | "no-mark" | "gone" | "dialog" | "starting" | "not-live";

// What the agents' side gives (agents/api.ts limitOps).
export type LimitAgents = {
  list(): Promise<AgentRecord[]>;
  load(id: string): Promise<AgentRecord | null>;
  // The stop mark in the session file now; ok false: the file could not be read.
  stopRead(rec: AgentRecord): Promise<StopRead>;
  // Null: the use of the logins is not known here (strong protection): rows with no buttons.
  logins(): Promise<LimitLogin[] | null>;
  move(rec: AgentRecord, login: string): Promise<"resumed" | "cold" | "patched" | "waits">;
  // The agent was moved while it was busy and its relaunch still waits (the relaunch's own list).
  waitsToMove(id: string): boolean;
  goOn(id: string): Promise<GoOnResult>;
  // Calls fn with the id of each agent that is deleted. Returns the stop.
  onRemoved(fn: (id: string) => void): () => void;
};

export type LimitDeps = {
  store: Pick<QueueStore, "add" | "get" | "list" | "withItem" | "write">;
  agents: LimitAgents;
  now?: () => number;
  log?: (s: string) => void;
};

export type PressResult = { code: 200; item: QueueItem; text: string } | { code: 400 | 404 | 409; error: string };

const CHAIN = "limit-ticket";
const SYNC_EVERY_MS = 60_000;
// "Going on" and "Answer its menu first" last this long: then the row is blocked again (the line
// did not make it work, or the menu was answered).
const TRANSIENT_MS = 10 * 60_000;

const isOpen = (i: QueueItem): boolean => i.status === "open" || i.status === "snoozed";
const isLimit = (i: QueueItem): boolean => i.kind === "limit" && i.agentId === CONSOLE_AGENT_ID;
export const tagOf = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 8);
// The console closes a limit ticket with one of LIMIT_CLOSED; any other withdraw is the user's.
const CLOSED_WHYS = new Set<string>(Object.values(LIMIT_CLOSED));
const byUser = (i: QueueItem): boolean => i.status === "withdrawn" && !CLOSED_WHYS.has(i.lastError ?? "");
// The user withdrew it and no sync saw zero rows since: the console adds no limit ticket.
const holds = (i: QueueItem): boolean => byUser(i) && i.limit?.quietAt === undefined;

// The block of an agent now, as a row's key: an agent that waits for a login, or a limit stop.
function keyOf(rec: AgentRecord): string | null {
  if (rec.waitsLogin) return `${rec.id}@w${rec.createdAt}`;
  return rec.stop?.why === "limit" ? `${rec.id}@${rec.stop.at}` : null;
}

// The answer to a press on a ticket that is closed: why it closed.
function closedText(i: QueueItem): string {
  if (i.lastError === LIMIT_CLOSED.none) return "This ticket is closed: no agent on it is blocked now.";
  if (i.lastError === LIMIT_CLOSED.renotified) return "This ticket is closed: a newer ticket lists these agents.";
  if (i.lastError === LIMIT_CLOSED.duplicate) return "This ticket is closed: another ticket lists these agents.";
  return "This ticket is closed: you withdrew it.";
}

// The agent as the console names it (health/api.ts agentName, and the Coordinator).
function nameOf(rec: AgentRecord): string {
  if (rec.kind === "fleet-master") return "Fleet master";
  if (rec.kind === "coordinator") return "Coordinator";
  if (rec.kind === "lead") return `Lead · ${rec.area ?? rec.label}`;
  return rec.label || "Agent";
}
const fallbackName = (login: string): string => (login === DEFAULT_ACCOUNT ? "Main login" : login);

// What the console learnt from a press, by agent: it lasts while the row's key is the same.
type Mark = { key: string; state: Exclude<LimitRowState, "blocked" | "waits-login">; at: number };
type Block = { key: string; state: LimitRowState; since: number };

export class LimitTicket {
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private readonly marks = new Map<string, Mark>();
  private queued = false;

  constructor(private readonly d: LimitDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
  }

  // Subscribes to the hub and to the deletes, syncs now and each minute. Returns the stop.
  start(hub: { subscribe(fn: (e: ConsoleEvent) => void): () => void }): () => void {
    const off = hub.subscribe((e) => {
      if (e.type === "agent-stop" || e.type === "agent-closed" || e.type === "agent-reopened" || (e.type === "agent-status" && !e.quiet)) this.kick();
      else if (e.type === "queue" && e.item.kind === "limit") this.kick();
      // The menu of Claude went away: the row has its Continue again.
      else if (e.type === "agent-prompt" && e.kind === null && this.marks.get(e.agentId)?.state === "answer-menu") {
        this.marks.delete(e.agentId);
        this.kick();
      }
    });
    const offRemoved = this.d.agents.onRemoved((id) => { this.marks.delete(id); this.kick(); });
    const timer = setInterval(() => this.kick(), SYNC_EVERY_MS);
    timer.unref?.();
    this.kick();
    return () => { off(); offRemoved(); clearInterval(timer); };
  }

  // One sync waits on the chain at most: more events meanwhile join it.
  kick(): void {
    if (this.queued) return;
    this.queued = true;
    void onChain(CHAIN, async () => { this.queued = false; await this.syncNow(); })
      .catch((e: unknown) => this.log(`[limit] sync failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  sync(): Promise<void> {
    return onChain(CHAIN, () => this.syncNow());
  }

  press(itemId: string, p: LimitPress): Promise<PressResult> {
    return onChain(CHAIN, () => this.pressNow(itemId, p));
  }

  // ---- the rows ----

  private async blockOf(rec: AgentRecord, now: number): Promise<Block | null> {
    const mark = this.marks.get(rec.id);
    if (mark?.state === "moves-when-quiet") {
      if (this.d.agents.waitsToMove(rec.id)) return { key: mark.key, state: mark.state, since: mark.at };
      this.marks.delete(rec.id);
    }
    const key = keyOf(rec);
    if (rec.waitsLogin) return { key: key!, state: "waits-login", since: rec.createdAt };
    // An agent that works now is not blocked (its turn goes on).
    const stop = rec.stop;
    if (!key || stop?.why !== "limit" || rec.status === "running") return null;
    // The mark of the record, read again: Claude's own "the limit has reset" clears it. A read
    // that fails (no file, an error) keeps the row.
    const read = await this.d.agents.stopRead(rec).catch((): StopRead => ({ ok: false }));
    if (read.ok && read.stop?.why !== "limit") return null;
    const fresh = mark && mark.key === key && now - mark.at < TRANSIENT_MS;
    return { key, state: fresh ? mark.state : "blocked", since: stop.at };
  }

  private async build(prev: LimitInfo | undefined, now: number): Promise<LimitInfo> {
    const { agents } = this.d;
    const recs = (await agents.list()).filter((r) => r.closedAt === undefined && (r.runtime ?? "claude") === "claude");
    const logins = await agents.logins().catch(() => null);
    const order = new Map((prev?.rows ?? []).map((r, i) => [r.agentId, i]));
    const found: { row: LimitRow; since: number }[] = [];
    for (const rec of recs) {
      const b = await this.blockOf(rec, now);
      if (!b) continue;
      const login = rec.account ?? DEFAULT_ACCOUNT;
      const l = logins?.find((x) => x.id === login);
      const use = l && l.loggedIn && !l.signedOut ? l.use : null;
      const waits = b.state === "waits-login";
      found.push({
        since: b.since,
        row: {
          agentId: rec.id, key: b.key, tag: tagOf(b.key), name: nameOf(rec), login, loginName: l?.name ?? fallbackName(login),
          until: waits ? rec.waitsLogin?.until ?? null : use ? backAt(use) : null,
          room: !waits && use !== null && hasRoom(use),
          state: b.state,
        },
      });
    }
    // The marks of agents that are no row now are old.
    const ids = new Set(found.map((f) => f.row.agentId));
    for (const id of [...this.marks.keys()]) if (!ids.has(id)) this.marks.delete(id);
    // The rows keep their place; a new one comes after them, the oldest block first.
    const rank = (f: { row: LimitRow }) => order.get(f.row.agentId) ?? Number.MAX_SAFE_INTEGER;
    found.sort((a, b) => rank(a) - rank(b) || a.since - b.since || (a.row.agentId < b.row.agentId ? -1 : 1));
    const free = (logins ?? []).filter((l): l is LimitLogin & { use: LoginUse } => l.loggedIn && !l.signedOut && l.use !== null && hasRoom(l.use));
    const best = free.sort((a, b) => roomLeft(b.use) - roomLeft(a.use) || (a.id < b.id ? -1 : 1))[0];
    return { rows: found.map((f) => f.row), ...(best ? { to: { id: best.id, name: best.name } } : {}) };
  }

  // ---- the ticket ----

  private async syncNow(): Promise<void> {
    const now = this.now();
    const limits = (await this.d.store.list()).filter(isLimit).sort((a, b) => b.createdAt - a.createdAt);
    const [cur, ...extra] = limits.filter(isOpen);
    for (const x of extra) await this.close(x.id, LIMIT_CLOSED.duplicate);
    const info = await this.build(cur?.limit, now);
    if (cur) {
      if (info.rows.length === 0) { await this.close(cur.id, LIMIT_CLOSED.none); return; }
      const had = new Set((cur.limit?.rows ?? []).map((r) => r.agentId));
      const added = info.rows.some((r) => !had.has(r.agentId));
      if (added && now - cur.createdAt >= LIMIT_RENOTIFY_MS) {
        // The user can withdraw it meanwhile: then the close did nothing, and the withdraw holds.
        if (await this.close(cur.id, LIMIT_CLOSED.renotified)) await this.add(info);
        return;
      }
      return this.update(cur.id, info);
    }
    const last = limits[0];
    // The user withdrew the newest ticket: nothing new until a sync sees no row.
    if (last && holds(last)) {
      if (info.rows.length === 0) await this.endHold(last.id, now);
      return;
    }
    if (info.rows.length === 0) return;
    if (last && last.status === "withdrawn" && last.lastError === LIMIT_CLOSED.none && now - (last.closedAt ?? 0) < LIMIT_REOPEN_MS) {
      return this.reopen(last.id, info);
    }
    await this.add(info);
  }

  private async add(info: LimitInfo): Promise<void> {
    await this.d.store.add({
      kind: "limit", agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" },
      repo: LIMIT_REPO, area: LIMIT_REPO, title: limitTitle(info.rows.length), body: "", blocking: true, limit: info,
    });
  }

  private async update(id: string, info: LimitInfo): Promise<void> {
    const { store } = this.d;
    await store.withItem(id, async () => {
      const item = await store.get(id);
      if (!item || !isOpen(item) || !isLimit(item)) return;
      const title = limitTitle(info.rows.length);
      if (item.title === title && JSON.stringify(item.limit) === JSON.stringify(info)) return;
      await store.write({ ...item, title, limit: info });
    });
  }

  // True: this call closed it (false: it was closed already, by the user or another sync).
  private async close(id: string, why: string): Promise<boolean> {
    const { store } = this.d;
    let closed = false;
    await store.withItem(id, async () => {
      const item = await store.get(id);
      if (!item || !isOpen(item) || !isLimit(item)) return;
      const { snoozedUntil: _ended, ...rest } = item;
      await store.write({ ...rest, status: "withdrawn", lastError: why, closedAt: this.now() });
      closed = true;
    });
    return closed;
  }

  // The user's withdraw holds no more: a sync saw no row.
  private async endHold(id: string, now: number): Promise<void> {
    const { store } = this.d;
    await store.withItem(id, async () => {
      const item = await store.get(id);
      if (!item || !isLimit(item) || !holds(item) || !item.limit) return;
      await store.write({ ...item, limit: { ...item.limit, quietAt: now } });
    });
  }

  private async reopen(id: string, info: LimitInfo): Promise<void> {
    const { store } = this.d;
    await store.withItem(id, async () => {
      const item = await store.get(id);
      if (!item || item.status !== "withdrawn" || item.lastError !== LIMIT_CLOSED.none) return;
      const { closedAt: _c, lastError: _e, ...rest } = item;
      await store.write({ ...rest, status: "open", title: limitTitle(info.rows.length), limit: info });
    });
  }

  // ---- a press ----

  private async pressNow(itemId: string, p: LimitPress): Promise<PressResult> {
    if (p.row !== LIMIT_ALL && !LIMIT_TAG_RE.test(p.row)) return { code: 400, error: "no such row" };
    if (p.act === "move" && typeof p.to !== "string") return { code: 400, error: "a move needs a login" };
    // The rows as they are now.
    await this.syncNow();
    const item = await this.d.store.get(itemId);
    if (!item || !isLimit(item)) return { code: 404, error: "not found" };
    if (!isOpen(item) || !item.limit) return { code: 409, error: closedText(item) };
    const rows = item.limit.rows;
    let to: LimitLoginRef | undefined;
    if (p.act === "move") {
      const logins = await this.d.agents.logins().catch(() => null);
      const l = logins?.find((x) => x.id === p.to);
      if (!l) return { code: 400, error: "no such login" };
      if (!l.loggedIn || l.signedOut) return { code: 409, error: `${l.name} is not logged in now.` };
      if (!l.use || !hasRoom(l.use)) return { code: 409, error: `${l.name} has no room now.` };
      to = { id: l.id, name: l.name };
    }
    const fits = (r: LimitRow): boolean => (to ? rowCanMove(r, to) : rowCanContinue(r));
    let text: string;
    if (p.row === LIMIT_ALL) {
      // Each row is checked again right before its act (one()): a move kills a live terminal,
      // and an agent can work again during the loop.
      let done = 0, skipped = 0;
      for (const r of rows) {
        if (fits(r) && (await this.one(r, to)).ok) done++;
        else skipped++;
      }
      if (done === 0) { await this.syncNow(); return { code: 409, error: "No agent on the ticket fits this now." }; }
      text = allText(p.act, done, skipped, to?.name);
    } else {
      const r = rows.find((x) => x.tag === p.row);
      if (!r) return { code: 409, error: "This agent is not blocked now." };
      if (!fits(r)) return { code: 409, error: r.state === "going-on" ? "It goes on already." : r.state === "moves-when-quiet" ? "It moves when it is quiet already." : "This button does not fit the agent now." };
      const o = await this.one(r, to);
      // A press that did nothing can still change the row (it works now, or a menu is on its
      // screen): the ticket shows that at once.
      if (!o.ok) { await this.syncNow(); return { code: 409, error: o.text }; }
      text = o.text;
    }
    await this.syncNow();
    const after = await this.d.store.get(itemId);
    return { code: 200, item: after ?? item, text };
  }

  // One row: a move to `to`, else Continue. Right before the act: the agent does not work, and
  // its block now is the row's (else the row changed since the ticket was read: it is skipped).
  private async one(r: LimitRow, to: LimitLoginRef | undefined): Promise<{ ok: boolean; text: string }> {
    const { agents } = this.d;
    const rec = await agents.load(r.agentId);
    if (!rec || rec.closedAt !== undefined) return { ok: false, text: "The agent is closed." };
    if (rec.status === "running" || keyOf(rec) !== r.key) return { ok: false, text: "This agent is not blocked now." };
    if (to) {
      try {
        const outcome = await agents.move(rec, to.id);
        this.log(`[limit] the user moved ${rec.id} to the login ${to.id} (${outcome})`);
        if (outcome === "waits") {
          this.marks.set(rec.id, { key: r.key, state: "moves-when-quiet", at: this.now() });
          return { ok: true, text: `It moves to ${to.name} when it is quiet.` };
        }
        this.marks.delete(rec.id);
        return { ok: true, text: `Moved to ${to.name}. The agent goes on.` };
      } catch (e) {
        return { ok: false, text: e instanceof Error ? e.message : "the move did not work" };
      }
    }
    const g = await agents.goOn(rec.id);
    this.log(`[limit] Continue for ${rec.id}: ${g}`);
    switch (g) {
      case "sent":
        this.marks.set(rec.id, { key: r.key, state: "going-on", at: this.now() });
        return { ok: true, text: "The agent goes on." };
      case "dialog":
        this.marks.set(rec.id, { key: r.key, state: "answer-menu", at: this.now() });
        return { ok: false, text: "A menu of Claude is on its screen: answer it first." };
      case "running": case "no-mark":
        // The row goes at the next read of the agent; meanwhile it shows "Going on", with no button.
        this.marks.set(rec.id, { key: r.key, state: "going-on", at: this.now() });
        return { ok: false, text: "It goes on already." };
      case "gone": return { ok: false, text: "The agent is closed." };
      case "starting": return { ok: false, text: "The agent is starting: press again in a moment." };
      case "not-live": return { ok: false, text: "The agent is not live: open it in the console." };
    }
  }
}
