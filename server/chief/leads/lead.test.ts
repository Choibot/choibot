// server/chief/leads/lead.test.ts — ensureLead, the boot repair and the leads'
// runtimes (spec §13, Task 3-7).
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryCtx } from "../../agents/recovery.js";
import { SessionStore, type AgentRecord } from "../../agents/store.js";
import { agentSessionName } from "../../agents/terminal.js";
import { EventHub } from "../../events.js";
import { EventQueue } from "../../master/events.js";
import { AREA_RE, AreaStore } from "./areas.js";
import { bootLeads, ensureLead, ensureLeadRuntimes, ensureLeadsAtBoot, leadId, LeadRuntimes, masterAccept } from "./lead.js";

const tmps: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true });
});
async function tmp(prefix: string) { const d = await mkdtemp(join(tmpdir(), prefix)); tmps.push(d); return d; }
const flush = () => new Promise<void>((r) => { setImmediate(r); });

const LEAD = "lead-app-shop";
const W = "9c8d7e6f-0000-0000-0000-000000000003";

// A REAL SessionStore and AreaStore; the terminals are sets: `live` = a tracked
// Term, `sessions` = a dtach socket. `log` records markStarting and spawns in order.
async function setup() {
  const chiefDir = await tmp("chief-lead-");
  const store = new SessionStore(await tmp("agents-"));
  const log: string[] = [];
  const live = new Set<string>();
  const sessions = new Set<string>();
  const writes: string[] = [];
  const terminals = {
    has: (id: string) => live.has(id),
    hasSession: async (id: string) => sessions.has(id),
    reattach: async (id: string) => (sessions.has(id) ? (live.add(id), {}) : null),
    write: (_id: string, d: string) => { writes.push(d); },
    inputReady: (id: string) => live.has(id),
  };
  const recoveryCtx = {
    port: 1, workspaceDir: "/ws", store,
    claudeHooksPathFor: (rec: AgentRecord) => join(rec.worktree, ".choibot-hooks.json"),
    writeClaudeHookSettings: async () => {},
    terminals: {
      ...terminals,
      spawn: (o: { id: string }) => { log.push(`spawn:${o.id}`); live.add(o.id); sessions.add(o.id); },
    },
  } as unknown as RecoveryCtx;
  const areas = new AreaStore(join(chiefDir, "areas.json"), { exists: async (id) => (await store.load(id)) !== null });
  const hub = new EventHub();
  const runtimes = new LeadRuntimes({
    hub, agents: store, issues: { list: async () => [] }, acted: { recent: () => false }, terminals, areas,
  });
  const d = {
    store, recoveryCtx, chiefDir, areas, terminals, env: {},
    markStarting: (id: string) => { log.push(`starting:${id}`); runtimes.markStarting(id); },
  };
  return { d, store, areas, chiefDir, log, live, sessions, writes, hub, runtimes, terminals };
}

describe("leadId", () => {
  it("stays inside the dtach helper's socket charset after agentSessionName, for every start area and a maximal area name", () => {
    const maximal = "z" + "9-".repeat(15) + "x";
    expect(maximal).toHaveLength(32);
    for (const area of ["app-shop", "indexer", "infra", maximal, "0"]) {
      expect(AREA_RE.test(area)).toBe(true);
      expect(leadId(area)).toBe(`lead-${area}`);
      expect(agentSessionName(leadId(area))).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });
});

describe("ensureLead", () => {
  it("creates the home, the git repo, charter.md, the record and the areas.json leadId, then resumes it", async () => {
    const { d, store, areas, chiefDir, log } = await setup();
    await areas.set("app-shop", { repos: ["app-shop", "ui-kit"] });
    expect(await ensureLead(d, "app-shop")).toBe(LEAD);
    const agentDir = join(chiefDir, "leads", "app-shop", "agent");
    const rec = await store.load(LEAD);
    expect(rec).toMatchObject({
      id: LEAD, label: "Lead · app-shop", kind: "lead", area: "app-shop", repo: "",
      worktree: agentDir, cwd: agentDir, branch: "", baseBranch: "", status: "idle",
    });
    // Never spawnedBy: the master would drop the lead's own lead-errored line.
    expect(rec!.spawnedBy).toBeUndefined();
    expect(rec!.hookToken).toBeTruthy();
    expect(existsSync(join(agentDir, ".git"))).toBe(true);
    expect(existsSync(join(chiefDir, "leads", "app-shop", "memory"))).toBe(true);
    const charter = await readFile(join(chiefDir, "leads", "app-shop", "charter.md"), "utf8");
    expect(charter.trim().split("\n")).toHaveLength(1);
    expect(charter).toContain("app-shop");
    expect(charter).toContain("ui-kit");
    expect((await areas.read())["app-shop"]).toEqual({ repos: ["app-shop", "ui-kit"], leadId: LEAD });
    expect(log).toEqual([`starting:${LEAD}`, `spawn:${LEAD}`]);
  });

  it("keeps an existing charter.md", async () => {
    const { d, chiefDir } = await setup();
    await mkdir(join(chiefDir, "leads", "infra"), { recursive: true });
    await writeFile(join(chiefDir, "leads", "infra", "charter.md"), "Own the infra.\n");
    await ensureLead(d, "infra");
    expect(await readFile(join(chiefDir, "leads", "infra", "charter.md"), "utf8")).toBe("Own the infra.\n");
  });

  it("two concurrent calls for one area: one record, one spawn", async () => {
    const { d, store, log } = await setup();
    const [a, b] = await Promise.all([ensureLead(d, "app-shop"), ensureLead(d, "app-shop")]);
    expect([a, b]).toEqual([LEAD, LEAD]);
    expect((await store.list()).map((r) => r.id)).toEqual([LEAD]);
    expect(log.filter((l) => l.startsWith("spawn:"))).toHaveLength(1);
  });

  it("two areas in parallel: two records, two spawns", async () => {
    const { d, store, areas, log } = await setup();
    await Promise.all([ensureLead(d, "app-shop"), ensureLead(d, "indexer")]);
    expect((await store.list()).map((r) => r.id).sort()).toEqual(["lead-app-shop", "lead-indexer"]);
    expect(log.filter((l) => l.startsWith("spawn:")).sort()).toEqual(["spawn:lead-app-shop", "spawn:lead-indexer"]);
    const a = await areas.read();
    expect([a["app-shop"]?.leadId, a.indexer?.leadId]).toEqual(["lead-app-shop", "lead-indexer"]);
  });

  it("a second call while the lead is live is a no-op: no spawn, no starting mark, same record", async () => {
    const { d, store, log } = await setup();
    await ensureLead(d, "app-shop");
    const first = await store.load(LEAD);
    log.length = 0;
    expect(await ensureLead(d, "app-shop")).toBe(LEAD);
    expect(log).toEqual([]);
    expect((await store.load(LEAD))!.hookToken).toBe(first!.hookToken);
  });

  it("a surviving dtach session is a reattach: no starting mark", async () => {
    const { d, log, sessions } = await setup();
    sessions.add(LEAD);
    await ensureLead(d, "app-shop");
    expect(log).toEqual([]);
  });

  it("a cold start marks that lead's inbox starting before the spawn; it reads busy until SessionStart", async () => {
    const { d, log, hub, runtimes } = await setup();
    const rt = runtimes.ensure(LEAD, { starting: false, recordExists: true });
    expect(rt.inbox.turn()).toBe("idle");
    await ensureLead(d, "app-shop");
    expect(log).toEqual([`starting:${LEAD}`, `spawn:${LEAD}`]);
    expect(rt.inbox.turn()).toBe("busy");
    hub.emitEvent({ type: "agent-hook", agentId: "lead-indexer", event: "SessionStart", source: "startup" });
    expect(rt.inbox.turn()).toBe("busy");
    hub.emitEvent({ type: "agent-hook", agentId: LEAD, event: "SessionStart", source: "startup" });
    expect(rt.inbox.turn()).toBe("idle");
    runtimes.stopAll();
  });

  it("refuses a bad area name and creates nothing", async () => {
    const { d, store, chiefDir } = await setup();
    for (const bad of ["", "App", "../x", "a b", "a".repeat(33)]) await expect(ensureLead(d, bad)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
    expect(existsSync(join(chiefDir, "leads"))).toBe(false);
  });
});

// Task 2c-7, as ensureFleetMaster: the lead's home in AGENT_HOME_ROOT (hardened only).
describe("ensureLead homes", () => {
  const HARDENED = {
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
  };
  const mode = async (p: string) => (await stat(p)).mode & 0o7777;

  it("hardened: the record in <root>/leads/<area>/agent, the legacy memory copied, charter.md console-side", async () => {
    const { d, store, chiefDir, log } = await setup();
    await mkdir(join(chiefDir, "leads", "app-shop", "memory"), { recursive: true });
    await writeFile(join(chiefDir, "leads", "app-shop", "memory", "MEMORY.md"), "- [x](x.md)\n");
    const root = await tmp("homes-");
    const old = process.umask(0o022);
    try {
      await ensureLead({ ...d, env: { ...HARDENED, AGENT_HOME_ROOT: root } }, "app-shop");
    } finally { process.umask(old); }
    const agentDir = join(root, "leads", "app-shop", "agent");
    expect(await store.load(LEAD)).toMatchObject({ cwd: agentDir, worktree: agentDir });
    expect(log).toEqual([`starting:${LEAD}`, `spawn:${LEAD}`]);
    expect(await readFile(join(root, "leads", "app-shop", "memory", "MEMORY.md"), "utf8")).toBe("- [x](x.md)\n");
    expect(await mode(join(root, "leads", "app-shop"))).toBe(0o2750);
    expect(await mode(agentDir)).toBe(0o3770);
    expect(await mode(join(root, "leads", "app-shop", "memory"))).toBe(0o2770);
    expect(existsSync(join(agentDir, ".git"))).toBe(true);
    expect(existsSync(join(chiefDir, "leads", "app-shop", "charter.md"))).toBe(true);
    expect(existsSync(join(chiefDir, "leads", "app-shop", "agent"))).toBe(false);
    expect(existsSync(join(root, "leads", "app-shop", "charter.md"))).toBe(false);
  });

  it("hardened with an AGENT_HOME_ROOT that does not exist: refused, nothing made", async () => {
    const { d, store, chiefDir, log } = await setup();
    const missing = join(await tmp("homes-"), "homes");
    await expect(ensureLead({ ...d, env: { ...HARDENED, AGENT_HOME_ROOT: missing } }, "app-shop")).rejects.toThrow("does not exist");
    expect(await readdir(chiefDir)).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe("ensureLeadsAtBoot", () => {
  it("never creates a lead: no record, nothing made and nothing spawned", async () => {
    const { d, store, areas, chiefDir, log } = await setup();
    await areas.set("app-shop", { repos: ["app-shop"], leadId: LEAD });
    await areas.set("indexer", { repos: ["indexer"] });
    expect(await ensureLeadsAtBoot(d)).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(log).toEqual([]);
    expect(existsSync(join(chiefDir, "leads"))).toBe(false);
  });

  it("resumes a lead with a record whatever its status, and returns the ids it spawned; live → a no-op", async () => {
    const { d, store, log, live, sessions } = await setup();
    await ensureLead(d, "app-shop");
    await store.patch(LEAD, { status: "done" });
    live.clear();
    sessions.clear();
    log.length = 0;
    expect(await ensureLeadsAtBoot(d)).toEqual([LEAD]);
    expect(log).toEqual([`starting:${LEAD}`, `spawn:${LEAD}`]);
    expect((await store.load(LEAD))!.status).toBe("idle");
    log.length = 0;
    expect(await ensureLeadsAtBoot(d)).toEqual([]);
    expect(log).toEqual([]);
  });

  it("one lead's failure does not stop the others", async () => {
    const { d, chiefDir, log, live, sessions } = await setup();
    await ensureLead(d, "app-shop");
    await ensureLead(d, "indexer");
    live.clear();
    sessions.clear();
    log.length = 0;
    // app-shop's memory dir is now a file: its ensure throws.
    const memory = join(chiefDir, "leads", "app-shop", "memory");
    await rm(memory, { recursive: true });
    await writeFile(memory, "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await ensureLeadsAtBoot(d)).toEqual(["lead-indexer"]);
    expect(log).toEqual(["starting:lead-indexer", "spawn:lead-indexer"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("lead-app-shop"))).toBe(true);
  });
});

describe("LeadRuntimes", () => {
  function counting() {
    const hub = new EventHub();
    let subs = 0;
    const subscribe = hub.subscribe.bind(hub);
    hub.subscribe = (fn) => { subs++; return subscribe(fn); };
    return { hub, subs: () => subs };
  }
  function runtimesOn(hub: EventHub, writes: string[] = [], quiet?: ConstructorParameters<typeof LeadRuntimes>[0]["quiet"]) {
    const terminals = {
      has: () => true, hasSession: async () => true, reattach: async () => ({}),
      write: (_id: string, d: string) => { writes.push(d); }, inputReady: () => true,
    };
    const areas = new AreaStore("/nonexistent/areas.json", { exists: async () => true });
    return new LeadRuntimes({
      hub, agents: { load: async () => null }, issues: { list: async () => [] }, acted: { recent: () => false }, terminals, areas,
      ...(quiet ? { quiet } : {}),
    });
  }

  it("with the quiet deps (an active core), a failure line skips the digest gap; without them it waits", async () => {
    for (const withQuiet of [true, false]) {
      const hub = new EventHub();
      const writes: string[] = [];
      const quiet = { userPresent: () => false, queue: { list: async () => [] }, workspaceDir: "/nonexistent" };
      const r = runtimesOn(hub, writes, withQuiet ? quiet : undefined);
      const rt = r.ensure(LEAD, { starting: false, recordExists: true });
      rt.events.addQueueLine("qaaaaaaaa", "pr", "app-shop");
      await rt.inbox.tick();
      hub.emitEvent({ type: "agent-hook", agentId: LEAD, event: "Stop" });
      rt.events.add({ agentId: W, repo: "app-shop", kind: "errored" });
      await rt.inbox.tick();
      expect(writes.join("").includes("errored")).toBe(withQuiet);
      r.stopAll();
    }
  });

  it("ensure twice: one runtime and one set of hub subscriptions", async () => {
    const { hub, subs } = counting();
    const r = runtimesOn(hub);
    const a = r.ensure(LEAD, { starting: false, recordExists: true });
    await flush();
    const once = subs();
    expect(once).toBeGreaterThan(0);
    const b = r.ensure(LEAD, { starting: true, recordExists: true });
    await flush();
    expect(b).toBe(a);
    expect(subs()).toBe(once);
    // An existing runtime is not marked starting again (a live lead's inbox stays open).
    expect(a.inbox.turn()).toBe("idle");
    expect(r.get(LEAD)).toBe(a);
    r.stopAll();
  });

  it("starting → the inbox starts busy until its SessionStart", () => {
    const hub = new EventHub();
    const r = runtimesOn(hub);
    const rt = r.ensure(LEAD, { starting: true, recordExists: true });
    expect(rt.inbox.turn()).toBe("busy");
    hub.emitEvent({ type: "agent-hook", agentId: LEAD, event: "SessionStart", source: "resume" });
    expect(rt.inbox.turn()).toBe("idle");
    r.markStarting(LEAD);
    expect(rt.inbox.turn()).toBe("busy");
    r.markStarting("lead-unknown"); // no runtime: nothing
    r.stopAll();
  });

  it("refuses an id that is not a lead id", () => {
    const r = runtimesOn(new EventHub());
    for (const bad of ["fleet-master", "cron-master", W, "lead-", "lead-App"]) {
      expect(() => r.ensure(bad, { starting: false, recordExists: true })).toThrow();
    }
    expect(r.get("fleet-master")).toBeUndefined();
  });

  it("onWebInput reaches that lead's tracker and does nothing for a worker id", () => {
    const hub = new EventHub();
    const r = runtimesOn(hub);
    const rt = r.ensure(LEAD, { starting: false, recordExists: true });
    r.onWebInput(W, "x");
    expect(rt.inbox.blockedBy()).toBeNull();
    r.onWebInput(LEAD, "x");
    expect(rt.inbox.blockedBy()).toBe("draft");
    r.stopAll();
  });

  it("ready() is a synchronous boolean: seeded by recordExists, kept from the lead's status and hook events", () => {
    const hub = new EventHub();
    const r = runtimesOn(hub);
    const rt = r.ensure(LEAD, { starting: false, recordExists: false });
    expect(rt.ready()).toBe(false);
    hub.emitEvent({ type: "agent-hook", agentId: W, event: "SessionStart", source: "startup" });
    expect(rt.ready()).toBe(false);
    hub.emitEvent({ type: "agent-hook", agentId: LEAD, event: "SessionStart", source: "startup" });
    expect(rt.ready()).toBe(true);
    hub.emitEvent({ type: "agent-status", agentId: LEAD, status: "done" });
    expect(rt.ready()).toBe(false);
    hub.emitEvent({ type: "agent-status", agentId: LEAD, status: "idle" });
    expect(rt.ready()).toBe(true);
    const rt2 = r.ensure("lead-infra", { starting: false, recordExists: true });
    expect(rt2.ready()).toBe(true);
    r.stopAll();
  });

  it("the inbox types its digest into the lead's own PTY; not ready → no send", async () => {
    const hub = new EventHub();
    const writes: string[] = [];
    const r = runtimesOn(hub, writes);
    const off = r.ensure("lead-infra", { starting: false, recordExists: false });
    off.events.addLead("lead-report", "infra", "lead-infra");
    await off.inbox.tick();
    expect(writes).toEqual([]);
    const rt = r.ensure(LEAD, { starting: false, recordExists: true });
    rt.events.add({ agentId: W, repo: "app-shop", kind: "waiting" });
    await rt.inbox.tick();
    expect(writes.join("")).toContain("[events] agent-9c8d7e6f app-shop waiting");
    expect(rt.events.size()).toBe(0);
    r.stopAll();
  });

  it("stopAll ends every runtime's subscriptions", async () => {
    const { hub } = counting();
    const r = runtimesOn(hub);
    const rt = r.ensure(LEAD, { starting: true, recordExists: true });
    await flush();
    r.stopAll();
    hub.emitEvent({ type: "agent-hook", agentId: LEAD, event: "SessionStart", source: "startup" });
    expect(rt.inbox.turn()).toBe("busy");
    expect(r.get(LEAD)).toBeUndefined();
  });
});

describe("bootLeads", () => {
  // The console restarted: no runtime, no live Term; `sessions` says whether the dtach session survived.
  async function restarted(o: { status: AgentRecord["status"]; survived: boolean }) {
    const s = await setup();
    await ensureLead(s.d, "app-shop");
    await s.store.patch(LEAD, { status: o.status });
    s.runtimes.stopAll();
    s.live.clear();
    if (!o.survived) s.sessions.clear();
    s.log.length = 0;
    const ensure = s.runtimes.ensure.bind(s.runtimes);
    vi.spyOn(s.runtimes, "ensure").mockImplementation((id, x) => {
      s.log.push(`ensure:${id}:${JSON.stringify(x)}`);
      return ensure(id, x);
    });
    return s;
  }

  it("creates a dead lead's runtime with starting: true before it resumes it (status done), and returns its id", async () => {
    const { d, runtimes, log } = await restarted({ status: "done", survived: false });
    expect(await bootLeads({ ...d, runtimes })).toEqual([LEAD]);
    expect(log).toEqual([
      `ensure:${LEAD}:{"starting":true,"recordExists":true}`, `starting:${LEAD}`, `spawn:${LEAD}`,
    ]);
    expect(runtimes.get(LEAD)!.inbox.turn()).toBe("busy");
    runtimes.stopAll();
  });

  it("a running lead whose session survived starts busy too; a reattach is not returned", async () => {
    const { d, runtimes, log } = await restarted({ status: "running", survived: true });
    expect(await bootLeads({ ...d, runtimes })).toEqual([]);
    expect(log).toEqual([`ensure:${LEAD}:{"starting":true,"recordExists":true}`]);
    runtimes.stopAll();
  });

  it("an idle lead whose session survived: starting false, no spawn, not returned", async () => {
    const { d, runtimes, log } = await restarted({ status: "idle", survived: true });
    expect(await bootLeads({ ...d, runtimes })).toEqual([]);
    expect(log).toEqual([`ensure:${LEAD}:{"starting":false,"recordExists":true}`]);
    expect(runtimes.get(LEAD)!.inbox.turn()).toBe("idle");
    runtimes.stopAll();
  });

  it("ensureLeadRuntimes only makes the runtimes: no resume", async () => {
    const { d, runtimes, log } = await restarted({ status: "idle", survived: false });
    expect(await ensureLeadRuntimes({ ...d, runtimes })).toEqual([LEAD]);
    expect(log).toEqual([`ensure:${LEAD}:{"starting":true,"recordExists":true}`]);
    runtimes.stopAll();
  });
});

describe("the master and lead event queues (end to end)", () => {
  it("a lead worker's idle event reaches the lead digest only; a master worker's reaches the master only", async () => {
    const { d, store, areas, hub, runtimes } = await setup();
    await areas.set("app-shop", { repos: ["app-shop"] });
    await ensureLead(d, "app-shop");
    const A = "1a2b3c4d-0000-0000-0000-000000000001";
    const rec = (id: string, spawnedBy: string): AgentRecord => ({
      id, label: id, repo: "/ws/app-shop", worktree: "/ws/wt", branch: "b", baseBranch: "main",
      sessionId: null, hookToken: "t", status: "running", createdAt: 1, spawnedBy,
    });
    await store.save(rec(W, LEAD));
    await store.save(rec(A, "fleet-master"));
    const rt = runtimes.ensure(LEAD, { starting: false, recordExists: true });
    const master = new EventQueue({
      hub, agents: store, issues: { list: async () => [] }, acted: { recent: () => false },
      accept: masterAccept(areas), leads: { get: (id) => runtimes.get(id)?.events },
    });
    const stopMaster = await master.start();
    await flush();
    // Both queues load records and read areas.json (disk I/O) before they add.
    const settle = () => new Promise((r) => setTimeout(r, 50));
    hub.emitEvent({ type: "agent-status", agentId: W, status: "idle" });
    await vi.waitFor(() => expect(rt.events.digest()).toBe("[events] agent-9c8d7e6f app-shop waiting"));
    await settle();
    expect(master.digest()).toBeNull();
    rt.events.clear();
    hub.emitEvent({ type: "agent-status", agentId: A, status: "idle" });
    await vi.waitFor(() => expect(master.digest()).toBe("[events] agent-1a2b3c4d app-shop waiting"));
    await settle();
    expect(rt.events.digest()).toBeNull();
    master.clear();
    // A queue item of the lead's worker: the master line and the lead copy.
    await master.addQueue("qaaaaaaa1", "choice", "app-shop", W);
    expect(master.digest()).toBe("[events] queue qaaaaaaa1 choice app-shop");
    expect(rt.events.digest()).toBe("[events] queue qaaaaaaa1 choice app-shop");
    // The lead record gone while areas.json still names it: the master takes its workers again.
    await store.delete(LEAD);
    master.clear();
    rt.events.clear();
    hub.emitEvent({ type: "agent-status", agentId: W, status: "error" });
    await vi.waitFor(() => expect(master.digest()).toBe("[events] agent-9c8d7e6f app-shop errored"));
    await settle();
    expect(rt.events.digest()).toBeNull();
    stopMaster();
    runtimes.stopAll();
  });

  it("masterAccept: an unreadable areas.json routes to the master, with one log line", async () => {
    const root = await tmp("chief-areas-");
    await mkdir(join(root, "areas.json")); // EISDIR on read
    const lines: string[] = [];
    const accept = masterAccept(new AreaStore(join(root, "areas.json"), { exists: async () => true }), (s) => lines.push(s));
    const worker = { id: W, spawnedBy: LEAD } as AgentRecord;
    expect(await accept(worker)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(await accept({ id: "x" } as AgentRecord)).toBe(true);
    expect(lines).toHaveLength(1);
  });
});

