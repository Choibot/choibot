// server/widgets/api.test.ts — HTTP routes for agent widgets, driven with fastify inject.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWidgetsApi } from "./api.js";
import { WidgetStore } from "./store.js";
import { AgentTyper } from "./agent.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";

let base: string;
let app: FastifyInstance;
let agents: SessionStore;
let widgets: WidgetStore;
let writes: string[];

function rec(id: string, over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id, label: id, repo: "", worktree: base, branch: "", baseBranch: "", sessionId: null,
    hookToken: "t", status: "idle", createdAt: 1, cwd: base, ...over,
  };
}

async function widget(agentId: string, wid: string, files: Record<string, string> = {}, exec: string[] = []): Promise<string> {
  const dir = join(widgets.root, agentId, wid);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries({ "widget.html": "<p>hi</p>", ...files })) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
    if (exec.includes(name)) await chmod(join(dir, name), 0o755);
  }
  return dir;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "widgets-api-"));
  agents = new SessionStore(join(base, "agents"));
  widgets = new WidgetStore(join(base, "widgets"));
  writes = [];
  const terminals = {
    has: () => true, hasSession: async () => true, inputReady: () => true, reattach: async () => null,
    write: (_id: string, d: string) => { writes.push(d); },
  };
  app = Fastify();
  registerWidgetsApi(app, { agents, widgets, typer: new AgentTyper({ terminals, sleep: async () => {} }), workspaceDir: base });
  await app.ready();
  await agents.save(rec("a1"));
});
afterEach(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

const W = "/api/agents/a1/widgets";
const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, payload });
const put = (url: string, payload: object) => app.inject({ method: "PUT", url, payload });

describe("GET /api/agents/:id/widgets", () => {
  it("lists the agent's widgets", async () => {
    await widget("a1", "w1", { "meta.json": JSON.stringify({ title: "T" }) });
    const res = await app.inject({ method: "GET", url: W });
    expect(res.statusCode).toBe(200);
    expect(res.json().widgets).toMatchObject([{ id: "w1", title: "T", hasRefresh: false }]);
  });
  it("404s a lead", async () => {
    await agents.save(rec("lead-app-shop", { kind: "lead" }));
    expect((await app.inject({ method: "GET", url: "/api/agents/lead-app-shop/widgets" })).statusCode).toBe(404);
  });

  it("404s an unknown agent, a master agent and a malformed id", async () => {
    await agents.save(rec("fleet-master", { kind: "fleet-master" }));
    expect((await app.inject({ method: "GET", url: "/api/agents/nope/widgets" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/agents/fleet-master/widgets" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/agents/%2E%2E/widgets" })).statusCode).toBe(404);
  });
});

describe("GET /api/agents/:id/widgets/:wid", () => {
  it("returns html, data, history and state; ?since leaves out html", async () => {
    await widget("a1", "w1", { "data.json": '{"n":1}', "history.jsonl": '{"at":1,"data":1}\n{"at":2,"data":2}\n' });
    const full = (await app.inject({ method: "GET", url: `${W}/w1` })).json();
    expect(full).toEqual({ html: "<p>hi</p>", data: { n: 1 }, history: [{ at: 1, data: 1 }, { at: 2, data: 2 }], state: {} });
    const part = (await app.inject({ method: "GET", url: `${W}/w1?since=1` })).json();
    expect(part).toEqual({ data: { n: 1 }, history: [{ at: 2, data: 2 }], state: {} });
  });
  it("404s an unknown or malformed widget id; 413 for widget.html over 1 MB", async () => {
    expect((await app.inject({ method: "GET", url: `${W}/nope` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${W}/Bad` })).statusCode).toBe(404);
    await widget("a1", "big", { "widget.html": "x".repeat(1024 * 1024 + 1) });
    expect((await app.inject({ method: "GET", url: `${W}/big` })).statusCode).toBe(413);
  });
});

describe("POST refresh", () => {
  it("script mode: runs the script and answers with data and status", async () => {
    await widget("a1", "w1", { refresh: "#!/bin/sh\necho '{\"n\":5}'\n" }, ["refresh"]);
    const res = await post(`${W}/w1/refresh`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: "script", data: { n: 5 }, status: { ok: true, mode: "script" } });
  });
  it("agent mode: 428 with the exact text and nothing typed until confirmed", async () => {
    await widget("a1", "w1");
    const res = await post(`${W}/w1/refresh`);
    expect(res.statusCode).toBe(428);
    expect(res.json()).toEqual({
      needsConfirm: true,
      text: `[widget w1] Refresh: get fresh data and write it as JSON to ${join(widgets.root, "a1", "w1")}/data.json.`,
    });
    expect(writes).toEqual([]);
  });
  it("agent mode confirmed: types the text; a second one within 10 s is 429", async () => {
    await widget("a1", "w1");
    const res = await post(`${W}/w1/refresh`, { confirmed: true, args: { d: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "agent" });
    expect(writes[0]).toContain("[widget w1] Refresh: get fresh data");
    expect(writes[0]).toContain(' Args: {"d":1}');
    expect((await post(`${W}/w1/refresh`, { confirmed: true })).statusCode).toBe(429);
  });
  it("409 for an issue agent and for an agent that is not running, before any confirm", async () => {
    await agents.save(rec("i1", { kind: "issue" }));
    await agents.save(rec("d1", { status: "done" }));
    await widget("i1", "w1");
    await widget("d1", "w1");
    const issue = await post("/api/agents/i1/widgets/w1/refresh");
    expect(issue.statusCode).toBe(409);
    expect(issue.json().error).toBe("not for issue agents");
    const done = await post("/api/agents/d1/widgets/w1/refresh");
    expect(done.statusCode).toBe(409);
    expect(done.json().error).toBe("agent not running");
  });
  it("agent mode: 400 when the args make the message too long; nothing typed", async () => {
    await widget("a1", "w1");
    const res = await post(`${W}/w1/refresh`, { confirmed: true, args: { s: "x".repeat(2000) } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("args too long");
    expect(writes).toEqual([]);
  });
  it("agent mode: the 428 text is exactly the typed text", async () => {
    await widget("a1", "w1");
    const args = { note: "a\n\nb" };
    const first = await post(`${W}/w1/refresh`, { args });
    expect(first.statusCode).toBe(428);
    await post(`${W}/w1/refresh`, { args, confirmed: true });
    expect(writes[0]).toBe(`\x1b[200~${first.json().text}\x1b[201~`);
  });
  it("415 for a text/plain body", async () => {
    await widget("a1", "w1");
    const res = await app.inject({
      method: "POST", url: `${W}/w1/refresh`, headers: { "content-type": "text/plain" }, payload: "{}",
    });
    expect(res.statusCode).toBe(415);
  });
});

describe("POST ask", () => {
  it("428 with the text, then types it once confirmed", async () => {
    await widget("a1", "w1");
    const first = await post(`${W}/w1/ask`, { text: "hello" });
    expect(first.statusCode).toBe(428);
    expect(first.json()).toEqual({ needsConfirm: true, text: "[widget w1] hello" });
    const ok = await post(`${W}/w1/ask`, { text: "hello", confirmed: true });
    expect(ok.json()).toEqual({ ok: true });
    expect(writes[0]).toBe("\x1b[200~[widget w1] hello\x1b[201~");
  });
  it("400 without text", async () => {
    await widget("a1", "w1");
    expect((await post(`${W}/w1/ask`, { text: "  " })).statusCode).toBe(400);
  });
  it("the 428 text is exactly the typed text, whitespace collapsed", async () => {
    await widget("a1", "w1");
    const text = "line 1\n\n\n\n\n\nhidden line\t\tend";
    const first = await post(`${W}/w1/ask`, { text });
    expect(first.json().text).toBe("[widget w1] line 1 hidden line end");
    await post(`${W}/w1/ask`, { text, confirmed: true });
    expect(writes[0]).toBe(`\x1b[200~${first.json().text}\x1b[201~`);
  });
});

describe("POST action", () => {
  it("returns the result; bad name 400; missing script 400 not runnable", async () => {
    await widget("a1", "w1", { "actions/echo": "#!/bin/sh\ncat\n" }, ["actions/echo"]);
    const res = await post(`${W}/w1/action`, { name: "echo", args: { a: 1 } });
    expect(res.json()).toEqual({ result: { a: 1 } });
    expect((await post(`${W}/w1/action`, { name: "../x" })).statusCode).toBe(400);
    const missing = await post(`${W}/w1/action`, { name: "nope" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("not runnable");
  });
});

describe("PUT state and ui", () => {
  it("saves state; 400 without state; 413 over 64 KB; 404 unknown widget", async () => {
    await widget("a1", "w1");
    expect((await put(`${W}/w1/state`, { state: { tab: 2 } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: `${W}/w1` })).json().state).toEqual({ tab: 2 });
    expect((await put(`${W}/w1/state`, {})).statusCode).toBe(400);
    expect((await put(`${W}/w1/state`, { state: "x".repeat(70_000) })).statusCode).toBe(413);
    expect((await put(`${W}/nope/state`, { state: {} })).statusCode).toBe(404);
  });
  it("saves ui overrides that the list applies", async () => {
    await widget("a1", "w1");
    expect((await put(`${W}/w1/ui`, { width: "wide", autoRefresh: null })).json()).toEqual({ ok: true });
    const [w] = (await app.inject({ method: "GET", url: W })).json().widgets;
    expect(w).toMatchObject({ width: "wide", autoRefresh: null });
  });
});

describe("DELETE", () => {
  it("removes the widget folder, then 404s", async () => {
    const dir = await widget("a1", "w1");
    expect((await app.inject({ method: "DELETE", url: `${W}/w1` })).json()).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(false);
    expect((await app.inject({ method: "DELETE", url: `${W}/w1` })).statusCode).toBe(404);
  });
});
