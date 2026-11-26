import { describe, it, expect } from "vitest";
import { runLeads, type LeadsDeps } from "./leads.js";

type Call = { method: string; path: string; body: any; headers: Record<string, string> };

function world(routes: Record<string, (body: any) => { status?: number; body?: unknown }>, o: Partial<LeadsDeps> = {}) {
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
  const deps: Partial<LeadsDeps> = {
    fetch: f, readStdin: async () => "", stdinIsTTY: false, stderrIsTTY: true,
    out: (s) => out.push(s), err: (s) => err.push(s),
    env: { HOME: "/nonexistent/leads-test-home", PORT: "4321", CHOIBOT_AGENT_ID: "lead-app-shop", CHOIBOT_AGENT_PASS: "p1", CHOIBOT_USER_TOKEN: "ut" },
    flags: {}, readFile: () => null,
    ...o,
  };
  return { calls, out, err, deps };
}

describe("choibot leads", () => {
  it("show of an unknown area exits 1 with unknown area", async () => {
    const w = world({ "GET /api/leads/nope": () => ({ status: 404, body: { error: "unknown area" } }) });
    expect(await runLeads("show", ["nope"], w.deps)).toBe(1);
    expect(w.err).toEqual(["unknown area"]);
  });
  it("show prints the route body", async () => {
    const body = { area: "app-shop", repos: ["app-shop"], leadId: "lead-app-shop", report: "r" };
    const w = world({ "GET /api/leads/app-shop": () => ({ body }) });
    expect(await runLeads("show", ["app-shop"], w.deps)).toBe(0);
    expect(JSON.parse(w.out.join(""))).toEqual(body);
  });
  it("start sends area and repos with only x-choibot-user", async () => {
    const w = world({ "POST /api/leads": () => ({ body: { id: "lead-app-shop" } }) }, { flags: { repos: "app-shop", "user-token": "ut" } });
    expect(await runLeads("start", ["app-shop"], w.deps)).toBe(0);
    expect(w.calls[0].body).toEqual({ area: "app-shop", repos: ["app-shop"] });
    expect(Object.keys(w.calls[0].headers).filter((k) => k.startsWith("x-choibot"))).toEqual(["x-choibot-user"]);
    expect(JSON.parse(w.out.join(""))).toEqual({ id: "lead-app-shop" });
  });
  it("start splits a comma list and needs an area and --repos", async () => {
    const w = world({ "POST /api/leads": () => ({ body: { id: "x" } }) }, { flags: { repos: "a, b", "user-token": "ut" } });
    await runLeads("start", ["x"], w.deps);
    expect(w.calls[0].body.repos).toEqual(["a", "b"]);
    const bad = world({}, { flags: {} });
    expect(await runLeads("start", ["x"], bad.deps)).toBe(1);
    expect(await runLeads("start", [], world({}, { flags: { repos: "a" } }).deps)).toBe(1);
    expect(bad.calls).toEqual([]);
  });
  it("report sends the stdin JSON with agent headers", async () => {
    const w = world({ "POST /api/leads/report": () => ({ body: { ok: true } }) }, { readStdin: async () => '{"text":"hi"}' });
    expect(await runLeads("report", [], w.deps)).toBe(0);
    expect(w.calls[0].body).toEqual({ text: "hi" });
    expect(w.calls[0].headers["x-choibot-agent"]).toBe("lead-app-shop");
  });
  it("list prints the rows with sessionId and cwd", async () => {
    const rows = [{ area: "app-shop", repos: [], leadId: "lead-app-shop", status: "idle", reportAt: null, sessionId: "s", cwd: "/c" }];
    const w = world({ "GET /api/leads": () => ({ body: rows }) });
    expect(await runLeads("list", [], w.deps)).toBe(0);
    expect(JSON.parse(w.out.join(""))).toEqual(rows);
  });
});
