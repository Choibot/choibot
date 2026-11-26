import { describe, it, expect } from "vitest";
import { agentLines, ago, coordinatorLine, cronLines, leadLines, queueLines, runCoordinator, runFleet, SUMMARY_CAP, type FleetDeps, type FleetTicket } from "./fleet.js";

type Call = { method: string; path: string; body: any; headers: Record<string, string> };
const NOW = 1_800_000_000_000;
const MIN = 60_000, HOUR = 60 * MIN;

function world(routes: Record<string, (body: any) => { status?: number; body?: unknown }>, o: Partial<FleetDeps> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const h = routes[`${method} ${u.pathname}`];
    const r = h ? h(body) : { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  const deps: Partial<FleetDeps> = {
    fetch: f, readStdin: async () => "", stdinIsTTY: false, stderrIsTTY: true,
    out: (s) => out.push(s), err: (s) => err.push(s),
    env: { HOME: "/nonexistent/fleet-test-home", PORT: "4321", CHOIBOT_AGENT_ID: "fleet-master", CHOIBOT_AGENT_PASS: "p1" },
    flags: {}, readFile: () => null, now: () => NOW,
    ...o,
  };
  return { calls, out, err, deps };
}

const ticket = (id: string, o: Partial<FleetTicket> = {}): FleetTicket =>
  ({ id, kind: "choice", agentId: "3ee90a02-1111-4222-8333-444444444444", repo: "app-shop", title: `Ticket ${id}`, createdAt: NOW - 3 * HOUR, ...o });
const ROUTES = {
  "GET /api/queue": () => ({ body: { serverNow: NOW, items: [
    ticket("q_old", { createdAt: NOW - 3 * 24 * HOUR }),
    ticket("q_block", { blocking: true, kind: "question", agentId: "lead-app", recommend: { value: "B" } }),
  ] } }),
  "GET /api/agents": () => ({ body: { sessions: [
    { id: "a1", label: "fix the build", repo: "/ws/app-shop", status: "running", prNumber: 12 },
    { id: "a2", label: "docs", repo: "/ws/docs", status: "error", spawnedBy: "lead-app" },
    { id: "a3", repo: "/ws/docs", status: "idle" },
    { id: "a4", repo: "/ws/docs", status: "idle", closedAt: 5 },
  ] } }),
  "GET /api/leads": () => ({ body: [
    { area: "app", repos: ["app-shop", "docs"], leadId: "lead-app", status: "idle", reportAt: NOW - 12 * MIN },
    { area: "infra", repos: [], leadId: null, status: null, reportAt: null },
  ] }),
  "GET /api/cron/jobs": () => ({ body: { jobs: [
    { name: "brief", enabled: true, nextRun: "Sat 2026-11-21 08:00:00 UTC", lastRun: { finishedAt: NOW - 2 * HOUR, ok: true, state: "needs" } },
    { name: "cost", enabled: false, nextRun: null, lastRun: { finishedAt: NOW - 10 * MIN, ok: false } },
    { name: "new", enabled: true, nextRun: null, lastRun: null },
  ] } }),
  "GET /api/coordinator": () => ({ body: { id: "coordinator", state: "waiting", lastActivityAt: NOW - 3 * MIN, queuedEvents: 2, model: "sonnet" } }),
};

describe("fleet", () => {
  it("prints every part in short plain lines, with GET calls only", async () => {
    const w = world(ROUTES);
    expect(await runFleet(undefined, [], w.deps)).toBe(0);
    expect(w.out.join("\n").split("\n")).toEqual([
      "Queue: 2 open, 1 blocking",
      "  q_block question blocking · app-shop · lead-app · 3h · Ticket q_block · suggested: B",
      "  q_old choice · app-shop · agent-3ee90a02 · 3d · Ticket q_old",
      "Agents: 3 (1 working, 1 waiting, 1 failed)",
      "  a2 failed · docs · of lead-app · docs",
      "Leads: 2",
      "  app waiting · report 12m ago · app-shop, docs",
      "  infra no lead · no report",
      "Recurring: 3 tasks, 1 needs you, 1 did not finish",
      "  brief · needs-you 2h ago · next Sat 2026-11-21 08:00:00 UTC",
      "  cost (paused) · did-not-finish 10m ago",
      "  new · no run yet",
      "Coordinator: waiting · last activity 3m ago · 2 events wait",
    ]);
    expect(w.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);
    expect(w.calls.every((c) => c.headers["x-choibot-agent"] === "fleet-master")).toBe(true);
  });

  it("one section lists every line and calls only its route", async () => {
    const w = world(ROUTES);
    expect(await runFleet("agents", [], w.deps)).toBe(0);
    expect(w.out.join("\n").split("\n")).toEqual([
      "Agents: 3 (1 working, 1 waiting, 1 failed)",
      "  a1 working · app-shop · PR #12 · fix the build",
      "  a2 failed · docs · of lead-app · docs",
      "  a3 waiting · docs",
    ]);
    expect(w.calls.map((c) => c.path)).toEqual(["/api/agents"]);
  });

  it("a part that cannot be read says why and does not hide the others", async () => {
    const w = world({ ...ROUTES, "GET /api/queue": () => ({ status: 503, body: { error: "chief-misconfigured" } }) });
    expect(await runFleet(undefined, [], w.deps)).toBe(0);
    expect(w.out.join("\n")).toContain("Queue: not read (chief-misconfigured)\nAgents: 3");
  });

  it("the summary caps the tickets; an unknown section prints the help", async () => {
    const many = Array.from({ length: SUMMARY_CAP + 4 }, (_, i) => ticket(`q${i}`, { createdAt: NOW - (i + 1) * HOUR, title: "x".repeat(200) + "\nsecond line" }));
    const lines = queueLines(many, NOW, SUMMARY_CAP);
    expect(lines).toHaveLength(SUMMARY_CAP + 2);
    expect(lines.at(-1)).toMatch(/^ {2}\+4 more: \S+ fleet queue$/);
    expect(lines.every((l) => l.length < 160 && !l.includes("\n"))).toBe(true);
    expect(queueLines(many, NOW, null)).toHaveLength(SUMMARY_CAP + 5);
    const w = world(ROUTES);
    expect(await runFleet("nope", [], w.deps)).toBe(2);
    expect(w.calls).toEqual([]);
  });

  it("the small parts", () => {
    expect([ago(0), ago(59 * MIN), ago(47 * HOUR), ago(48 * HOUR)]).toEqual(["now", "59m", "47h", "2d"]);
    expect(agentLines([], SUMMARY_CAP)).toEqual(["Agents: 0"]);
    expect(leadLines([], NOW)).toEqual(["Leads: 0"]);
    expect(cronLines([{ name: "one", nextRun: null, lastRun: null }], NOW)[0]).toBe("Recurring: 1 task");
    // A console from before the state: ok or did-not-finish, as before.
    expect(cronLines([
      { name: "a", nextRun: null, lastRun: { finishedAt: NOW - 10 * MIN, ok: true } },
      { name: "b", nextRun: null, lastRun: { finishedAt: NOW - 10 * MIN, ok: true, state: "clear" } },
      { name: "c", nextRun: null, lastRun: { finishedAt: NOW, ok: false, state: "failed" } },
    ], NOW)).toEqual(["Recurring: 3 tasks, 1 did not finish", "  a · ok 10m ago", "  b · all-clear 10m ago", "  c · did-not-finish now"]);
    expect(coordinatorLine({ state: "not-started", lastActivityAt: null, queuedEvents: 0, model: "sonnet" }, NOW)).toBe("Coordinator: not started · no activity yet");
  });
});

describe("coordinator", () => {
  it("with no word prints its state", async () => {
    const w = world(ROUTES);
    expect(await runCoordinator(undefined, [], w.deps)).toBe(0);
    expect(JSON.parse(w.out.join(""))).toMatchObject({ state: "waiting", model: "sonnet" });
  });
  it("tell sends the text of stdin as the caller", async () => {
    const w = world({ "POST /api/coordinator/task": () => ({ status: 202, body: { queued: true } }) }, { readStdin: async () => '{"text":"Make a ticket for X."}' });
    expect(await runCoordinator("tell", [], w.deps)).toBe(0);
    expect(w.calls[0]).toMatchObject({ method: "POST", path: "/api/coordinator/task", body: { text: "Make a ticket for X." } });
    expect(w.calls[0].headers["x-choibot-agent"]).toBe("fleet-master");
  });
  it("a refusal exits 1 with the console's words", async () => {
    const w = world({ "POST /api/coordinator/task": () => ({ status: 403, body: { error: "only the fleet master or the user gives the Coordinator a task" } }) }, { readStdin: async () => '{"text":"x"}' });
    expect(await runCoordinator("tell", [], w.deps)).toBe(1);
    expect(w.err).toEqual(["only the fleet master or the user gives the Coordinator a task"]);
  });
});
