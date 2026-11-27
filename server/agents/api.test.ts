// server/agents/api.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentApi } from "./api.js";
import { SessionStore, type AgentRecord } from "./store.js";
import { EventHub } from "../events.js";
import { makeGate } from "../chief/gate.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER, type CallerDeps } from "../chief/auth.js";
import { AreaStore } from "../chief/leads/areas.js";

const run = promisify(execFile);

// A real chief gate in log mode whose one paired device holds CHIEF_UT.
const CHIEF_UT = "user-token";
function chiefGate(misconfigured: string | null, agents: CallerDeps["agents"] = { load: async () => null }) {
  return makeGate({
    misconfigured, userAuth: "log",
    deps: {
      devices: { verify: async (t: string) => (t === CHIEF_UT ? { label: "phone", createdAt: 1, lastUsedAt: 1 } : null) },
      agents,
    },
  });
}

// `command` and `env` are optional so the terse call sites below (which only
// need an id) stay valid, while the runtime tests can assert on what was spawned.
type SpawnCall = {
  id: string; cwd: string; args: string[];
  command?: string; env?: Record<string, string>;
};

function fakeTerminals() {
  const ids = new Set<string>();
  return {
    spawned: [] as SpawnCall[],
    spawn(o: SpawnCall) { ids.add(o.id); this.spawned.push(o); },
    kill(id: string) { ids.delete(id); },
    has(id: string) { return ids.has(id); },
    write() {}, resize() {}, attach() { return null; },
  };
}

// A workspace dir containing one real git repo so createWorktree succeeds.
async function makeWorkspaceWithRepo(): Promise<{ workspaceDir: string; repo: string; cleanup: () => Promise<void> }> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "ws-"));
  const repo = join(workspaceDir, "myrepo");
  await run("git", ["init", "-b", "main", repo]);
  await run("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
  return { workspaceDir, repo, cleanup: () => rm(workspaceDir, { recursive: true, force: true }) };
}

describe("agents api", () => {
  let store: SessionStore;
  beforeEach(async () => { store = new SessionStore(await mkdtemp(join(tmpdir(), "api-"))); });

  it("GET /api/agents returns sessions", async () => {
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    await store.save({
      id: "s1", label: "G", repo: "/tmp", worktree: "/tmp/w",
      branch: "agent/abc12345", baseBranch: "main", sessionId: null, hookToken: "t",
      status: "running", createdAt: 1,
    });
    const res = await app.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.json().presets).toBeUndefined();
    expect(res.json().sessions.map((s: any) => s.id)).toEqual(["s1"]);
  });

  it("POST /api/agents 400s for an unknown repo", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "ws-empty-"));
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir });
    const res = await app.inject({
      method: "POST", url: "/api/agents",
      payload: { repo: join(workspaceDir, "does-not-exist"), prompt: "do a thing" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown repo");
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("POST /api/agents spawns with default config for a known repo", async () => {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    const terminals = fakeTerminals();
    const app = Fastify();
    registerAgentApi(app, {
      terminals: terminals as any, store, hub: new EventHub(),
      workspaceDir, worktreeRoot: join(workspaceDir, ".wt"),
    });
    const res = await app.inject({
      method: "POST", url: "/api/agents",
      payload: { repo, prompt: "fix the bug" },
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().id as string;
    expect(id).toBeTruthy();
    const rec = await store.load(id);
    expect(rec?.label).toBe("fix the bug");
    expect(rec?.repo).toBe(repo);
    expect(rec?.branch).toBe(`agent/${id.slice(0, 8)}`);
    expect(rec?.baseBranch).toBe("main");
    // an initial prompt means claude starts working immediately → running
    expect(rec?.status).toBe("running");
    // default config → the console's model setting, opus when not set (agents/model.ts)
    const spawned = terminals.spawned.find((s) => s.id === id)!;
    expect(spawned.args.slice(spawned.args.indexOf("--model"), spawned.args.indexOf("--model") + 2)).toEqual(["--model", "opus"]);
    expect(spawned.args).toContain("--dangerously-skip-permissions");
    expect(spawned.args).toContain("fix the bug");
    await cleanup();
  });

  it("POST /api/agents ignores kind, issueId and label from the body", async () => {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    const app = Fastify();
    registerAgentApi(app, {
      terminals: fakeTerminals() as any, store, hub: new EventHub(),
      workspaceDir, worktreeRoot: join(workspaceDir, ".wt"),
    });
    const prompt = "  " + "p".repeat(60) + "  ";
    const res = await app.inject({
      method: "POST", url: "/api/agents",
      payload: { repo, prompt, kind: "issue", issueId: "t1", label: "x" },
    });
    expect(res.statusCode).toBe(202);
    const rec = await store.load(res.json().id as string);
    expect(rec?.kind).toBeUndefined();
    expect(rec?.issueId).toBeUndefined();
    expect(rec?.label).toBe(prompt.trim().slice(0, 50));
    await cleanup();
  });

  it("cleans the record, worktree, and branch when agent spawn fails", async () => {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    const terminals = fakeTerminals();
    terminals.spawn = () => { throw new Error("spawn failed"); };
    const app = Fastify();
    const worktreeRoot = join(workspaceDir, ".wt");
    registerAgentApi(app, {
      terminals: terminals as any, store, hub: new EventHub(), workspaceDir, worktreeRoot,
    });

    const res = await app.inject({
      method: "POST", url: "/api/agents", payload: { repo, prompt: "fail cleanly" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("agent launch failed");
    expect(await store.list()).toEqual([]);
    const { stdout: worktrees } = await run("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    expect(worktrees).not.toContain(worktreeRoot);
    const { stdout: branches } = await run("git", ["-C", repo, "branch", "--list", "agent/*"]);
    expect(branches.trim()).toBe("");
    await cleanup();
  });

  it("POST /api/agents with createFrom makes a new local branch and forks the worktree from it", async () => {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    // Record main's tip so we can prove the new branch (and worktree) fork from it.
    const { stdout: mainTipOut } = await run("git", ["-C", repo, "rev-parse", "main"]);
    const mainTip = mainTipOut.trim();
    const terminals = fakeTerminals();
    const app = Fastify();
    registerAgentApi(app, {
      terminals: terminals as any, store, hub: new EventHub(),
      workspaceDir, worktreeRoot: join(workspaceDir, ".wt"),
    });
    const res = await app.inject({
      method: "POST", url: "/api/agents",
      payload: { repo, prompt: "build a feature", baseBranch: "feature/x", createFrom: "main" },
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().id as string;
    const rec = await store.load(id);
    // baseBranch is the NEW local branch, not the start point.
    expect(rec?.baseBranch).toBe("feature/x");
    expect(rec?.branch).toBe(`agent/${id.slice(0, 8)}`);
    // The new branch actually exists locally and points at main's tip.
    const { stdout: featTip } = await run("git", ["-C", repo, "rev-parse", "feature/x"]);
    expect(featTip.trim()).toBe(mainTip);
    // The agent worktree was created off the new branch: its fork point is main's tip.
    const { stdout: mb } = await run("git", ["-C", rec!.worktree, "merge-base", "feature/x", "HEAD"]);
    expect(mb.trim()).toBe(mainTip);
    await cleanup();
  });

  it("POST /api/agents with no prompt starts idle, not running", async () => {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    const terminals = fakeTerminals();
    const events: any[] = [];
    const hub = new EventHub();
    hub.subscribe((e) => events.push(e));
    const app = Fastify();
    registerAgentApi(app, {
      terminals: terminals as any, store, hub,
      workspaceDir, worktreeRoot: join(workspaceDir, ".wt"),
    });
    const res = await app.inject({ method: "POST", url: "/api/agents", payload: { repo } });
    expect(res.statusCode).toBe(202);
    const id = res.json().id as string;
    // No initial prompt → the session is waiting for the first message, not working.
    expect((await store.load(id))?.status).toBe("idle");
    expect(events.some((e) => e.type === "agent-status" && e.agentId === id && e.status === "idle")).toBe(true);
    expect(events.some((e) => e.type === "agent-status" && e.agentId === id && e.status === "running")).toBe(false);
    await cleanup();
  });

  it("POST /api/agents with the workspace sentinel spawns at the workspace root with no repo/branch", async () => {
    const { workspaceDir, cleanup } = await makeWorkspaceWithRepo();
    const terminals = fakeTerminals();
    const app = Fastify();
    registerAgentApi(app, {
      terminals: terminals as any, store, hub: new EventHub(),
      workspaceDir, worktreeRoot: join(workspaceDir, ".wt"),
    });
    const res = await app.inject({
      method: "POST", url: "/api/agents",
      payload: { repo: "__workspace__", prompt: "tidy everything" },
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().id as string;
    const rec = await store.load(id);
    expect(rec?.repo).toBe("");
    expect(rec?.branch).toBe("");
    expect(rec?.baseBranch).toBe("");
    expect(rec?.worktree).toBe(workspaceDir);
    // claude is spawned with the workspace root as cwd
    const spawned = terminals.spawned.find((s) => s.id === id)!;
    expect(spawned.cwd).toBe(workspaceDir);
    // merge is meaningless for a workspace agent (stop it first so we get past
    // the live-agent guard and hit the workspace rejection)
    await app.inject({ method: "POST", url: `/api/agents/${id}/stop` });
    const merge = await app.inject({ method: "POST", url: `/api/agents/${id}/merge` });
    expect(merge.statusCode).toBe(400);
    await cleanup();
  });

  it("GET /api/agents/:id/changed lists per-repo changes for a workspace agent", async () => {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    await run("git", ["-C", repo, "config", "user.email", "t@t"]);
    await run("git", ["-C", repo, "config", "user.name", "t"]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repo, "fresh.txt"), "new file");

    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir });
    await store.save({
      id: "wsc", label: "workspace", repo: "", worktree: workspaceDir,
      branch: "", baseBranch: "", sessionId: null, hookToken: "t",
      status: "running", createdAt: 1,
    });
    const res = await app.inject({ method: "GET", url: "/api/agents/wsc/changed" });
    expect(res.statusCode).toBe(200);
    // path is namespaced by repo name
    expect(res.json().files.map((f: any) => f.rel)).toContain("myrepo/fresh.txt");
    await cleanup();
  });

  it("POST /api/agents/:id/merge 409s while the terminal is live", async () => {
    const terminals = fakeTerminals();
    terminals.spawn({ id: "live1", cwd: "/tmp", args: [] });
    const app = Fastify();
    registerAgentApi(app, { terminals: terminals as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    await store.save({
      id: "live1", label: "G", repo: "/tmp", worktree: "/tmp/w",
      branch: "agent/abc12345", baseBranch: "main", sessionId: null, hookToken: "t",
      status: "running", createdAt: 1,
    });
    const res = await app.inject({ method: "POST", url: "/api/agents/live1/merge" });
    expect(res.statusCode).toBe(409);
  });

  it("POST /api/agents/:id/delete kills, discards (best-effort), and removes the record", async () => {
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    await store.save({
      id: "del1", label: "G", repo: "/tmp", worktree: "/tmp/does-not-exist-wt",
      branch: "agent/abcdel12", baseBranch: "main", sessionId: null, hookToken: "t",
      status: "done", createdAt: 1,
    });
    const res = await app.inject({ method: "POST", url: "/api/agents/del1/delete" });
    expect(res.statusCode).toBe(202);
    expect(await store.load("del1")).toBeNull();
  });

  it("POST /api/agents/:id/delete also removes the agent's widget folder", async () => {
    const removed: string[] = [];
    const app = Fastify();
    registerAgentApi(app, {
      terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp",
      widgets: { removeAgent: async (id: string) => { removed.push(id); } },
    });
    await store.save({
      id: "delw", label: "G", repo: "/tmp", worktree: "/tmp/does-not-exist-wt",
      branch: "agent/abcdelw1", baseBranch: "main", sessionId: null, hookToken: "t",
      status: "done", createdAt: 1,
    });
    const res = await app.inject({ method: "POST", url: "/api/agents/delw/delete" });
    expect(res.statusCode).toBe(202);
    expect(removed).toEqual(["delw"]);
  });

  it("POST /api/repos inits a new empty git repo", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "ws-init-"));
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir });
    const res = await app.inject({ method: "POST", url: "/api/repos", payload: { name: "newproj" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().repo.path.endsWith("/newproj")).toBe(true);
    // the dir is a real git repo on disk
    const dest = join(workspaceDir, "newproj");
    expect((await stat(join(dest, ".git"))).isDirectory()).toBe(true);
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("POST /api/repos clones from a (local) url", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "ws-clone-"));
    const srcDir = await mkdtemp(join(tmpdir(), "src-"));
    const source = join(srcDir, "origin");
    await run("git", ["init", "-b", "main", source]);
    await run("git", ["-C", source, "commit", "--allow-empty", "-m", "init"]);
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir });
    const res = await app.inject({ method: "POST", url: "/api/repos", payload: { url: source } });
    expect(res.statusCode).toBe(201);
    expect(res.json().repo.path).toBe(join(workspaceDir, "origin"));
    const { listRepos } = await import("./repos.js");
    expect((await listRepos(workspaceDir)).some((r) => r.path === join(workspaceDir, "origin"))).toBe(true);
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(srcDir, { recursive: true, force: true });
  });

  it("POST /api/repos, hardened (fix round 2, item 3): a local, file://, ext:: or dash url is refused before any git", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "ws-clone-h-"));
    const srcDir = await mkdtemp(join(tmpdir(), "src-h-"));
    const source = join(srcDir, "origin");
    await run("git", ["init", "-b", "main", source]);
    await run("git", ["-C", source, "commit", "--allow-empty", "-m", "init"]);
    const env = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001" };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    try {
      const app = Fastify();
      registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir });
      for (const url of [source, `file://${source}`, "ext::sh -c true", "--upload-pack=true"]) {
        const res = await app.inject({ method: "POST", url: "/api/repos", payload: { url, name: "cl" } });
        expect(res.statusCode, url).toBe(400);
        expect(res.json().error, url).toMatch(/https:\/\/, ssh:\/\/ or user@host:path/);
        expect(existsSync(join(workspaceDir, "cl")), url).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(srcDir, { recursive: true, force: true });
    }
  });

  it("POST /api/repos rejects an existing name (409) and traversal (400)", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "ws-rej-"));
    await run("git", ["init", "-b", "main", join(workspaceDir, "existing")]);
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir });
    const dup = await app.inject({ method: "POST", url: "/api/repos", payload: { name: "existing" } });
    expect(dup.statusCode).toBe(409);
    const trav = await app.inject({ method: "POST", url: "/api/repos", payload: { name: "../evil" } });
    expect(trav.statusCode).toBe(400);
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("POST /api/agents/:id/hook updates status when the token matches", async () => {
    const { default: Fastify } = await import("fastify");
    const app = Fastify();
    const hub = new EventHub();
    const events: any[] = [];
    hub.subscribe((e) => events.push(e));
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub, workspaceDir: "/tmp" });
    await store.save({
      id: "h1", label: "G", repo: "/tmp", worktree: "/tmp/w",
      branch: "agent/abc12345", baseBranch: "main", sessionId: null, hookToken: "sekret",
      status: "running", createdAt: 1,
    });
    const ok = await app.inject({
      method: "POST", url: "/api/agents/h1/hook?token=sekret",
      payload: { hook_event_name: "Stop", session_id: "sess-x" },
    });
    expect(ok.statusCode).toBe(200);
    expect((await store.load("h1"))?.status).toBe("idle");
    expect((await store.load("h1"))?.sessionId).toBe("sess-x");
    expect(events.some((e) => e.type === "agent-status" && e.status === "idle")).toBe(true);

    const bad = await app.inject({
      method: "POST", url: "/api/agents/h1/hook?token=wrong",
      payload: { hook_event_name: "Stop" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("POST /api/agents/:id/hook tracks a session change (/clear starts a new session id)", async () => {
    const { default: Fastify } = await import("fastify");
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    await store.save({
      id: "h2", label: "G", repo: "/tmp", worktree: "/tmp/w",
      branch: "agent/abc12345", baseBranch: "main", sessionId: "sess-old", hookToken: "sekret",
      status: "idle", createdAt: 1,
    });
    // The user /clears (or otherwise relaunches) inside the terminal: SessionStart
    // fires with a NEW session id. The record must follow, or a later
    // `claude --resume` restores the pre-/clear conversation (the stale-id bug).
    const res = await app.inject({
      method: "POST", url: "/api/agents/h2/hook?token=sekret",
      payload: { hook_event_name: "SessionStart", session_id: "sess-new", source: "clear" },
    });
    expect(res.statusCode).toBe(200);
    expect((await store.load("h2"))?.sessionId).toBe("sess-new");
  });

  it("POST /api/agents/:id/hook persists the transcript path for a codex agent only", async () => {
    const { default: Fastify } = await import("fastify");
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    const roll = "/home/u/.codex/sessions/2026/08/13/rollout-x-s1.jsonl";
    await store.save({
      id: "h3", label: "G", repo: "/tmp", worktree: "/tmp/w",
      branch: "agent/abc12345", baseBranch: "main", sessionId: null, hookToken: "sekret",
      status: "idle", createdAt: 1, runtime: "codex",
    });
    const res = await app.inject({
      method: "POST", url: "/api/agents/h3/hook?token=sekret",
      payload: { hook_event_name: "SessionStart", session_id: "s1", transcript_path: roll },
    });
    expect(res.statusCode).toBe(200);
    expect((await store.load("h3"))?.transcriptPath).toBe(roll);

    // Claude derives its transcript path from cwd + session id, so the shared
    // route must NOT start persisting one for it just because the field exists.
    await store.save({
      id: "h4", label: "G", repo: "/tmp", worktree: "/tmp/w",
      branch: "agent/abc12345", baseBranch: "main", sessionId: null, hookToken: "sekret",
      status: "idle", createdAt: 1, runtime: "claude",
    });
    const cl = await app.inject({
      method: "POST", url: "/api/agents/h4/hook?token=sekret",
      payload: { hook_event_name: "SessionStart", session_id: "s1", transcript_path: roll },
    });
    expect(cl.statusCode).toBe(200);
    expect((await store.load("h4"))?.transcriptPath).toBeUndefined();
  });

  it("POST /api/agents/:id/hook drops a stale transcript path when the session id changes", async () => {
    const { default: Fastify } = await import("fastify");
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    const old = "/home/u/.codex/sessions/2026/08/13/rollout-old-s1.jsonl";
    const fresh = "/home/u/.codex/sessions/2026/08/14/rollout-new-s2.jsonl";
    await store.save({
      id: "h5", label: "G", repo: "/tmp", worktree: "/tmp/w",
      branch: "agent/abc12345", baseBranch: "main", sessionId: "s1", hookToken: "sekret",
      status: "idle", createdAt: 1, runtime: "codex", transcriptPath: old,
    });

    // /clear: a new session id arrives, but this payload's path is rejected by
    // the .jsonl guard. Keeping the old one would let canResume restore the
    // PREVIOUS conversation and the Plan rail render its plan.
    const cleared = await app.inject({
      method: "POST", url: "/api/agents/h5/hook?token=sekret",
      payload: { hook_event_name: "SessionStart", session_id: "s2", transcript_path: "/tmp/not-a-rollout" },
    });
    expect(cleared.statusCode).toBe(200);
    let rec = await store.load("h5");
    expect(rec?.sessionId).toBe("s2");
    expect(rec?.transcriptPath).toBeUndefined();

    // A usable path in the same payload still wins over the clearing.
    await store.patch("h5", { sessionId: "s2", transcriptPath: old });
    const swapped = await app.inject({
      method: "POST", url: "/api/agents/h5/hook?token=sekret",
      payload: { hook_event_name: "SessionStart", session_id: "s3", transcript_path: fresh },
    });
    expect(swapped.statusCode).toBe(200);
    rec = await store.load("h5");
    expect(rec?.sessionId).toBe("s3");
    expect(rec?.transcriptPath).toBe(fresh);
  });

  it("POST /api/agents/:id/hook keeps an unchanged transcript path across a session id change", async () => {
    const { default: Fastify } = await import("fastify");
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    const roll = "/home/u/.codex/sessions/2026/08/14/rollout-same-s1.jsonl";
    await store.save({
      id: "h6", label: "G", repo: "/tmp", worktree: "/tmp/w",
      branch: "agent/abc12345", baseBranch: "main", sessionId: "s1", hookToken: "sekret",
      status: "idle", createdAt: 1, runtime: "codex", transcriptPath: roll,
    });

    // A new id arriving with the SAME rollout path: the id change clears the
    // path, so the reinstating line must fire on the id change too — otherwise
    // the record keeps a session with no path and canResume cold-starts it.
    const res = await app.inject({
      method: "POST", url: "/api/agents/h6/hook?token=sekret",
      payload: { hook_event_name: "SessionStart", session_id: "s2", transcript_path: roll },
    });
    expect(res.statusCode).toBe(200);
    const rec = await store.load("h6");
    expect(rec?.sessionId).toBe("s2");
    expect(rec?.transcriptPath).toBe(roll);
  });

  it("GET /api/agents/:id/changed 404s for an unknown agent", async () => {
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    const res = await app.inject({ method: "GET", url: "/api/agents/nope/changed" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/agents/:id/changed lists worktree changes", async () => {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    const root = await mkdtemp(join(tmpdir(), "wt-"));
    const { createWorktree } = await import("./worktree.js");
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/c-1", root });
    await run("git", ["-C", wt.path, "config", "user.email", "t@t"]);
    await run("git", ["-C", wt.path, "config", "user.name", "t"]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(wt.path, "x.txt"), "fresh");

    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir });
    await store.save({
      id: "c1", label: "G", repo, worktree: wt.path,
      branch: "agent/c-1", baseBranch: "main", sessionId: null, hookToken: "t",
      status: "running", createdAt: 1,
    });
    const res = await app.inject({ method: "GET", url: "/api/agents/c1/changed" });
    expect(res.statusCode).toBe(200);
    expect(res.json().files.map((f: any) => f.rel)).toContain("x.txt");
    await rm(root, { recursive: true, force: true });
    await cleanup();
  });

  it("POST /api/agents/:id/upload writes an image and returns its path", async () => {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir });
    await store.save({
      id: "up1", label: "U", repo, worktree: repo,
      branch: "agent/up1", baseBranch: "main", sessionId: null, hookToken: "t",
      status: "running", createdAt: 1,
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const res = await app.inject({
      method: "POST", url: "/api/agents/up1/upload",
      headers: { "content-type": "image/png" }, payload: png,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toMatch(/^\.choibot\/uploads\/screenshot-\d+-\d+\.png$/);
    const onDisk = await stat(join(repo, res.json().path));
    expect(onDisk.size).toBe(png.length);
    await cleanup();
  });

  it("GET /api/agents/:id/git 404s for an unknown agent", async () => {
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    const res = await app.inject({ method: "GET", url: "/api/agents/nope/git" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/agents/:id/git adopts the live branch when the worktree is switched", async () => {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    const root = await mkdtemp(join(tmpdir(), "wt-"));
    const { createWorktree } = await import("./worktree.js");
    await run("git", ["-C", repo, "branch", "feature", "main"]);
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/g-1", root });
    // the worktree gets switched onto a real branch other than the recorded one
    await run("git", ["-C", wt.path, "checkout", "-q", "feature"]);

    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir });
    await store.save({
      id: "g1", label: "G", repo, worktree: wt.path,
      branch: "agent/g-1", baseBranch: "main", sessionId: null, hookToken: "t",
      status: "running", createdAt: 1,
    });
    const res = await app.inject({ method: "GET", url: "/api/agents/g1/git" });
    expect(res.statusCode).toBe(200);
    const git = res.json().git;
    // the agent now tracks the branch actually checked out — no drift warning
    expect(git.head).toBe("feature");
    expect(git.trackedBranch).toBe("feature");
    expect(git.onTracked).toBe(true);
    // and the adoption is persisted on the record
    expect((await store.load("g1"))!.branch).toBe("feature");
    await rm(root, { recursive: true, force: true });
    await cleanup();
  });

  it("POST /api/agents/:id/upload 404s for an unknown agent", async () => {
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    const res = await app.inject({
      method: "POST", url: "/api/agents/nope/upload",
      headers: { "content-type": "image/png" }, payload: Buffer.from([1]),
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/agents/:id/upload 415s for a non-image body", async () => {
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    await store.save({
      id: "up2", label: "U", repo: "/tmp", worktree: "/tmp",
      branch: "agent/up2", baseBranch: "main", sessionId: null, hookToken: "t",
      status: "running", createdAt: 1,
    });
    const res = await app.inject({
      method: "POST", url: "/api/agents/up2/upload",
      headers: { "content-type": "text/plain" }, payload: "hello",
    });
    expect(res.statusCode).toBe(415);
  });

  it("POST /api/agents/:id/upload takes a file of an allowed extension and makes the name itself", async () => {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir });
    await store.save({
      id: "up3", label: "U", repo, worktree: repo,
      branch: "agent/up3", baseBranch: "main", sessionId: null, hookToken: "t",
      status: "running", createdAt: 1,
    });
    const post = (ext: string) => app.inject({
      method: "POST", url: `/api/agents/up3/upload?ext=${encodeURIComponent(ext)}`,
      headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("%PDF-1.7"),
    });
    const ok = await post("PDF");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().path).toMatch(/^\.choibot\/uploads\/file-\d+-\d+\.pdf$/);
    expect((await stat(join(repo, ok.json().path))).size).toBe(8);
    // Not in the list, and a path in place of an extension: refused, with the reason.
    for (const ext of ["exe", "html", "../../x.pdf", ""]) {
      const res = await post(ext);
      expect(res.statusCode, ext).toBe(415);
      expect(res.json().error, ext).toMatch(/^file type not allowed \(allowed: png, jpg, .*pdf/);
    }
    await cleanup();
  });

  it("POST /api/agents/:id/upload refuses a body over the cap (413) and a missing worktree (409)", async () => {
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    await store.save({
      id: "up4", label: "U", repo: "", worktree: "/tmp/choibot-no-such-worktree",
      branch: "", baseBranch: "", sessionId: null, hookToken: "t",
      status: "idle", createdAt: 1,
    });
    const big = await app.inject({
      method: "POST", url: "/api/agents/up4/upload",
      headers: { "content-type": "image/png" }, payload: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    expect(big.statusCode).toBe(413);
    const gone = await app.inject({
      method: "POST", url: "/api/agents/up4/upload",
      headers: { "content-type": "image/png" }, payload: Buffer.from([1]),
    });
    expect(gone.statusCode).toBe(409);
    expect(gone.json().error).toMatch(/no worktree/);
  });

  // The runtime is chosen at creation time and lives on the record, which is what
  // every later call (resume, plan, hooks) dispatches on via pick().
  describe("runtime selection", () => {
    // Point the codex binary at a path that does not exist. `prepare` still runs
    // and still writes the whole CODEX_HOME, but its `codex plugin add` calls
    // fail closed (registerHookPlugin returns false rather than throwing), so
    // these tests never shell out to the real CLI. The path keeps "codex" in its
    // basename because the spawn assertion below matches on it.
    beforeEach(() => { vi.stubEnv("CODEX_EXECUTABLE", "/nonexistent/bin/codex"); });
    afterEach(() => { vi.unstubAllEnvs(); });

    it("records the requested runtime on a new agent", async () => {
      const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
      const app = Fastify();
      registerAgentApi(app, {
        terminals: fakeTerminals() as any, store, hub: new EventHub(),
        workspaceDir, worktreeRoot: join(workspaceDir, ".wt"),
      });
      const res = await app.inject({
        method: "POST", url: "/api/agents",
        payload: { repo, prompt: "hi", runtime: "codex" },
      });
      expect(res.statusCode).toBe(202);
      const { id } = res.json();
      expect((await store.load(id))?.runtime).toBe("codex");
      await cleanup();
    });

    it("defaults a new agent to the claude runtime", async () => {
      const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
      const app = Fastify();
      registerAgentApi(app, {
        terminals: fakeTerminals() as any, store, hub: new EventHub(),
        workspaceDir, worktreeRoot: join(workspaceDir, ".wt"),
      });
      const res = await app.inject({ method: "POST", url: "/api/agents", payload: { repo, prompt: "hi" } });
      expect(res.statusCode).toBe(202);
      const { id } = res.json();
      expect((await store.load(id))?.runtime).toBe("claude");
      await cleanup();
    });

    // "toString"/"constructor"/"__proto__" are inherited Object.prototype keys.
    // A membership test written with `in` accepts all three, and the value then
    // survives onto the record — which both 500s the request halfway through
    // (after the worktree exists) and defeats pick()'s fallback on every later
    // resume. A non-string is the other shape the wire can deliver: it must take
    // the same 400, never throw on .trim().
    const BAD_RUNTIMES: Array<[string, unknown]> = [
      ["a typo", "gpt4all"],
      ["an inherited method name", "toString"],
      ["constructor", "constructor"],
      ["__proto__", "__proto__"],
      ["a number", 123],
      ["an object", { id: "codex" }],
    ];

    it.each(BAD_RUNTIMES)("rejects %s before creating anything", async (_label, runtime) => {
      const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
      const terminals = fakeTerminals();
      const app = Fastify();
      const worktreeRoot = join(workspaceDir, ".wt");
      registerAgentApi(app, {
        terminals: terminals as any, store, hub: new EventHub(), workspaceDir, worktreeRoot,
      });
      const res = await app.inject({
        method: "POST", url: "/api/agents",
        payload: { repo, prompt: "hi", runtime },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/runtime/);
      // Validation runs before any side effect: no record, no worktree, no spawn.
      expect(await store.list()).toEqual([]);
      expect(terminals.spawned).toEqual([]);
      expect(existsSync(worktreeRoot)).toBe(false);
      await cleanup();
    });

    it("records the runtime on a workspace agent too (no repo, no worktree)", async () => {
      const { workspaceDir, cleanup } = await makeWorkspaceWithRepo();
      const terminals = fakeTerminals();
      const app = Fastify();
      registerAgentApi(app, {
        terminals: terminals as any, store, hub: new EventHub(), workspaceDir,
      });
      const res = await app.inject({
        method: "POST", url: "/api/agents",
        payload: { repo: "__workspace__", prompt: "tidy up", runtime: "codex" },
      });
      expect(res.statusCode).toBe(202);
      const { id } = res.json();
      const rec = await store.load(id);
      expect(rec?.repo).toBe("");
      expect(rec?.runtime).toBe("codex");
      // A workspace agent has no worktree, so its CODEX_HOME lives under
      // .choibot-agents/<id>/ in the workspace — still never the user's ~/.codex.
      const call = terminals.spawned.find((s) => s.id === id)!;
      expect(call.env?.CODEX_HOME).toBe(join(workspaceDir, ".choibot-agents", id, "codex-home"));
      await cleanup();
    });

    it("spawns codex with the codex binary and CODEX_HOME set", async () => {
      const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
      const terminals = fakeTerminals();
      const app = Fastify();
      registerAgentApi(app, {
        terminals: terminals as any, store, hub: new EventHub(),
        workspaceDir, worktreeRoot: join(workspaceDir, ".wt"),
      });
      const res = await app.inject({
        method: "POST", url: "/api/agents",
        payload: { repo, prompt: "hi", runtime: "codex" },
      });
      expect(res.statusCode).toBe(202);
      const { id } = res.json();
      const call = terminals.spawned.find((s) => s.id === id)!;
      expect(call.command).toMatch(/codex/);
      // CODEX_HOME is the agent's own, inside its worktree — never the user's ~/.codex.
      expect(call.env?.CODEX_HOME).toBeTruthy();
      expect(call.env!.CODEX_HOME.startsWith(workspaceDir)).toBe(true);
      expect(call.args).toContain("--dangerously-bypass-approvals-and-sandbox");
      await cleanup();
    });
  });

  // The fleet master is an agent record like any other, but it is NOT a worker:
  // it has no repo and no disposable worktree, so it must stay out of the agent
  // list and reject every repo-shaped operation. Without these guards its empty
  // `repo` makes it look like a workspace agent, and /diff, /changed and delete
  // would act on the whole workspace / its own home dir.
  describe("master guards", () => {
    const MASTER_DIR = "/tmp/fleet-master-agent-dir";
    const saveMaster = (worktree = MASTER_DIR) => store.save({
      id: "fleet-master", label: "Master", repo: "", worktree,
      branch: "", baseBranch: "", sessionId: null, hookToken: "t",
      status: "idle", createdAt: 1, kind: "fleet-master",
    });

    it("GET /api/agents omits the fleet master", async () => {
      const app = Fastify();
      registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
      await saveMaster();
      await store.save({
        id: "worker1", label: "W", repo: "/tmp", worktree: "/tmp/w",
        branch: "agent/abc12345", baseBranch: "main", sessionId: null, hookToken: "t",
        status: "running", createdAt: 2,
      });
      const res = await app.inject({ method: "GET", url: "/api/agents" });
      expect(res.statusCode).toBe(200);
      expect(res.json().sessions.map((s: any) => s.id)).toEqual(["worker1"]);
    });

    it("GET /api/agents/:id still returns the fleet master (the Master pane reads it)", async () => {
      const app = Fastify();
      registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
      await saveMaster();
      const res = await app.inject({ method: "GET", url: "/api/agents/fleet-master" });
      expect(res.statusCode).toBe(200);
      expect(res.json().kind).toBe("fleet-master");
    });

    it("repo operations 400 for the fleet master", async () => {
      const app = Fastify();
      registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
      await saveMaster();
      const calls: Array<{ method: "GET" | "POST"; url: string; payload?: unknown }> = [
        { method: "GET", url: "/api/agents/fleet-master/diff" },
        { method: "GET", url: "/api/agents/fleet-master/changed" },
        { method: "GET", url: "/api/agents/fleet-master/git" },
        { method: "POST", url: "/api/agents/fleet-master/merge" },
        { method: "POST", url: "/api/agents/fleet-master/discard" },
        { method: "POST", url: "/api/agents/fleet-master/discard-file", payload: { rel: "x.txt" } },
      ];
      for (const c of calls) {
        const res = await app.inject(c as any);
        expect(res.statusCode, c.url).toBe(400);
        expect(res.json().error, c.url).toBe("not applicable to a master agent");
      }
    });

    it("repo operations still 404 for an unknown agent (guard sits after the 404 check)", async () => {
      const app = Fastify();
      registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
      const res = await app.inject({ method: "GET", url: "/api/agents/nope/diff" });
      expect(res.statusCode).toBe(404);
    });

    it("POST /api/agents/:id/delete removes the master record without touching its dir", async () => {
      const { mkdtemp: mkdtempP, writeFile } = await import("node:fs/promises");
      const dir = await mkdtempP(join(tmpdir(), "fleet-master-"));
      await writeFile(join(dir, "keep.txt"), "state");
      const terminals = fakeTerminals();
      terminals.spawn({ id: "fleet-master", cwd: dir, args: [] });
      const app = Fastify();
      registerAgentApi(app, { terminals: terminals as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
      await saveMaster(dir);
      const res = await app.inject({ method: "POST", url: "/api/agents/fleet-master/delete" });
      expect(res.statusCode).toBe(202);
      expect(await store.load("fleet-master")).toBeNull();
      // the terminal is killed…
      expect(terminals.has("fleet-master")).toBe(false);
      // …but the master's own agent dir (its "worktree") survives — it is not
      // disposable git state, and its hook-settings file lives inside it.
      expect((await stat(join(dir, "keep.txt"))).isFile()).toBe(true);
      await rm(dir, { recursive: true, force: true });
    });
  });

  it("POST /api/agents/:id/hook emits agent-turn-end with the last message on Stop only", async () => {
    const app = Fastify();
    const hub = new EventHub();
    const events: any[] = [];
    hub.subscribe((e) => events.push(e));
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub, workspaceDir: "/tmp" });
    await store.save({
      id: "te1", label: "G", repo: "/tmp", worktree: "/tmp/w",
      branch: "agent/te1", baseBranch: "main", sessionId: null, hookToken: "sekret",
      status: "running", createdAt: 1,
    });
    const hook = (payload: object) =>
      app.inject({ method: "POST", url: "/api/agents/te1/hook?token=sekret", payload });
    await hook({ hook_event_name: "Notification", session_id: "s1" });
    await hook({ hook_event_name: "UserPromptSubmit", session_id: "s1" });
    await hook({ hook_event_name: "SessionStart", session_id: "s1" });
    expect(events.filter((e) => e.type === "agent-turn-end")).toEqual([]);
    await hook({ hook_event_name: "Stop", session_id: "s1", last_assistant_message: "Which browser?" });
    await hook({ hook_event_name: "Stop", session_id: "s1" });
    expect(events.filter((e) => e.type === "agent-turn-end")).toEqual([
      { type: "agent-turn-end", agentId: "te1", lastMessage: "Which browser?" },
      { type: "agent-turn-end", agentId: "te1", lastMessage: "" },
    ]);
  });

  it("POST /api/agents/:id/hook emits agent-hook for every hook, SessionStart included", async () => {
    const app = Fastify();
    const hub = new EventHub();
    const events: any[] = [];
    hub.subscribe((e) => events.push(e));
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub, workspaceDir: "/tmp" });
    await store.save({
      id: "hk1", label: "G", repo: "/tmp", worktree: "/tmp/w",
      branch: "agent/hk1", baseBranch: "main", sessionId: null, hookToken: "sekret",
      status: "idle", createdAt: 1,
    });
    const hook = (payload: object) =>
      app.inject({ method: "POST", url: "/api/agents/hk1/hook?token=sekret", payload });
    await hook({ hook_event_name: "SessionStart", session_id: "s1", source: "resume" });
    await hook({ hook_event_name: "UserPromptSubmit", session_id: "s1" });
    await hook({ hook_event_name: "Notification", session_id: "s1" });
    await hook({ hook_event_name: "Stop", session_id: "s1" });
    expect(events.filter((e) => e.type === "agent-hook")).toEqual([
      { type: "agent-hook", agentId: "hk1", event: "SessionStart", source: "resume" },
      { type: "agent-hook", agentId: "hk1", event: "UserPromptSubmit" },
      { type: "agent-hook", agentId: "hk1", event: "Notification" },
      { type: "agent-hook", agentId: "hk1", event: "Stop" },
    ]);
  });

  it("marks stop/resume/delete as acted BEFORE the status event, only with the fleet-master header", async () => {
    const app = Fastify();
    const hub = new EventHub();
    const order: string[] = [];
    const acted = { mark: (id: string) => { order.push(`mark:${id}`); } };
    hub.subscribe((e) => { if (e.type === "agent-status") order.push(`status:${e.agentId}:${e.status}`); });
    const terminals = fakeTerminals();
    registerAgentApi(app, { terminals: terminals as any, store, hub, workspaceDir: "/tmp", acted });
    await store.save({
      id: "act1", label: "G", repo: "", worktree: "/tmp", branch: "", baseBranch: "",
      sessionId: null, hookToken: "t", status: "idle", createdAt: 1,
    });
    const headers = { "x-choibot-actor": "fleet-master" };
    await app.inject({ method: "POST", url: "/api/agents/act1/stop", headers });
    expect(order).toEqual(["mark:act1", "status:act1:done"]);
    order.length = 0;
    await app.inject({ method: "POST", url: "/api/agents/act1/stop" }); // the UI: no header
    expect(order).toEqual(["status:act1:done"]);
    order.length = 0;
    // A live terminal makes resume return early (no relaunch in this fake); the
    // mark still comes first.
    terminals.spawn({ id: "act1", cwd: "/tmp", args: [] });
    await app.inject({ method: "POST", url: "/api/agents/act1/resume", headers });
    expect(order).toEqual(["mark:act1"]);
    order.length = 0;
    await app.inject({ method: "POST", url: "/api/agents/act1/delete", headers });
    expect(order).toEqual(["mark:act1"]);
  });
});

describe("agents api hookToken stripping (chief)", () => {
  const rec = {
    id: "s1", label: "G", repo: "/tmp", worktree: "/tmp/w",
    branch: "agent/abc12345", baseBranch: "main", sessionId: null, hookToken: "secret",
    status: "running" as const, createdAt: 1,
  };
  const UT = CHIEF_UT;
  async function build(chiefOpts?: { misconfigured: string | null }) {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), "api-")));
    await store.save(rec as any);
    const app = Fastify();
    const chief = chiefOpts && chiefGate(chiefOpts.misconfigured);
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp", chief });
    return { app, store };
  }
  const both = async (app: any, headers: Record<string, string> = {}) => ({
    list: (await app.inject({ method: "GET", url: "/api/agents", headers })).json().sessions[0],
    one: (await app.inject({ method: "GET", url: "/api/agents/s1", headers })).json(),
  });

  it("without chief both routes include hookToken", async () => {
    const { app } = await build();
    const r = await both(app);
    expect(r.list.hookToken).toBe("secret");
    expect(r.one.hookToken).toBe("secret");
  });

  it("with chief a headerless caller does not see hookToken", async () => {
    const { app, store } = await build({ misconfigured: null });
    const r = await both(app);
    expect(r.list.hookToken).toBeUndefined();
    expect(r.one.hookToken).toBeUndefined();
    expect(r.one.id).toBe("s1");
    expect((await store.load("s1"))!.hookToken).toBe("secret");
  });

  it("with chief the user sees hookToken", async () => {
    const { app } = await build({ misconfigured: null });
    const r = await both(app, { [USER_HEADER]: UT });
    expect(r.list.hookToken).toBe("secret");
    expect(r.one.hookToken).toBe("secret");
  });

  it("misconfigured chief strips hookToken even for a valid user", async () => {
    const { app } = await build({ misconfigured: "bad" });
    const r = await both(app, { [USER_HEADER]: UT });
    expect(r.list.hookToken).toBeUndefined();
    expect(r.one.hookToken).toBeUndefined();
  });
});

// Merge gate on the local merge (spec §7 "Merge routes", §15): a real repo,
// a real worktree, a real SessionStore behind the gate.
describe("POST /api/agents/:id/merge gate (chief)", () => {
  const rec = (over: Partial<AgentRecord> & { id: string }): AgentRecord => ({
    label: over.id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
    hookToken: `tok-${over.id}`, status: "idle", createdAt: 1, ...over,
  });
  const agent = (id: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });
  const user = { [USER_HEADER]: CHIEF_UT };

  let cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups) await c();
    cleanups = [];
  });

  // Agent m1 (stopped unless `live`) owns a worktree on agent/m1 with one
  // commit main does not have yet; w2, lead1 and master are callers.
  async function setup(o: { chief?: { misconfigured: string | null }; live?: boolean } = {}) {
    const ws = await makeWorkspaceWithRepo();
    const storeDir = await mkdtemp(join(tmpdir(), "chief-merge-agents-"));
    cleanups.push(ws.cleanup, () => rm(storeDir, { recursive: true, force: true }));
    const wt = join(ws.workspaceDir, ".wt", "m1");
    await run("git", ["-C", ws.repo, "worktree", "add", "-q", "-b", "agent/m1", wt, "main"]);
    await writeFile(join(wt, "feature.txt"), "x\n");
    await run("git", ["-C", wt, "add", "feature.txt"]);
    await run("git", ["-C", wt, "commit", "-q", "-m", "feature"]);
    const store = new SessionStore(storeDir);
    await store.save(rec({ id: "m1", repo: ws.repo, worktree: wt, branch: "agent/m1", baseBranch: "main" }));
    await store.save(rec({ id: "w2" }));
    // "lead" joins AgentRecord's kind union in Phase 3; callerOf reads it already.
    await store.save(rec({ id: "lead1", kind: "lead" }));
    await store.save(rec({ id: "master", kind: "fleet-master" }));
    const terminals = fakeTerminals();
    if (o.live) terminals.spawn({ id: "m1", cwd: wt, args: [] });
    const app = Fastify();
    cleanups.push(() => app.close());
    const chief = o.chief && chiefGate(o.chief.misconfigured, store);
    registerAgentApi(app, { terminals: terminals as any, store, hub: new EventHub(), workspaceDir: ws.workspaceDir, chief });
    const merge = (headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url: "/api/agents/m1/merge", headers });
    const merged = () => run("git", ["-C", ws.repo, "merge-base", "--is-ancestor", "agent/m1", "main"]).then(() => true, () => false);
    return { merge, merged };
  }

  it("headerless → 403 pair-required and nothing is merged", async () => {
    const { merge, merged } = await setup({ chief: { misconfigured: null } });
    const res = await merge();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "pair-required", userAuth: "log" });
    expect(await merged()).toBe(false);
  });

  it("USER → ok and the branch is merged into its base", async () => {
    const { merge, merged } = await setup({ chief: { misconfigured: null } });
    const res = await merge(user);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await merged()).toBe(true);
  });

  it("fleet-master headers → ok and the branch is merged", async () => {
    const { merge, merged } = await setup({ chief: { misconfigured: null } });
    const res = await merge(agent("master"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await merged()).toBe(true);
  });

  it("a sibling worker → 403 merge is a user action and nothing is merged", async () => {
    const { merge, merged } = await setup({ chief: { misconfigured: null } });
    const res = await merge(agent("w2"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "merge is a user action" });
    expect(await merged()).toBe(false);
  });

  it("the agent itself → 403 merge is a user action", async () => {
    const { merge, merged } = await setup({ chief: { misconfigured: null } });
    const res = await merge(agent("m1"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "merge is a user action" });
    expect(await merged()).toBe(false);
  });

  it("a lead → 403 merge is a user action", async () => {
    const { merge, merged } = await setup({ chief: { misconfigured: null } });
    const res = await merge(agent("lead1"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "merge is a user action" });
    expect(await merged()).toBe(false);
  });

  it("the gate runs before the live check: a worker on a live agent gets 403, not 409", async () => {
    const { merge } = await setup({ chief: { misconfigured: null }, live: true });
    const res = await merge(agent("w2"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "merge is a user action" });
  });

  it("misconfigured → 503 even for the user", async () => {
    const { merge, merged } = await setup({ chief: { misconfigured: "bad" } });
    const res = await merge(user);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "chief-misconfigured" });
    expect(await merged()).toBe(false);
  });

  it("without chief a live agent → 409 (today)", async () => {
    const { merge, merged } = await setup({ live: true });
    const res = await merge();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "agent still live — stop it first" });
    expect(await merged()).toBe(false);
  });
});

// Persistent agents (spec §7): delete/resume/reopen need the paired user.
describe("persistent agent delete/resume gate (chief)", () => {
  const rec = (over: Partial<AgentRecord> & { id: string }): AgentRecord => ({
    label: over.id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
    hookToken: `tok-${over.id}`, status: "idle", createdAt: 1, ...over,
  });
  const user = { [USER_HEADER]: CHIEF_UT };
  let dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs = [];
  });

  async function setup(chief?: { misconfigured: string | null }) {
    const dir = await mkdtemp(join(tmpdir(), "chief-persist-"));
    dirs.push(dir);
    const store = new SessionStore(dir);
    await store.save(rec({ id: "master", kind: "fleet-master" }));
    await store.save(rec({ id: "w1" }));
    const terminals = fakeTerminals();
    terminals.spawn({ id: "master", cwd: dir, args: [] }); // live: resume returns early
    const app = Fastify();
    registerAgentApi(app, { terminals: terminals as any, store, hub: new EventHub(), workspaceDir: dir, chief: chief && chiefGate(chief.misconfigured, store) });
    const post = (id: string, action: string, headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url: `/api/agents/${id}/${action}`, headers });
    return { post, store, dir };
  }

  it("headerless delete of the master -> 403, record kept", async () => {
    const { post, store } = await setup({ misconfigured: null });
    const res = await post("master", "delete");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("pair-required");
    expect(await store.load("master")).not.toBeNull();
  });

  it("the fleet-master actor header is not an identity", async () => {
    const { post, store } = await setup({ misconfigured: null });
    const res = await post("master", "delete", { "x-choibot-actor": "fleet-master" });
    expect(res.statusCode).toBe(403);
    expect(await store.load("master")).not.toBeNull();
  });

  it("USER delete of the master -> 202, record gone", async () => {
    const { post, store } = await setup({ misconfigured: null });
    expect((await post("master", "delete", user)).statusCode).toBe(202);
    expect(await store.load("master")).toBeNull();
  });

  it("headerless resume and reopen of the master -> 403", async () => {
    const { post } = await setup({ misconfigured: null });
    for (const action of ["resume", "reopen"]) {
      const res = await post("master", action);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("pair-required");
    }
  });

  it("headerless delete of a lead -> 403, record kept", async () => {
    const { post, store } = await setup({ misconfigured: null });
    await store.save(rec({ id: "lead1", kind: "lead" }));
    expect((await post("lead1", "delete")).statusCode).toBe(403);
    expect(await store.load("lead1")).not.toBeNull();
  });

  it("worker delete under a misconfigured chief -> 202 (today)", async () => {
    const { post } = await setup({ misconfigured: "bad" });
    expect((await post("w1", "delete")).statusCode).toBe(202);
  });

  it("malformed traversal id -> 404 before any store access", async () => {
    const { post, dir } = await setup({ misconfigured: null });
    const bad = "x%2F..%2Fmaster";
    for (const action of ["delete", "resume", "reopen"]) {
      const res = await post(bad, action);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not found" });
    }
    expect(existsSync(join(dir, "master.json"))).toBe(true);
  });

  it("USER resume of the master -> 202", async () => {
    const { post } = await setup({ misconfigured: null });
    expect((await post("master", "resume", user)).statusCode).toBe(202);
  });

  it("headerless delete of a worker -> 202", async () => {
    const { post, store } = await setup({ misconfigured: null });
    expect((await post("w1", "delete")).statusCode).toBe(202);
    expect(await store.load("w1")).toBeNull();
  });

  it("misconfigured chief + persistent -> 503", async () => {
    const { post, store } = await setup({ misconfigured: "bad" });
    const res = await post("master", "delete", user);
    expect(res.statusCode).toBe(503);
    expect(await store.load("master")).not.toBeNull();
  });

  it("without chief the master delete -> 202 (today)", async () => {
    const { post, store } = await setup();
    expect((await post("master", "delete")).statusCode).toBe(202);
    expect(await store.load("master")).toBeNull();
  });
});

// SessionStore joins the id into a file path and Fastify decodes %2F in a
// param, so `x%2F..%2Ffleet-master` arrives as `x/../fleet-master`. The store
// and the routes that act before a load refuse it, with the flag off and on.
describe("malformed agent id on /api/agents/:id routes", () => {
  const rec = (over: Partial<AgentRecord> & { id: string }): AgentRecord => ({
    label: over.id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
    hookToken: `tok-${over.id}`, status: "idle", createdAt: 1, ...over,
  });
  let dirs: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs = [];
  });

  // Wired like index.ts: a chief gate only with CHIEF_ENABLED=1.
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "agent-trav-"));
    dirs.push(dir);
    const store = new SessionStore(dir);
    await store.save(rec({ id: "fleet-master", kind: "fleet-master" }));
    await store.save(rec({ id: "w1", status: "running" }));
    const files = async () => Object.fromEntries(await Promise.all(
      ["fleet-master", "w1"].map(async (id) => [id, await readFile(join(dir, `${id}.json`), "utf8")] as const)));
    const before = await files();
    const terminals = fakeTerminals();
    terminals.spawn({ id: "fleet-master", cwd: dir, args: [] });
    terminals.spawn({ id: "w1", cwd: dir, args: [] });
    const killed: string[] = [];
    const kill = terminals.kill.bind(terminals);
    terminals.kill = (id: string) => { killed.push(id); kill(id); };
    const hub = new EventHub();
    const events: unknown[] = [];
    hub.subscribe((e) => events.push(e));
    const chief = process.env.CHIEF_ENABLED === "1" ? chiefGate(null, store) : undefined;
    const app = Fastify();
    registerAgentApi(app, { terminals: terminals as any, store, hub, workspaceDir: dir, chief });
    const post = (id: string, action: string) =>
      app.inject({ method: "POST", url: `/api/agents/${id}/${action}`, headers: { [USER_HEADER]: CHIEF_UT } });
    const untouched = async () => {
      expect(await files()).toEqual(before);
      expect(killed).toEqual([]);
      expect(events).toEqual([]);
      expect(terminals.has("fleet-master") && terminals.has("w1")).toBe(true);
    };
    return { post, untouched };
  }

  const cases = [
    ["flag off", () => {}],
    ["flag on", () => {
      vi.stubEnv("CHIEF_ENABLED", "1");
      vi.stubEnv("CHIEF_USER_AUTH", "log");
      vi.stubEnv("CHIEF_CONSOLE_URL", "http://127.0.0.1:4999");
    }],
  ] as const;

  for (const [name, env] of cases) {
    it(`${name}: stop via x%2F..%2F<id> -> 404, fleet master and worker untouched`, async () => {
      env();
      const { post, untouched } = await setup();
      for (const target of ["fleet-master", "w1"]) {
        const res = await post(`x%2F..%2F${target}`, "stop");
        expect(res.statusCode, target).toBe(404);
        expect(res.json()).toEqual({ error: "not found" });
      }
      await untouched();
    });

    it(`${name}: delete via x%2F..%2F<id> -> 404, records kept, nothing killed`, async () => {
      env();
      const { post, untouched } = await setup();
      for (const target of ["fleet-master", "w1"]) {
        const res = await post(`x%2F..%2F${target}`, "delete");
        expect(res.statusCode, target).toBe(404);
        expect(res.json()).toEqual({ error: "not found" });
      }
      await untouched();
    });

    it(`${name}: every record route answers its not-found code and touches nothing`, async () => {
      env();
      const { post, untouched } = await setup();
      for (const action of ["resume", "reopen", "close", "account", "merge", "discard", "discard-file", "hook"]) {
        const res = await post("x%2F..%2Fw1", action);
        expect(res.statusCode, action).toBe(404);
      }
      await untouched();
    });
  }
});

describe("POST /api/agents spawnedBy (chief)", () => {
  const rec = (over: Partial<AgentRecord> & { id: string }): AgentRecord => ({
    label: over.id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
    hookToken: `tok-${over.id}`, status: "idle", createdAt: 1, ...over,
  });
  const agent = (id: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });
  let cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups) await c(); cleanups = []; });

  async function setup(withChief: boolean) {
    const dir = await mkdtemp(join(tmpdir(), "spawnedby-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const store = new SessionStore(join(dir, "store"));
    await store.save(rec({ id: "fleet-master", kind: "fleet-master" }));
    await store.save(rec({ id: "lead-app-shop", kind: "lead", area: "app-shop" }));
    await store.save(rec({ id: "w1" }));
    const app = Fastify();
    cleanups.push(() => app.close());
    registerAgentApi(app, {
      terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: dir,
      chief: withChief ? chiefGate(null, store) : undefined,
    });
    const spawn = async (headers: Record<string, string>, payload: Record<string, unknown> = {}) => {
      const res = await app.inject({ method: "POST", url: "/api/agents", headers, payload: { prompt: "go", ...payload } });
      expect(res.statusCode).toBe(202);
      return (await store.load(res.json().id))!;
    };
    return { spawn };
  }

  it("master headers -> spawnedBy fleet-master", async () => {
    const { spawn } = await setup(true);
    expect((await spawn(agent("fleet-master"))).spawnedBy).toBe("fleet-master");
  });
  // A lead's spawnedBy (and its body spawnedBy ignored) is asserted in
  // "lead spawn limits (chief)": a lead spawns only in its area's repos.
  it("worker headers -> spawnedBy is the worker id", async () => {
    const { spawn } = await setup(true);
    expect((await spawn(agent("w1"))).spawnedBy).toBe("w1");
  });
  it("headerless and user callers get no spawnedBy key", async () => {
    const { spawn } = await setup(true);
    expect("spawnedBy" in (await spawn({}))).toBe(false);
    expect("spawnedBy" in (await spawn({ [USER_HEADER]: CHIEF_UT }))).toBe(false);
  });
  it("a body spawnedBy is ignored", async () => {
    const { spawn } = await setup(true);
    expect("spawnedBy" in (await spawn({}, { spawnedBy: "evil", area: "x" }))).toBe(false);
    expect((await spawn(agent("w1"), { spawnedBy: "evil" })).spawnedBy).toBe("w1");
  });
  it("without chief the record has no new keys, even with agent headers", async () => {
    const { spawn } = await setup(false);
    const r = await spawn(agent("fleet-master"), { spawnedBy: "evil" });
    expect("spawnedBy" in r).toBe(false);
    expect("area" in r).toBe(false);
  });
});

describe("leads in the agents api", () => {
  it("GET /api/agents hides a lead", async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), "lead-list-")));
    await store.save({ id: "lead-app-shop", label: "L", repo: "", worktree: "/tmp", branch: "", baseBranch: "", sessionId: null,
      hookToken: "t", status: "idle", createdAt: 1, kind: "lead", area: "app-shop" });
    await store.save({ id: "w1", label: "W", repo: "", worktree: "/tmp", branch: "", baseBranch: "", sessionId: null,
      hookToken: "t", status: "idle", createdAt: 2 });
    const app = Fastify();
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: "/tmp" });
    const list = await app.inject({ method: "GET", url: "/api/agents" });
    expect(list.json().sessions.map((s: any) => s.id)).toEqual(["w1"]);
    await app.close();
  });
});

// Task 3-9, Review Focus 4 (spec §13): a lead spawns only in a repo whose
// basename its area's `repos` lists, refused before any worktree or record.
describe("lead spawn limits (chief)", () => {
  const rec = (over: Partial<AgentRecord> & { id: string }): AgentRecord => ({
    label: over.id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
    hookToken: `tok-${over.id}`, status: "idle", createdAt: 1, ...over,
  });
  const agent = (id: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });
  let cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups) await c(); cleanups = []; });

  // A workspace with repos app-shop and indexer; areas.json gives app-shop to
  // lead-app-shop and indexer to its own area. `areas: false` omits the store.
  async function setup(o: { areas?: boolean } = {}) {
    const root = await mkdtemp(join(tmpdir(), "lead-spawn-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspaceDir = join(root, "ws");
    const repos: Record<string, string> = {};
    for (const name of ["app-shop", "indexer"]) {
      repos[name] = join(workspaceDir, name);
      await run("git", ["init", "-q", "-b", "main", repos[name]]);
      await run("git", ["-C", repos[name], "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    }
    const worktreeRoot = join(root, "wt");
    const store = new SessionStore(join(root, "store"));
    await store.save(rec({ id: "fleet-master", kind: "fleet-master" }));
    await store.save(rec({ id: "lead-app-shop", kind: "lead", area: "app-shop" }));
    await store.save(rec({ id: "lead-nowhere", kind: "lead", area: "nowhere" }));
    await store.save(rec({ id: "w1" }));
    const areas = new AreaStore(join(root, "areas.json"), { exists: async () => true });
    await areas.set("app-shop", { repos: ["app-shop"], leadId: "lead-app-shop" });
    await areas.set("indexer", { repos: ["indexer"] });
    const terminals = fakeTerminals();
    const app = Fastify();
    cleanups.push(() => app.close());
    registerAgentApi(app, {
      terminals: terminals as any, store, hub: new EventHub(), workspaceDir, worktreeRoot,
      chief: chiefGate(null, store), ...(o.areas === false ? {} : { areas }),
    });
    const spawn = (headers: Record<string, string>, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/agents", headers, payload: { prompt: "go", ...payload } });
    const ids = async () => (await store.list()).map((r) => r.id).sort();
    const before = await ids();
    // Nothing was created: no worktree dir, no new record, no terminal.
    const untouched = async () => {
      expect(existsSync(worktreeRoot)).toBe(false);
      expect(await ids()).toEqual(before);
      expect(terminals.spawned).toEqual([]);
      for (const path of Object.values(repos)) {
        const { stdout } = await run("git", ["-C", path, "worktree", "list", "--porcelain"]);
        expect(stdout.match(/^worktree /gm)).toHaveLength(1);
      }
    };
    return { spawn, store, repos, untouched };
  }

  it("a lead in a repo outside its area (indexer) → 403, no worktree, no record", async () => {
    const { spawn, repos, untouched } = await setup();
    const res = await spawn(agent("lead-app-shop"), { repo: repos.indexer });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "repo outside the lead's area" });
    await untouched();
  });

  it("a lead in its area's repo (app-shop) → 202, spawnedBy the lead; a body spawnedBy is ignored", async () => {
    const { spawn, store, repos } = await setup();
    const res = await spawn(agent("lead-app-shop"), { repo: repos["app-shop"], spawnedBy: "evil" });
    expect(res.statusCode).toBe(202);
    const r = (await store.load(res.json().id))!;
    expect(r).toMatchObject({ repo: repos["app-shop"], spawnedBy: "lead-app-shop" });
    expect("area" in r).toBe(false);
  });

  it.each([["no repo", {}], ["an empty repo", { repo: "" }], ["the workspace sentinel", { repo: "__workspace__" }]])(
    "a lead with %s → 403, no record", async (_n, payload) => {
      const { spawn, untouched } = await setup();
      const res = await spawn(agent("lead-app-shop"), payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "a lead spawns only in its area's repos" });
      await untouched();
    });

  it("a lead whose area areas.json does not list → 403 in any repo", async () => {
    const { spawn, repos, untouched } = await setup();
    for (const repo of Object.values(repos)) {
      const res = await spawn(agent("lead-nowhere"), { repo });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "repo outside the lead's area" });
    }
    await untouched();
  });

  it("without an area store a lead spawns nothing (fails closed)", async () => {
    const { spawn, repos, untouched } = await setup({ areas: false });
    const res = await spawn(agent("lead-app-shop"), { repo: repos["app-shop"] });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "repo outside the lead's area" });
    await untouched();
  });

  it("a path whose basename is in the area but is not a workspace repo → not a worktree (400 unknown repo)", async () => {
    const { spawn, repos, untouched } = await setup();
    const res = await spawn(agent("lead-app-shop"), { repo: `${repos.indexer}/../app-shop` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "unknown repo" });
    await untouched();
  });

  it("master, worker and user callers are not limited (indexer → 202)", async () => {
    const { spawn, repos } = await setup();
    const callers: Array<Record<string, string>> = [agent("fleet-master"), agent("w1"), { [USER_HEADER]: CHIEF_UT }, {}];
    for (const headers of callers) {
      expect((await spawn(headers, { repo: repos.indexer })).statusCode).toBe(202);
    }
  });
});

// Final review C1 (hardened only): git writes `branch: Created from <start>`
// to a new branch's reflog whatever GIT_REFLOG_ACTION says, and an agent can
// plant that reflog as a symlink to a console file. So a hardened deployment
// refuses a caller-given branch, base or start name outside [A-Za-z0-9._/-]
// (or with a leading "-") before any git call.
describe("POST /api/agents ref names, hardened (final review C1)", () => {
  const HARD = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:1", CHIEF_AGENT_UID: "1001" };
  const SHELL = "x$(touch${IFS}pwned)";
  let cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const c of cleanups) await c();
    cleanups = [];
  });

  async function setup() {
    const { workspaceDir, repo, cleanup } = await makeWorkspaceWithRepo();
    cleanups.push(cleanup);
    const store = new SessionStore(join(workspaceDir, ".store"));
    const worktreeRoot = join(workspaceDir, ".wt");
    const app = Fastify();
    cleanups.push(() => app.close());
    registerAgentApi(app, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir, worktreeRoot });
    const spawn = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/agents", payload: { repo, prompt: "go", ...payload } });
    const hasRef = async (ref: string) =>
      run("git", ["-C", repo, "show-ref", "--verify", "--quiet", ref]).then(() => true, () => false);
    // An agent-made branch whose name holds shell text, and a planted reflog
    // symlink for a new branch `name` to a console file.
    await run("git", ["-C", repo, "branch", SHELL]);
    const plant = async (name: string) => {
      const victim = join(workspaceDir, `victim-${name}`);
      await writeFile(victim, "# console file\n");
      const { symlink, mkdir } = await import("node:fs/promises");
      await mkdir(join(repo, ".git", "logs", "refs", "heads"), { recursive: true });
      await symlink(victim, join(repo, ".git", "logs", "refs", "heads", name));
      return victim;
    };
    return { repo, store, worktreeRoot, spawn, hasRef, plant };
  }

  it("hardened: a bad branch, baseBranch or createFrom is a 400 before any git call: no branch, no worktree, no record, the console file untouched", async () => {
    const { store, worktreeRoot, spawn, hasRef, plant } = await setup();
    const victim = await plant("evil");
    for (const [k, v] of Object.entries(HARD)) vi.stubEnv(k, v);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ branch: "evil", baseBranch: SHELL }, /^invalid baseBranch: /],
      [{ baseBranch: "evil", createFrom: SHELL }, /^invalid createFrom: /],
      [{ branch: "a;b" }, /^invalid branch: /],
      [{ branch: "-f" }, /^invalid branch: /],
      [{ baseBranch: "--orphan" }, /^invalid baseBranch: /],
      [{ createFrom: ["main"], baseBranch: "evil" }, /^invalid createFrom: /],
    ];
    for (const [payload, error] of cases) {
      const res = await spawn(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error, JSON.stringify(payload)).toMatch(error);
    }
    expect(await readFile(victim, "utf8")).toBe("# console file\n");
    expect(await hasRef("refs/heads/evil")).toBe(false);
    expect(existsSync(worktreeRoot)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("control: the console's branch creation, run without the check, writes `Created from <shell text>` through the symlink (GIT_REFLOG_ACTION set)", async () => {
    const { repo, plant } = await setup();
    const victim = await plant("evil");
    for (const [k, v] of Object.entries(HARD)) vi.stubEnv(k, v);
    const { ensureBaseBranch } = await import("./repos.js");
    await ensureBaseBranch(repo, "evil", SHELL);
    expect(await readFile(victim, "utf8")).toContain(`branch: Created from ${SHELL}`);
  });

  it("hardened: a default base whose name holds shell text (planted origin/HEAD) is refused too", async () => {
    const { repo, store, worktreeRoot, spawn, hasRef, plant } = await setup();
    const victim = await plant("evil");
    await run("git", ["-C", repo, "update-ref", `refs/remotes/origin/${SHELL}`, "HEAD"]);
    await run("git", ["-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${SHELL}`]);
    for (const [k, v] of Object.entries(HARD)) vi.stubEnv(k, v);
    const res = await spawn({ branch: "evil" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^invalid baseBranch: /);
    expect(await readFile(victim, "utf8")).toBe("# console file\n");
    expect(await hasRef("refs/heads/evil")).toBe(false);
    expect(existsSync(worktreeRoot)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("not hardened (flag on without CHIEF_AGENT_UID, or flag off): today's behaviour, the names are taken", async () => {
    const { store, spawn, hasRef } = await setup();
    vi.stubEnv("CHIEF_AGENT_UID", "");
    const res = await spawn({ branch: "w$(true)", baseBranch: "feat$(true)", createFrom: "main" });
    expect(res.statusCode).toBe(202);
    const rec = await store.load(res.json().id);
    expect(rec?.branch).toBe("w$(true)");
    expect(rec?.baseBranch).toBe("feat$(true)");
    expect(await hasRef("refs/heads/feat$(true)")).toBe(true);
    for (const [k, v] of Object.entries(HARD)) vi.stubEnv(k, v);
    vi.stubEnv("CHIEF_AGENT_UID", "");
    const res2 = await spawn({ branch: "w2$(true)" });
    expect(res2.statusCode).toBe(202);
    expect((await store.load(res2.json().id))?.branch).toBe("w2$(true)");
  });
});
