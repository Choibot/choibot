// The caller gate of POST /api/agents/:id/pr and /fetch-base (part 3): the paired user for any
// agent, an agent (or lead) for itself only; never the master, another agent, a Recurring task
// (cron:<job>, no record) or a request with no identity. With no chief gate the route is as before. A real gate over a real SessionStore; gh is
// a fake, and no request here reaches git (the records have no repo, or no helper).
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PR_CALLER_ONLY, registerGhPrApi } from "./pr.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import { CLONE_NO_HELPER, setCloneExec } from "../agents/agentclone.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { makeGate } from "../chief/gate.js";

const USER_TOKEN = "u".repeat(43);
const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
  hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...o,
});
const agent = (id: string, token = `tok-${id}`) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: token });
const user = { [USER_HEADER]: USER_TOKEN };

let app: FastifyInstance | undefined;
let root: string | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  setCloneExec(null);
  vi.unstubAllEnvs();
});

async function setup(o: { chief?: { misconfigured: string | null } } = {}) {
  root = await mkdtemp(join(tmpdir(), "pr-gate-"));
  const store = new SessionStore(join(root, "store"));
  for (const r of [rec("w1"), rec("w2"), rec("lead1", { kind: "lead" }), rec("fleet-master", { kind: "fleet-master" }),
    rec("c1", { repo: "/srv/w/repo", worktree: "/srv/homes/clones/c1", branch: "agent/c1", baseBranch: "main", clone: true })]) await store.save(r);
  const ghCalls: string[][] = [];
  const chief = o.chief && makeGate({
    misconfigured: o.chief.misconfigured, userAuth: "log",
    deps: { devices: { verify: async (t: string) => (t === USER_TOKEN ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents: store },
  });
  app = Fastify();
  registerGhPrApi(app, { store, chief, gh: async (a) => { ghCalls.push(a); return ""; }, ghCwd: root });
  const post = (id: string, what: "pr" | "fetch-base", headers: Record<string, string> = {}, payload: object = {}) =>
    app!.inject({ method: "POST", url: `/api/agents/${id}/${what}`, headers, payload });
  return { post, ghCalls };
}

describe("POST /api/agents/:id/pr and /fetch-base: who may call", () => {
  it("with the gate: the user and the agent itself pass; another agent, a lead for another, the master and a wrong token are refused; no header must pair", async () => {
    const { post, ghCalls } = await setup({ chief: { misconfigured: null } });
    for (const what of ["pr", "fetch-base"] as const) {
      // Passed the gate: w1 has no repo (400 for pr, 409 for fetch-base).
      const passed = what === "pr" ? 400 : 409;
      expect((await post("w1", what, user)).statusCode).toBe(passed);
      expect((await post("w1", what, agent("w1"))).statusCode).toBe(passed);
      expect((await post("lead1", what, agent("lead1"))).statusCode).toBe(passed);
      for (const h of [agent("w2"), agent("lead1"), agent("fleet-master"), agent("w1", "wrong"), agent("cron:j1", "x")]) {
        const r = await post("w1", what, h);
        expect([what, h[AGENT_HEADER], r.statusCode, r.json()]).toEqual([what, h[AGENT_HEADER], 403, { error: PR_CALLER_ONLY }]);
      }
      const none = await post("w1", what);
      expect([none.statusCode, none.json()]).toEqual([403, { error: "pair-required", userAuth: "log" }]);
    }
    expect(ghCalls).toEqual([]);
  });

  it("a misconfigured gate answers 503; with no gate (chief off) the route is as before", async () => {
    expect((await (await setup({ chief: { misconfigured: "x" } })).post("w1", "pr", user)).statusCode).toBe(503);
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true });
    const r = await (await setup()).post("w1", "pr");
    expect([r.statusCode, r.json()]).toEqual([400, { error: "agent has no branch to push" }]);
  });

  it("an agent with its own clone: no helper gives 409; a bad title gives 400; both before any git", async () => {
    const { post, ghCalls } = await setup({ chief: { misconfigured: null } });
    expect((await post("c1", "pr", agent("c1"))).json()).toEqual({ error: CLONE_NO_HELPER });
    for (const [k, v] of Object.entries({ AGENT_HOME_ROOT: root!, CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "4242" })) vi.stubEnv(k, v);
    setCloneExec({ sudo: "/nonexistent/sudo", helper: "/nonexistent/helper", uid: 4242 });
    const r = await post("c1", "pr", agent("c1"), { title: "two\nlines" });
    expect([r.statusCode, r.json().error]).toEqual([400, expect.stringMatching(/one line/)]);
    expect(ghCalls).toEqual([]);
  });
});

describe("basic mode: the page's Open PR works as before", () => {
  it("the user's request for an agent with a worktree: pending work is committed, the branch pushed, gh pr create with today's arguments, the PR recorded", async () => {
    root = await mkdtemp(join(tmpdir(), "pr-basic-"));
    const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" }).trim();
    const origin = join(root, "origin.git");
    g(root, "init", "-q", "--bare", origin);
    const repo = join(root, "repo");
    g(root, "clone", "-q", origin, repo);
    await writeFile(join(repo, "README.md"), "hi\n");
    g(repo, "add", "README.md");
    g(repo, "commit", "-qm", "first");
    g(repo, "push", "-q", "origin", "main");
    const wt = join(root, "wt");
    g(repo, "worktree", "add", "-q", "-b", "agent/w9", wt);
    await writeFile(join(wt, "work.txt"), "work\n"); // not committed: the route commits it
    const store = new SessionStore(join(root, "store"));
    await store.save(rec("w9", { repo, worktree: wt, branch: "agent/w9", baseBranch: "main" }));
    const calls: { args: string[]; cwd?: string }[] = [];
    const chief = makeGate({ misconfigured: null, userAuth: "log", deps: { devices: { verify: async (tk: string) => (tk === USER_TOKEN ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents: store } });
    app = Fastify();
    registerGhPrApi(app, { store, chief, gh: async (a, o) => { calls.push({ args: a, cwd: o?.cwd }); return "https://github.com/o/r/pull/5\n"; } });
    const r = await app.inject({ method: "POST", url: "/api/agents/w9/pr", headers: user, payload: { title: "T", body: "B" } });
    expect([r.statusCode, r.json()]).toEqual([200, { url: "https://github.com/o/r/pull/5", number: 5 }]);
    expect(calls).toEqual([{ args: ["pr", "create", "--base", "main", "--head", "agent/w9", "--title", "T", "--body", "B"], cwd: repo }]);
    expect(g(origin, "ls-tree", "--name-only", "agent/w9")).toContain("work.txt");
    expect((await store.load("w9"))?.prNumber).toBe(5);
  });
});
