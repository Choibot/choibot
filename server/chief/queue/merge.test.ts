// server/chief/queue/merge.test.ts — the Merge button of a pr ticket (merge.ts, api.ts): a tiny
// Fastify app with the real gate, store, QueueActions, AutoAnswer and QueueMerge in a temp dir.
// Only gh is fake: the fresh read (`facts`), the PR state the "I merged it" close reads, and the
// one merge function (a spy that counts every merge).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import { mergePullRequest, mergeRestArgs, type GhRunner, type GhWriteResult, type MergeMethod } from "../../gh/actions.js";
import { GhError } from "../../gh/exec.js";
import type { PrMergeFacts } from "../../gh/status.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER } from "../auth.js";
import { CHIEF_ERR, makeGate } from "../gate.js";
import { harness, lines, type Harness } from "./actions.fixture.js";
import { QueueActions } from "./actions.js";
import { registerQueueApi } from "./api.js";
import { AutoAnswer } from "./auto.js";
import { isMergedNotice } from "./lines.js";
import { checksAsk, mergeBlock, QueueMerge } from "./merge.js";
import { prMergeState } from "./prgate.js";
import type { NewItem } from "./store.js";
import type { QueueItem } from "./types.js";

const NOW = 9_000_000;
const UNDO_MS = 600_000;
const PR_URL = "https://github.com/o/app-shop/pull/12";
const HEAD = "a1b2c3d".padEnd(40, "0");
const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/ws/app-shop", worktree: `/ws/wt-${id}`, branch: `agent/${id}`, baseBranch: "main",
  sessionId: null, hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...o,
});
const RECORDS: Record<string, AgentRecord> = {
  [FLEET_MASTER_ID]: rec(FLEET_MASTER_ID, { kind: "fleet-master", repo: "" }),
  a1: rec("a1"),
  "lead-app": rec("lead-app", { kind: "lead" as AgentRecord["kind"] }),
};
type H = Record<string, string>;
const agentHdr = (id: string): H => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });
const pairRequired = { error: CHIEF_ERR.pairRequired, userAuth: "log" };

const prItem: NewItem = {
  agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "app-shop", area: "app-shop", kind: "pr",
  title: "Merge me", body: "b", blocking: false, pr: { url: PR_URL, number: 12, checks: "success", mergeable: "MERGEABLE" },
};
const question: NewItem = { ...prItem, kind: "question", title: "How?", blocking: true, pr: undefined } as NewItem;

let root: string;
let h: Harness;
let app: FastifyInstance;
let userHdr: H;
let gh: { state: string; draft: boolean; mergeable: string; failed: number; pending: number; mergeFails: string | null; mergedLate: number;
  url: string; number: number; headSha: string };
let merges: { repoPath: string; pr: number; method: MergeMethod; headSha: string }[];
let reads: number;
let prChanges: number;
let rule: string;
let mergeGate: Promise<void> | null;

const facts = (): PrMergeFacts => ({
  number: gh.number, url: gh.url, state: gh.state, draft: gh.draft, mergeable: gh.mergeable, base: "main",
  head: "agent/a1", headSha: gh.headSha, title: "Merge me (GitHub title)",
  checks: { total: 3, passed: 3 - gh.failed - gh.pending, failed: gh.failed, pending: gh.pending,
    rollup: gh.failed ? "failure" : gh.pending ? "pending" : "success" },
});

// `ghRunner`: the merge is the real gh/actions.ts mergePullRequest over this fake gh runner.
async function build(o: { misconfigured?: string | null; ghRunner?: GhRunner } = {}) {
  root = mkdtempSync(join(tmpdir(), "chief-queue-merge-"));
  h = harness(root, () => NOW);
  const devices = new DeviceStore(join(root, "user-devices.json"));
  userHdr = { [USER_HEADER]: await devices.add("laptop") };
  const agents = { load: async (id: string) => RECORDS[id] ?? null };
  const gate = makeGate({ misconfigured: o.misconfigured ?? null, userAuth: "log", deps: { devices, agents } });
  gh = { state: "OPEN", draft: false, mergeable: "MERGEABLE", failed: 0, pending: 0, mergeFails: null, mergedLate: 0, url: PR_URL, number: 12, headSha: HEAD };
  merges = []; reads = 0; prChanges = 0; mergeGate = null;
  const listRepos = async () => [{ name: "app-shop", slug: "o/app-shop", path: "/ws/app-shop" }];
  // The state "I merged it" reads (prgate.ts): MERGED once the merge spy ran, `mergedLate` reads after it.
  const prStatus = async () => {
    let prState = gh.state;
    if (prState === "MERGED" && gh.mergedLate > 0) { gh.mergedLate--; prState = "OPEN"; }
    return { prState, mergeable: gh.mergeable, reviewDecision: "", url: PR_URL, checks: facts().checks };
  };
  const actions = new QueueActions({
    store: h.store, rules: h.rules, decisions: h.decisions, agents, deliverer: h.kicker, inbox: { cancel: () => "absent" },
    audit: h.audit, undoMs: UNDO_MS, now: () => NOW, log: h.log,
    mergeState: (it) => prMergeState({ agents, workspaceDir: "/ws", listRepos, prStatus, isAncestor: async () => false }, it),
  });
  // The master's `answer --auto` with a real active rule: it must never reach a merge.
  const autoAnswer = new AutoAnswer({
    store: h.store, rules: h.rules, agents, audit: h.audit, deliverer: h.kicker, mode: () => "weak", threshold: 0.5, undoMs: UNDO_MS,
    now: () => NOW, log: h.log,
  });
  rule = (await h.rules.add({ text: "always merge the PR", state: "active", kind: "decision", source: { origin: "panel" },
    scope: { area: "app-shop", repo: "app-shop", audience: "all" } })).rule.id;
  await h.rules.confirm(rule, { via: "telegram" });
  const merge = new QueueMerge({
    store: h.store, workspaceDir: "/ws", listRepos,
    facts: async () => { reads++; return facts(); },
    merge: async (repoPath, pr, method, headSha): Promise<GhWriteResult> => {
      merges.push({ repoPath, pr, method, headSha });
      if (o.ghRunner) return mergePullRequest(o.ghRunner, repoPath, pr, method, headSha, { log: h.log });
      if (mergeGate) await mergeGate;
      if (gh.mergeFails) return { ok: false, status: 405, error: gh.mergeFails, kind: "unknown" };
      gh.state = "MERGED";
      return { ok: true };
    },
    closeMerged: (id) => actions.answerUser(id, { value: "approve" }, "tab"),
    onPrChange: () => { prChanges++; },
    retryMs: 1, log: h.log, now: () => NOW,
  });
  app = Fastify();
  registerQueueApi(app, {
    gate, undoMs: UNDO_MS, store: h.store, actions, autoAnswer, merge,
    add: async () => { throw new Error("no add in these tests"); },
    events: { addQueue: async () => {} }, agents, weekMetrics: async () => ({ decisions: 0, corrections: 0 }),
    hardened: () => false, prWatch: { refreshSoon: () => {} }, previewEnabled: false, now: () => NOW, log: h.log,
  });
}
beforeEach(async () => { await build(); });
afterEach(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

const post = (url: string, headers: H, payload: unknown = {}) => app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers: H) => app.inject({ method: "GET", url, headers });
const item = async (id: string): Promise<QueueItem> => (await h.store.get(id))!;
const addPr = async (o: Partial<NewItem> = {}): Promise<string> => (await h.store.add({ ...prItem, ...o })).id;

describe("POST /api/queue/:id/merge: the user merges from the ticket", () => {
  it("merges with the chosen method, then closes the ticket as \"I merged it\" does", async () => {
    const id = await addPr();
    const r = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "rebase" });
    expect(r.statusCode).toBe(200);
    // The head the user saw goes to GitHub (--match-head-commit, gh/actions.ts mergeArgs).
    expect(merges).toEqual([{ repoPath: "/ws/app-shop", pr: 12, method: "rebase", headSha: HEAD }]);
    const closed = await item(id);
    expect(r.json()).toEqual({ merged: true, item: closed });
    // The same result as "I merged it": withdrawn as merged, the merged notice pending, a kick,
    // and the user's decision line.
    expect(closed).toMatchObject({ status: "withdrawn", lastError: "merged" });
    expect(isMergedNotice(closed)).toBe(true);
    expect(h.kicks).toEqual([id]);
    expect(await lines(h)).toEqual([expect.objectContaining({ itemId: id, by: "user", via: "queue-tab", value: "approve", prUrl: PR_URL })]);
    expect(prChanges).toBe(1);
    expect(h.logs.some((l) => l.includes(`${id}: PR #12 merged (rebase, head a1b2c3d) from the ticket by device laptop`))).toBe(true);
  });

  it("reads the PR fresh at press time, not the ticket's pills", async () => {
    const id = await addPr(); // the pills say: checks pass, mergeable
    gh.mergeable = "CONFLICTING";
    const r = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ reason: "blocked", error: "PR #12 has conflicts with main. Fix them first.", blocked: { why: "conflicts" } });
    expect(reads).toBe(1);
    expect(merges).toEqual([]);
    // The pills take the fresh read; the ticket stays open.
    expect((await item(id)).pr).toMatchObject({ mergeable: "CONFLICTING" });
    expect((await item(id)).status).toBe("open");
  });

  it.each([
    ["a draft", () => { gh.draft = true; }, "draft", "PR #12 is a draft. Mark it ready on GitHub first."],
    ["already merged", () => { gh.state = "MERGED"; }, "merged", "PR #12 is already merged."],
    ["closed", () => { gh.state = "CLOSED"; }, "closed", "PR #12 is closed."],
    ["a conflict check that is not done", () => { gh.mergeable = "UNKNOWN"; }, "unknown", "GitHub has not finished its conflict check. Try again in a moment."],
  ])("refuses %s: 409 with the reason, no merge", async (_n, arrange, why, text) => {
    const id = await addPr();
    arrange();
    const r = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash", checks: "accept" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ reason: "blocked", error: text, blocked: { why, text } });
    expect(merges).toEqual([]);
  });

  it("asks first while checks fail or run; with checks: accept it merges", async () => {
    const id = await addPr();
    gh.failed = 1;
    const ask = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" });
    expect(ask.statusCode).toBe(409);
    expect(ask.json()).toMatchObject({ reason: "checks", error: "Checks: 1 failing.", checks: "Checks: 1 failing." });
    expect(merges).toEqual([]);
    expect((await item(id)).pr).toMatchObject({ checks: "failure" });
    const yes = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash", checks: "accept" });
    expect(yes.statusCode).toBe(200);
    expect(merges).toHaveLength(1);
  });

  it("a GitHub refusal: its text, the ticket stays open, no decision line, no kick", async () => {
    const id = await addPr();
    gh.mergeFails = "GraphQL: Pull request Repository rule violations found (mergePullRequest)";
    const r = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" });
    expect(r.statusCode).toBe(405);
    expect(r.json()).toMatchObject({ reason: "github", error: gh.mergeFails });
    expect((await item(id)).status).toBe("open");
    expect(await lines(h)).toEqual([]);
    expect(h.kicks).toEqual([]);
    expect(prChanges).toBe(0);
  });

  it("GitHub shows the merge a moment late: one retry closes the ticket", async () => {
    const id = await addPr();
    gh.mergedLate = 1;
    const r = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" });
    expect(r.statusCode).toBe(200);
    expect(r.json().item).toMatchObject({ status: "withdrawn", lastError: "merged" });
  });

  it("GitHub still shows it open after the retry: 200 merged, the ticket waits for PrWatch", async () => {
    const id = await addPr();
    gh.mergedLate = 5;
    const r = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ merged: true, item: { id, status: "open" } });
    expect(prChanges).toBe(1);
  });

  it("one merge per ticket at a time", async () => {
    const id = await addPr();
    let release!: () => void;
    mergeGate = new Promise((r) => { release = r; });
    const first = post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" });
    while (merges.length === 0) await new Promise((r) => setImmediate(r));
    const second = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ reason: "running" });
    release();
    expect((await first).statusCode).toBe(200);
    expect(merges).toHaveLength(1);
  });

  it("refuses a bad body, a ticket that is not a GitHub pr, a closed ticket and an unknown id", async () => {
    const id = await addPr();
    expect((await post(`/api/queue/${id}/merge`, userHdr, {})).statusCode).toBe(400);
    expect((await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "fast-forward" })).statusCode).toBe(400);
    expect((await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash", checks: "yes" })).statusCode).toBe(400);
    const q = (await h.store.add(question)).id;
    expect((await post(`/api/queue/${q}/merge`, userHdr, { head: HEAD, method: "squash" })).statusCode).toBe(400);
    const local = await addPr({ pr: { local: { repo: "app-shop", branch: "agent/a1", aheadAtAdd: true } } });
    expect((await post(`/api/queue/${local}/merge`, userHdr, { head: HEAD, method: "squash" })).statusCode).toBe(400);
    await h.store.withItem(id, async () => { await h.store.write({ ...(await item(id)), status: "withdrawn", lastError: "closed" }); });
    const closed = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ reason: "closed" });
    expect((await post("/api/queue/q00000000/merge", userHdr, { head: HEAD, method: "squash" })).statusCode).toBe(404);
    expect(merges).toEqual([]);
    expect(reads).toBe(0);
  });
});

// GitHub's GraphQL API fails (2026-11-25), its REST API works: the real merge function over a
// fake gh. GraphQL: gh's merge. REST: a read of the PR (`gh api repos/{owner}/{repo}/pulls/N`)
// and the merge (PUT .../merge).
describe("the merge when GitHub's GraphQL API fails", () => {
  const DOWN = "GraphQL: Something went wrong while executing your query on 2026-11-25T16:11:50Z. Please include `9CC2:35A6B9:AA29EA7:FB4B23F:6B0708C6` when reporting this issue.";
  const NOTE = "GitHub's GraphQL API failed. The merge went through GitHub's REST API.";
  let calls: string[][];
  let putFails: string | null;
  const runner: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "pr") throw new GhError("unknown", DOWN);
    if (args.includes("PUT")) {
      if (putFails) throw new GhError("unknown", putFails);
      gh.state = "MERGED";
      return JSON.stringify({ sha: "9".repeat(40), merged: true, message: "Pull Request successfully merged" });
    }
    const merged = gh.state === "MERGED";
    return JSON.stringify({ number: gh.number, state: merged ? "closed" : "open", merged, head: { sha: gh.headSha }, merge_commit_sha: "9".repeat(40) });
  };
  beforeEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    calls = []; putFails = null;
    await build({ ghRunner: runner });
  });

  it("the REST merge takes the method and the head the user saw; the answer and the closed ticket keep the note", async () => {
    const id = await addPr();
    const r = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "rebase" });
    expect(r.statusCode).toBe(200);
    expect(calls.at(-1)).toEqual(mergeRestArgs(12, "rebase", HEAD));
    const closed = await item(id);
    expect(closed).toMatchObject({ status: "withdrawn", lastError: "merged", mergeNote: { text: NOTE, at: NOW } });
    expect(r.json()).toEqual({ merged: true, item: closed, note: NOTE });
    // A later read of the ticket (GET /api/queue/:id) still has it.
    expect((await get(`/api/queue/${id}`, userHdr)).json()).toMatchObject({ mergeNote: { text: NOTE } });
    expect(h.logs.filter((l) => l.includes("merged through GitHub's REST API"))).toHaveLength(1);
    expect(prChanges).toBe(1);
  });

  it("the REST merge fails too: both errors in the answer and the log, the ticket stays open with no note", async () => {
    putFails = "gh: Pull Request is not mergeable (HTTP 405)";
    const id = await addPr();
    const r = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" });
    const both = `GitHub's GraphQL API failed: ${DOWN} Then the merge through GitHub's REST API failed too: ${putFails}`;
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ reason: "github", error: both });
    expect(h.logs.some((l) => l.includes(`${id}: merge of PR #12 failed: ${both}`))).toBe(true);
    const open = await item(id);
    expect(open.status).toBe("open");
    expect(open.mergeNote).toBeUndefined();
    expect(prChanges).toBe(0);
  });

  it("the agent roles still get 403 and gh is not called", async () => {
    const id = await addPr();
    for (const hdr of [agentHdr("a1"), agentHdr(FLEET_MASTER_ID), agentHdr("lead-app"), {}]) {
      const p = await post(`/api/queue/${id}/merge`, hdr, { head: HEAD, method: "squash", checks: "accept" });
      expect(p.statusCode).toBe(403);
    }
    expect(calls).toEqual([]);
    expect(merges).toEqual([]);
  });
});

// The merge binds to what the user saw (an agent wrote the ticket and its PR url).
describe("the merge binds to the PR and the head commit the confirm showed", () => {
  it.each([
    ["another repo", () => { gh.url = "https://github.com/o/other/pull/12"; }, "o/other#12"],
    ["another number", () => { gh.url = "https://github.com/o/app-shop/pull/13"; gh.number = 13; }, "o/app-shop#13"],
    ["a url that is not a PR", () => { gh.url = ""; }, "another PR"],
  ])("GitHub gives %s: GET and POST refuse with reason mismatch, nothing merges", async (_n, arrange, got) => {
    const id = await addPr();
    arrange();
    const g = await get(`/api/queue/${id}/merge`, userHdr);
    expect(g.statusCode).toBe(409);
    expect(g.json()).toEqual({ reason: "mismatch", error: `GitHub gives ${got} for this ticket's o/app-shop#12. Merge is off.` });
    const p = await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash", checks: "accept" });
    expect(p.statusCode).toBe(409);
    expect(p.json()).toMatchObject({ reason: "mismatch" });
    expect(merges).toEqual([]);
    // The pills are not touched by a read of another PR.
    expect((await item(id)).pr).toMatchObject({ checks: "success", mergeable: "MERGEABLE" });
  });

  it("the same PR with other letter case is the same PR", async () => {
    const id = await addPr();
    gh.url = "https://github.com/O/App-shop/pull/12";
    expect((await get(`/api/queue/${id}/merge`, userHdr)).statusCode).toBe(200);
    expect((await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" })).statusCode).toBe(200);
  });

  it("new commits since the confirm: 409 moved with the fresh facts, nothing merges", async () => {
    const id = await addPr();
    const seen = (await get(`/api/queue/${id}/merge`, userHdr)).json().facts.headSha;
    expect(seen).toBe(HEAD);
    gh.headSha = "f".repeat(40); // a push lands
    const r = await post(`/api/queue/${id}/merge`, userHdr, { head: seen, method: "squash", checks: "accept" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ reason: "moved", error: "New commits since you opened this. Look again.", facts: { headSha: "f".repeat(40) } });
    expect(merges).toEqual([]);
    // Looked again: the new head merges.
    expect((await post(`/api/queue/${id}/merge`, userHdr, { head: "F".repeat(40), method: "squash" })).statusCode).toBe(200);
    expect(merges).toEqual([expect.objectContaining({ headSha: "f".repeat(40) })]);
  });

  it("a POST without the head commit, or with one that is not 40 hex, is refused before any read", async () => {
    const id = await addPr();
    for (const head of [undefined, "", "a1b2c3d", "z".repeat(40), 7]) {
      const r = await post(`/api/queue/${id}/merge`, userHdr, { method: "squash", ...(head === undefined ? {} : { head }) });
      expect(r.statusCode).toBe(400);
    }
    expect(reads).toBe(0);
    expect(merges).toEqual([]);
  });
});

describe("GET /api/queue/:id/merge: the facts of the confirm step", () => {
  it("gives the fresh facts, the reason it cannot merge and the checks ask", async () => {
    const id = await addPr();
    const ok = await get(`/api/queue/${id}/merge`, userHdr);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ facts: facts(), blocked: null, checks: null });
    gh.pending = 2;
    expect((await get(`/api/queue/${id}/merge`, userHdr)).json()).toMatchObject({ blocked: null, checks: "Checks: 2 still running." });
    expect((await item(id)).pr).toMatchObject({ checks: "pending" });
    gh.draft = true;
    expect((await get(`/api/queue/${id}/merge`, userHdr)).json()).toMatchObject({ blocked: { why: "draft" } });
    expect(merges).toEqual([]);
  });
});

// The hard rule (as the Deploy button's): only a USER caller, a paired device's token. Every
// other caller gets 403 pair-required, and neither gh read nor merge runs.
describe("who may merge", () => {
  const callers: [string, () => H][] = [
    ["no headers (a loopback request, the cookie session)", () => ({})],
    ["a user token that does not verify", () => ({ [USER_HEADER]: "not-a-token" })],
    ["the ticket's own agent", () => agentHdr("a1")],
    ["the fleet master", () => agentHdr(FLEET_MASTER_ID)],
    ["a lead", () => agentHdr("lead-app")],
    ["an agent that also sends a valid user token", () => ({ ...agentHdr("a1"), ...userHdr })],
    ["the master that also sends a valid user token", () => ({ ...agentHdr(FLEET_MASTER_ID), ...userHdr })],
    ["an agent header with a wrong token", () => ({ [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "nope" })],
  ];
  it.each(callers)("%s: POST and GET get 403 pair-required, nothing is read or merged", async (_n, hdr) => {
    const id = await addPr();
    const p = await post(`/api/queue/${id}/merge`, hdr(), { head: HEAD, method: "squash", checks: "accept" });
    expect(p.statusCode).toBe(403);
    expect(p.json()).toEqual(pairRequired);
    const g = await get(`/api/queue/${id}/merge`, hdr());
    expect(g.statusCode).toBe(403);
    expect(g.json()).toEqual(pairRequired);
    expect(reads).toBe(0);
    expect(merges).toEqual([]);
    expect((await item(id)).status).toBe("open");
  });

  it("a misconfigured core answers 503 before any caller lookup", async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    await build({ misconfigured: "bad mode" });
    const id = await addPr();
    expect((await post(`/api/queue/${id}/merge`, userHdr, { head: HEAD, method: "squash" })).statusCode).toBe(503);
    expect(merges).toEqual([]);
  });

  // No other queue route reaches a merge, whatever the caller and the body: an `answer` with any
  // value (also the user's own approve), an auto answer by an active rule, a recommendation, an
  // undo, a snooze, a withdraw, a delivery action.
  it("no other queue route merges, for any caller and any body", async () => {
    const bodies = (id: string): unknown[] => [
      { value: "merge" }, { value: "approve" }, { value: "approve", method: "squash", checks: "accept" },
      { value: "merge", text: "squash it" }, { value: "approve", auto: true, ruleIds: [rule], confidence: 0.99 },
      { value: "merge", auto: true, ruleIds: [rule], confidence: 0.99 },
      { value: "approve", why: "rule says merge", ruleIds: [rule] }, { minutes: 5 }, { action: "resend", slot: "answer", id },
    ];
    const who: H[] = [{}, userHdr, agentHdr("a1"), agentHdr(FLEET_MASTER_ID), agentHdr("lead-app")];
    const routes = ["answer", "recommend", "undo", "snooze", "withdraw", "delivery"];
    const id = await addPr();
    for (const route of routes) {
      for (const hdr of who) {
        for (const body of bodies(id)) {
          const r = await post(`/api/queue/${id}/${route}`, hdr, body);
          expect(r.statusCode).toBeLessThan(500);
        }
      }
    }
    expect(merges).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe("mergeBlock and checksAsk", () => {
  const f = { number: 465, state: "OPEN", draft: false, mergeable: "MERGEABLE", base: "main" };
  it("no block for an open, ready, mergeable PR", () => { expect(mergeBlock(f)).toBeNull(); });
  it("names the state GitHub gives when it is none of the known ones", () => {
    expect(mergeBlock({ ...f, state: "LOCKED" })).toEqual({ why: "state", text: 'GitHub gives PR #465 the state "LOCKED".' });
  });
  it("the checks ask", () => {
    expect(checksAsk({ failed: 0, pending: 0 })).toBeNull();
    expect(checksAsk({ failed: 1, pending: 0 })).toBe("Checks: 1 failing.");
    expect(checksAsk({ failed: 2, pending: 1 })).toBe("Checks: 2 failing, 1 running.");
    expect(checksAsk({ failed: 0, pending: 3 })).toBe("Checks: 3 still running.");
  });
});
