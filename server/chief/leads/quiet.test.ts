// server/chief/leads/quiet.test.ts — a lead's quiet policy (owner's order of 2026-11-26): one
// test per event kind of the table in quiet.ts, the explained check, and the digest gap.
import { describe, expect, it } from "vitest";
import type { ThreadItem } from "../../agents/thread.js";
import type { AgentRecord } from "../../agents/store.js";
import { EventHub } from "../../events.js";
import { InputTracker } from "../../master/draft.js";
import { EventQueue } from "../../master/events.js";
import { MasterInbox } from "../../master/inbox.js";
import { BLOCKED_ALERT_MS, UserPresence } from "../../master/quiet.js";
import type { QueueItem } from "../queue/types.js";
import { LEAD_DIGEST_GAP_MS, leadDigestGap, leadExplained, messagedInLastTurn } from "./quiet.js";

const LEAD = "lead-app-shop";
const W = "9c0d1e2f-0000-0000-0000-000000000003";
const X = "1a2b3c4d-0000-0000-0000-000000000001";
const flush = () => new Promise((r) => setImmediate(r));

function setup(o: { items?: Partial<QueueItem>[]; messaged?: Set<string>; turn?: ThreadItem[]; failQueue?: boolean } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, add: (ms: number) => { t += ms; } };
  const hub = new EventHub();
  const presence = new UserPresence(clock.now);
  const recs: Record<string, Partial<AgentRecord>> = {
    [W]: { id: W, repo: "/ws/app-shop", spawnedBy: LEAD },
    [X]: { id: X, repo: "/ws/app-shop", spawnedBy: LEAD },
  };
  const agents = { load: async (id: string) => (recs[id] as AgentRecord) ?? null };
  const items = (o.items ?? []) as QueueItem[];
  const queue = { list: async () => { if (o.failQueue) throw new Error("read failed"); return items; } };
  const messaged = o.messaged ?? new Set<string>();
  const q = new EventQueue({
    hub, agents, issues: { list: async () => [] }, acted: { recent: () => false },
    accept: async (r) => r.spawnedBy === LEAD,
    quiet: {
      userPresent: (id) => presence.recent(id),
      queueEcho: async () => true,
      now: clock.now,
      lead: {
        explained: leadExplained({
          agents, queue, messaged: async (r) => (o.turn ? messagedInLastTurn(o.turn) : messaged.has(r.id)),
        }),
      },
    },
  });
  const status = async (agentId: string, s: "running" | "idle" | "done" | "error") => {
    hub.emitEvent({ type: "agent-status", agentId, status: s });
    await flush();
  };
  // As the inbox sees it over two ticks: a due held line is released after its check.
  const digest = async (): Promise<string | null> => {
    q.digest();
    await flush(); await flush();
    return q.digest();
  };
  return { hub, q, clock, presence, status, digest, recs };
}

describe("a lead's digest: waiting", () => {
  it("no line before BLOCKED_ALERT_MS; then one line when the wait is not explained", async () => {
    const { q, clock, status, digest } = setup();
    await q.start();
    await status(W, "idle");
    clock.add(BLOCKED_ALERT_MS - 1);
    expect(await digest()).toBeNull();
    clock.add(1);
    expect(await digest()).toBe("[events] agent-9c0d1e2f app-shop waiting");
  });
  it("no line while the worker holds an open or snoozed queue item of its own; a line with an answered one", async () => {
    for (const [st, line] of [["open", null], ["snoozed", null], ["answered", "[events] agent-9c0d1e2f app-shop waiting"]] as const) {
      const { q, clock, status, digest } = setup({ items: [{ id: "qaaaaaaaa", agentId: W, status: st }, { id: "qbbbbbbbb", agentId: X, status: "open" }] });
      await q.start();
      await status(W, "idle");
      clock.add(BLOCKED_ALERT_MS);
      expect(await digest()).toBe(line);
    }
  });
  it("no line when the worker's last turn sent a message", async () => {
    const { q, clock, status, digest } = setup({ messaged: new Set([W]) });
    await q.start();
    await status(W, "idle");
    clock.add(BLOCKED_ALERT_MS);
    expect(await digest()).toBeNull();
    expect(q.heldCount()).toBe(0);
  });
  it("a send that failed does not explain the wait: the line passes after 15 minutes", async () => {
    const turn = (error: boolean): ThreadItem[] => [
      { kind: "user", id: "u", ts: 1, text: "go" },
      { kind: "step", id: "s", ts: 2, tool: "SendMessage", label: "Message agent-22", end: 3, ...(error ? { error: true } : {}) },
    ];
    for (const [error, line] of [[true, "[events] agent-9c0d1e2f app-shop waiting"], [false, null]] as const) {
      const { q, clock, status, digest } = setup({ turn: turn(error) });
      await q.start();
      await status(W, "idle");
      clock.add(BLOCKED_ALERT_MS);
      expect(await digest()).toBe(line);
    }
  });
  it("held while the user typed to the worker in the last 10 minutes", async () => {
    const { q, clock, presence, status, digest } = setup();
    await q.start();
    await status(W, "idle");
    clock.add(BLOCKED_ALERT_MS - 60_000);
    presence.touch(W);
    clock.add(60_000);
    expect(await digest()).toBeNull();
    expect(q.heldCount()).toBe(1);
  });
  it("a failed check passes the line (the safe side)", async () => {
    const { q, clock, status, digest } = setup({ failQueue: true });
    await q.start();
    await status(W, "idle");
    clock.add(BLOCKED_ALERT_MS);
    expect(await digest()).toBe("[events] agent-9c0d1e2f app-shop waiting");
  });
});

describe("a lead's digest: finished", () => {
  it("a finished worker with no message and no open item is held as a waiting one, then a line", async () => {
    const { q, clock, status, digest } = setup();
    await q.start();
    await status(W, "running");
    await status(W, "done");
    expect(await digest()).toBeNull();
    clock.add(BLOCKED_ALERT_MS);
    expect(await digest()).toBe("[events] agent-9c0d1e2f app-shop finished");
  });
  it("a finished worker that sent a message, or holds a ticket, gives no line", async () => {
    for (const o of [{ messaged: new Set([W]) }, { items: [{ id: "qaaaaaaaa", agentId: W, status: "open" as const }] }]) {
      const { q, clock, status, digest } = setup(o);
      await q.start();
      await status(W, "done");
      clock.add(BLOCKED_ALERT_MS);
      expect(await digest()).toBeNull();
    }
  });
  it("a waiting worker that then ends is held as finished from its end; a resumed one is no line", async () => {
    const { q, clock, status, digest } = setup();
    await q.start();
    await status(W, "idle");
    clock.add(BLOCKED_ALERT_MS - 1);
    await status(W, "done");
    clock.add(1);
    expect(await digest()).toBeNull();
    await status(W, "running");
    clock.add(BLOCKED_ALERT_MS);
    expect(await digest()).toBeNull();
    expect(q.heldCount()).toBe(0);
  });
});

describe("a lead's digest: the other kinds", () => {
  it("pr-opened gives no line", async () => {
    const { q, hub, digest } = setup();
    await q.start();
    hub.emitEvent({ type: "issue", issue: { id: "i1", agentId: W, prUrl: "https://github.com/o/r/pull/1", status: "open" } as never });
    await flush();
    expect(await digest()).toBeNull();
  });
  it("errored, at-limit, model-error and login-out are lines at once, and alerts", async () => {
    const { q, hub, status } = setup();
    await q.start();
    await status(W, "error");
    expect(q.hasAlert()).toBe(true);
    for (const why of ["limit", "model", "login"] as const) hub.emitEvent({ type: "agent-stop", agentId: X, why });
    await flush();
    const d = q.digest()!;
    expect(d.startsWith("[events] agent-9c0d1e2f app-shop errored · ")).toBe(true);
    for (const k of ["at-limit", "model-error", "login-out"]) expect(d).toContain(`agent-1a2b3c4d app-shop ${k} (`);
    q.clear();
    expect(q.hasAlert()).toBe(false);
  });
  it("a worker's queue item is a line, not an alert", async () => {
    const { q } = setup();
    expect(q.addQueueLine("qaaaaaaaa", "choice", "app-shop")).toBe(true);
    expect(q.digest()).toBe("[events] queue qaaaaaaaa choice app-shop");
    expect(q.hasAlert()).toBe(false);
  });
  it("a crashed service never enters a lead's queue", async () => {
    const { q, hub } = setup();
    await q.start();
    hub.emitEvent({ type: "service-status", serviceId: "api", status: "crashed" } as never);
    await flush();
    expect(q.digest()).toBeNull();
  });
});

describe("explained: the worker's last turn", () => {
  const step = (tool: string): Extract<ThreadItem, { kind: "step" }> => ({ kind: "step", id: tool, ts: 1, tool, label: tool });
  const user: ThreadItem = { kind: "user", id: "u", ts: 1, text: "go" };
  const peer: ThreadItem = { kind: "peer", id: "p", ts: 1, text: "review done" };
  it("a SendMessage step after the last given line counts; one before it does not", () => {
    expect(messagedInLastTurn([user, step("Bash"), step("SendMessage")])).toBe(true);
    expect(messagedInLastTurn([step("SendMessage"), peer, step("Bash")])).toBe(false);
    expect(messagedInLastTurn([step("Bash"), step("SendMessage")])).toBe(true);
    expect(messagedInLastTurn([])).toBe(false);
    // A failed send does not count; one with no result in the page does.
    expect(messagedInLastTurn([user, { ...step("SendMessage"), end: 2, error: true }])).toBe(false);
    expect(messagedInLastTurn([user, step("SendMessage")])).toBe(true);
  });
});

describe("a lead's digest gap", () => {
  it("5 minutes between plain digests; a failure line sends the batch at once", async () => {
    let t = 10_000_000;
    const hub = new EventHub();
    const q = new EventQueue({ hub, agents: { load: async () => null }, issues: { list: async () => [] }, acted: { recent: () => false } });
    const sent: string[] = [];
    const inbox = new MasterInbox({
      hub, events: q, tracker: new InputTracker(() => t), now: () => t, agentId: LEAD,
      send: async (text) => { sent.push(text); return true; }, digestGapMs: leadDigestGap(q),
    });
    const stop = () => hub.emitEvent({ type: "agent-hook", agentId: LEAD, event: "Stop" });
    inbox.start("idle", { tickMs: 0 });
    q.addQueueLine("qaaaaaaaa", "pr", "app-shop");
    await inbox.tick();
    expect(sent).toHaveLength(1);
    stop();
    q.addQueueLine("qbbbbbbbb", "choice", "app-shop");
    t += LEAD_DIGEST_GAP_MS - 1;
    await inbox.tick();
    expect(sent).toHaveLength(1);
    q.add({ agentId: W, repo: "app-shop", kind: "errored" });
    await inbox.tick();
    expect(sent).toEqual(["[events] queue qaaaaaaaa pr app-shop", "[events] agent-9c0d1e2f app-shop errored · queue qbbbbbbbb choice app-shop"]);
    stop();
    q.addQueueLine("qcccccccc", "question", "app-shop");
    t += LEAD_DIGEST_GAP_MS - 1;
    await inbox.tick();
    expect(sent).toHaveLength(2);
    t += 1;
    await inbox.tick();
    expect(sent).toHaveLength(3);
    inbox.stop();
  });
});
