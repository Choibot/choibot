import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentApi } from "./api.js";
import { registerAuth } from "../auth.js";
import { makeSessionValue } from "../session.js";
import { SessionStore, type AgentRecord } from "./store.js";
import type { ChiefGate } from "../chief/gate.js";

let base: string;
let root: string;
let store: SessionStore;
let app: FastifyInstance;

const stamp = "2026-11-10T17:30:00.000Z";
const L = (o: object): string => JSON.stringify({ parentUuid: null, isSidechain: false, timestamp: stamp, ...o });
const userLine = (uuid: string, text: string): string => L({ type: "user", uuid, message: { role: "user", content: text }, origin: { kind: "human" } });
const sayLine = (uuid: string, text: string): string => L({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
const toolLine = (uuid: string, id: string): string =>
  L({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "cat .env", description: "Run the tests" } }] } });
const resultLine = (uuid: string, id: string): string =>
  L({ type: "user", uuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "SECRET_TOKEN=abc" }] } });

const rec = (over: Partial<AgentRecord>): AgentRecord => ({
  id: "a1", label: "", repo: "/r", worktree: "/w/tree", branch: "b", baseBranch: "m",
  sessionId: "sess-1", hookToken: "t", status: "running", createdAt: 1, ...over,
});
const sessionPath = (id: string, cwdSlug = "-w-tree"): string => join(root, cwdSlug, `${id}.jsonl`);

function build(chief?: ChiefGate): FastifyInstance {
  const a = Fastify();
  registerAuth(a);
  registerAgentApi(a, {
    terminals: { has: () => false } as never,
    store,
    hub: { emitEvent: () => {} } as never,
    workspaceDir: base,
    projectsRoot: root,
    ...(chief ? { chief } : {}),
  });
  return a;
}

beforeAll(async () => {
  process.env.CONSOLE_COOKIE_SECRET = "x".repeat(32);
  base = await mkdtemp(join(tmpdir(), "threadroute-"));
  root = join(base, "projects");
  store = new SessionStore(join(base, "agents"));
  await mkdir(join(root, "-w-tree"), { recursive: true });
  await writeFile(sessionPath("sess-1"), [
    userLine("u1", "run the tests"),
    L({ type: "user", uuid: "n1", message: { content: "<task-notification>\n<task-id>b1</task-id></task-notification>" }, origin: { kind: "task-notification" } }),
    toolLine("t1", "toolu_1"),
    resultLine("r1", "toolu_1"),
    JSON.stringify({ type: "api-request-blob", sessionId: "sess-1", message: "SECRET_BLOB" }),
    sayLine("a1", "All tests pass."),
  ].join("\n") + "\n");
  await writeFile(sessionPath("sess-2"), userLine("u9", "a new session") + "\n");
  await store.save(rec({}));
  await store.save(rec({ id: "codex1", runtime: "codex" }));
  await store.save(rec({ id: "nosession", sessionId: null }));
  await store.save(rec({ id: "nofile", sessionId: "sess-none" }));
  await store.save(rec({ id: "badid", sessionId: "../../../etc/passwd" }));
  await store.save(rec({ id: "lead1", kind: "lead", area: "console" }));
  app = build();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});
afterEach(() => { vi.unstubAllEnvs(); });

const get = (url: string, a = app) => a.inject({ method: "GET", url });

describe("GET /api/agents/:id/thread", () => {
  it("returns the conversation: prompts, agent text and steps, without harness noise", async () => {
    const res = await get("/api/agents/a1/thread");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({ ok: true, sessionId: "sess-1", status: "running", start: null });
    expect(typeof body.now).toBe("number");
    expect(body.items).toEqual([
      { kind: "user", id: "u1", ts: Date.parse(stamp), text: "run the tests" },
      { kind: "step", id: "toolu_1", ts: Date.parse(stamp), tool: "Bash", label: "Run the tests", end: Date.parse(stamp) },
      { kind: "assistant", id: "a1", ts: Date.parse(stamp), text: "All tests pass." },
    ]);
    // A tool's input and output never leave the server.
    expect(res.body).not.toContain("SECRET");
    expect(res.body).not.toContain("cat .env");
  });

  it("returns only the appended items for an `after` cursor", async () => {
    const first = (await get("/api/agents/a1/thread")).json();
    const none = (await get(`/api/agents/a1/thread?after=${first.end}&session=sess-1`)).json();
    expect(none).toMatchObject({ ok: true, items: [], end: first.end });
    expect(none.reset).toBeUndefined();
    await appendFile(sessionPath("sess-1"), sayLine("a2", "One more thing.") + "\n");
    const next = (await get(`/api/agents/a1/thread?after=${first.end}&session=sess-1`)).json();
    expect(next.items).toMatchObject([{ kind: "assistant", id: "a2" }]);
    expect(next.end).toBeGreaterThan(first.end);
  });

  it("gives the time of the session's last entry, also on a poll with no change", async () => {
    await writeFile(sessionPath("sess-quiet"), [userLine("q1", "build it"), toolLine("q2", "toolu_q")].join("\n") + "\n");
    const at = Date.parse(stamp) + 1000;
    await utimes(sessionPath("sess-quiet"), at / 1000, at / 1000);
    await store.save(rec({ id: "quiet1", sessionId: "sess-quiet" }));
    const first = (await get("/api/agents/quiet1/thread")).json();
    expect(first).toMatchObject({ ok: true, lastEntryAt: at });
    expect(first.items[1]).toEqual({ kind: "step", id: "toolu_q", ts: Date.parse(stamp), tool: "Bash", label: "Run the tests" });
    const poll = (await get(`/api/agents/quiet1/thread?after=${first.end}&session=sess-quiet`)).json();
    expect(poll).toMatchObject({ ok: true, items: [], end: first.end, lastEntryAt: at });
    // No session file: no time.
    expect((await get("/api/agents/nofile/thread")).json().lastEntryAt).toBeUndefined();
  });

  it("pages back with a `before` cursor", async () => {
    const tail = (await get("/api/agents/a1/thread")).json();
    const cut = tail.end - Buffer.byteLength(sayLine("a2", "One more thing.") + "\n");
    const older = (await get(`/api/agents/a1/thread?before=${cut}`)).json();
    expect(older.items.map((i: { id: string }) => i.id)).toEqual(["u1", "toolu_1", "a1"]);
    expect(older.reset).toBeUndefined();
  });

  it("resets to the tail when the cursor is past the end of the file", async () => {
    const body = (await get("/api/agents/a1/thread?after=999999999&session=sess-1")).json();
    expect(body).toMatchObject({ ok: true, reset: true });
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("resets when the agent moved to a new session", async () => {
    await store.patch("a1", { sessionId: "sess-2" });
    try {
      const body = (await get("/api/agents/a1/thread?after=10&session=sess-1")).json();
      expect(body).toMatchObject({ ok: true, sessionId: "sess-2", reset: true });
      expect(body.items).toMatchObject([{ kind: "user", text: "a new session" }]);
    } finally {
      await store.patch("a1", { sessionId: "sess-1" });
    }
  });

  it("answers ok:false when there is no session file to read", async () => {
    expect((await get("/api/agents/codex1/thread")).json()).toMatchObject({ ok: false, reason: "runtime", status: "running" });
    expect((await get("/api/agents/nosession/thread")).json()).toMatchObject({ ok: false, reason: "no-session" });
    expect((await get("/api/agents/nofile/thread")).json()).toMatchObject({ ok: false, reason: "no-file" });
  });

  it("never reads a path built from a session id that is not filename-shaped", async () => {
    const res = await get("/api/agents/badid/thread");
    expect(res.json()).toMatchObject({ ok: false, reason: "no-session" });
    expect(res.body).not.toContain("root:");
  });

  it("rejects a bad cursor and an unknown agent", async () => {
    expect((await get("/api/agents/a1/thread?before=abc")).statusCode).toBe(400);
    expect((await get("/api/agents/a1/thread?after=-1")).statusCode).toBe(400);
    expect((await get("/api/agents/a1/thread?after=1&before=2")).statusCode).toBe(400);
    expect((await get("/api/agents/ghost/thread")).statusCode).toBe(404);
    expect((await get("/api/agents/x%2F..%2Fa1/thread")).statusCode).toBe(404);
  });

  it("sits behind the session cookie like the other agent routes", async () => {
    const remote = "203.0.113.7";
    const denied = await app.inject({ method: "GET", url: "/api/agents/a1/thread", remoteAddress: remote });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain("run the tests");
    // The hook token opens only the hook route, never the thread.
    const withToken = await app.inject({ method: "GET", url: "/api/agents/a1/thread?token=t", remoteAddress: remote });
    expect(withToken.statusCode).toBe(401);
    const cookie = app.signCookie(makeSessionValue(60_000));
    const ok = await app.inject({ method: "GET", url: "/api/agents/a1/thread", remoteAddress: remote, cookies: { session: cookie } });
    expect(ok.statusCode).toBe(200);
  });

  describe("chief", () => {
    const gate = (level: "user" | "none"): ChiefGate =>
      ({ misconfigured: null, userAuth: "log", caller: async () => ({ level }) }) as unknown as ChiefGate;
    const HARD = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:1", CHIEF_AGENT_UID: "1001" };

    it("hardened: a lead's thread needs the paired user; a worker's does not", async () => {
      for (const [k, v] of Object.entries(HARD)) vi.stubEnv(k, v);
      const anon = build(gate("none"));
      await anon.ready();
      const lead = await get("/api/agents/lead1/thread", anon);
      expect(lead.statusCode).toBe(403);
      expect(lead.json()).toMatchObject({ error: "pair-required" });
      expect((await get("/api/agents/a1/thread", anon)).statusCode).toBe(200);
      await anon.close();
      const paired = build(gate("user"));
      await paired.ready();
      expect((await get("/api/agents/lead1/thread", paired)).statusCode).toBe(200);
      await paired.close();
    });

    it("not hardened: a lead's thread reads like any agent's", async () => {
      const anon = build(gate("none"));
      await anon.ready();
      const res = await get("/api/agents/lead1/thread", anon);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, sessionId: "sess-1" });
      await anon.close();
    });
  });
});
