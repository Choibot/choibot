import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { appendFile, mkdtemp, mkdir, utimes, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentApi } from "./api.js";
import { registerAuth } from "../auth.js";
import { makeSessionValue } from "../session.js";
import { SessionStore, type AgentRecord } from "./store.js";
import type { ChiefGate } from "../chief/gate.js";
import { clearSubagentSummaries } from "./subagents.js";

// The subagent side of GET /api/agents/:id/thread: `subs` in a page, the
// `?subs=` poll, and `?sub=<id>` (one subagent's own file).

let base: string;
let root: string;
let store: SessionStore;
let app: FastifyInstance;

const RUN = "a521e7a16e68e274c";   // still running
const DONE = "a60f72618901508d2";  // finished
const NESTED = "abd301715e62b8a4f"; // started by DONE
const stamp = "2026-11-10T17:30:00.000Z";
const TS = Date.parse(stamp);
const L = (o: object, sidechain = false): string => JSON.stringify({ parentUuid: null, isSidechain: sidechain, timestamp: stamp, ...o });
const S = (o: object): string => L(o, true);
const userLine = (uuid: string, text: string): object => ({ type: "user", uuid, message: { role: "user", content: text }, origin: { kind: "human" } });
const sayLine = (uuid: string, text: string, stop = "end_turn"): object => ({ type: "assistant", uuid, message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text }] } });
const toolLine = (uuid: string, id: string, name: string, description: string): object =>
  ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "tool_use", id, name, input: { command: "cat .env", prompt: "SECRET_BRIEF", description } }] } });
const resultLine = (uuid: string, id: string, agentId?: string): object => ({
  type: "user", uuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "SECRET_OUTPUT" }] },
  ...(agentId ? { toolUseResult: { isAsync: true, status: "async_launched", agentId, prompt: "SECRET_BRIEF" } } : {}),
});
const notifyLine = (uuid: string, description: string): object => ({
  type: "user", uuid, origin: { kind: "task-notification" },
  message: { role: "user", content: `<task-notification>\n<task-id>${DONE}</task-id>\n<status>completed</status>\n<summary>Agent "${description}" finished</summary>\n<result>SECRET_RESULT</result>\n</task-notification>` },
});

const rec = (over: Partial<AgentRecord>): AgentRecord => ({
  id: "a1", label: "", repo: "/r", worktree: "/w/tree", branch: "b", baseBranch: "m",
  sessionId: "sess-1", hookToken: "t", status: "idle", createdAt: 1, ...over,
});
const subDir = (): string => join(root, "-w-tree", "sess-1", "subagents");

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
  base = await mkdtemp(join(tmpdir(), "subagentroute-"));
  root = join(base, "projects");
  store = new SessionStore(join(base, "agents"));
  await mkdir(subDir(), { recursive: true });
  await writeFile(join(root, "-w-tree", "sess-1.jsonl"), [
    L(userLine("u1", "review the feature")),
    L(toolLine("t1", "toolu_1", "Agent", "Build the reminders")),
    L(resultLine("r1", "toolu_1", DONE)),
    L(toolLine("t2", "toolu_2", "Agent", "Review the reminders feature")),
    L(resultLine("r2", "toolu_2", RUN)),
    L(sayLine("a1", "Two subagents work on it.")),
    L(notifyLine("n1", "Build the reminders")),
  ].join("\n") + "\n");
  const meta = (o: object): string => JSON.stringify({ agentType: "general-purpose", spawnDepth: 1, requestShape: "background", ...o });
  await writeFile(join(subDir(), `agent-${RUN}.jsonl`), [
    S(userLine("b1", "SECRET_BRIEF review it")),
    S(toolLine("s1", "toolu_a", "Bash", "Read the spec")),
  ].join("\n") + "\n");
  await writeFile(join(subDir(), `agent-${RUN}.meta.json`), meta({ description: "Review the reminders feature", toolUseId: "toolu_2" }));
  await writeFile(join(subDir(), `agent-${DONE}.jsonl`), [
    S(userLine("b2", "Build it.")),
    S(toolLine("s2", "toolu_b", "Bash", "Run the tests")),
    S(resultLine("s3", "toolu_b")),
    S(toolLine("s4", "toolu_c", "Agent", "Fetch the facts")),
    S(resultLine("s5", "toolu_c", NESTED)),
    S(sayLine("s6", "The reminders are **built**.")),
  ].join("\n") + "\n");
  await writeFile(join(subDir(), `agent-${DONE}.meta.json`), meta({ description: "Build the reminders", toolUseId: "toolu_1", finished: true }));
  await writeFile(join(subDir(), `agent-${NESTED}.jsonl`), S(sayLine("x1", "Facts.")) + "\n");
  await writeFile(join(subDir(), `agent-${NESTED}.meta.json`), meta({ description: "Fetch the facts", toolUseId: "toolu_c", spawnDepth: 2, parentAgentId: DONE, finished: true }));
  await store.save(rec({}));
  await store.save(rec({ id: "lead1", kind: "lead", area: "console" }));
  await store.save(rec({ id: "gone", status: "done" }));
  app = build();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});
afterEach(() => { vi.unstubAllEnvs(); });

const get = (url: string, a = app) => a.inject({ method: "GET", url });

describe("GET /api/agents/:id/thread: subagents", () => {
  it("gives the state of each subagent a step of the page launched", async () => {
    const res = await get("/api/agents/a1/thread");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toMatchObject([
      { kind: "user", id: "u1" },
      { kind: "step", id: "toolu_1", tool: "Agent", label: "Build the reminders (subagent)", agent: DONE, bg: true },
      { kind: "step", id: "toolu_2", tool: "Agent", label: "Review the reminders feature (subagent)", agent: RUN, bg: true },
      { kind: "assistant", id: "a1" },
      { kind: "note", id: "n1", text: "Subagent finished: Build the reminders" },
    ]);
    expect(body.subs[DONE]).toMatchObject({ description: "Build the reminders", agentType: "general-purpose", state: "done", end: TS, steps: 2, step: "Fetch the facts (subagent)" });
    expect(body.subs[RUN]).toMatchObject({ description: "Review the reminders feature", state: "running", steps: 1, step: "Read the spec" });
    expect(Object.keys(body.subs).sort()).toEqual([RUN, DONE].sort());
    // No brief, no tool input or output, no notification text.
    expect(res.body).not.toContain("SECRET");
    expect(res.body).not.toContain("cat .env");
  });

  it("has no `subs` in a page without subagents and without `?subs=`", async () => {
    const first = (await get("/api/agents/a1/thread")).json();
    const none = (await get(`/api/agents/a1/thread?after=${first.end}&session=sess-1`)).json();
    expect(none).toMatchObject({ ok: true, items: [] });
    expect(none).not.toHaveProperty("subs");
  });

  it("answers the live poll for the subagents the client names, and follows one to its end", async () => {
    const first = (await get("/api/agents/a1/thread")).json();
    const url = `/api/agents/a1/thread?after=${first.end}&session=sess-1&subs=${RUN}`;
    const poll = (await get(url)).json();
    expect(poll.items).toEqual([]);
    expect(Object.keys(poll.subs)).toEqual([RUN]);
    expect(poll.subs[RUN]).toMatchObject({ state: "running", steps: 1 });
    await appendFile(join(subDir(), `agent-${RUN}.jsonl`), [S(toolLine("s7", "toolu_d", "Grep", "x")), S(sayLine("s8", "Review done."))].join("\n") + "\n");
    expect((await get(url)).json().subs[RUN]).toMatchObject({ state: "done", steps: 2, end: TS });
  });

  it("tells a subagent with no recorded end as stopped when the agent's process is gone", async () => {
    clearSubagentSummaries();
    await writeFile(join(subDir(), `agent-${RUN}.jsonl`), [S(userLine("b1", "review it")), S(toolLine("s1", "toolu_a", "Bash", "Read the spec"))].join("\n") + "\n");
    expect((await get("/api/agents/a1/thread")).json().subs[RUN]).toMatchObject({ state: "running" });
    expect((await get("/api/agents/gone/thread")).json().subs[RUN]).toMatchObject({ state: "stopped" });
  });

  it("quiet signal: a running subagent that writes keeps `lastEntryAt` new; one that ended does not", async () => {
    const main = join(root, "-w-tree", "sess-1.jsonl");
    const run = join(subDir(), `agent-${RUN}.jsonl`);
    const done = join(subDir(), `agent-${DONE}.jsonl`);
    const now = Date.now();
    const at = (path: string, ms: number): Promise<void> => utimes(path, ms / 1000, ms / 1000);
    await at(main, now - 30 * 60_000);
    await at(run, now - 60_000);
    await at(done, now - 5000);
    // No subagent named and none in the page: the session file's own time.
    const first = (await get("/api/agents/a1/thread")).json();
    const bare = (await get(`/api/agents/a1/thread?after=${first.end}&session=sess-1`)).json();
    expect(Math.abs(bare.lastEntryAt - (now - 30 * 60_000))).toBeLessThan(5);
    // The running one counts; the finished one (written later) does not.
    const poll = (await get(`/api/agents/a1/thread?after=${first.end}&session=sess-1&subs=${RUN},${DONE}`)).json();
    expect(poll.subs[RUN].state).toBe("running");
    expect(poll.subs[DONE].state).toBe("done");
    expect(Math.abs(poll.lastEntryAt - (now - 60_000))).toBeLessThan(5);
    // The first page gets it from the subagents of its own steps.
    expect(Math.abs(first.lastEntryAt - (now - 60_000))).toBeLessThan(5);
    // A running subagent that is silent for longer than the session file changes nothing.
    await at(run, now - 50 * 60_000);
    const old = (await get(`/api/agents/a1/thread?after=${first.end}&session=sess-1&subs=${RUN}`)).json();
    expect(old.subs[RUN].state).toBe("running");
    expect(Math.abs(old.lastEntryAt - (now - 30 * 60_000))).toBeLessThan(5);
    // A subagent's own page tells its own file's time.
    const own = (await get(`/api/agents/a1/thread?sub=${DONE}`)).json();
    expect(Math.abs(own.lastEntryAt - (now - 5000))).toBeLessThan(5);
  });

  it("serves one subagent's own steps and final message with `?sub=`", async () => {
    const res = await get(`/api/agents/a1/thread?sub=${DONE}`);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, sessionId: "sess-1", start: null });
    expect(body.items).toMatchObject([
      { kind: "user", id: "b2", text: "Build it." },
      { kind: "step", id: "toolu_b", tool: "Bash", label: "Run the tests", end: TS },
      { kind: "step", id: "toolu_c", tool: "Agent", label: "Fetch the facts (subagent)", agent: NESTED, bg: true },
      { kind: "assistant", id: "s6", text: "The reminders are **built**.", final: true },
    ]);
    // Its own state, and the state of the subagent it started.
    expect(body.subs[DONE]).toMatchObject({ state: "done", steps: 2 });
    expect(body.subs[NESTED]).toMatchObject({ state: "done", depth: 2, description: "Fetch the facts" });
    expect(res.body).not.toContain("SECRET");
    // The cursors work as on the session file.
    const none = (await get(`/api/agents/a1/thread?sub=${DONE}&after=${body.end}&session=sess-1`)).json();
    expect(none).toMatchObject({ ok: true, items: [], end: body.end });
    const older = (await get(`/api/agents/a1/thread?sub=${DONE}&before=${body.end - 10}`)).json();
    expect(older.items.map((i: { id: string }) => i.id)).toEqual(["b2", "toolu_b", "toolu_c"]);
  });

  it("answers ok:false for a subagent with no file", async () => {
    expect((await get("/api/agents/a1/thread?sub=a0000000000000000")).json()).toMatchObject({ ok: false, reason: "no-file" });
  });

  it("rejects an id that is not filename-shaped before it becomes a path", async () => {
    await writeFile(join(root, "-w-tree", "sess-1", "secret.jsonl"), S(sayLine("z", "SECRET_FILE")) + "\n");
    for (const bad of ["..%2Fsecret", "..", "a%2Fb", "agent-x", "a.b", "", `${DONE}%00`]) {
      const one = await get(`/api/agents/a1/thread?sub=${bad}`);
      expect(one.statusCode).toBe(400);
      expect(one.body).not.toContain("SECRET");
      expect((await get(`/api/agents/a1/thread?subs=${DONE},${bad}`)).statusCode).toBe(400);
    }
    expect((await get(`/api/agents/a1/thread?subs=${"a".repeat(4000)}`)).statusCode).toBe(400);
    expect((await get(`/api/agents/a1/thread?sub=${DONE}&sub=${RUN}`)).statusCode).toBe(400);
  });

  it("sits behind the session cookie", async () => {
    const remote = "203.0.113.7";
    const denied = await app.inject({ method: "GET", url: `/api/agents/a1/thread?sub=${DONE}`, remoteAddress: remote });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain("built");
    const withToken = await app.inject({ method: "GET", url: `/api/agents/a1/thread?sub=${DONE}&token=t`, remoteAddress: remote });
    expect(withToken.statusCode).toBe(401);
    const cookie = app.signCookie(makeSessionValue(60_000));
    const ok = await app.inject({ method: "GET", url: `/api/agents/a1/thread?sub=${DONE}`, remoteAddress: remote, cookies: { session: cookie } });
    expect(ok.statusCode).toBe(200);
  });

  it("hardened: a subagent of a lead needs the paired user, as the lead's thread does", async () => {
    const gate = (level: "user" | "none"): ChiefGate =>
      ({ misconfigured: null, userAuth: "log", caller: async () => ({ level }) }) as unknown as ChiefGate;
    const HARD = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:1", CHIEF_AGENT_UID: "1001" };
    for (const [k, v] of Object.entries(HARD)) vi.stubEnv(k, v);
    const anon = build(gate("none"));
    await anon.ready();
    for (const q of [`sub=${DONE}`, `subs=${DONE}`]) {
      const lead = await get(`/api/agents/lead1/thread?${q}`, anon);
      expect(lead.statusCode).toBe(403);
      expect(lead.json()).toMatchObject({ error: "pair-required" });
      expect(lead.body).not.toContain("built");
    }
    expect((await get(`/api/agents/a1/thread?sub=${DONE}`, anon)).statusCode).toBe(200);
    await anon.close();
    const paired = build(gate("user"));
    await paired.ready();
    const ok = await get(`/api/agents/lead1/thread?sub=${DONE}`, paired);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items.at(-1)).toMatchObject({ kind: "assistant", final: true });
    await paired.close();
  });
});
