// server/coordinator/feed.test.ts — the Coordinator's feed: the digest has one reader, the
// Coordinator starts by itself when work waits, and a cron run or lead report that a restart
// would lose gets its line again at boot.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import { holdOnRelaunch } from "../chief/leads/lead.js";
import { EventHub } from "../events.js";
import { EventQueue } from "../master/events.js";
import { InputTracker } from "../master/draft.js";
import { DIGEST_GAP_MS, MasterInbox } from "../master/inbox.js";
import { HANDOVER_MS, HELLO_WAIT_MS, NO_EVENTS, SEEN_MARGIN_MS, START_RETRY_MS, catchUp, makeCoordinatorFeed, readFeedFile } from "./feed.js";
import { COORDINATOR_ID } from "./paths.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "coordinator-feed-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const NOW = 1_800_000_000_000;
const flush = () => new Promise((r) => setTimeout(r, 20));

function queue(hub = new EventHub()) {
  return new EventQueue({ hub, agents: { load: async () => null }, issues: { list: async () => [] }, acted: { recent: () => false }, cron: true });
}

// `hello`: the session started one time (the default: a healthy Coordinator).
function world(o: { attached?: boolean; hello?: boolean } = {}) {
  let t = NOW;
  const hub = new EventHub();
  const events = queue(hub);
  const typed: string[] = [];
  let attached = o.attached ?? true;
  let starts = 0;
  let dialog = false;
  const terminals = {
    has: (id: string) => id === COORDINATOR_ID && attached,
    hasSession: async () => attached, reattach: async () => null,
    write: (_id: string, data: string) => { typed.push(data); },
  };
  const file = join(dir, "coordinator", "feed.json");
  const feed = makeCoordinatorFeed({
    hub, events, file, now: () => t, log: () => {},
    terminals: terminals as unknown as Parameters<typeof makeCoordinatorFeed>[0]["terminals"],
    ensure: async () => { starts++; attached = true; },
    dialog: async () => dialog,
  });
  if (o.hello ?? true) feed.markHello();
  // The fleet master's inbox beside it, as index.ts builds it with the Coordinator on.
  const masterSent: string[] = [];
  const master = new MasterInbox({
    hub, events: NO_EVENTS, tracker: new InputTracker(() => t), now: () => t,
    send: async (text) => { masterSent.push(text); return true; },
  });
  return {
    hub, events, feed, master, masterSent, typed, file, starts: () => starts, advance: (ms: number) => { t += ms; }, now: () => t,
    setDialog: (v: boolean) => { dialog = v; }, detach: () => { attached = false; },
    hook: (event: string) => hub.emitEvent({ type: "agent-hook", agentId: COORDINATOR_ID, event, ...(event === "SessionStart" ? { source: "startup" } : {}) }),
    digests: () => typed.filter((d) => d.includes("[events]")),
  };
}

describe("one reader for the digest", () => {
  it("50 events: the Coordinator gets them in one digest, the master gets no line", async () => {
    const w = world();
    w.feed.markKnown();
    w.feed.inbox.start("idle", { tickMs: 0 });
    w.master.start("idle", { tickMs: 0 });
    for (let i = 0; i < 25; i++) w.events.add({ agentId: `job-${i}`, repo: "", kind: i % 2 ? "cron-ok" : "cron-failed" });
    for (let i = 0; i < 25; i++) w.events.addQueueLine(`q${String(i).padStart(8, "0")}`, "choice", "app");
    w.advance(DIGEST_GAP_MS);
    await w.feed.inbox.tick();
    await w.master.tick();
    expect(w.masterSent).toEqual([]);
    const pastes = w.typed.filter((d) => d.includes("[events]"));
    expect(pastes).toHaveLength(1);
    expect(pastes[0].match(/cron job-\d+ (ok|did-not-finish)/g)).toHaveLength(25);
    // 20 queue lines per digest (QUEUE_DIGEST_CAP), the other 5 wait for the next one.
    expect(pastes[0].match(/queue q\d{8} choice app/g)).toHaveLength(20);
    w.hub.emitEvent({ type: "agent-hook", agentId: COORDINATOR_ID, event: "Stop" });
    w.advance(DIGEST_GAP_MS);
    await w.feed.inbox.tick();
    await w.master.tick();
    expect(w.typed.filter((d) => d.includes("[events]"))).toHaveLength(2);
    expect(w.events.size()).toBe(0);
    expect(w.masterSent).toEqual([]);
  });

  it("the Coordinator's own ticket and the master's own ticket add no digest line", async () => {
    const events = queue();
    await events.addQueue("q00000001", "question", "workspace", COORDINATOR_ID);
    await events.addQueue("q00000002", "question", "workspace", "fleet-master");
    expect(events.size()).toBe(0);
    await events.addQueue("q00000003", "question", "app", "w1");
    expect(events.digest()).toBe("[events] queue q00000003 question app");
  });

  it("a relaunch holds the Coordinator's inbox, as a lead's and the master's", () => {
    const held: string[] = [];
    const hold = holdOnRelaunch({ fleet: { markStarting: () => held.push("master") }, coordinator: { markStarting: () => held.push("coordinator") } });
    const rec = (kind: AgentRecord["kind"]) => ({ id: "x", kind } as AgentRecord);
    hold(rec("coordinator")); hold(rec("fleet-master")); hold(rec(undefined));
    expect(held).toEqual(["coordinator", "master"]);
  });

  it("NO_EVENTS never has an event", () => {
    expect([NO_EVENTS.size(), NO_EVENTS.digest()]).toEqual([0, null]);
    NO_EVENTS.clear();
  });
});

describe("it starts by itself", () => {
  it("no record and an event waits: one start, then the digest goes out", async () => {
    const w = world({ attached: false });
    w.feed.inbox.start("idle", { tickMs: 0 });
    await w.feed.inbox.tick();
    expect(w.starts()).toBe(0); // nothing waits: no session is made
    w.events.add({ agentId: "nightly", repo: "", kind: "cron-ok" });
    w.advance(DIGEST_GAP_MS);
    expect(w.feed.known()).toBe(false);
    for (let i = 0; i < 3; i++) await w.feed.inbox.tick();
    await flush();
    expect(w.starts()).toBe(1); // one start for the three ticks
    expect(w.feed.known()).toBe(true);
    await w.feed.inbox.tick();
    expect(w.typed.filter((d) => d.includes("[events] cron nightly ok"))).toHaveLength(1);
  });

  it("a start that fails is tried again only after START_RETRY_MS, and the event is kept", async () => {
    let t = NOW;
    let tries = 0;
    const hub = new EventHub();
    const events = queue(hub);
    const feed = makeCoordinatorFeed({
      hub, events, file: join(dir, "feed.json"), now: () => t, log: () => {},
      terminals: { has: () => false, hasSession: async () => false, reattach: async () => null, write: () => {} } as unknown as Parameters<typeof makeCoordinatorFeed>[0]["terminals"],
      ensure: async () => { tries++; throw new Error("no login"); },
    });
    feed.inbox.start("idle", { tickMs: 0 });
    events.add({ agentId: "nightly", repo: "", kind: "cron-failed" });
    for (let i = 0; i < 5; i++) await feed.inbox.tick();
    await flush();
    expect(tries).toBe(1);
    t += START_RETRY_MS;
    await feed.inbox.tick();
    await flush();
    expect(tries).toBe(2);
    expect(events.size()).toBe(1);
  });
});

// The incident of 2026-11-20 on the live console: the Coordinator's first session stopped at
// Claude's folder trust dialog; the digest was typed into the dialog (Enter = "No, exit"), the
// session ended, the digest counted as delivered and nothing started the Coordinator again.
describe("a line is typed only into a session that is ready", () => {
  const withEvent = (o: Parameters<typeof world>[0] = {}) => {
    const w = world(o);
    w.feed.markKnown();
    w.feed.inbox.start("idle", { tickMs: 0 });
    w.events.addLead("lead-report", "app", "lead-app");
    w.advance(DIGEST_GAP_MS);
    return w;
  };

  it("a session that never said hello gets no line: the digest is kept and the mark does not move", async () => {
    const w = withEvent({ hello: false });
    for (let i = 0; i < 3; i++) await w.feed.inbox.tick();
    await flush();
    expect(w.typed).toEqual([]);
    expect(w.events.size()).toBe(1);
    expect(await readFeedFile(w.file)).toEqual({});
    expect(w.feed.blocked()).toBe("starting");
    // Its SessionStart: now the digest goes out, one time.
    w.hook("SessionStart");
    await w.feed.inbox.tick();
    await flush();
    expect(w.digests()).toHaveLength(1);
    expect(w.events.size()).toBe(0);
    expect((await readFeedFile(w.file)).lastDigestAt).toBe(w.now());
    expect(w.feed.blocked()).toBeNull();
  });

  it("a dialog on its screen: no line is typed, also when the session said hello before", async () => {
    const w = withEvent();
    w.setDialog(true);
    for (let i = 0; i < 3; i++) await w.feed.inbox.tick();
    expect(w.typed).toEqual([]);
    expect(w.events.size()).toBe(1);
    expect(w.feed.blocked()).toBe("dialog");
    // Long after: still nothing is typed into the dialog.
    w.advance(10 * HELLO_WAIT_MS);
    await w.feed.inbox.tick();
    expect(w.typed).toEqual([]);
    // The user answered it in the thread.
    w.setDialog(false);
    await w.feed.inbox.tick();
    await flush();
    expect(w.digests()).toHaveLength(1);
    expect(w.feed.blocked()).toBeNull();
  });

  it("a start or a relaunch: the new session must say hello first", async () => {
    const w = withEvent();
    w.feed.starting();
    w.advance(DIGEST_GAP_MS);
    await w.feed.inbox.tick();
    expect(w.typed).toEqual([]);
    expect(w.feed.blocked()).toBe("starting");
    w.hook("SessionStart");
    w.advance(DIGEST_GAP_MS);
    await w.feed.inbox.tick();
    await flush();
    expect(w.digests()).toHaveLength(1);
  });

  it("a hello that was lost: with no dialog the line goes after HELLO_WAIT_MS, not before", async () => {
    const w = withEvent({ hello: false });
    w.advance(HELLO_WAIT_MS - DIGEST_GAP_MS - 1_000);
    await w.feed.inbox.tick();
    expect(w.typed).toEqual([]);
    w.advance(1_000);
    await w.feed.inbox.tick();
    await flush();
    expect(w.digests()).toHaveLength(1);
  });

  it("a session that is not attached here gets no line before it is attached", async () => {
    const w = withEvent({ attached: false });
    await w.feed.inbox.tick(); // this tick starts or reattaches it (the fake attaches at once)
    await flush();
    expect(w.starts()).toBe(1);
    await w.feed.inbox.tick();
    await flush();
    expect(w.digests()).toHaveLength(1);
  });
});

describe("a Coordinator that stopped", () => {
  it("is started again with no event, at most once per START_RETRY_MS", async () => {
    const w = world({ attached: false });
    w.feed.markKnown();
    w.feed.inbox.start("idle", { tickMs: 0 });
    for (let i = 0; i < 3; i++) await w.feed.inbox.tick();
    await flush();
    expect(w.starts()).toBe(1);
    // It ends again.
    w.detach();
    await w.feed.inbox.tick();
    expect(w.starts()).toBe(1);
    w.advance(START_RETRY_MS);
    await w.feed.inbox.tick();
    await flush();
    expect(w.starts()).toBe(2);
  });

  it("with no record and no work nothing is started", async () => {
    const w = world({ attached: false });
    w.feed.inbox.start("idle", { tickMs: 0 });
    await w.feed.inbox.tick();
    expect(w.starts()).toBe(0);
  });
});

describe("the feed file and the catch-up", () => {
  const run = (cron: string, name: string, finishedAt: number, ok = true, result?: { state: string; sentence: string }) => {
    mkdirSync(join(cron, "runs", name), { recursive: true });
    writeFileSync(join(cron, "runs", name, "last.json"), JSON.stringify({ startedAt: finishedAt - 5, finishedAt, exitCode: ok ? 0 : 1, ok, outputTail: "x", ...(result ? { result } : {}) }));
  };
  const report = (leads: string, area: string, at: number) => {
    mkdirSync(join(leads, area), { recursive: true });
    writeFileSync(join(leads, area, "report.md"), "r");
    utimesSync(join(leads, area, "report.md"), at / 1000, at / 1000);
  };

  it("a delivered digest moves the mark to just before its render time", async () => {
    const w = world();
    w.feed.markKnown();
    w.feed.inbox.start("idle", { tickMs: 0 });
    w.events.add({ agentId: "nightly", repo: "", kind: "cron-ok" });
    w.advance(DIGEST_GAP_MS);
    const at = w.now();
    await w.feed.inbox.tick();
    await flush();
    expect(JSON.parse(readFileSync(w.file, "utf8"))).toEqual({ seenAt: at - SEEN_MARGIN_MS, lastDigestAt: at });
    expect(w.feed.lastActivityAt()).toBe(at);
  });

  it("the first start (the hand-over) looks back HANDOVER_MS; the next boot keeps that mark", async () => {
    const cron = join(dir, "cron"), leads = join(dir, "leads"), file = join(dir, "c", "feed.json");
    run(cron, "old", NOW - HANDOVER_MS - 1);
    run(cron, "fresh", NOW - 60_000);
    run(cron, "broken", NOW - 30_000, false);
    // The state of a run's result line goes in its line; a run from before (no result) is `ok`.
    run(cron, "costs", NOW - 20_000, true, { state: "needs-you", sentence: "Costs are up 40%." });
    run(cron, "backup", NOW - 10_000, true, { state: "all-clear", sentence: "Fine." });
    run(cron, "Bad Name", NOW - 1);
    report(leads, "app", NOW - 90_000);
    report(leads, "infra", NOW - HANDOVER_MS - 60_000);
    const events = queue();
    const got = await catchUp({ file, cronDataDir: cron, leadsDir: leads, events, now: () => NOW, log: () => {} });
    expect([got.cron.sort(), got.reports]).toEqual([["backup", "broken", "costs", "fresh"], ["app"]]);
    expect(events.digest()).toBe("[events] cron backup all-clear · cron broken did-not-finish · cron costs needs-you · cron fresh ok · lead-report app");
    expect(await readFeedFile(file)).toEqual({ seenAt: NOW - HANDOVER_MS });
    // A second boot with no digest between: the same lines again, never fewer.
    const again = queue();
    await catchUp({ file, cronDataDir: cron, leadsDir: leads, events: again, now: () => NOW + 3_600_000, log: () => {} });
    expect(again.size()).toBe(5);
  });

  it("after a digest only what is newer than the mark comes back, and missing dirs add nothing", async () => {
    const cron = join(dir, "cron"), file = join(dir, "feed.json");
    writeFileSync(file, JSON.stringify({ seenAt: NOW - 1000, lastDigestAt: NOW - 500 }));
    run(cron, "seen", NOW - 5000);
    run(cron, "missed", NOW - 10);
    const events = queue();
    const got = await catchUp({ file, cronDataDir: cron, leadsDir: join(dir, "none"), events, now: () => NOW, log: () => {} });
    expect(got).toEqual({ since: NOW - 1000, cron: ["missed"], reports: [] });
    expect(await catchUp({ file: join(dir, "x.json"), cronDataDir: join(dir, "no-cron"), leadsDir: join(dir, "none"), events: queue(), now: () => NOW }))
      .toMatchObject({ cron: [], reports: [] });
  });

  it("a Coordinator that never started: the mark of the file is not true; the catch-up looks back from its record", async () => {
    const cron = join(dir, "cron"), leads = join(dir, "leads"), file = join(dir, "feed.json");
    const created = NOW - 10 * 60_000;
    // The digest that ended the session moved the mark to 2 minutes ago; nothing was read.
    writeFileSync(file, JSON.stringify({ seenAt: NOW - 2 * 60_000, lastDigestAt: NOW - 2 * 60_000 }));
    report(leads, "app", created - 60_000);       // in the hand-over window before the record
    run(cron, "nightly", created + 60_000, false); // while the session sat at the dialog
    run(cron, "old", created - HANDOVER_MS - 1);   // before the window
    const events = queue();
    const got = await catchUp({ file, cronDataDir: cron, leadsDir: leads, events, now: () => NOW, log: () => {}, neverStartedSince: created });
    expect(got).toEqual({ since: created - HANDOVER_MS, cron: ["nightly"], reports: ["app"] });
    expect((await readFeedFile(file)).seenAt).toBe(created - HANDOVER_MS);
    // With a session id (it started), the mark of the file holds.
    const again = await catchUp({ file: join(dir, "feed2.json"), cronDataDir: cron, leadsDir: leads, events: queue(), now: () => NOW, log: () => {} });
    expect(again.since).toBe(NOW - HANDOVER_MS);
  });
});
