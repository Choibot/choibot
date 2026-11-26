import { describe, it, expect } from "vitest";
import { runRemind, type RemindDeps } from "./remind.js";

type Call = { method: string; path: string; search: string; body: any; headers: Record<string, string> };
type Route = (body: any) => { status?: number; body?: unknown; raw?: string };

function world(routes: Record<string, Route>, o: Partial<RemindDeps> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const h = routes[`${method} ${u.pathname}`];
    // An unregistered route (flag off) is Next's HTML 404 page, not JSON.
    const r = h ? h(body) : { status: 404, raw: "<!DOCTYPE html><title>404</title>" };
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  const deps: Partial<RemindDeps> = {
    fetch: f, readStdin: async () => "", stdinIsTTY: false, stderrIsTTY: false,
    out: (s) => out.push(s), err: (s) => err.push(s),
    env: { HOME: "/nonexistent/remind-test-home", PORT: "4321", CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p1" },
    flags: {}, readFile: () => null,
    ...o,
  };
  return { calls, out, err, deps };
}

const DUE = Date.parse("2026-11-13T15:40:00Z");
const R = { id: "r_ab12cd34", agentId: "a1", agentLabel: "app", setBy: "a1", createdAt: Date.parse("2026-11-10T15:40:00Z"), dueAt: DUE, text: "check the canary", state: "open", attempts: 0, updatedAt: 1 };

describe("choibot remind add", () => {
  it("sends --in and --text with the agent headers and prints {id, dueAt}", async () => {
    const w = world({ "POST /api/reminders": () => ({ body: { id: "r_ab12cd34", dueAt: DUE } }) }, { flags: { in: "3d", text: "check the canary" } });
    expect(await runRemind("add", [], w.deps)).toBe(0);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].body).toEqual({ in: "3d", text: "check the canary" });
    expect(w.calls[0].headers["x-choibot-agent"]).toBe("a1");
    expect(w.calls[0].headers["x-choibot-agent-token"]).toBe("p1");
    expect(JSON.parse(w.out.join(""))).toEqual({ id: "r_ab12cd34", dueAt: "2026-11-13T15:40:00.000Z" });
  });
  it("--at and --agent go in the body; --agent never becomes the caller's identity", async () => {
    const w = world({ "POST /api/reminders": () => ({ body: { id: "r_ab12cd34", dueAt: DUE } }) },
      { flags: { at: "2026-11-13T15:40:00Z", text: "t", agent: "w1" }, env: { PORT: "4321", CHOIBOT_AGENT_ID: "fleet-master", CHOIBOT_AGENT_PASS: "pm" } });
    expect(await runRemind("add", [], w.deps)).toBe(0);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].body).toEqual({ at: "2026-11-13T15:40:00Z", text: "t", agentId: "w1" });
    expect(w.calls[0].headers["x-choibot-agent"]).toBe("fleet-master");
  });
  it.each([
    [{ text: "t" }, "exactly one of --in or --at"],
    [{ in: "1h", at: "2026-11-13T15:40:00Z", text: "t" }, "exactly one of --in or --at"],
    [{ in: "1h" }, "--text"],
    [{ in: true, text: "t" }, "--in needs a value"],
    [{ in: "1h", text: true }, "--text needs a value"],
    [{ in: "1h", text: "t", agent: true }, "--agent needs a value"],
  ] as const)("refuses %j with no request", async (flags, why) => {
    const w = world({}, { flags: { ...flags } });
    expect(await runRemind("add", [], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.err.join("")).toContain(why);
  });
  it("prints the server's refusal", async () => {
    const w = world({ "POST /api/reminders": () => ({ status: 403, body: { error: "you may manage reminders only for yourself" } }) },
      { flags: { in: "1h", text: "t", agent: "a2" } });
    expect(await runRemind("add", [], w.deps)).toBe(1);
    expect(w.err).toEqual(["you may manage reminders only for yourself"]);
  });
  it("says the feature is off when the console has no reminder routes", async () => {
    const w = world({}, { flags: { in: "1h", text: "t" } });
    expect(await runRemind("add", [], w.deps)).toBe(1);
    expect(w.err.join("")).toMatch(/reminders are off/);
  });
});

describe("choibot remind list", () => {
  it("lists the caller's open reminders with readable dates", async () => {
    const w = world({ "GET /api/reminders": () => ({ body: { reminders: [R], serverNow: 1 } }) });
    expect(await runRemind("list", [], w.deps)).toBe(0);
    expect(w.calls[0].search).toBe("?status=open");
    expect(JSON.parse(w.out.join(""))).toEqual([{
      id: "r_ab12cd34", agentId: "a1", setBy: "a1", state: "open", dueAt: "2026-11-13T15:40:00.000Z",
      createdAt: "2026-11-10T15:40:00.000Z", text: "check the canary",
    }]);
  });
  it("--all asks for every state; --agent filters by target", async () => {
    const w = world({ "GET /api/reminders": () => ({ body: { reminders: [R, { ...R, id: "r_ab12cd35", agentId: "w1" }] } }) },
      { flags: { all: true, agent: "w1" } });
    expect(await runRemind("list", [], w.deps)).toBe(0);
    expect(w.calls[0].search).toBe("?status=all");
    expect(Object.keys(w.calls[0].headers)).not.toContain("x-choibot-user");
    expect(w.calls[0].headers["x-choibot-agent"]).toBe("a1");
    expect(JSON.parse(w.out.join("")).map((r: { id: string }) => r.id)).toEqual(["r_ab12cd35"]);
  });
  it("a human shell sends the user token", async () => {
    const w = world({ "GET /api/reminders": () => ({ body: { reminders: [] } }) },
      { env: { HOME: "/nonexistent/remind-test-home", PORT: "4321", CHOIBOT_USER_TOKEN: "ut" }, stderrIsTTY: true });
    expect(await runRemind("list", [], w.deps)).toBe(0);
    expect(w.calls[0].headers["x-choibot-user"]).toBe("ut");
  });
});

describe("choibot remind cancel", () => {
  it("posts the cancel and prints the reminder", async () => {
    const w = world({ "POST /api/reminders/r_ab12cd34/cancel": () => ({ body: { ...R, state: "cancelled", cancelledBy: "a1" } }) });
    expect(await runRemind("cancel", ["r_ab12cd34"], w.deps)).toBe(0);
    expect(w.calls[0].method).toBe("POST");
    expect(JSON.parse(w.out.join(""))).toMatchObject({ id: "r_ab12cd34", state: "cancelled", dueAt: "2026-11-13T15:40:00.000Z" });
  });
  it.each([undefined, "..", "r_1", "q12345678", "r_ab12cd34/x"])("refuses id %s with no request", async (id) => {
    const w = world({});
    expect(await runRemind("cancel", id === undefined ? [] : [id], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
  it("prints a 404 error body as it is", async () => {
    const w = world({ "POST /api/reminders/r_ab12cd34/cancel": () => ({ status: 404, body: { error: "not found" } }) });
    expect(await runRemind("cancel", ["r_ab12cd34"], w.deps)).toBe(1);
    expect(w.err).toEqual(["not found"]);
  });
});

describe("choibot remind help", () => {
  it("prints the help and exits 2 for an unknown sub", async () => {
    const w = world({});
    expect(await runRemind("bogus", [], w.deps)).toBe(2);
    expect(w.out.join("")).toContain("remind add --in");
  });
});

describe("choibot remind through bin/choibot.ts", () => {
  it("parses --in and a quoted --text and sends the agent identity", async () => {
    const { createServer } = await import("node:http");
    const { spawn } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const seen: { url?: string; body: any; agent?: string }[] = [];
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen.push({ url: req.url, body: b ? JSON.parse(b) : undefined, agent: req.headers["x-choibot-agent"] as string });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "r_ab12cd34", dueAt: DUE }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const home = mkdtempSync(join(tmpdir(), "choibot-remind-"));
    try {
      const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn("./node_modules/.bin/tsx", ["bin/choibot.ts", "remind", "add", "--in", "30m", "--text", "check the canary"], {
          cwd: root, timeout: 30000,
          env: { PATH: process.env.PATH ?? "", PORT: String(port), HOME: home, CHIEF_TEST: "1", CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p1" } as unknown as NodeJS.ProcessEnv,
        });
        let stdout = "", stderr = "";
        child.stdout!.on("data", (d: Buffer) => (stdout += d));
        child.stderr!.on("data", (d: Buffer) => (stderr += d));
        child.on("error", (e) => resolve({ status: null, stdout, stderr: String(e) }));
        child.on("close", (status: number | null) => resolve({ status, stdout, stderr }));
      });
      expect(r.status, r.stderr).toBe(0);
      expect(seen).toEqual([{ url: "/api/reminders", body: { in: "30m", text: "check the canary" }, agent: "a1" }]);
      expect(JSON.parse(r.stdout)).toEqual({ id: "r_ab12cd34", dueAt: "2026-11-13T15:40:00.000Z" });
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 40000);
});
