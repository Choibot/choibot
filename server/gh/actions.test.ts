// server/gh/actions.test.ts
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeArgs, mergeRestArgs, prRestArgs, prCloseArgs, prReopenArgs, issueCloseArgs, issueReopenArgs, commentArgs, MERGE_METHODS, registerGhActionsApi } from "./actions.js";
import { GhError } from "./exec.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { makeGate } from "../chief/gate.js";

const run = promisify(execFile);

describe("action arg-builders", () => {
  it("merge with each method", () => {
    expect(mergeArgs(7, "squash")).toEqual(["pr", "merge", "7", "--squash"]);
    expect(mergeArgs(7, "merge")).toEqual(["pr", "merge", "7", "--merge"]);
    expect(mergeArgs(7, "rebase")).toEqual(["pr", "merge", "7", "--rebase"]);
  });
  it("merge bound to a head commit (the Queue ticket's merge)", () => {
    const sha = "a".repeat(40);
    expect(mergeArgs(7, "squash", sha)).toEqual(["pr", "merge", "7", "--squash", "--match-head-commit", sha]);
    expect(mergeArgs(7, "merge", "")).toEqual(["pr", "merge", "7", "--merge"]);
  });
  it("only squash/merge/rebase are valid methods", () => {
    expect(MERGE_METHODS).toEqual(["squash", "merge", "rebase"]);
  });
  it("pr close/reopen", () => {
    expect(prCloseArgs(7)).toEqual(["pr", "close", "7"]);
    expect(prReopenArgs(7)).toEqual(["pr", "reopen", "7"]);
  });
  it("issue close/reopen", () => {
    expect(issueCloseArgs(9)).toEqual(["issue", "close", "9"]);
    expect(issueReopenArgs(9)).toEqual(["issue", "reopen", "9"]);
  });
  it("comment on pr vs issue", () => {
    expect(commentArgs("pr", 7, "hi there")).toEqual(["pr", "comment", "7", "--body", "hi there"]);
    expect(commentArgs("issue", 9, "yo")).toEqual(["issue", "comment", "9", "--body", "yo"]);
  });
});

// Merge gate (spec §7 "Merge routes", §15): a real gate over a real
// SessionStore; only `gh` is a fake that records its calls.
const GRAPHQL_DOWN = "GraphQL: Something went wrong while executing your query on 2026-11-25T16:12:58Z. Please include `E554:1F94F7:AA81766:FB98E2F:6B070908` when reporting this issue.";
const READ_HEAD = "c".repeat(40);

describe("/api/gh/pr/merge gate (chief)", () => {
  const USER_TOKEN = "u".repeat(43);
  const rec = (id: string, kind: string | undefined): AgentRecord => ({
    id, label: id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
    hookToken: `tok-${id}`, status: "idle", createdAt: 1,
    ...(kind ? { kind: kind as AgentRecord["kind"] } : {}),
  });
  const agent = (id: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });
  const user = { [USER_HEADER]: USER_TOKEN };
  const body = { repo: "demo", pr: 7, method: "squash" };

  let app: FastifyInstance | undefined;
  let root: string | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  // A workspace whose one repo has a GitHub-style origin (listRepos keeps only
  // those), agent records for each kind, and the app with or without a gate.
  // `graphqlDown`: gh's merge fails as GitHub's GraphQL API failed on 2026-11-25; its REST API works.
  async function setup(o: { chief?: { misconfigured: string | null }; onPrChange?: () => void; ghFails?: boolean; graphqlDown?: boolean } = {}) {
    root = await mkdtemp(join(tmpdir(), "chief-ghmerge-"));
    const workspaceDir = join(root, "ws");
    const repo = join(workspaceDir, "demo");
    await run("git", ["init", "-q", "-b", "main", repo]);
    await run("git", ["-C", repo, "remote", "add", "origin", "git@github.com:o/demo.git"]);
    const storeDir = join(root, "agents");
    await mkdir(storeDir);
    const store = new SessionStore(storeDir);
    for (const r of [rec("master", "fleet-master"), rec("w1", undefined), rec("lead1", "lead"),
      { ...rec("lead-app-shop", "lead"), area: "app-shop" }]) await store.save(r);
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const gh = async (args: string[], opts?: { cwd?: string }) => {
      calls.push({ args, cwd: opts?.cwd });
      if (o.ghFails) throw new Error("gh: not mergeable");
      if (o.graphqlDown && args[0] === "pr") throw new GhError("unknown", GRAPHQL_DOWN);
      if (o.graphqlDown && args.includes("PUT")) return JSON.stringify({ sha: "9".repeat(40), merged: true, message: "Pull Request successfully merged" });
      if (o.graphqlDown) return JSON.stringify({ number: 7, state: "open", merged: false, head: { sha: READ_HEAD }, merge_commit_sha: "8".repeat(40) });
      return "";
    };
    const chief = o.chief && makeGate({
      misconfigured: o.chief.misconfigured, userAuth: "log",
      deps: {
        devices: { verify: async (t: string) => (t === USER_TOKEN ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) },
        agents: store,
      },
    });
    app = Fastify();
    registerGhActionsApi(app, { gh, workspaceDir, chief, ...(o.onPrChange ? { onPrChange: o.onPrChange } : {}) });
    const merge = (headers: Record<string, string> = {}, payload: object = body) =>
      app!.inject({ method: "POST", url: "/api/gh/pr/merge", headers, payload });
    return { merge, calls, repo };
  }

  it("headerless → 403 pair-required and gh is not called", async () => {
    const { merge, calls } = await setup({ chief: { misconfigured: null } });
    const res = await merge();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "pair-required", userAuth: "log" });
    expect(calls).toEqual([]);
  });

  it("the gate runs before the body checks: headerless with an unknown repo is still 403", async () => {
    const { merge, calls } = await setup({ chief: { misconfigured: null } });
    const res = await merge({}, { repo: "nope", pr: 7, method: "squash" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("pair-required");
    expect(calls).toEqual([]);
  });

  it("USER → 200 and gh merges the PR in the repo", async () => {
    const { merge, calls, repo } = await setup({ chief: { misconfigured: null } });
    const res = await merge(user);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ args: mergeArgs(7, "squash"), cwd: repo }]);
  });

  // Overview decision 60: the queue closes the PR's item at once, not at PrWatch's next timer.
  it("onPrChange fires after a merge and a close that gh took; never after a failed one, a reopen or a refused request", async () => {
    let n = 0;
    const { merge } = await setup({ chief: { misconfigured: null }, onPrChange: () => { n++; } });
    expect((await merge()).statusCode).toBe(403);
    expect(n).toBe(0);
    expect((await merge(user)).statusCode).toBe(200);
    expect(n).toBe(1);
    const post = (route: string) => app!.inject({ method: "POST", url: `/api/gh/pr/${route}`, headers: user, payload: { repo: "demo", pr: 7 } });
    expect((await post("close")).statusCode).toBe(200);
    expect(n).toBe(2);
    expect((await post("reopen")).statusCode).toBe(200);
    expect(n).toBe(2);
    await app!.close();
    const failing = await setup({ chief: { misconfigured: null }, onPrChange: () => { n++; }, ghFails: true });
    expect((await failing.merge(user)).statusCode).toBe(502);
    expect(n).toBe(2);
  });

  it("an onPrChange that throws never changes the merge route's answer", async () => {
    const { merge } = await setup({ chief: { misconfigured: null }, onPrChange: () => { throw new Error("queue down"); } });
    const res = await merge(user);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  // GitHub's GraphQL API down: the same route and gate, the merge goes through the REST API.
  it("USER, GraphQL down → 200 with the note; the REST merge takes the head of its read; onPrChange fires", async () => {
    let n = 0;
    const { merge, calls, repo } = await setup({ chief: { misconfigured: null }, graphqlDown: true, onPrChange: () => { n++; } });
    const res = await merge(user);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, note: "GitHub's GraphQL API failed. The merge went through GitHub's REST API." });
    expect(calls).toEqual([
      { args: mergeArgs(7, "squash"), cwd: repo }, { args: prRestArgs(7), cwd: repo }, { args: mergeRestArgs(7, "squash", READ_HEAD), cwd: repo },
    ]);
    expect(n).toBe(1);
  });

  it.each([["a worker", "w1"], ["a lead", "lead1"]])("GraphQL down: %s still gets 403 and gh is not called", async (_n, id) => {
    const { merge, calls } = await setup({ chief: { misconfigured: null }, graphqlDown: true });
    const res = await merge(agent(id));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "merge is a user action" });
    expect(calls).toEqual([]);
  });

  it("fleet-master headers → 200", async () => {
    const { merge, calls } = await setup({ chief: { misconfigured: null } });
    const res = await merge(agent("master"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("worker headers → 403 merge is a user action", async () => {
    const { merge, calls } = await setup({ chief: { misconfigured: null } });
    const res = await merge(agent("w1"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "merge is a user action" });
    expect(calls).toEqual([]);
  });

  it("lead headers → 403 merge is a user action", async () => {
    const { merge, calls } = await setup({ chief: { misconfigured: null } });
    const res = await merge(agent("lead1"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "merge is a user action" });
    expect(calls).toEqual([]);
  });

  // Task 3-9, ruling Q5: `choibot agents merge-pr` from a real lead record (id lead-<area>, an area).
  it("a real lead (lead-app-shop, area app-shop) → 403 merge is a user action", async () => {
    const { merge, calls } = await setup({ chief: { misconfigured: null } });
    const res = await merge(agent("lead-app-shop"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "merge is a user action" });
    expect(calls).toEqual([]);
  });

  it("a master id with a wrong token → 403 merge is a user action", async () => {
    const { merge, calls } = await setup({ chief: { misconfigured: null } });
    const res = await merge({ [AGENT_HEADER]: "master", [AGENT_TOKEN_HEADER]: "wrong" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "merge is a user action" });
    expect(calls).toEqual([]);
  });

  it("misconfigured → 503 even for the user", async () => {
    const { merge, calls } = await setup({ chief: { misconfigured: "bad" } });
    const res = await merge(user);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "chief-misconfigured" });
    expect(calls).toEqual([]);
  });

  it("without chief a headerless merge → 200 (today)", async () => {
    const { merge, calls, repo } = await setup();
    const res = await merge();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ args: mergeArgs(7, "squash"), cwd: repo }]);
  });
});
