// server/chief/queue/deliver.ts — the queue Deliverer (spec §5.4): delivers an
// item's two slots, the answer's `delivery` and the `withdrawal`, at least
// once. Every store write runs under the item lock. A worker or lead paste
// runs under it too (item lock → typing lock); a fleet-master line is pushed
// under it and awaited outside it, and its result is written under it again.
// It never calls ActedLog.mark: a mark would hide the agent's real status
// events from the digest for 60 s (§5.4 step 4). A 5 s scanner (start/tick)
// moves slots and items along their timers and closes items, writing the
// `hit`s of an auto answer that passed its undo window (§5.1, §5.5);
// bootScan recovers what a restart left, and retryAgent re-sends an agent's
// `not-live` slots (§5.4 step 5, §5.2).
import { join } from "node:path";
import type { ComposerGate, InputResult } from "../../agents/composer.js";
import type { SessionStore } from "../../agents/store.js";
import type { EventHub } from "../../events.js";
import { BUSY_TIMEOUT_MS, InboxError, type MasterInbox } from "../../master/inbox.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import type { RuleStore } from "../brain/store.js";
import { pruneDrafts } from "./answerImages.js";
import { formatAnswerLine, formatMergedLine, formatWithdrawalLine, isMergedNotice, withdrawalSeq } from "./lines.js";
import { isAgentGone } from "./sections.js";
import type { QueueStore } from "./store.js";
import { isAgentItem, type Answer, type Delivery, type QueueItem } from "./types.js";

export type DelivererDeps = { store: QueueStore; agents: Pick<SessionStore, "load" | "exists">;
  composer: Pick<ComposerGate, "inputInternal">; inbox: Pick<MasterInbox, "pushConsole">; rules: Pick<RuleStore, "hit">;
  hub: Pick<EventHub, "subscribe">; now?: () => number; tickMs?: number; undoMs: number; log?: (s: string) => void };

export const SCAN_MS = 5_000;
export const RETENTION_MS = 30 * 86_400_000;
const PURGE_EVERY_MS = 3_600_000;

type SlotName = "delivery" | "withdrawal";
const SLOTS = ["delivery", "withdrawal"] as const satisfies readonly SlotName[];
type Outcome = "resolved" | "timeout" | "cancelled";
// A master line pushed under the item lock. Boxed, so the lock callback that
// returns it does not wait for the promise.
type Pushed = { slot: SlotName; msgId: string; outcome: Promise<Outcome> };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Order (§5.4): a withdrawal that is not `delivered` goes first and blocks the
// answer; one with `afterMsgId` waits for that master send to settle. Only a
// `pending` slot is sendable, and the answer slot only while `item.answer` is
// set (after an undo its `delivery` is stale, overview decision 32) or while
// it is the merged notice of a pr item closed as merged (decision 60).
function nextSlot(item: QueueItem): SlotName | null {
  const w = item.withdrawal;
  if (w && w.state !== "delivered") return w.state === "pending" && w.afterMsgId === undefined ? "withdrawal" : null;
  return (item.answer || isMergedNotice(item)) && item.delivery?.state === "pending" ? "delivery" : null;
}

// The answer a withdrawal takes back. Its msgId names that answer's seq, and
// history keeps answers in commit order (decision 50), so a later answer
// undone while the withdrawal waited is not taken for it. When that lookup
// misses, the last entry gives the line and the surface, and it counts as an
// auto answer: a closed agent is then never resumed for it (fail closed).
function undoneAnswer(item: QueueItem, msgId: string): Answer | undefined {
  const seq = withdrawalSeq(item, msgId);
  const exact = seq === null ? undefined : item.history[seq - 1];
  if (exact) return exact;
  const last = item.history.at(-1);
  return last && { ...last, by: "master" };
}

// A copy of the item with one slot moved to `state`. `lastError` is kept only
// when given; the withdrawal keeps its `afterMsgId`.
function withSlot(item: QueueItem, name: SlotName, state: Delivery["state"], set: Partial<Delivery> = {}): QueueItem {
  const { lastError: _old, ...prev } = item[name]!;
  const slot = { ...prev, ...set, state };
  return name === "delivery" ? { ...item, delivery: slot } : { ...item, withdrawal: slot };
}

// The agent's record file is gone (spec Q12, decision 37): the item is
// withdrawn, and each slot still waiting to go out fails in the same write,
// so nothing is sent for it again and a withdrawn item never shows in
// Undelivered. A `delivering` slot is left to its in-flight send (a master
// timeout then fails it too, see settle). An item already withdrawn keeps its
// own closedAt and lastError.
function withdrawnGone(item: QueueItem, now: number): QueueItem {
  let next: QueueItem = item.status === "withdrawn" ? item : { ...item, status: "withdrawn", lastError: "agent-gone", closedAt: now };
  for (const name of SLOTS) {
    const state = next[name]?.state;
    if (state && state !== "delivered" && state !== "delivering") next = withSlot(next, name, "failed", { lastError: "agent-gone" });
  }
  return next;
}


// Boot (§5.4 step 5): the in-memory gate dedup and inbox queue are gone. A
// slot left `delivering` may or may not have arrived, so it becomes `unknown`
// and is not re-sent (the tab offers Resend / Mark delivered). A withdrawal
// loses its afterMsgId, since the send it waited for will never settle, and is
// sent as in the "absent" case. `pending` and `held` stay.
function afterRestart(item: QueueItem): QueueItem {
  let next = item;
  for (const name of SLOTS) if (next[name]?.state === "delivering") next = withSlot(next, name, "unknown");
  const w = next.withdrawal;
  if (w?.afterMsgId !== undefined) {
    const { afterMsgId: _lost, ...rest } = w;
    next = { ...next, withdrawal: rest };
  }
  return next;
}

export class Deliverer {
  // Set by start(). Before it (boot, Task 2a-21) kick() only marks the id,
  // and the next tick delivers it.
  private started = false;
  private readonly kicked = new Set<string>();
  private timer?: NodeJS.Timeout;
  private unsub?: () => void;
  private ticking = false;
  private lastPurgeAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly log: (s: string) => void;

  constructor(private readonly d: DelivererDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
  }

  kick(id: string): void {
    if (this.started) this.startDelivery(id);
    else this.kicked.add(id);
  }

  // The scanner: one tick every SCAN_MS (or tickMs), and a `not-live` slot
  // retried on its agent's next agent-status `idle` event (§5.4 step 4, as the
  // relaunch retry of §5.2). Not on `done` or `error`: the session just ended,
  // and a paste would resume an agent the user just closed. Never throws, and
  // its timer does not keep the process alive. Returns stop.
  start(): () => void {
    this.started = true;
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.tick().catch((e) => this.log(`[queue] tick failed: ${errText(e)}`));
      }, this.d.tickMs ?? SCAN_MS);
      this.timer.unref?.();
    }
    this.unsub ??= this.d.hub.subscribe((e) => {
      if (e.type === "agent-status" && e.status === "idle") void this.retryLogged(e.agentId);
    });
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.unsub?.();
      this.unsub = undefined;
    };
  }

  // After reconcileAgents settles and before start() (Task 2a-21): every item
  // through afterRestart, then retryAgent for each id reconcile resumed.
  // Never rejects.
  async bootScan(resumedIds: string[]): Promise<void> {
    try {
      const ids = (await this.d.store.list()).map((i) => i.id);
      await this.eachItem(ids, "boot scan", async (item) => {
        const next = afterRestart(item);
        if (next !== item) await this.d.store.write(next);
        return false;
      });
    } catch (e) {
      this.log(`[queue] boot scan failed: ${errText(e)}`);
    }
    for (const id of resumedIds) await this.retryLogged(id);
  }

  private retryLogged(agentId: string): Promise<void> {
    return this.retryAgent(agentId).catch((e) => this.log(`[queue] retry ${agentId} failed: ${errText(e)}`));
  }

  // That agent's `failed` `not-live` slots go back to `pending`, and those
  // items are delivered (started, not awaited, as in tick). Callers: bootScan,
  // the agent-status subscription, and afterRelaunch (§5.2), which runs it
  // only after the relaunch's typing lock is released: it takes item locks,
  // and the item lock comes before the typing lock (§5.4).
  async retryAgent(agentId: string): Promise<void> {
    const ids = (await this.d.store.list()).filter((i) => i.agentId === agentId).map((i) => i.id);
    const ready = await this.eachItem(ids, "retry", async (item) => {
      if (item.agentId !== agentId) return false;
      let next = item;
      for (const name of SLOTS) {
        const slot = next[name];
        if (slot?.state === "failed" && slot.lastError === "not-live") next = withSlot(next, name, "pending");
      }
      if (next === item) return false;
      await this.d.store.write(next);
      return nextSlot(next) !== null;
    });
    for (const id of ready) this.startDelivery(id);
  }

  // fn on each item, re-read under its own item lock (a missing one is
  // skipped). An item that throws is logged and the loop goes on. Returns the
  // ids for which fn returned true.
  private async eachItem(ids: string[], what: string, fn: (item: QueueItem) => Promise<boolean>): Promise<string[]> {
    const yes: string[] = [];
    for (const id of ids) {
      try {
        const r = await this.d.store.withItem(id, async () => {
          const item = await this.d.store.get(id);
          return item ? fn(item) : false;
        });
        if (r) yes.push(id);
      } catch (e) {
        this.log(`[queue] ${what} of ${id} failed: ${errText(e)}`);
      }
    }
    return yes;
  }

  // One scan of every item, each under its own item lock; an item that throws
  // is logged and the scan goes on. The deliveries start after the scan and
  // are not awaited: a master line can wait minutes in the inbox, and a slot
  // it holds says `delivering`, so the next tick does not pick it again.
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const send = new Set(this.kicked);
      this.kicked.clear();
      try {
        const items = await this.d.store.list();
        const now = this.now();
        const purge = now - this.lastPurgeAt >= PURGE_EVERY_MS;
        if (purge) this.lastPurgeAt = now;
        const ready = await this.eachItem(items.map((i) => i.id), "scan", (item) => this.scan(item, now, purge));
        for (const id of ready) send.add(id);
      } catch (e) {
        this.log(`[queue] scan failed: ${errText(e)}`);
      }
      for (const id of send) this.startDelivery(id);
    } finally {
      this.ticking = false;
    }
  }

  private startDelivery(id: string): void {
    void this.deliver(id).catch((e) => this.log(`[queue] deliver ${id} failed: ${errText(e)}`));
  }

  // One item's scan, under its item lock. True when a slot is ready to send.
  private async scan(read: QueueItem, now: number, purge: boolean): Promise<boolean> {
    const { store, agents } = this.d;
    // Retention (§10): 30 days after closedAt; checked once an hour. A ticket shared outside
    // (share.ts) stays until the user stops sharing it: it holds the page id that Stop sharing needs.
    if (purge && read.closedAt !== undefined && !read.share && now - read.closedAt > RETENTION_MS) {
      await store.remove(read.id);
      return false;
    }
    // An answer image that the user added and never sent goes after a day (answerImages.ts).
    if (purge) await pruneDrafts(join(store.mediaDir, read.id), now).catch((e) => this.log(`[queue] ${read.id}: draft clean-up failed: ${errText(e)}`));
    let item = read;
    if (item.status === "open" || item.status === "snoozed") {
      // The console's own deploy ticket has no agent (spec §5.7): it is never "agent gone".
      if (isAgentItem(item) && !(await agents.exists(item.agentId))) {
        await store.write(withdrawnGone(item, now));
        return false;
      }
      if (item.status === "snoozed" && (item.snoozedUntil ?? 0) <= now) {
        const { snoozedUntil: _woken, ...rest } = item;
        item = { ...rest, status: "open" };
      }
    }
    for (const name of SLOTS) {
      const slot = item[name];
      // The 60 s hold of an auto answer (§5.4 step 6).
      if (slot?.state === "held" && (slot.deliverAfter ?? 0) <= now) item = withSlot(item, name, "pending");
      // No push was made for it, so a record load is the whole re-check. Never
      // on an agent-gone item: its line would reach a master made after the
      // one it was meant for. A withdrawal of an item withdrawn otherwise
      // still goes out (§5.6, "when in doubt the rule is withdraw").
      else if (slot?.state === "failed" && slot.lastError === "no-master" && !isAgentGone(item)
        && (await agents.load(FLEET_MASTER_ID))) {
        item = withSlot(item, name, "pending");
      }
    }
    // An answer closes once delivered and past its undo window (§5.1); an
    // auto answer then earns one `hit` per cited rule. `closedAt` is the
    // once-guard: the hits follow the write that sets it, under this item
    // lock, so a failed write leaves no hit (the next scan tries both again)
    // and an item with `closedAt` never earns them again. A failed hit is
    // logged, never retried: a hit is lost rather than counted twice.
    let hits: string[] = [];
    const a = item.answer;
    if ((item.status === "answered" || item.status === "auto") && item.closedAt === undefined && a
      && item.delivery?.state === "delivered" && now >= a.at + this.d.undoMs) {
      item = { ...item, closedAt: now };
      if (item.status === "auto") hits = [...new Set(a.ruleIds ?? [])];
    }
    if (item !== read) await store.write(item);
    for (const ruleId of hits) {
      try {
        await this.d.rules.hit(ruleId, item.id);
      } catch (e) {
        this.log(`[queue] ${item.id}: hit ${ruleId} failed: ${errText(e)}`);
      }
    }
    return nextSlot(item) !== null;
  }

  // One step: the next sendable slot of this item. The item lock is taken
  // before the first await, so an undo queued right after this call runs only
  // once a master line is in the inbox.
  async deliver(id: string): Promise<void> {
    const pushed = await this.d.store.withItem(id, () => this.step(id));
    if (!pushed) return;
    const outcome = await pushed.outcome;
    await this.d.store.withItem(id, () => this.settle(id, pushed, outcome));
  }

  // Under the item lock.
  private async step(id: string): Promise<Pushed | undefined> {
    const item = await this.d.store.get(id);
    if (!item) return undefined;
    const name = nextSlot(item);
    if (!name) return undefined;
    // The merged notice (decision 60) has no answer: `null` below. It never
    // takes the place of an answer the item still has.
    const notice = name === "delivery" && !item.answer && isMergedNotice(item);
    const answer = notice ? null : name === "delivery" ? item.answer : undoneAnswer(item, item.withdrawal!.msgId);
    if (answer === undefined) {
      // A withdrawal with no answer in history (a hand-edited file): no line
      // to send. `failed` shows it in Undelivered, where Mark delivered frees
      // the answer behind it.
      await this.d.store.write(withSlot(item, name, "failed", { lastError: "no-answer" }));
      return undefined;
    }
    let text: string;
    try {
      text = answer === null ? formatMergedLine(item) : name === "delivery" ? formatAnswerLine(item, answer) : formatWithdrawalLine(item, answer);
    } catch (e) {
      // The formatter refuses the answer (a value it does not know, e.g. a hand-edited file):
      // no line goes out. `failed` shows it in Undelivered; nothing retries it on its own.
      this.log(`[queue] ${id}: no ${name} line: ${errText(e)}`);
      await this.d.store.write(withSlot(item, name, "failed", { lastError: errText(e) }));
      return undefined;
    }
    if (item.agentId === FLEET_MASTER_ID) return this.push(item, name, text, answer);
    await this.paste(item, name, text, answer);
    return undefined;
  }

  // `delivering` (attempts + 1, `at` from the first try), written before the
  // line goes out: the gate's msgId dedup is in memory, so the disk state is
  // the only durable record (§5.4 step 2).
  private async markDelivering(item: QueueItem, name: SlotName): Promise<QueueItem> {
    const slot = item[name]!;
    const next = withSlot(item, name, "delivering", { attempts: slot.attempts + 1, at: slot.at ?? this.now() });
    await this.d.store.write(next);
    return next;
  }

  // Worker or lead (§5.4 steps 3–4), under the item lock. `answer` null: the
  // merged notice of a pr item (decision 60).
  private async paste(item: QueueItem, name: SlotName, text: string, answer: Answer | null): Promise<void> {
    const { store, agents } = this.d;
    if (answer === null || answer.by === "master") {
      // An auto answer, or its withdrawal, must never resume a closed agent,
      // which inputInternal would do. Nor does the merged notice: the user
      // closed that agent, so there is nothing for it to continue. Its slot
      // is dropped (the item stays closed as merged, with no line owed), so a
      // PR merged after its agent was closed never shows in Undelivered.
      const rec = await agents.load(item.agentId);
      if (rec?.closedAt !== undefined) {
        if (answer !== null) return store.write(withSlot(item, name, "failed", { lastError: "agent-closed" }));
        return this.dropNotice(item, "is closed");
      }
      // Null but present: a half-written record, closedAt unknown. Next tick.
      if (!rec && (await agents.exists(item.agentId))) {
        this.log(`[queue] ${item.id}: the record of ${item.agentId} is half-written; the ${answer === null ? "merged" : "auto"} line waits`);
        return;
      }
    }
    const cur = await this.markDelivering(item, name);
    let r: InputResult;
    try {
      r = await this.d.composer.inputInternal(item.agentId, { msgId: cur[name]!.msgId, text });
    } catch (e) {
      // The paste may or may not have happened: Resend or Mark delivered decide.
      return store.write(withSlot(cur, name, "unknown", { lastError: errText(e) }));
    }
    if (r.code === 200) return store.write(withSlot(cur, name, "delivered"));
    if (r.code === 409) {
      return store.write(r.body.reason === "starting"
        ? withSlot(cur, name, "pending")
        : withSlot(cur, name, "failed", { lastError: "not-live" }));
    }
    if (r.code === 400) return store.write(withSlot(cur, name, "failed", { lastError: r.body.error }));
    // 404: the gate checks load() !== null, so a half-written record answers
    // 404 too; only a missing file means the agent is gone (decision 37). Then
    // the item is withdrawn and its slots failed in one write.
    if (await agents.exists(item.agentId)) return store.write(withSlot(cur, name, "pending"));
    if (answer === null) return this.dropNotice(cur, "is gone");
    return store.write(withdrawnGone(withSlot(cur, name, "failed", { lastError: "agent-gone" }), this.now()));
  }

  // The merged notice has no agent to go to, for good: the item stays closed
  // as merged and owes no line.
  private dropNotice(item: QueueItem, why: string): Promise<void> {
    const { delivery: _dropped, ...rest } = item;
    this.log(`[queue] ${item.id}: ${item.agentId} ${why}; no merged line`);
    return this.d.store.write(rest);
  }

  // Fleet master (§5.4 step 3), under the item lock: the push happens here,
  // so an undo that takes the lock next always finds the message in the inbox
  // (cancel never answers "absent" for a slot that says `delivering`).
  private async push(item: QueueItem, name: SlotName, text: string, answer: Answer | null): Promise<Pushed | undefined> {
    if (!(await this.d.agents.load(FLEET_MASTER_ID))) {
      // No push, so no endless 3 min timeout loop; the scanner re-checks.
      await this.d.store.write(withSlot(item, name, "failed", { lastError: "no-master" }));
      return undefined;
    }
    const slot = (await this.markDelivering(item, name))[name]!;
    const p = this.d.inbox.pushConsole(text, answer?.via === "telegram" ? "telegram" : "tab",
      { msgId: slot.msgId, timeoutMs: BUSY_TIMEOUT_MS, since: slot.at });
    // Handled now, so a reject before deliver() awaits it is never unhandled.
    const outcome = p.then((): Outcome => "resolved", (e: unknown): Outcome => {
      if (e instanceof InboxError) return e.reason;
      this.log(`[queue] master push ${slot.msgId} failed: ${errText(e)}`);
      return "timeout";
    });
    return { slot: name, msgId: slot.msgId, outcome };
  }

  // Under the item lock, once a master push settled; three independent steps.
  private async settle(id: string, pushed: Pushed, outcome: Outcome): Promise<void> {
    let item = await this.d.store.get(id);
    if (!item) return;
    let changed = false;
    // The slot that was pushed, only while it still holds that msgId (an undo
    // clears the answer slot). A cancel writes nothing to it. A timeout sends
    // again, except when the master record went while the line was out: the
    // item is then withdrawn agent-gone (withdrawnGone left this slot to its
    // send), and the slot fails as the others did.
    if (item[pushed.slot]?.msgId === pushed.msgId && outcome !== "cancelled") {
      item = outcome === "resolved" ? withSlot(item, pushed.slot, "delivered")
        : isAgentGone(item) ? withSlot(item, pushed.slot, "failed", { lastError: "agent-gone" })
        : withSlot(item, pushed.slot, "pending");
      changed = true;
    }
    // A withdrawal that waits on this answer line, whatever the answer slot
    // holds: a resolve releases it; a cancel (the send returned false) drops
    // it, since the answer never reached the master.
    const w = item.withdrawal;
    if (w?.afterMsgId === pushed.msgId && outcome !== "timeout") {
      if (outcome === "resolved") {
        const { afterMsgId: _done, ...released } = w;
        item = { ...item, withdrawal: released };
      } else {
        const { withdrawal: _dropped, ...rest } = item;
        item = rest;
      }
      changed = true;
    }
    if (changed) await this.d.store.write(item);
  }
}
