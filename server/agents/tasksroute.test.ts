import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentApi } from "./api.js";
import { SessionStore } from "./store.js";

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "tasksroute-"));
  const store = new SessionStore(join(base, "agents"));
  await store.save({
    id: "withtasks", label: "", repo: "/r", worktree: "/w", branch: "b", baseBranch: "m",
    sessionId: "sess-1", hookToken: "t", status: "idle", createdAt: 1,
  });
  await store.save({
    id: "nosession", label: "", repo: "/r", worktree: "/w", branch: "b", baseBranch: "m",
    sessionId: null, hookToken: "t", status: "idle", createdAt: 1,
  });
  await store.save({
    id: "nodir", label: "", repo: "/r", worktree: "/w", branch: "b", baseBranch: "m",
    sessionId: "sess-none", hookToken: "t", status: "idle", createdAt: 1,
  });
  const tasksRoot = join(base, "tasks");
  await mkdir(join(tasksRoot, "sess-1"), { recursive: true });
  await writeFile(join(tasksRoot, "sess-1", "2.json"), JSON.stringify({ id: "2", subject: "Second", status: "in_progress", activeForm: "Doing second" }));
  await writeFile(join(tasksRoot, "sess-1", "1.json"), JSON.stringify({ id: "1", subject: "First", status: "completed" }));
  await writeFile(join(tasksRoot, "sess-1", "10.json"), JSON.stringify({ id: "10", subject: "Tenth" }));
  await writeFile(join(tasksRoot, "sess-1", ".lock"), "");
  await writeFile(join(tasksRoot, "sess-1", "junk.json"), "not json");

  app = Fastify();
  registerAgentApi(app, {
    terminals: { has: () => false } as never,
    store,
    hub: { emitEvent: () => {} } as never,
    workspaceDir: base,
    // Injected, not an env var: the route hands it to readPlan as a dependency,
    // so nothing ambient can repoint the Plan rail in production.
    tasksRoot,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

describe("GET /api/agents/:id/tasks", () => {
  it("returns normalized tasks sorted by numeric id, skipping junk and dot-files", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/withtasks/tasks" });
    expect(res.statusCode).toBe(200);
    const tasks = res.json().tasks as { id: string; subject: string; status: string; activeForm?: string }[];
    expect(tasks.map((t) => t.id)).toEqual(["1", "2", "10"]);
    expect(tasks[1]).toEqual({ id: "2", subject: "Second", status: "in_progress", activeForm: "Doing second" });
    expect(tasks[2].status).toBe("pending"); // missing status normalized
  });
  it("returns empty for an agent with no session id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/nosession/tasks" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tasks).toEqual([]);
  });
  it("returns empty when the session has no tasks directory", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/nodir/tasks" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tasks).toEqual([]);
  });
  it("404s an unknown agent", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents/ghost/tasks" });
    expect(res.statusCode).toBe(404);
  });
});

// Basic protection, an agent pinned to another Claude login (accounts.ts): Claude Code keeps the
// task files in ITS config folder, the login's folder. Its `tasks` is a link to the default
// login's folder only when that folder was there at the sync; else Claude makes a real `tasks/`
// in the login's folder (on the owner's console: ~/.claude-accounts/choibot has no `tasks` entry).
// The rail reads the folder of the agent's own login.
describe("GET /api/agents/:id/tasks with a pinned login (basic protection)", () => {
  let b: string;
  let a: FastifyInstance;
  beforeAll(async () => {
    b = await mkdtemp(join(tmpdir(), "tasksroute-login-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(b, "claude"));
    vi.stubEnv("CLAUDE_ACCOUNTS_DIR", join(b, "accounts"));
    const st = new SessionStore(join(b, "agents"));
    for (const [id, account] of [["pinned", "work"], ["linked", "home"], ["plain", undefined]] as const) {
      await st.save({ id, label: "", repo: "/r", worktree: "/w", branch: "b", baseBranch: "m", sessionId: `sess-${id}`, hookToken: "t", status: "idle", createdAt: 1, ...(account ? { account } : {}) });
    }
    // "work": a real tasks folder of its own. "home": a link to the default folder (the shadow).
    await mkdir(join(b, "accounts", "work", "tasks", "sess-pinned"), { recursive: true });
    await writeFile(join(b, "accounts", "work", "tasks", "sess-pinned", "1.json"), JSON.stringify({ id: "1", subject: "On the work login" }));
    await mkdir(join(b, "claude", "tasks", "sess-linked"), { recursive: true });
    await mkdir(join(b, "claude", "tasks", "sess-plain"), { recursive: true });
    await writeFile(join(b, "claude", "tasks", "sess-linked", "1.json"), JSON.stringify({ id: "1", subject: "Through the link" }));
    await writeFile(join(b, "claude", "tasks", "sess-plain", "1.json"), JSON.stringify({ id: "1", subject: "On the default login" }));
    await mkdir(join(b, "accounts", "home"), { recursive: true });
    await symlink(join(b, "claude", "tasks"), join(b, "accounts", "home", "tasks"));
    a = Fastify();
    registerAgentApi(a, { terminals: { has: () => false } as never, store: st, hub: { emitEvent: () => {} } as never, workspaceDir: b });
    await a.ready();
  });
  afterAll(async () => {
    await a.close();
    vi.unstubAllEnvs();
    await rm(b, { recursive: true, force: true });
  });
  const subjects = async (id: string) => ((await a.inject({ method: "GET", url: `/api/agents/${id}/tasks` })).json().tasks as { subject: string }[]).map((t) => t.subject);

  it("reads the tasks folder of the agent's own login", async () => {
    expect(await subjects("pinned")).toEqual(["On the work login"]);
  });
  it("a login whose tasks folder is the shadow link, and the default login: as before", async () => {
    expect(await subjects("linked")).toEqual(["Through the link"]);
    expect(await subjects("plain")).toEqual(["On the default login"]);
  });
});
