// server/health/api.test.ts — the health routes are for the paired user only, and the disk
// sizes come from a run in the background, never from a request. Made-up folders only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { CHIEF_ERR, makeGate } from "../chief/gate.js";
import { agentName, fixedPlaces, registerHealthApi } from "./api.js";
import { HealthMonitor } from "./monitor.js";
import { measure, parseDu, Places, systemDu, type Du } from "./places.js";

const MB = 1024 * 1024;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "health-api-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const mk = (...parts: string[]): string => {
  const p = join(dir, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

describe("what fills the disk", () => {
  // du's answer for a folder: the sizes of the made-up tree, in MB.
  const fakeDu = (sizes: Record<string, number>, slow: string[] = []): Du & { asked: string[] } => {
    const asked: string[] = [];
    const du = (async (t: { path: string; depth: number }) => {
      asked.push(`${t.path.slice(dir.length)} d${t.depth}`);
      if (slow.some((s) => t.path.endsWith(s))) return null;
      const out = new Map<string, number>();
      for (const [rel, mb] of Object.entries(sizes)) {
        const p = join(dir, rel);
        if (p === t.path || p.startsWith(t.path + "/")) out.set(p, mb * MB);
      }
      return out.size ? out : null;
    }) as Du & { asked: string[] };
    du.asked = asked;
    return du;
  };

  it("lists each repo, each agent's copy, the copies that no agent uses and the console's places, biggest first", async () => {
    mk("ws", "shop", ".git");
    const copy = mk("ws", "shop", ".agent-worktrees", "agent-a1");
    mk("ws", "shop", ".agent-worktrees", "agent-old");
    mk("ws", "notes");
    mk("home", ".claude");
    mk("home", ".cache");
    mk("data");
    const du = fakeDu({
      "ws/shop": 5000, "ws/shop/.git": 300, "ws/shop/node_modules": 900, "ws/shop/.next": 200, "ws/shop/dist": 50, "ws/shop/src": 20,
      "ws/shop/.agent-worktrees": 3200, "ws/shop/.agent-worktrees/agent-a1": 2000, "ws/shop/.agent-worktrees/agent-a1/node_modules": 1500,
      "ws/shop/.agent-worktrees/agent-old": 1200,
      "ws/notes": 40, "home/.claude": 700, "home/.cache": 2500, "data": 10,
    });
    const rows = await measure({
      workDir: join(dir, "ws"), worktreeDir: ".agent-worktrees",
      agents: [{ id: "a1", title: "Fix the login", worktree: copy }],
      fixed: fixedPlaces({ env: { HOME: join(dir, "home") }, checkout: join(dir, "ws", "shop"), dataDirs: [join(dir, "data")] }),
    }, du);
    expect(rows.map((r) => [r.kind, r.name, r.bytes === null ? null : r.bytes / MB])).toEqual([
      ["downloads", "Downloads of the tools (package caches)", 2500],
      ["agent", "Fix the login", 2000],
      ["repo", "shop", 1800], // 5000 less the agents' copies
      ["closed", "agent-old", 1200],
      ["claude", "The agents' conversations and settings", 700],
      ["folder", "notes", 40],
      ["console", "ChoiBot (the program and its records)", 10], // the checkout is in the repo "shop": counted there
    ]);
    expect(rows[1]).toMatchObject({ agentId: "a1", repo: "shop", parts: [{ name: "installed parts", bytes: 1500 * MB }] });
    expect(rows[2].parts).toEqual([{ name: "installed parts", bytes: 900 * MB }, { name: "build outputs", bytes: 250 * MB }, { name: "Git history", bytes: 300 * MB }]);
    expect(rows.every((r) => r.workDisk)).toBe(true);
    // One du per folder of the work folder and per place that is there: no place two times.
    expect(du.asked).toEqual(["/ws/notes d3", "/ws/shop d3", "/data d0", "/home/.claude d0", "/home/.cache d0"]);
  });

  it("finds the agents' copies also when one folder of its own holds them all", async () => {
    mk("ws", "shop", ".git");
    const copy = mk("wt", "agent-a1");
    mk("wt", "agent-old");
    const rows = await measure({
      workDir: join(dir, "ws"), worktreeDir: join(dir, "wt"), agents: [{ id: "a1", title: "Fix the login", worktree: copy, repo: "shop" }], fixed: [],
    }, fakeDu({ "ws/shop": 100, "wt": 900, "wt/agent-a1": 600, "wt/agent-a1/node_modules": 500, "wt/agent-old": 300 }));
    expect(rows.map((r) => [r.kind, r.name, r.repo, (r.bytes as number) / MB])).toEqual([
      ["agent", "Fix the login", "shop", 600], ["closed", "agent-old", undefined, 300], ["repo", "shop", undefined, 100],
    ]);
    expect(rows[0].parts).toEqual([{ name: "installed parts", bytes: 500 * MB }]);
  });

  it("a place that took too long has no size, and the others still have theirs", async () => {
    mk("ws", "big");
    mk("ws", "small");
    const rows = await measure({ workDir: join(dir, "ws"), worktreeDir: ".agent-worktrees", agents: [], fixed: [] }, fakeDu({ "ws/small": 3 }, ["/big"]));
    expect(rows.map((r) => [r.name, r.bytes])).toEqual([["small", 3 * MB], ["big", null]]);
  });

  it("reads du's lines, and the real du measures a made-up folder at low priority", async () => {
    expect([...parseDu("12\t/a b\n4\t/a b/c\nbroken\n")]).toEqual([["/a b", 12288], ["/a b/c", 4096]]);
    const p = mk("tree", "sub");
    writeFileSync(join(p, "file"), Buffer.alloc(300_000));
    const sizes = await systemDu(10_000)({ path: join(dir, "tree"), depth: 1 });
    expect(sizes!.get(join(dir, "tree"))).toBeGreaterThanOrEqual(300_000);
    expect(sizes!.get(p)).toBeGreaterThanOrEqual(300_000);
    expect(await systemDu(10_000)({ path: join(dir, "not-there"), depth: 0 })).toBeNull();
  });

  it("runs one at a time and keeps the last answer with its time", async () => {
    mk("ws", "shop");
    let runs = 0;
    let release: () => void = () => {};
    const du: Du = async (t) => {
      runs += 1;
      await new Promise<void>((r) => { release = r; });
      return new Map([[t.path, 7 * MB]]);
    };
    const places = new Places({ input: async () => ({ workDir: join(dir, "ws"), worktreeDir: ".agent-worktrees", agents: [], fixed: [] }), du, now: () => 4242 });
    expect(places.view()).toEqual({ rows: [], checkedAt: null, checking: false });
    const a = places.check();
    const b = places.check();
    expect(places.view().checking).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
    expect(places.view()).toMatchObject({ checkedAt: 4242, checking: false, rows: [{ name: "shop", bytes: 7 * MB }] });
  });
});

describe("the health routes", () => {
  const USER = "user-token";
  const HOOK = "hook-token";
  const ROUTES: ["GET" | "POST", string][] = [["GET", "/api/server/health"], ["GET", "/api/server/status"], ["POST", "/api/server/places/check"]];

  function app(o: { gate?: boolean; misconfigured?: string | null } = {}) {
    const a = Fastify();
    const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id)
      ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
    const gate = makeGate({
      misconfigured: o.misconfigured ?? null, userAuth: "log",
      deps: { devices: { verify: async (t: string) => (t === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents },
    });
    let checks = 0;
    const places = new Places({ input: async () => { checks += 1; return { workDir: join(dir, "none"), worktreeDir: ".agent-worktrees", agents: [], fixed: [] }; } });
    const monitor = new HealthMonitor({ workDir: dir, places, agents: async () => [], sessionName: (id) => id });
    registerHealthApi(a, { gate: o.gate === false ? undefined : gate, monitor, places });
    return { a, checks: () => checks };
  }

  it("answer the paired user", async () => {
    const { a, checks } = app();
    const health = await a.inject({ method: "GET", url: "/api/server/health", headers: { [USER_HEADER]: USER } });
    expect(health.statusCode).toBe(200);
    expect(Object.keys(health.json()).sort()).toEqual([
      "agents", "at", "cores", "costMs", "cpu", "disks", "facts", "history", "level", "load", "memory", "places", "since", "topCpu", "topMemory", "uptimeSec", "warnings",
    ]);
    expect(["ok", "warn", "error"]).toContain((await a.inject({ method: "GET", url: "/api/server/status", headers: { [USER_HEADER]: USER } })).json().level);
    expect((await a.inject({ method: "POST", url: "/api/server/places/check", headers: { [USER_HEADER]: USER } })).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(checks()).toBe(1);
    await a.close();
  });

  it("refuse a browser that is not paired, an agent, a lead and the fleet master", async () => {
    const { a, checks } = app();
    for (const [method, url] of ROUTES) {
      for (const headers of [{}, { [USER_HEADER]: "wrong" }, ...["w1", "lead-app", "fleet-master"].map((id) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: HOOK }))]) {
        const res = await a.inject({ method, url, headers });
        expect([method, url, res.statusCode, res.json().error]).toEqual([method, url, 403, CHIEF_ERR.pairRequired]);
      }
    }
    expect(checks()).toBe(0);
    await a.close();
  });

  it("answer 503 while the pairing is set up wrong, and answer on a console with no pairing", async () => {
    const bad = app({ misconfigured: "no key" });
    expect((await bad.a.inject({ method: "GET", url: "/api/server/health", headers: { [USER_HEADER]: USER } })).statusCode).toBe(503);
    await bad.a.close();
    const open = app({ gate: false });
    expect((await open.a.inject({ method: "GET", url: "/api/server/status" })).statusCode).toBe(200);
    await open.a.close();
  });

  it("names a worker by its title, a lead by its area and the fleet master by its name", () => {
    expect(agentName({ id: "a1", label: "Fix the login" })).toEqual({ id: "a1", title: "Fix the login", kind: "agent" });
    expect(agentName({ id: "lead-shop", label: "lead", kind: "lead", area: "shop" })).toEqual({ id: "lead-shop", title: "Lead · shop", kind: "lead" });
    expect(agentName({ id: "fleet-master", label: "x", kind: "fleet-master" })).toEqual({ id: "fleet-master", title: "Fleet master", kind: "fleet-master" });
  });
});
