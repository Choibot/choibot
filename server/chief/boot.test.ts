// server/chief/boot.test.ts — ChiefCore and the chief boot steps (spec §4.4
// misconfigured boot line and fail closed, §5.2 boot relaunch, §3 hardened
// monitor). The core is real (stores in a temp dir); only Telegram and the
// boot callbacks are fakes.
import Fastify, { type FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerGate, registerComposerApi } from "../agents/composer.js";
import type { AgentRecord } from "../agents/store.js";
import { AGENT_DTACH_DIR_RESOLVED } from "../agents/terminal.js";
import { registerChiefApi } from "./api.js";
import { PAIR_TTL_MS, USER_HEADER } from "./auth.js";
import {
  agentRoots, captureDeps, chiefAuthMode, coalesce, deleteExpiredPairMessage, gitIsAncestor, loadCardIndex, makeAutoAnswer, makeChiefCore,
  makeDistillRunner, queueAddDeps, relayQueueAdd, runAgentBoot, runChiefBoot, runChiefPreReconcile, startCardPoster, weekCounts,
  type ChiefCore,
} from "./boot.js";
import { SessionStore } from "../agents/store.js";
import type { RecoveryCtx } from "../agents/recovery.js";
import { AreaStore } from "./leads/areas.js";
import { bootLeads, LeadRuntimes } from "./leads/lead.js";
import { registerBrainApi } from "./brain/api.js";
import { ClassifiedLog, RuleStore, type Rule } from "./brain/store.js";
import { CHIEF_ERR } from "./gate.js";
import type { QueueActions } from "./queue/actions.js";
import type { AddDeps } from "./queue/add.js";
import { registerQueueApi } from "./queue/api.js";
import { acceptMedia } from "./queue/media.js";
import { EventHub, type ConsoleEvent } from "../events.js";
import { CardIndex } from "./cards.js";
import { AuditLog } from "./queue/auto.js";
import { cardRenderHash } from "./queue/poster.js";
import { registerRelaunchRoute, type ChiefRelaunchCtx } from "./relaunch.js";

const LOG = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };
const agents = { load: async () => null };

let dirs: string[] = [];
let app: FastifyInstance | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function dataDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "chief-boot-"));
  dirs.push(d);
  return d;
}

describe("makeChiefCore", () => {
  it("misconfigured env: one boot line, not active, the gate carries the reason", async () => {
    const log = vi.fn();
    const core = makeChiefCore({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_DATA_DIR: await dataDir() }, { agents, log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[chief] misconfigured: CHIEF_CONSOLE_URL is not set");
    expect(core.active).toBe(false);
    expect(core.misconfigured).toBe("CHIEF_CONSOLE_URL is not set");
    expect(core.gate.misconfigured).toBe("CHIEF_CONSOLE_URL is not set");
  });

  it("log env: active, log user auth, paths under CHIEF_DATA_DIR, no boot line", async () => {
    const log = vi.fn();
    const root = await dataDir();
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: root }, { agents, log });
    expect(log).not.toHaveBeenCalled();
    expect(core.active).toBe(true);
    expect(core.misconfigured).toBeNull();
    expect(core.gate.misconfigured).toBeNull();
    expect(core.userAuth).toBe("log");
    expect(core.gate.userAuth).toBe("log");
    expect(core.paths.root).toBe(root);
    expect(core.paths.devices).toBe(join(root, "user-devices.json"));
    expect(core.consoleUrl).toBe("http://127.0.0.1:4999");
  });

  it("telegram env with the Master topic: active, telegram user auth", async () => {
    const core = makeChiefCore({
      CHIEF_ENABLED: "1", CHIEF_CONSOLE_URL: "https://c", CHIEF_DATA_DIR: await dataDir(),
      TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ISSUES_USER_ID: "42", TELEGRAM_MASTER_CHAT_ID: "-100", TELEGRAM_MASTER_THREAD_ID: "2",
    }, { agents, log: vi.fn() });
    expect(core.active).toBe(true);
    expect(core.userAuth).toBe("telegram");
  });

  it("consoleUrl drops a trailing slash, so a link is <origin>/#pair=<code>", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_CONSOLE_URL: "https://console.example.ts.net/", CHIEF_DATA_DIR: await dataDir() }, { agents });
    expect(core.consoleUrl).toBe("https://console.example.ts.net");
  });

  it("exposes the rule store and the classified log at the chief paths, and the tunables", async () => {
    const root = await dataDir();
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: root, CHIEF_DISTILL_AT: "04:15", CHIEF_UNDO_MINUTES: "5" }, { agents });
    expect(core.rules).toBeInstanceOf(RuleStore);
    expect(core.classified).toBeInstanceOf(ClassifiedLog);
    expect(core.classified.file).toBe(join(root, "brain", "classified.jsonl"));
    await core.rules.add({ text: "Use pnpm.", state: "candidate", scope: { area: "*" }, kind: "preference", source: { origin: "panel" } });
    expect(existsSync(join(root, "brain", "rules.jsonl"))).toBe(true);
    expect(core.tunables).toEqual({ undoMs: 300_000, autoThreshold: 0.85, telegramAuto: true, distillAt: "04:15" });
  });

  it("hardened() is false until a monitor is attached, then the monitor's strong()", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    expect(core.hardened()).toBe(false);
    let strong = false;
    core.monitor = { strong: () => strong };
    expect(core.hardened()).toBe(false);
    strong = true;
    expect(core.hardened()).toBe(true);
  });

  it("the queue store lives at <root>/queue; every store write emits {type: \"queue\", item} on the hub", async () => {
    const root = await dataDir();
    const events: ConsoleEvent[] = [];
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: root }, { agents, hub: { emitEvent: (e) => { events.push(e); } } });
    expect(core.queue.dir).toBe(join(root, "queue"));
    const { id } = await core.queue.add({
      kind: "question", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "demo", area: "demo",
      title: "t", body: "b", blocking: true,
    });
    const item = await core.queue.get(id);
    expect(events).toEqual([{ type: "queue", item }]);
    await core.queue.withItem(id, () => core.queue.write({ ...item!, status: "snoozed", snoozedUntil: 1 }));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "queue", item: { id, status: "snoozed" } });
  });

  it("the reminder store lives at <root>/reminders.json; every write emits {type: \"reminders\"} on the hub", async () => {
    const root = await dataDir();
    const events: ConsoleEvent[] = [];
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: root }, { agents, hub: { emitEvent: (e) => { events.push(e); } } });
    expect(core.reminders.path).toBe(join(root, "reminders.json"));
    await core.reminders.add({ agentId: "a1", agentLabel: "a1", setBy: "a1", dueAt: 1, text: "t" });
    expect(events).toEqual([{ type: "reminders" }]);
  });

  it("an expired pairing code deletes its private message through the Telegram client", async () => {
    vi.useFakeTimers();
    const deleteMessage = vi.fn(async (_chatId: number, _messageId: number) => {});
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, {
      agents, onPairExpire: deleteExpiredPairMessage(() => ({ deleteMessage })),
    });
    const { code } = core.pairing.mint("laptop");
    expect(core.pairing.attachMessage(code, 42, 777)).toBe(true);
    vi.advanceTimersByTime(PAIR_TTL_MS - 1);
    expect(deleteMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(42, 777);
    expect(core.pairing.claim(code)).toBeNull();
  });
});

describe("deleteExpiredPairMessage", () => {
  it("no Telegram client or no message: nothing to delete", () => {
    const deleteMessage = vi.fn(async () => {});
    deleteExpiredPairMessage(() => undefined)({ label: "laptop", expiresAt: 0, tg: { chatId: 1, messageId: 2 } });
    deleteExpiredPairMessage(() => ({ deleteMessage }))({ label: "laptop", expiresAt: 0 });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("a failing deleteMessage is logged, never thrown or left unhandled", async () => {
    const log = vi.fn();
    const onExpire = deleteExpiredPairMessage(() => ({ deleteMessage: async () => { throw new Error("message to delete not found"); } }), log);
    expect(() => onExpire({ label: "laptop", expiresAt: 0, tg: { chatId: 1, messageId: 2 } })).not.toThrow();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("[chief] pairing deleteMessage failed: message to delete not found"));
  });
});

describe("runChiefBoot", () => {
  function deferred<T = void>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }
  const flush = () => new Promise<void>((r) => { setImmediate(r); });

  // The boot deps as spies that log their order; each async step waits on its
  // own deferred unless `instant`.
  function steps(instant = false) {
    const order: string[] = [];
    const scan = deferred(), digest = deferred(), relaunch = deferred<unknown>();
    if (instant) { scan.resolve(); digest.resolve(); relaunch.resolve([]); }
    const d = {
      alive: ["a1", "fleet-master"], resumed: ["r1", "r2"], cold: ["c1"],
      startMonitor: vi.fn(() => { order.push("monitor"); }),
      bootScan: vi.fn((ids: string[]) => { order.push(`scan ${ids.join(",")}`); return scan.promise; }),
      startDeliverer: vi.fn(() => { order.push("deliverer"); }),
      requeueDigest: vi.fn(() => { order.push("digest"); return digest.promise; }),
      bootRelaunch: vi.fn((ids: string[]) => { order.push(`relaunch ${ids.join(",")}`); return relaunch.promise; }),
    };
    return { order, d, scan, digest, relaunch };
  }

  it("misconfigured core: starts the monitor and runs no other boot step", async () => {
    const core = makeChiefCore({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_DATA_DIR: await dataDir() }, { agents, log: vi.fn() });
    const { order, d } = steps(true);
    await expect(runChiefBoot(core, d)).resolves.toEqual({ relaunched: false });
    expect(order).toEqual(["monitor"]);
    for (const f of [d.bootScan, d.startDeliverer, d.requeueDigest, d.bootRelaunch]) expect(f).not.toHaveBeenCalled();
  });

  it("active core: monitor, bootScan(resumed + cold), startDeliverer, requeueDigest, bootRelaunch(alive), each after the previous one resolved", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const { order, d, scan, digest, relaunch } = steps();
    const done = runChiefBoot(core, d);
    await flush();
    expect(order).toEqual(["monitor", "scan r1,r2,c1"]);
    expect(d.startDeliverer).not.toHaveBeenCalled();
    scan.resolve();
    await flush();
    expect(order).toEqual(["monitor", "scan r1,r2,c1", "deliverer", "digest"]);
    expect(d.bootRelaunch).not.toHaveBeenCalled();
    digest.resolve();
    await flush();
    expect(order).toEqual(["monitor", "scan r1,r2,c1", "deliverer", "digest", "relaunch a1,fleet-master"]);
    let settled = false;
    void done.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    relaunch.resolve([]);
    await expect(done).resolves.toEqual({ relaunched: true });
    for (const f of [d.startMonitor, d.bootScan, d.startDeliverer, d.requeueDigest, d.bootRelaunch]) expect(f).toHaveBeenCalledTimes(1);
  });

  it("the reminders' boot (scan, then their timers) runs after the queue Deliverer starts and before the digest re-add; misconfigured: never", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const { order, d } = steps(true);
    const rem = deferred();
    const reminders = vi.fn(() => { order.push("reminders"); return rem.promise; });
    const done = runChiefBoot(core, { ...d, reminders });
    await flush();
    expect(order).toEqual(["monitor", "scan r1,r2,c1", "deliverer", "reminders"]);
    rem.resolve();
    await done;
    expect(order).toEqual(["monitor", "scan r1,r2,c1", "deliverer", "reminders", "digest", "relaunch a1,fleet-master"]);
    const off = makeChiefCore({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_DATA_DIR: await dataDir() }, { agents, log: vi.fn() });
    const r2 = vi.fn(async () => {});
    await runChiefBoot(off, { ...steps(true).d, reminders: r2 });
    expect(r2).not.toHaveBeenCalled();
  });
});

// The issue relay's queue hook (Task 2a-17, spec §5.3): a `pr` item for the
// PR an issue agent opened, then its digest line.
describe("relayQueueAdd", () => {
  const PR = { url: "https://github.com/o/demo/pull/7", number: 7 };
  const REC: AgentRecord = {
    id: "a1", label: "a1", repo: "/ws/demo", worktree: "/w", branch: "agent/x", baseBranch: "main",
    sessionId: null, hookToken: "tok-a1", status: "idle", createdAt: 1, kind: "issue", issueId: "i1",
  };
  const STATUS = {
    prState: "OPEN", mergeable: "MERGEABLE", reviewDecision: "", url: PR.url,
    checks: { total: 1, passed: 1, failed: 0, pending: 0, rollup: "success" as const },
  };

  function deps(core: ChiefCore, o: Partial<AddDeps> = {}): AddDeps {
    return {
      store: core.queue, agents: { load: async (id) => (id === "a1" ? REC : null) }, workspaceDir: "/ws", agentRoots: ["/ws"],
      listRepos: async () => [{ name: "demo", slug: "o/demo", path: "/ws/demo" }],
      prStatus: async () => STATUS, isAncestor: async () => false, ...o,
    };
  }

  it("misconfigured core: undefined, so the relay adds no item", async () => {
    const core = makeChiefCore({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_DATA_DIR: await dataDir() }, { agents, log: vi.fn() });
    const addQueue = vi.fn(async () => {});
    expect(relayQueueAdd(core, deps(core), { addQueue })).toBeUndefined();
    expect(await core.queue.list()).toEqual([]);
  });

  it("active core: adds `PR #<n>` with an empty body, created by the relay, then one digest line; a second add of the URL dedups", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const addQueue = vi.fn(async () => {});
    const add = relayQueueAdd(core, deps(core), { addQueue })!;
    // A stale record copy: only its id is used, addItem reloads the record.
    await add({ ...REC, repo: "/stale", baseBranch: "stale" }, PR);
    const [item] = await core.queue.list();
    expect(item).toMatchObject({
      kind: "pr", agentId: "a1", createdBy: { agentId: "a1", kind: "relay" }, repo: "demo", area: "demo",
      title: "PR #7", body: "", blocking: false, status: "open",
      pr: { url: PR.url, number: 7, checks: "success", mergeable: "MERGEABLE" },
    });
    expect(addQueue).toHaveBeenCalledTimes(1);
    expect(addQueue).toHaveBeenCalledWith(item!.id, "pr", "demo", "a1");
    await add(REC, PR);
    expect(await core.queue.list()).toHaveLength(1);
    expect(addQueue).toHaveBeenCalledTimes(1);
  });

  // The master's quiet policy drops pr-opened (the PR has its item). When the item cannot be made, the line is an alert.
  it("an add that fails: the error goes on to the relay, and the master's digest gets the pr-opened line", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const addQueue = vi.fn(async () => {});
    const prWithoutItem = vi.fn(async () => {});
    const add = relayQueueAdd(core, deps(core, { agents: { load: async () => null } }), { addQueue, prWithoutItem })!;
    await expect(add(REC, PR)).rejects.toThrow("unknown agent");
    expect(prWithoutItem).toHaveBeenCalledTimes(1);
    expect(prWithoutItem).toHaveBeenCalledWith("a1", PR.url);
    expect(addQueue).not.toHaveBeenCalled();
    expect(await core.queue.list()).toEqual([]);
    // An add that works adds no pr-opened line.
    const ok = relayQueueAdd(core, deps(core), { addQueue, prWithoutItem })!;
    await ok(REC, PR);
    expect(prWithoutItem).toHaveBeenCalledTimes(1);
  });

  it("a hung gh call is cut at the timeout: the item is stored without checks", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const addQueue = vi.fn(async () => {});
    const hung = () => new Promise<never>(() => {});
    const add = relayQueueAdd(core, deps(core, { prStatus: hung }), { addQueue }, 30)!;
    const t0 = Date.now();
    await add(REC, PR);
    expect(Date.now() - t0).toBeLessThan(2_000);
    const [item] = await core.queue.list();
    expect(item!.pr).toEqual({ url: PR.url, number: 7 });
    expect(addQueue).toHaveBeenCalledTimes(1);

    const add2 = relayQueueAdd(core, deps(core, { listRepos: hung }), { addQueue }, 30)!;
    await add2(REC, { url: "https://github.com/o/demo/pull/8", number: 8 });
    expect((await core.queue.list()).map((i) => i.pr)).toEqual([{ url: PR.url, number: 7 }, { url: "https://github.com/o/demo/pull/8", number: 8 }]);
  });

  it("a rejected addQueue (a throwing record load) is logged; the add still resolves", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const addQueue = vi.fn(async () => { throw new Error("record load failed"); });
    const add = relayQueueAdd(core, deps(core), { addQueue })!;
    await add(REC, PR);
    await vi.waitFor(() => expect(warn.mock.calls.flat().join(" ")).toContain("record load failed"));
    expect(await core.queue.list()).toHaveLength(1);
    warn.mockRestore();
  });

  it("a URL that is not a GitHub PR URL is refused, nothing stored", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const addQueue = vi.fn(async () => {});
    const add = relayQueueAdd(core, deps(core), { addQueue })!;
    await expect(add(REC, { url: "javascript:alert(1)//github.com/o/demo/pull/7", number: 7 })).rejects.toThrow(/pr/);
    expect(await core.queue.list()).toEqual([]);
    expect(addQueue).not.toHaveBeenCalled();
  });
});

describe("queueAddDeps", () => {
  it("the core's queue store, the given agents, workspace and agent roots, the shared git isAncestor helper", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const d = queueAddDeps(core, { agents, workspaceDir: "/ws", agentRoots: ["/ws", "/m/agent"] });
    expect(d.store).toBe(core.queue);
    expect(d.agents).toBe(agents);
    expect(d.workspaceDir).toBe("/ws");
    expect(d.agentRoots).toEqual(["/ws", "/m/agent"]);
    expect(d.isAncestor).toBe(gitIsAncestor);
    expect(d.areaOf).toBeUndefined();
  });

  it("with an AreaStore: areaOf maps a repo to its area; an unreadable areas.json gives the repo", async () => {
    const root = await dataDir();
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: root }, { agents });
    const areas = new AreaStore(core.paths.areas, { exists: async () => true });
    await areas.set("app-shop", { repos: ["demo"] });
    const d = queueAddDeps(core, { agents, workspaceDir: "/ws", agentRoots: ["/ws"], areas });
    expect(await d.areaOf!("demo")).toBe("app-shop");
    expect(await d.areaOf!("other")).toBe("other");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await rm(core.paths.areas);
    await mkdir(core.paths.areas); // EISDIR on read
    expect(await d.areaOf!("demo")).toBe("demo");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

// Task 3-7: the lead boot step, between the fleet master's boot repair and reconcileAgents.
describe("runChiefPreReconcile", () => {
  it("no core, or a misconfigured core: returns [] and never calls leadBoot", async () => {
    const leadBoot = vi.fn(async () => ["lead-app-shop"]);
    expect(await runChiefPreReconcile(undefined, { leadBoot })).toEqual([]);
    const bad = makeChiefCore({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_DATA_DIR: await dataDir() }, { agents, log: vi.fn() });
    expect(bad.active).toBe(false);
    expect(await runChiefPreReconcile(bad, { leadBoot })).toEqual([]);
    expect(leadBoot).not.toHaveBeenCalled();
  });

  it("active core: a dead lead record (status done) gets its runtime with starting: true before it is resumed", async () => {
    const root = await dataDir();
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: root }, { agents });
    const store = new SessionStore(await dataDir());
    const LEAD = "lead-app-shop";
    const agentDir = join(root, "leads", "app-shop", "agent");
    await store.save({
      id: LEAD, label: "Lead · app-shop", kind: "lead", area: "app-shop", repo: "", worktree: agentDir, cwd: agentDir,
      branch: "", baseBranch: "", sessionId: null, hookToken: "t", status: "done", createdAt: 1,
    });
    const areas = new AreaStore(core.paths.areas, { exists: async (id) => (await store.load(id)) !== null });
    await areas.set("app-shop", { repos: ["app-shop"], leadId: LEAD });
    const order: string[] = [];
    const terminals = {
      has: () => false, hasSession: async () => false, reattach: async () => null,
      write: () => {}, inputReady: () => false,
    };
    const hub = new EventHub();
    const runtimes = new LeadRuntimes({
      hub, agents: store, issues: { list: async () => [] }, acted: { recent: () => false }, terminals, areas,
    });
    const ensure = runtimes.ensure.bind(runtimes);
    vi.spyOn(runtimes, "ensure").mockImplementation((id, o) => { order.push(`ensure ${id} ${o.starting}`); return ensure(id, o); });
    const recoveryCtx = {
      port: 0, workspaceDir: "/ws", store,
      claudeHooksPathFor: (rec: AgentRecord) => join(rec.worktree, ".choibot-hooks.json"),
      writeClaudeHookSettings: async () => {},
      terminals: { ...terminals, spawn: (o: { id: string }) => { order.push(`spawn ${o.id}`); } },
    } as unknown as RecoveryCtx;
    const ids = await runChiefPreReconcile(core, {
      leadBoot: () => bootLeads({
        store, recoveryCtx, chiefDir: root, areas, terminals, runtimes, env: {},
        markStarting: (id) => { order.push(`starting ${id}`); runtimes.markStarting(id); },
      }),
    });
    expect(ids).toEqual([LEAD]);
    expect(order).toEqual([`ensure ${LEAD} true`, `starting ${LEAD}`, `spawn ${LEAD}`]);
    expect(runtimes.get(LEAD)!.inbox.turn()).toBe("busy");
    runtimes.stopAll();
  });
});

describe("runAgentBoot", () => {
  const R = { resumed: ["r1"], cold: ["c1"], alive: ["a1"], failed: [] };

  it("runs the cron master retire step, the fleet master, the lead boot, reconcile, then the chief steps, in that order", async () => {
    const order: string[] = [];
    const step = (name: string, v?: unknown) => vi.fn(async () => { order.push(name); return v; });
    const chiefBoot = vi.fn(async (r: unknown, leads: string[]) => { order.push(`chief ${JSON.stringify(r)} ${leads.join(",")}`); });
    await runAgentBoot({
      retireCronMaster: step("cron"), fleetMaster: step("fleet"), preReconcile: step("pre", ["lead-app-shop"]) as () => Promise<string[]>,
      reconcile: step("reconcile", R) as () => Promise<typeof R>, chiefBoot,
    });
    expect(order).toEqual(["cron", "fleet", "pre", "reconcile", `chief ${JSON.stringify(R)} lead-app-shop`]);
  });

  it("a failed step is logged and the next one still runs; a failed reconcile gives the chief step undefined", async () => {
    const order: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = (name: string) => vi.fn(async () => { order.push(name); throw new Error(name); });
    await runAgentBoot({
      retireCronMaster: boom("cron"), fleetMaster: boom("fleet"), preReconcile: boom("pre"), reconcile: boom("reconcile"),
      chiefBoot: async (r, leads) => { order.push(`chief ${String(r)} ${leads.length}`); throw new Error("chief"); },
    });
    expect(order).toEqual(["cron", "fleet", "pre", "reconcile", "chief undefined 0"]);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    error.mockRestore();
  });

  it("the lead ids reach runChiefBoot's bootScan next to reconcile's resumed and cold", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const bootScan = vi.fn(async (_ids: string[]) => {});
    await runAgentBoot({
      retireCronMaster: async () => {}, fleetMaster: async () => {},
      preReconcile: () => runChiefPreReconcile(core, { leadBoot: async () => ["lead-app-shop"] }),
      reconcile: async () => R,
      chiefBoot: (r, leads) => runChiefBoot(core, {
        alive: r?.alive ?? [], resumed: r?.resumed ?? [], cold: r?.cold ?? [], leads,
        bootScan, startDeliverer: () => {}, requeueDigest: async () => {}, bootRelaunch: async () => [], startMonitor: () => {},
      }),
    });
    expect(bootScan).toHaveBeenCalledWith(["r1", "c1", "lead-app-shop"]);
  });
});

// Ruling P3: the dirs an agent's cwd may sit in for preview media.
describe("agentRoots", () => {
  it("weak mode (not hardened): the workspace and the fleet-master agent dir (the retired cron master's is not one)", () => {
    const env = { XDG_DATA_HOME: "/x" };
    expect(agentRoots("/ws", env)).toEqual(["/ws", "/x/choibot/master/agent"]);
  });

  it("MASTER_DATA_DIR moves the master dir; AGENT_WORKTREE_ROOT counts only when absolute", () => {
    const env = { MASTER_DATA_DIR: "/m", CRON_DATA_DIR: "/c" };
    expect(agentRoots("/ws", { ...env, AGENT_WORKTREE_ROOT: "/wt" })).toEqual(["/ws", "/wt", "/m/agent"]);
    expect(agentRoots("/ws", { ...env, AGENT_WORKTREE_ROOT: ".agent-worktrees" })).toEqual(["/ws", "/m/agent"]);
  });

  it("hardened (Task 2c-7): AGENT_HOME_ROOT too; not hardened, never", () => {
    const env = { MASTER_DATA_DIR: "/m", CRON_DATA_DIR: "/c", AGENT_HOME_ROOT: "/h", CHIEF_DATA_DIR: "/k" };
    const hardened = {
      ...env, CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
    };
    expect(agentRoots("/ws", hardened)).toEqual(["/ws", "/m/agent", "/k/leads", "/h"]);
    expect(agentRoots("/ws", env)).toEqual(["/ws", "/m/agent"]);
    expect(agentRoots("/ws", { ...hardened, CHIEF_AGENT_UID: undefined })).toEqual(["/ws", "/m/agent", "/k/leads"]);
  });

  it("chief active (final review minor 1): the leads dir of the chief data dir too, so a not-hardened lead's cwd is accepted; flag off or misconfigured, never", () => {
    const env = { MASTER_DATA_DIR: "/m", CRON_DATA_DIR: "/c", CHIEF_DATA_DIR: "/k" };
    const active = { ...env, CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:1" };
    expect(agentRoots("/ws", active)).toEqual(["/ws", "/m/agent", "/k/leads"]);
    expect(agentRoots("/ws", { ...active, CHIEF_DATA_DIR: undefined, XDG_DATA_HOME: "/x" }))
      .toEqual(["/ws", "/m/agent", "/x/choibot/chief/leads"]);
    expect(agentRoots("/ws", env)).toEqual(["/ws", "/m/agent"]);
    expect(agentRoots("/ws", { ...active, CHIEF_CONSOLE_URL: undefined })).toEqual(["/ws", "/m/agent"]);
  });

  it("chief active, not hardened: a lead's own preview item (cwd <chief>/leads/<area>/agent) is accepted; flag off it is not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roots-lead-"));
    try {
      const cwd = join(dir, "chief", "leads", "app-shop", "agent");
      await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
      const env = { MASTER_DATA_DIR: join(dir, "m"), CRON_DATA_DIR: join(dir, "c"), CHIEF_DATA_DIR: join(dir, "chief") };
      const active = { ...env, CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:1" };
      const ws = join(dir, "ws");
      expect(await acceptMedia({ roots: agentRoots(ws, env), cwd, images: ["a.png"], destDir: join(dir, "media", "off") }))
        .toEqual({ ok: false, error: "agent folder outside the agent roots" });
      expect(await acceptMedia({ roots: agentRoots(ws, active), cwd, images: ["a.png"], destDir: join(dir, "media", "on") }))
        .toEqual({ ok: true, names: ["1.png"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// `git merge-base --is-ancestor`: exit 0 → true, exit 1 → false, any other
// error rejects (it must never read as either answer).
describe("gitIsAncestor", () => {
  async function repo(): Promise<string> {
    const dir = await dataDir();
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "a");
    git("checkout", "-q", "-b", "feat");
    await writeFile(join(dir, "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "b");
    return dir;
  }

  it("true when the branch is in the base, false when it has commits the base lacks", async () => {
    const dir = await repo();
    await expect(gitIsAncestor(dir, "main", "feat")).resolves.toBe(true);
    await expect(gitIsAncestor(dir, "feat", "main")).resolves.toBe(false);
  });

  it("rejects on a bad ref, a missing repo, or a ref that starts with -", async () => {
    const dir = await repo();
    await expect(gitIsAncestor(dir, "no-such-branch", "main")).rejects.toThrow();
    await expect(gitIsAncestor(join(dir, "missing"), "feat", "main")).rejects.toThrow();
    await expect(gitIsAncestor(dir, "--help", "main")).rejects.toThrow(/-/);
    await expect(gitIsAncestor(dir, "feat", "-main")).rejects.toThrow(/-/);
  });
});

// The Queue header's week line (spec §8b): the 1b metrics fold for the
// current ISO week.
describe("weekCounts", () => {
  it("counts this ISO week's decisions and corrections only", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const now = Date.UTC(2026, 10, 11, 12); // Wednesday, 2026-W46
    await core.decisions.append({ at: now - 60_000, via: "queue-tab", by: "user", text: "x", correction: true });
    await core.decisions.append({ at: now - 2 * 86_400_000, via: "queue-tab", by: "user", text: "y", correction: false });
    await core.decisions.append({ at: now - 8 * 86_400_000, via: "queue-tab", by: "user", text: "z", correction: true });
    await expect(weekCounts(core, now)).resolves.toEqual({ decisions: 2, corrections: 1 });
  });

  it("no decision log: zeros", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    await expect(weekCounts(core)).resolves.toEqual({ decisions: 0, corrections: 0 });
  });
});

// The core's gate drives every chief route group index.ts registers: 503 in
// misconfigured mode, the normal answers otherwise.
describe("chief routes on the core's gate", () => {
  async function routes(env: Record<string, string>) {
    const core = makeChiefCore({ ...env, CHIEF_DATA_DIR: await dataDir() }, { agents, log: vi.fn() });
    app = Fastify();
    registerChiefApi(app, { gate: core.gate, pairing: core.pairing, devices: core.devices, consoleUrl: core.consoleUrl });
    registerBrainApi(app, { gate: core.gate, devices: core.devices, decisions: core.decisions, surface: () => "tab" });
    registerRelaunchRoute(app, { gate: core.gate, ctx: {} as ChiefRelaunchCtx, retry: { arm: () => {} } });
    registerQueueApi(app, {
      gate: core.gate, undoMs: core.tunables.undoMs, store: core.queue, actions: {} as QueueActions,
      add: async () => { throw new Error("no add here"); }, events: { addQueue: async () => {} }, agents,
      weekMetrics: () => weekCounts(core), hardened: () => core.hardened(), prWatch: { refreshSoon: () => {} },
      previewEnabled: false,
    });
    await app.ready();
    return {
      claim: () => app!.inject({ method: "POST", url: "/api/chief/pair/claim", payload: { code: "junk" } }),
      devices: () => app!.inject({ method: "GET", url: "/api/brain/devices" }),
      relaunch: () => app!.inject({ method: "POST", url: "/api/agents/a1/relaunch", payload: {} }),
      queue: () => app!.inject({ method: "GET", url: "/api/queue" }),
      snooze: () => app!.inject({ method: "POST", url: "/api/queue/q12345678/snooze", payload: { minutes: 10 } }),
    };
  }

  it("misconfigured: every route answers 503 chief-misconfigured", async () => {
    const r = await routes({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log" });
    for (const res of [await r.claim(), await r.devices(), await r.relaunch(), await r.queue(), await r.snooze()]) {
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: CHIEF_ERR.misconfigured });
    }
  });

  it("active log mode: a junk code is 410, USER routes ask to pair, the queue list answers any session", async () => {
    const r = await routes(LOG);
    expect((await r.claim()).statusCode).toBe(410);
    for (const res of [await r.devices(), await r.relaunch(), await r.snooze()]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: CHIEF_ERR.pairRequired, userAuth: "log" });
    }
    const q = await r.queue();
    expect(q.statusCode).toBe(200);
    expect(q.json()).toMatchObject({
      items: [], counts: { open: 0, auto: 0, undelivered: 0 }, metrics: { week: { decisions: 0, corrections: 0 } },
      undoMs: 600_000, hardened: false, userAuth: "log",
    });
  });
});

// The chief's capture of user lines (spec §6.2 sources 1–2) fails closed:
// a misconfigured core gets no capture deps, so nothing is captured (§4.4).
describe("captureDeps", () => {
  const REC: AgentRecord = {
    id: "a1", label: "a1", repo: "/ws/choibot", worktree: "/w", branch: "agent/x", baseBranch: "main",
    sessionId: null, hookToken: "tok-a1", status: "idle", createdAt: 1, prUrl: "https://github.com/o/choibot/pull/7",
  };
  const recs = { load: async (id: string) => (id === "a1" ? REC : null) };

  // A live PTY that takes every paste.
  function terms() {
    const writes: string[] = [];
    return {
      writes,
      has: () => true, hasSession: async () => true, reattach: async () => null,
      write: (_id: string, d: string) => { writes.push(d); }, inputReady: () => true,
    };
  }

  async function composer(core: ChiefCore, cards: Rule[] = []) {
    const t = terms();
    app = Fastify();
    registerComposerApi(app, new ComposerGate({ terminals: t, agentExists: async () => true, sleep: async () => {} }),
      captureDeps(core, { agents: recs, onCandidate: async (r) => { cards.push(r); } })?.composer);
    await app.ready();
    const token = await core.devices.add("laptop");
    return {
      t,
      post: (text: string, msgId: string, headers: Record<string, string> = { [USER_HEADER]: token }) =>
        app!.inject({ method: "POST", url: "/api/agents/a1/input", payload: { msgId, text }, headers }),
    };
  }

  it("misconfigured core: undefined; a USER composer line is delivered and writes no decision line", async () => {
    const core = makeChiefCore({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_DATA_DIR: await dataDir() }, { agents, log: vi.fn() });
    expect(captureDeps(core, { agents: recs, onCandidate: async () => {} })).toBeUndefined();
    const c = await composer(core);
    const r = await c.post("rule: always run tests", "msg-00001");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ delivered: true });
    expect(c.t.writes).toEqual(["\x1b[200~rule: always run tests\x1b[201~", "\r"]);
    expect(await core.decisions.read()).toEqual([]);
    expect(await core.rules.all()).toEqual([]);
  });

  it("active core: a USER composer line → one decision line; a headerless line → none", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const c = await composer(core);
    expect((await c.post("use pnpm here", "msg-00001")).json()).toEqual({ delivered: true });
    expect((await c.post("not the user", "msg-00002", {})).json()).toEqual({ delivered: true });
    expect((await core.decisions.read()).map(({ at: _at, ...l }) => l)).toEqual([
      { by: "user", correction: null, via: "composer", agentId: "a1", prUrl: REC.prUrl, repo: "choibot", text: "use pnpm here" },
    ]);
  });

  it("active core: a USER `rule:` line makes a candidate and posts its card; `line` captures a reply", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    const cards: Rule[] = [];
    const c = await composer(core, cards);
    expect((await c.post("rule: always run tests", "msg-00001")).json()).toEqual({ delivered: true });
    const [rule] = await core.rules.all();
    expect(rule).toMatchObject({ text: "always run tests", state: "candidate", source: { origin: "user-line", via: "composer", agentId: "a1" } });
    await vi.waitFor(() => expect(cards.map((r) => r.id)).toEqual([rule!.id]));

    const deps = captureDeps(core, { agents: recs, onCandidate: async () => {} })!;
    await expect(deps.line({ text: "ship it", via: "issue-telegram", agentId: "a1" })).resolves.toEqual({});
    expect((await core.decisions.read()).at(-1)).toMatchObject({ by: "user", via: "issue-telegram", agentId: "a1", text: "ship it" });
  });
});

describe("makeDistillRunner", () => {
  const MIN = 60_000;
  it("arms the first distill slot at the core's CHIEF_DISTILL_AT (host TZ)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir(), CHIEF_DISTILL_AT: "04:15" }, { agents });
    const now = new Date(2026, 10, 9, 4, 0, 0, 0).getTime();
    const timers: { ms: number; cleared: boolean }[] = [];
    const envelope = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "NONE" });
    const runner = makeDistillRunner(core, {
      run: async () => ({ code: 0, stdout: envelope, stderr: "" }), claudeBin: "/bin/claude", env: {},
      hub: { emitEvent() {} }, notify: () => {}, onProposal: async () => {}, now: () => now,
      setTimer: (_fn, ms) => { const t = { ms, cleared: false }; timers.push(t); return { clear: () => { t.cleared = true; } }; },
    });
    const stop = runner.start();
    await vi.waitFor(() => expect(timers.map((t) => t.ms)).toEqual([15 * MIN]));
    expect(runner.status()).toEqual({ enabled: true });
    stop();
    expect(timers[0]!.cleared).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("AGENT_DTACH_DIR_RESOLVED", () => {
  it("is the dtach dir the TerminalManager uses (AGENT_DTACH_DIR from the test setup)", () => {
    expect(AGENT_DTACH_DIR_RESOLVED).toBe(process.env.AGENT_DTACH_DIR);
  });
});

// Phase 2b wiring (Task 2b-13): the auth mode, the card index rebuild, the
// AutoAnswer on the core and the card poster.
const TG_ENV = {
  CHIEF_ENABLED: "1", CHIEF_CONSOLE_URL: "https://c", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ISSUES_USER_ID: "42",
  TELEGRAM_MASTER_CHAT_ID: "-100", TELEGRAM_MASTER_THREAD_ID: "2",
};
const WORKER_REC = { id: "a1", label: "a1", repo: "/ws/demo", worktree: "/w", branch: "agent/x", baseBranch: "main",
  sessionId: null, hookToken: "tok-a1", status: "idle", createdAt: 1 } as AgentRecord;
const workerAgents = { load: async (id: string) => (id === "a1" ? WORKER_REC : null) };
const CHOICE_ITEM = {
  kind: "choice" as const, agentId: "a1", createdBy: { agentId: "a1", kind: "worker" as const }, repo: "demo", area: "demo",
  title: "Pick", body: "b", blocking: true, choice: { options: [{ key: "A", label: "a" }, { key: "B", label: "b" }] },
};
const MASTER_CALLER = { level: "master" as const, agentHeaders: true, agentId: "fleet-master", kind: "fleet-master" as const };

describe("chiefAuthMode", () => {
  it("log user auth: log; telegram: weak until the hardened monitor says strong, then hardened", async () => {
    expect(chiefAuthMode(makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents }))).toBe("log");
    const core = makeChiefCore({ ...TG_ENV, CHIEF_DATA_DIR: await dataDir() }, { agents, log: vi.fn() });
    expect(chiefAuthMode(core)).toBe("weak");
    let strong = true;
    core.monitor = { strong: () => strong };
    expect(chiefAuthMode(core)).toBe("hardened");
    strong = false;
    expect(chiefAuthMode(core)).toBe("weak");
  });
});

describe("loadCardIndex", () => {
  it("spec §8 (b): cards.json plus every item's card, media and extra message ids (cardIdsOf)", async () => {
    const core = makeChiefCore({ ...LOG, CHIEF_DATA_DIR: await dataDir() }, { agents });
    await mkdir(dirname(core.paths.cards), { recursive: true });
    await writeFile(core.paths.cards, JSON.stringify({ 5: { ruleId: "r_aaaaa", textSha256: "x", at: 1 } }));
    const { id } = await core.queue.add(CHOICE_ITEM);
    const { id: bare } = await core.queue.add({ ...CHOICE_ITEM, title: "other" });
    await core.queue.withItem(id, async () => {
      await core.queue.write({ ...(await core.queue.get(id))!, telegram: { cardMessageId: 11, mediaMessageIds: [9, 10], extraMessageIds: [12] } });
    });
    const cards = new CardIndex(core.paths.cards);
    await loadCardIndex(core, cards);
    for (const m of [9, 10, 11, 12]) expect(cards.lookup(m)).toMatchObject({ kind: "item", itemId: id });
    expect(cards.lookup(5)).toMatchObject({ kind: "rule", ruleId: "r_aaaaa" });
    expect(cards.lookup(13)).toBeUndefined();
    expect(bare).not.toBe(id);
  });

  it("a failed queue read is logged once; cards.json still loads", async () => {
    const root = await dataDir();
    const file = join(root, "cards.json");
    await writeFile(file, JSON.stringify({ 5: { ruleId: "r_aaaaa", textSha256: "x", at: 1 } }));
    const log = vi.fn();
    const cards = new CardIndex(file);
    await loadCardIndex({ queue: { list: async () => { throw new Error("EIO"); } } }, cards, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("EIO");
    expect(cards.lookup(5)).toMatchObject({ kind: "rule" });
  });
});

describe("makeAutoAnswer", () => {
  async function setup(env: Record<string, string>, via: "telegram" | "tab") {
    const core = makeChiefCore({ ...env, CHIEF_DATA_DIR: await dataDir() }, { agents, log: vi.fn() });
    const { rule } = await core.rules.add({ text: "demo picks B", state: "active", scope: { area: "*" }, kind: "preference",
      source: { origin: "panel" }, confidence: 0.95 });
    if (via === "telegram") await core.rules.confirm(rule.id, { via: "telegram", confidence: 0.95 });
    const { id } = await core.queue.add(CHOICE_ITEM);
    const audit = new AuditLog(core.paths.auditAuto);
    const onAuto = vi.fn();
    const kick = vi.fn();
    const auto = makeAutoAnswer(core, { agents: workerAgents, audit, deliverer: { kick }, onAuto, log: () => {} });
    return { core, rule, id, audit, onAuto, kick, auto };
  }

  it("log mode: an --auto that passes every earlier check is downgraded with `log mode: auto-answer off`", async () => {
    const t = await setup(LOG, "telegram");
    const r = await t.auto.apply(t.id, { value: "B", auto: true, ruleIds: [t.rule.id], confidence: 0.95 }, MASTER_CALLER);
    expect(r).toMatchObject({ code: 200, downgraded: "log mode: auto-answer off" });
    expect((await t.core.queue.get(t.id))!.status).toBe("open");
    expect(t.onAuto).not.toHaveBeenCalled();
    expect(existsSync(t.core.paths.auditAuto)).toBe(false);
  });

  it("weak mode: a Telegram-confirmed rule applies with the core's undo window; onAuto gets the item", async () => {
    const t = await setup({ ...TG_ENV, CHIEF_UNDO_MINUTES: "5" }, "telegram");
    const r = await t.auto.apply(t.id, { value: "B", auto: true, ruleIds: [t.rule.id], confidence: 0.95 }, MASTER_CALLER);
    expect(r).toMatchObject({ code: 200 });
    expect(r).not.toHaveProperty("downgraded");
    const item = (await t.core.queue.get(t.id))!;
    expect(item).toMatchObject({ status: "auto", answer: { value: "B", by: "master" }, delivery: { state: "held" } });
    const [line] = JSON.parse(`[${(await readFile(t.core.paths.auditAuto, "utf8")).trim()}]`) as { at: number; undoUntil: number }[];
    expect(line!.undoUntil - line!.at).toBe(300_000);
    expect(t.onAuto).toHaveBeenCalledWith(item);
    expect(t.kick).toHaveBeenCalledWith(t.id);
  });

  it("weak mode: a tab-confirmed rule is downgraded; CHIEF_AUTO_THRESHOLD is the request bar", async () => {
    const tab = await setup(TG_ENV, "tab");
    const r1 = await tab.auto.apply(tab.id, { value: "B", auto: true, ruleIds: [tab.rule.id], confidence: 0.95 }, MASTER_CALLER);
    expect(r1).toMatchObject({ code: 200, downgraded: `rule ${tab.rule.id} was not confirmed on Telegram` });
    const t = await setup({ ...TG_ENV, CHIEF_AUTO_THRESHOLD: "0.97" }, "telegram");
    const r2 = await t.auto.apply(t.id, { value: "B", auto: true, ruleIds: [t.rule.id], confidence: 0.95 }, MASTER_CALLER);
    expect(r2).toMatchObject({ code: 200, downgraded: "request confidence < 0.97" });
  });
});

describe("startCardPoster", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const CFG = { chatId: -100, threadId: 2, userId: 42 };

  function fakeTg() {
    let next = 100;
    const sent = () => Promise.resolve({ message_id: next++ });
    return {
      sendMessage: vi.fn((..._a: unknown[]) => sent()), sendPhoto: vi.fn((..._a: unknown[]) => sent()),
      sendMediaGroup: vi.fn(async (_c: unknown, files: unknown[]) => files.map(() => ({ message_id: next++ }))),
      editMessageText: vi.fn(async () => {}), editMessageReplyMarkup: vi.fn(async () => {}),
    };
  }

  async function setup(env: Record<string, string> = TG_ENV) {
    const hub = new EventHub();
    const core = makeChiefCore({ ...env, CHIEF_DATA_DIR: await dataDir() }, { agents, hub, log: vi.fn() });
    const tg = fakeTg();
    const cards = new CardIndex(core.paths.cards);
    const logs: string[] = [];
    return { hub, core, tg, cards, logs, start: () => startCardPoster(core, { tg: tg as never, cfg: CFG, cards, hub, log: (s) => { logs.push(s); } }) };
  }
  const texts = (tg: ReturnType<typeof fakeTg>) => tg.sendMessage.mock.calls.map((c) => c[1] as string);

  it("a misconfigured core gets no poster", async () => {
    const t = await setup({ ...TG_ENV, CHIEF_CONSOLE_URL: "" });
    expect(t.core.active).toBe(false);
    expect(await t.start()).toBeUndefined();
  });

  it("boot: an open item without a card is posted; a hub queue event posts a new item; the card shows the cited rule's text", async () => {
    const t = await setup();
    const { id: before } = await t.core.queue.add(CHOICE_ITEM);
    const { rule } = await t.core.rules.add({ text: "demo picks B", state: "active", scope: { area: "*" }, kind: "preference", source: { origin: "panel" } });
    const run = (await t.start())!;
    await vi.waitFor(() => expect(texts(t.tg)).toHaveLength(1));
    expect(texts(t.tg)[0]).toContain("Pick");
    await vi.waitFor(async () => expect((await t.core.queue.get(before))!.telegram?.cardMessageId).toBe(100));
    expect(t.cards.lookup(100)).toMatchObject({ kind: "item", itemId: before });
    await t.core.queue.add({ ...CHOICE_ITEM, title: "Second", recommend: { value: "B", why: "w", ruleIds: [rule.id], by: "fleet-master", at: 1 } });
    await vi.waitFor(() => expect(texts(t.tg)).toHaveLength(2));
    expect(texts(t.tg)[1]).toContain(`★ Master suggests B — rule ${rule.id}: "demo picks B"`);
    run.stop();
    await run.poster.idle();
    await t.core.queue.add({ ...CHOICE_ITEM, title: "After stop" });
    await new Promise((r) => setTimeout(r, 50));
    await run.poster.idle();
    expect(texts(t.tg)).toHaveLength(2);
  });

  it("rule texts: refreshes never overlap (a slow first fold holds the next), the map ends with the newer fold, and the cards follow it", async () => {
    const t = await setup();
    // A v1 fix: it runs in weak mode, not only in a hardened deployment.
    expect(t.core.active).toBe(true);
    expect(t.core.hardened()).toBe(false);
    const { rule } = await t.core.rules.add({ text: "old text", state: "active", scope: { area: "*" }, kind: "preference", source: { origin: "panel" } });
    const run = (await t.start())!;
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let folds = 0;
    let active = 0;
    let maxActive = 0;
    // The first fold reads the old text and is slow; every later fold reads the new text at once.
    vi.spyOn(t.core.rules, "all").mockImplementation(async () => {
      maxActive = Math.max(maxActive, ++active);
      try {
        if (++folds === 1) {
          await slow;
          return [{ ...rule, text: "old text" }];
        }
        return [{ ...rule, text: "new text" }];
      } finally {
        active--;
      }
    });
    const recommend = { value: "B", why: "w", ruleIds: [rule.id], by: "fleet-master", at: 1 };
    const { id: a } = await t.core.queue.add({ ...CHOICE_ITEM, title: "First", recommend });
    await vi.waitFor(() => expect(folds).toBe(1));
    const { id: b } = await t.core.queue.add({ ...CHOICE_ITEM, title: "Second", recommend });
    await new Promise((r) => setTimeout(r, 20));
    expect(folds).toBe(1); // the second event's refresh waits for the slow one
    release();
    await vi.waitFor(async () => {
      for (const id of [a, b]) expect((await t.core.queue.get(id))!.telegram?.cardMessageId).toBeDefined();
    });
    await run.poster.idle();
    await run.poster.tick();
    await run.poster.idle();
    const newer = (id: string) => (id === rule.id ? "new text" : undefined);
    for (const id of [a, b]) {
      const item = (await t.core.queue.get(id))!;
      expect(item.telegram?.renderHash).toBe(cardRenderHash(item, t.core.consoleUrl, newer));
    }
    expect(maxActive).toBe(1);
    run.stop();
  });

  it("a failure after the rule-text refresh of an event is logged, never an unhandled rejection", async () => {
    const t = await setup();
    const { rule } = await t.core.rules.add({ text: "demo picks B", state: "active", scope: { area: "*" }, kind: "preference", source: { origin: "panel" } });
    const run = (await t.start())!;
    vi.spyOn(run.poster, "onItem").mockImplementation(() => { throw new Error("boom"); });
    await t.core.queue.add({ ...CHOICE_ITEM, recommend: { value: "B", why: "w", ruleIds: [rule.id], by: "fleet-master", at: 1 } });
    await vi.waitFor(() => expect(t.logs).toEqual([expect.stringContaining("boom")]));
    run.stop();
  });

  it("a preview posts its stored image from <queue>/media/<id>/; a stored name that is not <n>.<ext> is never read (the card goes without it)", async () => {
    const t = await setup();
    const add = async (images: string[]) => {
      const { id } = await t.core.queue.add({ ...CHOICE_ITEM, choice: undefined, kind: "preview", title: images[0]!, preview: { images } });
      return id;
    };
    const good = await add(["1.png"]);
    await mkdir(join(t.core.queue.mediaDir, good), { recursive: true });
    await writeFile(join(t.core.queue.mediaDir, good, "1.png"), PNG);
    await writeFile(join(t.core.queue.dir, "secret.png"), PNG);
    const bad = await add(["../../secret.png"]);
    const run = (await t.start())!;
    await vi.waitFor(async () => expect((await t.core.queue.get(bad))!.telegram).toMatchObject({ mediaFailed: true, cardMessageId: expect.any(Number) }));
    await vi.waitFor(async () => expect((await t.core.queue.get(good))!.telegram?.cardMessageId).toBeDefined());
    await run.poster.idle();
    expect(t.tg.sendPhoto).toHaveBeenCalledTimes(1);
    expect(t.tg.sendPhoto.mock.calls[0]![1]).toMatchObject({ data: PNG, filename: "1.png", mime: "image/png" });
    const [badCard, goodCard] = [texts(t.tg).find((x) => x.includes("secret")), texts(t.tg).find((x) => !x.includes("secret"))];
    expect(texts(t.tg)).toHaveLength(2);
    expect(goodCard).toContain("1.png");
    expect(goodCard).not.toContain("see the Queue tab");
    expect(badCard!.split("\n").at(-1)).toBe("1 image — see the Queue tab");
    expect(t.logs).toEqual([expect.stringContaining("refused")]);
    run.stop();
  });
});

// The rule-text cache refresh (Phase 2b carry-over): one run in flight, at
// most one rerun queued behind it.
describe("coalesce", () => {
  it("a call during a run waits for a rerun that starts after that run: a slow older read never overwrites a newer one", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let runs = 0;
    let value = "";
    const refresh = coalesce(async () => {
      const n = ++runs;
      const read = `read ${n}`; // what this run read when it started
      if (n === 1) await slow;
      value = read;
    });
    const first = refresh();
    const second = refresh();
    let secondDone = false;
    void second.then(() => { secondDone = true; });
    await new Promise((r) => setImmediate(r));
    expect(runs).toBe(1);
    release();
    await first;
    expect(value).toBe("read 1");
    await second;
    expect(secondDone).toBe(true);
    expect(runs).toBe(2);
    expect(value).toBe("read 2");
  });

  it("a burst during a run shares one rerun; a call after the runs end starts a fresh run", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let runs = 0;
    const refresh = coalesce(async () => { if (++runs === 1) await slow; });
    const first = refresh();
    const burst = Array.from({ length: 5 }, () => refresh());
    expect(new Set(burst).size).toBe(1);
    release();
    await Promise.all([first, ...burst]);
    expect(runs).toBe(2);
    await refresh();
    expect(runs).toBe(3);
  });

  it("a run that throws does not stop the queued rerun", async () => {
    let runs = 0;
    const refresh = coalesce(async () => { if (++runs === 1) throw new Error("boom"); });
    const first = refresh();
    const second = refresh();
    await expect(first).rejects.toThrow("boom");
    await second;
    expect(runs).toBe(2);
  });
});
