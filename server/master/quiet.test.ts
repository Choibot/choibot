// server/master/quiet.test.ts — the fleet master's quiet policy (order of
// 2026-11-10): the present-user window, the queue echo by kind and by rule
// match, the lead report filter, the failure alerts, and the lines the policy
// never touches.
import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import type { Rule } from "../chief/brain/store.js";
import type { QueueItem } from "../chief/queue/types.js";
import { EventHub } from "../events.js";
import { makeIssue } from "../issues/testkit.js";
import { InputTracker } from "./draft.js";
import { EventQueue } from "./events.js";
import { MasterInbox } from "./inbox.js";
import {
  BLOCKED_ALERT_MS, USER_PRESENT_MS, UserPresence, leadReportIsAlert, masterMayAnswer, masterQueueEcho, quietWindows, ruleCanMatch,
} from "./quiet.js";

const A = "1a2b3c4d-0000-0000-0000-000000000001";
const B = "5e6f7a8b-0000-0000-0000-000000000002";
const W = "9c0d1e2f-0000-0000-0000-000000000003"; // a worker of lead-app-shop
const MIN = 60_000;
const flush = () => new Promise((r) => setImmediate(r));

const rule = (o: Partial<Rule> = {}): Rule => ({
  id: "r_1", text: "t", scope: { area: "*" }, kind: "preference", source: { origin: "panel" },
  state: "active", confidence: 0.9, hits: 0, strikes: 0, createdAt: 1, ...o,
} as Rule);
const item = (o: Partial<QueueItem> = {}): QueueItem => ({
  id: "q00000001", kind: "choice", agentId: A, createdBy: { agentId: A, kind: "worker" }, repo: "app-shop", area: "app-shop",
  title: "t", body: "", createdAt: 1, updatedAt: 1, status: "open", blocking: true, history: [], answerSeq: 0, ...o,
});

// A master EventQueue with the policy on. `rules` and `items` feed the real
// masterQueueEcho; `quiet: false` builds the queue with no policy (flag off).
function setup(o: {
  rules?: Rule[]; items?: QueueItem[]; quiet?: boolean; leadWorker?: boolean;
  recs?: Record<string, Partial<AgentRecord>>;
} = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, add: (ms: number) => { t += ms; } };
  const hub = new EventHub();
  const presence = new UserPresence(clock.now);
  const recs: Record<string, Partial<AgentRecord>> = o.recs ?? {
    [A]: { id: A, repo: "/ws/app-shop" },
    [B]: { id: B, repo: "/ws/indexer" },
    [W]: { id: W, repo: "/ws/app-shop", spawnedBy: "lead-app-shop" },
    "lead-app-shop": { id: "lead-app-shop", kind: "lead", area: "app-shop", repo: "" },
  };
  const agents = { load: async (id: string) => (recs[id] as AgentRecord) ?? null };
  const issues = { list: async () => [] };
  const acted = { recent: () => false };
  const lead = new EventQueue({ hub, agents, issues, acted, accept: async (r) => r.spawnedBy === "lead-app-shop" });
  const logs: string[] = [];
  const items = new Map((o.items ?? []).map((i) => [i.id, i]));
  const q = new EventQueue({
    hub, agents, issues, acted, log: (s) => logs.push(s), cron: true,
    accept: async (r) => r.spawnedBy !== "lead-app-shop",
    leads: { get: (id) => (id === "lead-app-shop" ? lead : undefined) },
    ...(o.quiet === false ? {} : {
      quiet: {
        userPresent: (id: string) => presence.recent(id),
        queueEcho: masterQueueEcho({
          queue: { get: async (id) => items.get(id) ?? null },
          rules: { active: async () => (o.rules ?? []).filter((r) => r.state === "active") },
          log: (s) => logs.push(s),
        }),
        now: clock.now,
      },
    }),
  });
  const status = async (agentId: string, s: "running" | "idle" | "done" | "error") => {
    hub.emitEvent({ type: "agent-status", agentId, status: s });
    await flush();
  };
  // digest() as the inbox sees it over two ticks: a due waiting is released
  // after one record read.
  const digest = async (): Promise<string | null> => {
    q.digest();
    await flush();
    return q.digest();
  };
  return { hub, q, lead, presence, clock, logs, status, digest, recs };
}

describe("UserPresence (the present-user window)", () => {
  it("is recent for USER_PRESENT_MS after a typed key, per agent", () => {
    let t = 0;
    const p = new UserPresence(() => t);
    expect(p.recent(A)).toBe(false);
    p.mark(A, "h");
    expect(p.recent(A)).toBe(true);
    expect(p.recent(B)).toBe(false);
    t = USER_PRESENT_MS - 1;
    expect(p.recent(A)).toBe(true);
    t = USER_PRESENT_MS;
    expect(p.recent(A)).toBe(false);
  });
  it("a composer line (touch) counts as typing", () => {
    let t = 0;
    const p = new UserPresence(() => t);
    p.touch(A);
    t = USER_PRESENT_MS - 1;
    expect(p.recent(A)).toBe(true);
  });
  it("the window is one constant: 10 minutes", () => {
    expect(USER_PRESENT_MS).toBe(10 * MIN);
    expect(BLOCKED_ALERT_MS).toBe(15 * MIN);
  });
  it("the windows are the constants; shorter values count only on a test instance (CHIEF_TEST=1)", () => {
    const short = { CHIEF_TEST_QUIET_PRESENT_MS: "80000", CHIEF_TEST_QUIET_BLOCKED_MS: "120000" };
    expect(quietWindows({})).toEqual({ presentMs: USER_PRESENT_MS, blockedMs: BLOCKED_ALERT_MS });
    expect(quietWindows(short)).toEqual({ presentMs: USER_PRESENT_MS, blockedMs: BLOCKED_ALERT_MS });
    expect(quietWindows({ ...short, CHIEF_TEST: "1" })).toEqual({ presentMs: 80_000, blockedMs: 120_000 });
    expect(quietWindows({ CHIEF_TEST: "1", CHIEF_TEST_QUIET_BLOCKED_MS: "0", CHIEF_TEST_QUIET_PRESENT_MS: "x" }))
      .toEqual({ presentMs: USER_PRESENT_MS, blockedMs: BLOCKED_ALERT_MS });
  });
  it("the browser's own terminal reports are not typing", () => {
    const p = new UserPresence(() => 0);
    p.mark(A, "\x1b[I");       // focus in
    p.mark(A, "\x1b[12;40R");  // cursor position report
    expect(p.recent(A)).toBe(false);
    p.mark(A, "\x1b[I\r");
    expect(p.recent(A)).toBe(true);
  });
});

describe("waiting: an alert only when the agent is blocked and the user is away", () => {
  it("an idle agent adds no line before BLOCKED_ALERT_MS, then one waiting line", async () => {
    const { q, clock, status, digest } = setup();
    await q.start();
    await status(A, "idle");
    expect(q.size()).toBe(0);
    expect(await digest()).toBeNull();
    expect(q.heldCount()).toBe(1);
    clock.add(BLOCKED_ALERT_MS - 1);
    expect(q.size()).toBe(0);
    expect(await digest()).toBeNull();
    clock.add(1);
    expect(q.size()).toBe(1);
    expect(await digest()).toBe("[events] agent-1a2b3c4d app-shop waiting");
    q.clear();
    expect(await digest()).toBeNull();
    expect(q.heldCount()).toBe(0);
  });
  it("an agent deleted while its waiting is held (no status event: it had no live PTY) adds no line", async () => {
    const { q, clock, status, digest, recs } = setup();
    await q.start();
    await status(A, "idle");
    await status(B, "idle");
    delete recs[A];
    clock.add(BLOCKED_ALERT_MS);
    expect(await digest()).toBe("[events] agent-5e6f7a8b indexer waiting");
    expect(q.heldCount()).toBe(0);
  });
  it("no line while the user typed to that agent in the last 10 minutes; the line goes out when the window ends", async () => {
    const { q, clock, presence, status, digest } = setup();
    await q.start();
    await status(A, "idle");
    clock.add(8 * MIN);
    presence.mark(A, "a draft, not sent");
    clock.add(7 * MIN); // idle for 15 min, the user typed 7 min ago
    expect(q.size()).toBe(0);
    expect(await digest()).toBeNull();
    clock.add(3 * MIN - 1); // typed 10 min less 1 ms ago
    expect(await digest()).toBeNull();
    clock.add(1);
    expect(await digest()).toBe("[events] agent-1a2b3c4d app-shop waiting");
  });
  it("the user typing to another agent does not hide this one", async () => {
    const { q, clock, presence, status, digest } = setup();
    await q.start();
    await status(A, "idle");
    clock.add(BLOCKED_ALERT_MS);
    presence.mark(B, "x");
    expect(await digest()).toBe("[events] agent-1a2b3c4d app-shop waiting");
  });
  it("an agent that runs again, ends or fails before the 15 minutes adds no waiting line", async () => {
    const { q, clock, status, digest } = setup();
    await q.start();
    await status(A, "idle");
    clock.add(5 * MIN);
    await status(A, "running");
    expect(q.heldCount()).toBe(0);
    clock.add(BLOCKED_ALERT_MS);
    expect(await digest()).toBeNull();
    await status(A, "idle"); // a new wait starts now
    clock.add(BLOCKED_ALERT_MS - 1);
    expect(await digest()).toBeNull();
    clock.add(1);
    expect(await digest()).toBe("[events] agent-1a2b3c4d app-shop waiting");
  });
  it("a needs-input issue of a waiting agent keeps the first wait time", async () => {
    const { hub, q, clock, status, digest } = setup();
    await q.start();
    await status(A, "idle");
    clock.add(10 * MIN);
    hub.emitEvent({ type: "issue", issue: makeIssue({ id: "i1", agentId: A, status: "needs-input" }) });
    await flush();
    clock.add(5 * MIN);
    expect(await digest()).toBe("[events] agent-1a2b3c4d app-shop waiting");
  });
  it("finished and pr-opened are not alerts: no line", async () => {
    const { hub, q, clock, status, digest } = setup();
    await q.start();
    await status(A, "done");
    hub.emitEvent({ type: "issue", issue: makeIssue({ id: "i1", agentId: B, status: "pr-open", prUrl: "https://github.com/example-org/indexer/pull/7" }) });
    await flush();
    clock.add(BLOCKED_ALERT_MS);
    expect(q.size()).toBe(0);
    expect(await digest()).toBeNull();
  });
  it("a PR whose queue item could not be made is an alert: prWithoutItem adds pr-opened", async () => {
    const { q } = setup();
    await q.prWithoutItem(B, "https://github.com/example-org/indexer/pull/7");
    expect(q.digest()).toBe("[events] agent-5e6f7a8b indexer pr-opened https://github.com/example-org/indexer/pull/7");
  });
});

describe("failure alerts always pass", () => {
  it("an errored agent is in the digest at once, also while the user is present there", async () => {
    const { q, presence, status } = setup();
    await q.start();
    presence.mark(A, "typing");
    await status(A, "error");
    expect(q.digest()).toBe("[events] agent-1a2b3c4d app-shop errored");
  });
  it("an agent that fails while its waiting is held: errored, and no waiting later", async () => {
    const { q, clock, status } = setup();
    await q.start();
    await status(A, "idle");
    await status(A, "error");
    expect(q.digest()).toBe("[events] agent-1a2b3c4d app-shop errored");
    q.clear();
    clock.add(BLOCKED_ALERT_MS);
    expect(q.digest()).toBeNull();
  });
  it("a lead's error passes as lead-errored", async () => {
    const { q, status } = setup();
    await q.start();
    await status("lead-app-shop", "error");
    expect(q.digest()).toBe("[events] lead-errored app-shop");
  });
  it("an alert that arrives while a digest is sent is not cleared with it", async () => {
    const { q, status } = setup();
    await q.start();
    await status(A, "error");
    expect(q.digest()).toBe("[events] agent-1a2b3c4d app-shop errored"); // the inbox now sends this text
    await status(B, "error");                                          // … and B fails meanwhile
    q.clear();
    expect(q.digest()).toBe("[events] agent-5e6f7a8b indexer errored");
  });
  it("an agent that fails again while its errored line is sent keeps the new line", async () => {
    const { q, status } = setup();
    await q.start();
    await status(A, "error");
    q.digest();
    await status(A, "running");
    await status(A, "error");
    q.clear();
    expect(q.digest()).toBe("[events] agent-1a2b3c4d app-shop errored");
  });
  it("a crashed service is an alert; a stopped or running one is not; an unsafe id adds nothing", async () => {
    const { hub, q } = setup();
    await q.start();
    hub.emitEvent({ type: "service-status", serviceId: "share", status: "running" });
    hub.emitEvent({ type: "service-status", serviceId: "share", status: "stopped" });
    hub.emitEvent({ type: "service-status", serviceId: "bad id · x", status: "crashed" });
    await flush();
    expect(q.digest()).toBeNull();
    hub.emitEvent({ type: "service-status", serviceId: "share", status: "crashed", autoRestartDisabled: true });
    hub.emitEvent({ type: "service-status", serviceId: "share", status: "crashed", autoRestartDisabled: true });
    await flush();
    expect(q.digest()).toBe("[events] service share crashed");
  });
  it("every cron run reaches the master (ok and did-not-finish), never a lead", async () => {
    const { hub, q, lead } = setup();
    await q.start();
    await lead.start();
    hub.emitEvent({ type: "cron-run", name: "aws-cost-digest", ok: true, summary: "ok" });
    await flush();
    expect(q.digest()).toBe("[events] cron aws-cost-digest ok");
    q.clear();
    hub.emitEvent({ type: "cron-run", name: "aws-cost-digest", ok: false, summary: "exit 1" });
    await flush();
    expect(q.digest()).toBe("[events] cron aws-cost-digest did-not-finish");
    expect(lead.digest()).toBeNull();
  });
});

describe("queue echo", () => {
  it("masterMayAnswer: choice and question only", () => {
    expect(["pr", "preview", "choice", "question", "deploy"].map((k) => masterMayAnswer(k as QueueItem["kind"]))).toEqual([false, false, true, true, false]);
  });
  it("the console's deploy ticket never reaches the master or a lead, as before (spec §5.7)", async () => {
    const items = [item({ id: "q0000000d", kind: "deploy", agentId: W })];
    const { q, lead, logs } = setup({ rules: [rule()], items });
    await q.addQueue("q0000000d", "deploy" as never, "choibot", W);
    expect(q.digest()).toBeNull();
    expect(lead.digest()).toBeNull();
    expect(logs.join("\n")).toContain("skipped item");
    const echo = masterQueueEcho({ queue: { get: async () => items[0] }, rules: { active: async () => [rule()] } });
    expect(await echo("q0000000d")).toBe(false);
  });
  it("a pr or preview item never reaches the master, with a matching rule too", async () => {
    const items = [item({ id: "q0000000p", kind: "pr" }), item({ id: "q0000000v", kind: "preview" })];
    const { q } = setup({ rules: [rule()], items });
    await q.addQueue("q0000000p", "pr", "app-shop", A);
    await q.addQueue("q0000000v", "preview", "app-shop", A);
    expect(q.digest()).toBeNull();
  });
  it("a choice or question item reaches the master when an active rule can match it", async () => {
    const items = [item({ id: "q0000000c" }), item({ id: "q0000000q", kind: "question" })];
    const { q } = setup({ rules: [rule({ scope: { area: "app-shop" } })], items });
    await q.addQueue("q0000000c", "choice", "app-shop", A);
    await q.addQueue("q0000000q", "question", "app-shop", A);
    expect(q.digest()).toBe("[events] queue q0000000c choice app-shop · queue q0000000q question app-shop");
  });
  it("no line when no rule exists, or when no active rule's scope fits", async () => {
    const items = [item({ id: "q0000000c" })];
    const none = setup({ rules: [], items });
    await none.q.addQueue("q0000000c", "choice", "app-shop", A);
    expect(none.q.digest()).toBeNull();
    const off = setup({ items, rules: [
      rule({ id: "r_a", scope: { area: "indexer" } }),
      rule({ id: "r_b", scope: { area: "*", repo: "indexer" } }),
      rule({ id: "r_c", scope: { area: "*", kind: "question" } }),
      rule({ id: "r_d", state: "candidate" }),
      rule({ id: "r_e", state: "retired" }),
    ] });
    await off.q.addQueue("q0000000c", "choice", "app-shop", A);
    expect(off.q.digest()).toBeNull();
  });
  it("ruleCanMatch: area, repo and kind must all fit; `*` fits every area", () => {
    const i = item();
    expect(ruleCanMatch(rule(), i)).toBe(true);
    expect(ruleCanMatch(rule({ scope: { area: "app-shop", repo: "app-shop", kind: "choice" } }), i)).toBe(true);
    expect(ruleCanMatch(rule({ scope: { area: "indexer" } }), i)).toBe(false);
    expect(ruleCanMatch(rule({ scope: { area: "*", repo: "other" } }), i)).toBe(false);
    expect(ruleCanMatch(rule({ scope: { area: "*", kind: "pr" } }), i)).toBe(false);
    expect(ruleCanMatch(rule({ state: "candidate" }), i)).toBe(false);
  });
  it("an item of a lead is the user's alone: no line", async () => {
    const items = [item({ id: "q0000000l", agentId: "lead-app-shop", repo: "workspace" })];
    const { q } = setup({ rules: [rule()], items });
    await q.addQueue("q0000000l", "choice", "workspace", "lead-app-shop");
    expect(q.digest()).toBeNull();
  });
  it("when the console cannot tell (a failed read, an item not found), the line passes", async () => {
    const { q, logs } = setup({ rules: [], items: [] });
    await q.addQueue("q0000000x", "choice", "app-shop", A); // not in the store
    expect(q.digest()).toBe("[events] queue q0000000x choice app-shop");
    const echo = masterQueueEcho({
      queue: { get: async () => { throw new Error("disk"); } }, rules: { active: async () => [] }, log: (s) => logs.push(s),
    });
    expect(await echo("q0000000y")).toBe(true);
    expect(logs.join("\n")).toContain("queue echo check of q0000000y failed");
  });
  it("the lead's copy of its worker's item does not change: every kind, with no rule", async () => {
    const items = [item({ id: "q0000000p", kind: "pr", agentId: W }), item({ id: "q0000000c", agentId: W })];
    const { q, lead } = setup({ rules: [], items });
    await q.addQueue("q0000000p", "pr", "app-shop", W);
    await q.addQueue("q0000000c", "choice", "app-shop", W);
    expect(q.digest()).toBeNull();
    expect(lead.digest()).toBe("[events] queue q0000000p pr app-shop · queue q0000000c choice app-shop");
  });
  it("the master's own items add no line, as before", async () => {
    const { q } = setup({ rules: [rule()], items: [item({ id: "q0000000m", agentId: "fleet-master" })] });
    await q.addQueue("q0000000m", "choice", "workspace", "fleet-master");
    expect(q.digest()).toBeNull();
  });
});

describe("a lead's queue and the flag-off queue do not change", () => {
  it("a lead still gets its worker's waiting at once, and finished", async () => {
    const { q, lead, status } = setup();
    await q.start();
    await lead.start();
    await status(W, "idle");
    await status(W, "done");
    expect(lead.digest()).toBe("[events] agent-9c0d1e2f app-shop waiting · agent-9c0d1e2f app-shop finished");
    expect(q.digest()).toBeNull();
  });
  it("with no policy (flag off) waiting, finished, pr-opened and every queue kind pass at once; a service crash adds nothing", async () => {
    const { hub, q, status } = setup({ quiet: false });
    await q.start();
    await status(A, "idle");
    await status(A, "done");
    hub.emitEvent({ type: "issue", issue: makeIssue({ id: "i1", agentId: B, status: "pr-open", prUrl: "https://github.com/example-org/indexer/pull/7" }) });
    hub.emitEvent({ type: "service-status", serviceId: "share", status: "crashed" });
    await flush();
    await q.addQueue("q0000000p", "pr", "app-shop", A);
    await q.addQueue("q0000000c", "choice", "app-shop", A);
    expect(q.digest()).toBe(
      "[events] agent-1a2b3c4d app-shop waiting · agent-1a2b3c4d app-shop finished · "
      + "agent-5e6f7a8b indexer pr-opened https://github.com/example-org/indexer/pull/7 · "
      + "queue q0000000p pr app-shop · queue q0000000c choice app-shop",
    );
    expect(q.heldCount()).toBe(0);
  });
});

describe("the lead report filter", () => {
  it("a status report is no alert; a decision, a problem and a report with no mark are", () => {
    expect(leadReportIsAlert("none")).toBe(false);
    expect(leadReportIsAlert("decision")).toBe(true);
    expect(leadReportIsAlert("problem")).toBe(true);
    expect(leadReportIsAlert(undefined)).toBe(true);
  });
});

// The lines the policy never touches reach the master through the inbox's own
// queue (pushConsole, pushTelegram), not through the EventQueue.
describe("never filtered: the user's lines, [queue <id>] answers, [reminder <id>] lines", () => {
  it("all three are sent as they are, with the policy on and nothing in the digest", async () => {
    const { q, hub, status } = setup({ rules: [] });
    await q.start();
    await status(A, "idle"); // held: not in the digest
    const sent: string[] = [];
    const inbox = new MasterInbox({
      hub, events: q, tracker: new InputTracker(), send: async (text) => { sent.push(text); return true; },
    });
    inbox.start("idle", { tickMs: 0 });
    inbox.pushTelegram("please check app-shop");
    await inbox.tick();
    inbox.onHook("Stop");
    const answer = inbox.pushConsole("[queue q0000000m] B\n  with a note", "tab", { msgId: "q0000000m:1" });
    await inbox.tick();
    await answer;
    inbox.onHook("Stop");
    const reminder = inbox.pushConsole("[reminder m_1] check the canary", null, { msgId: "m_1" });
    await inbox.tick();
    await reminder;
    inbox.onHook("Stop");
    await inbox.tick(); // nothing queued, and the digest is empty: no send
    expect(sent).toEqual(["please check app-shop", "[queue q0000000m] B\n  with a note", "[reminder m_1] check the canary"]);
    inbox.stop();
  });
});

describe("the +N older count with the policy on", () => {
  it("does not count an event the digest that is being sent carries", async () => {
    const hub = new EventHub();
    const q = new EventQueue({
      hub, agents: { load: async () => null }, issues: { list: async () => [] }, acted: { recent: () => false }, cap: 2,
      quiet: { userPresent: () => false, queueEcho: async () => true },
    });
    q.add({ agentId: "a", repo: "r", kind: "errored" });
    q.add({ agentId: "b", repo: "r", kind: "errored" });
    expect(q.digest()).toBe("[events] agent-a r errored · agent-b r errored"); // being sent
    q.add({ agentId: "c", repo: "r", kind: "errored" });                       // pushes a out
    q.clear();
    expect(q.digest()).toBe("[events] agent-c r errored");
  });
});
