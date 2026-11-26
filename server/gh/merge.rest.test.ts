// server/gh/merge.rest.test.ts — the one merge of a PR (actions.ts mergePullRequest) when GitHub's
// GraphQL API fails (2026-11-25: the owner's Merge press failed twice while GitHub's REST API
// worked). Only gh is fake: a runner that answers each gh command from a script and records it.
import { describe, expect, it } from "vitest";
import { classifyError, GhError } from "./exec.js";
import { isGraphqlOutage, mergeArgs, mergePullRequest, mergeRestArgs, prRestArgs } from "./actions.js";

const REPO = "/ws/demo";
const HEAD = "a1b2c3d".padEnd(40, "0");
const OTHER = "f".repeat(40);
const MERGED_SHA = "9".repeat(40);

// The texts gh printed on 2026-11-25 and before (the console's journal and the agents' logs).
const OUTAGE = "GraphQL: Something went wrong while executing your query on 2026-11-25T16:11:50Z. Please include `9CC2:35A6B9:AA29EA7:FB4B23F:6B0708C6` when reporting this issue.";
const HTTP_5XX = [
  "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)",
  "HTTP 503: 503 Service Unavailable (https://api.github.com/graphql)",
  "HTTP 503: No server is currently available to service your request. Sorry about that. Please try resubmitting your request and contact us if the problem persists. (https://api.github.com/graphql)",
  "HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)",
];

type Answer = { out: unknown } | { fail: string };
const ok = (out: unknown): Answer => ({ out });
const fail = (text: string): Answer => ({ fail: text });
// The REST read of a PR, as GitHub gives it (GET repos/o/r/pulls/N; the fields the fallback reads).
const pull = (o: { state?: string; merged?: boolean; head?: string; number?: number; mergeSha?: string | null } = {}) => ({
  number: o.number ?? 12, state: o.state ?? "open", merged: o.merged ?? false, html_url: "https://github.com/o/demo/pull/12",
  head: { sha: o.head ?? HEAD, ref: "agent/a1" }, base: { ref: "main" }, merge_commit_sha: o.mergeSha === undefined ? MERGED_SHA : o.mergeSha,
});
const MERGED = { sha: MERGED_SHA, merged: true, message: "Pull Request successfully merged" };

// gh as the console runs it: a failure throws GhError with gh's text (exec.ts gh()).
function fakeGh(script: { merge: Answer; reads?: Answer[]; put?: Answer }) {
  const calls: { args: string[]; cwd?: string }[] = [];
  const reads = [...(script.reads ?? [])];
  const gh = async (args: string[], opts?: { cwd?: string }): Promise<string> => {
    calls.push({ args, cwd: opts?.cwd });
    let a: Answer | undefined;
    if (args[0] === "pr" && args[1] === "merge") a = script.merge;
    else if (args[0] === "api" && args.includes("PUT")) a = script.put;
    else if (args[0] === "api") a = reads.shift();
    if (!a) throw new Error(`the test did not script: gh ${args.join(" ")}`);
    if ("fail" in a) throw new GhError(classifyError(a.fail), a.fail);
    return typeof a.out === "string" ? a.out : JSON.stringify(a.out);
  };
  return { gh, calls };
}
const cmds = (calls: { args: string[] }[]) => calls.map((c) => c.args);

describe("mergePullRequest: GitHub's GraphQL API fails, its REST API merges", () => {
  it("the 2026-11-25 text: a REST read, then the REST merge with the method and the caller's head as sha", async () => {
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull())], put: ok(MERGED) });
    const logs: string[] = [];
    const r = await mergePullRequest(gh, REPO, 12, "rebase", HEAD, { log: (s) => logs.push(s) });
    expect(r).toEqual({ ok: true, note: "GitHub's GraphQL API failed. The merge went through GitHub's REST API." });
    expect(cmds(calls)).toEqual([mergeArgs(12, "rebase", HEAD), prRestArgs(12), mergeRestArgs(12, "rebase", HEAD)]);
    expect(mergeRestArgs(12, "rebase", HEAD)).toEqual(
      ["api", "-X", "PUT", "repos/{owner}/{repo}/pulls/12/merge", "-f", "merge_method=rebase", "-f", `sha=${HEAD}`]);
    expect(prRestArgs(12)).toEqual(["api", "repos/{owner}/{repo}/pulls/12"]);
    // Same runner, same repo folder (gh's credentials and repo of today).
    expect(calls.every((c) => c.cwd === REPO)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("PR #12");
    expect(logs[0]).toContain("merged through GitHub's REST API (rebase, head a1b2c3d)");
  });

  it.each(HTTP_5XX)("a 5xx of the GraphQL endpoint (%s): the REST merge runs", async (text) => {
    const { gh, calls } = fakeGh({ merge: fail(text), reads: [ok(pull())], put: ok(MERGED) });
    const r = await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: () => {} });
    expect(r).toMatchObject({ ok: true });
    expect(cmds(calls)).toEqual([mergeArgs(12, "squash", HEAD), prRestArgs(12), mergeRestArgs(12, "squash", HEAD)]);
  });

  it("the GitHub tab's merge (no head given): the head of the REST read is the sha", async () => {
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull({ head: OTHER }))], put: ok(MERGED) });
    const r = await mergePullRequest(gh, REPO, 12, "squash", undefined, { log: () => {} });
    expect(r).toMatchObject({ ok: true });
    expect(cmds(calls)).toEqual([mergeArgs(12, "squash"), prRestArgs(12), mergeRestArgs(12, "squash", OTHER)]);
  });

  it("the head the caller gave is compared without letter case", async () => {
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull({ head: HEAD.toUpperCase() }))], put: ok(MERGED) });
    expect(await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: () => {} })).toMatchObject({ ok: true });
    expect(cmds(calls)[2]).toEqual(mergeRestArgs(12, "squash", HEAD));
  });
});

describe("mergePullRequest: a refusal with a reason gives no fallback", () => {
  it.each([
    // GitHub's refusals of the merge mutation (real texts).
    "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)",
    "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)",
    "GraphQL: Pull request Repository rule violations found (mergePullRequest)",
    // gh's own refusal before the mutation.
    "X Pull request o/demo#12 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.",
    // A 4xx of the GraphQL endpoint, a 5xx of another endpoint.
    "HTTP 401: Bad credentials (https://api.github.com/graphql)",
    "HTTP 403: Resource not accessible by integration (https://api.github.com/graphql)",
    "HTTP 502: 502 Bad Gateway (https://api.github.com/repos/o/demo/pulls/12)",
    // The outage text, but not alone: a second error joined by gh, a path, a line after it.
    `${OUTAGE}, Pull Request is not mergeable (mergePullRequest)`,
    `${OUTAGE} (mergePullRequest)`,
    `${OUTAGE}\nPull Request is not mergeable`,
    `! The merge strategy for main is set by the merge queue\n${OUTAGE}`,
    "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)\nX Pull request o/demo#12 is not mergeable",
  ])("%s: the text goes to the caller as today, no REST call", async (text) => {
    const { gh, calls } = fakeGh({ merge: fail(text) });
    const logs: string[] = [];
    const r = await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: (s) => logs.push(s) });
    expect(r).toEqual({ ok: false, status: 502, error: text, kind: "unknown" });
    expect(cmds(calls)).toEqual([mergeArgs(12, "squash", HEAD)]);
    expect(logs).toEqual([]);
  });

  it.each([
    ["To get started with GitHub CLI, please run:  gh auth login", 401, "not_authed"],
    ["GraphQL: Could not resolve to a PullRequest with the number of 12. (repository.pullRequest)", 404, "not_found"],
    ["GraphQL: API rate limit exceeded for user ID 1.", 429, "rate_limited"],
  ] as const)("%s: a refusal with its own kind keeps its status, no REST call", async (text, status, kind) => {
    const { gh, calls } = fakeGh({ merge: fail(text) });
    expect(await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: () => {} })).toEqual({ ok: false, status, error: text, kind });
    expect(calls).toHaveLength(1);
  });

  it("isGraphqlOutage matches only the two forms", () => {
    expect(isGraphqlOutage(OUTAGE)).toBe(true);
    for (const t of HTTP_5XX) expect(isGraphqlOutage(t)).toBe(true);
    expect(isGraphqlOutage(`  ${OUTAGE}\n`)).toBe(true);
    expect(isGraphqlOutage("HTTP 500 (https://api.github.com/graphql)")).toBe(true);
    expect(isGraphqlOutage("HTTP 409: Conflict (https://api.github.com/graphql)")).toBe(false);
    expect(isGraphqlOutage("HTTP 5022: x (https://api.github.com/graphql)")).toBe(false);
    expect(isGraphqlOutage("HTTP 502: x (https://api.github.com/graphql/x)")).toBe(false);
    expect(isGraphqlOutage("HTTP 502: x (https://evil.example/https://api.github.com/graphql)")).toBe(false);
    expect(isGraphqlOutage("GraphQL: Something went wrong while executing your query on T. Please include `a b` when reporting this issue.")).toBe(false);
    expect(isGraphqlOutage("")).toBe(false);
  });
});

describe("mergePullRequest: the REST read before the REST merge", () => {
  it("already merged (the GraphQL call merged it after all): a success that says so, no second merge", async () => {
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull({ state: "closed", merged: true }))] });
    const logs: string[] = [];
    const r = await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: (s) => logs.push(s) });
    expect(r).toEqual({ ok: true, note: "GitHub's GraphQL API failed, but GitHub shows PR #12 as merged." });
    expect(cmds(calls)).toEqual([mergeArgs(12, "squash", HEAD), prRestArgs(12)]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("already merged");
  });

  it("closed and not merged: no merge, a clear text", async () => {
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull({ state: "closed", merged: false }))] });
    const r = await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: () => {} });
    expect(r).toEqual({ ok: false, status: 409, kind: "closed",
      error: `GitHub's GraphQL API failed: ${OUTAGE} PR #12 is closed and not merged. Nothing was merged.` });
    expect(cmds(calls)).toEqual([mergeArgs(12, "squash", HEAD), prRestArgs(12)]);
  });

  it("a changed head: no merge, a clear text", async () => {
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull({ head: OTHER }))] });
    const r = await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: () => {} });
    expect(r).toEqual({ ok: false, status: 409, kind: "moved",
      error: `GitHub's GraphQL API failed: ${OUTAGE} PR #12 has new commits (head fffffff, not a1b2c3d). Nothing was merged. Look again.` });
    expect(cmds(calls)).toEqual([mergeArgs(12, "squash", HEAD), prRestArgs(12)]);
  });

  it.each([
    ["the read fails", fail("HTTP 502: 502 Bad Gateway (https://api.github.com/repos/o/demo/pulls/12)")],
    ["the read is not JSON", ok("<html>oops</html>")],
    ["the read is of another PR", ok(pull({ number: 13 }))],
    ["the read has no head commit", ok(pull({ head: "" }))],
    ["the read has a state GitHub does not give", ok(pull({ state: "locked" }))],
    ["merged without a merge commit", ok(pull({ state: "closed", merged: true, mergeSha: null }))],
  ])("%s: no fallback, the first error goes to the caller as today", async (_n, read) => {
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [read] });
    const logs: string[] = [];
    const r = await mergePullRequest(gh, REPO, 12, "squash", undefined, { log: (s) => logs.push(s) });
    expect(r).toEqual({ ok: false, status: 502, error: OUTAGE, kind: "unknown" });
    expect(cmds(calls)).toEqual([mergeArgs(12, "squash"), prRestArgs(12)]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("no fallback");
  });
});

describe("mergePullRequest: the REST merge fails too", () => {
  const REFUSED = "gh: Pull Request is not mergeable (HTTP 405)";

  it("both errors, in order; the status of the second; a read again after the refusal", async () => {
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull()), ok(pull())], put: fail(REFUSED) });
    const logs: string[] = [];
    const r = await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: (s) => logs.push(s) });
    expect(r).toEqual({ ok: false, status: 502, kind: "unknown",
      error: `GitHub's GraphQL API failed: ${OUTAGE} Then the merge through GitHub's REST API failed too: ${REFUSED}` });
    expect(cmds(calls)).toEqual([mergeArgs(12, "squash", HEAD), prRestArgs(12), mergeRestArgs(12, "squash", HEAD), prRestArgs(12)]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(REFUSED);
  });

  it("the read again fails: both errors", async () => {
    const { gh } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull()), fail("HTTP 503: 503 Service Unavailable (https://api.github.com/repos/o/demo/pulls/12)")], put: fail(REFUSED) });
    const r = await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: () => {} });
    expect(r).toMatchObject({ ok: false, error: `GitHub's GraphQL API failed: ${OUTAGE} Then the merge through GitHub's REST API failed too: ${REFUSED}` });
  });

  it("the head changed between the read and the merge (409): both errors", async () => {
    const moved = "gh: Head branch was modified. Review and try the merge again. (HTTP 409)";
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull()), ok(pull({ head: OTHER }))], put: fail(moved) });
    const r = await mergePullRequest(gh, REPO, 12, "squash", undefined, { log: () => {} });
    expect(r).toMatchObject({ ok: false, error: `GitHub's GraphQL API failed: ${OUTAGE} Then the merge through GitHub's REST API failed too: ${moved}` });
    expect(cmds(calls)[2]).toEqual(mergeRestArgs(12, "squash", HEAD));
  });

  it("the GraphQL merge went through after all (the first read was a moment behind): the read again says merged, a success", async () => {
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull()), ok(pull({ state: "closed", merged: true }))], put: fail(REFUSED) });
    const logs: string[] = [];
    const r = await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: (s) => logs.push(s) });
    expect(r).toEqual({ ok: true, note: "GitHub's GraphQL API failed, but GitHub shows PR #12 as merged." });
    expect(cmds(calls)).toEqual([mergeArgs(12, "squash", HEAD), prRestArgs(12), mergeRestArgs(12, "squash", HEAD), prRestArgs(12)]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("already merged");
  });

  it("merged without a merge commit on the read again: both errors", async () => {
    const { gh, calls } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull()), ok(pull({ state: "closed", merged: true, mergeSha: "" }))], put: fail(REFUSED) });
    expect(await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: () => {} })).toEqual({ ok: false, status: 502, kind: "unknown",
      error: `GitHub's GraphQL API failed: ${OUTAGE} Then the merge through GitHub's REST API failed too: ${REFUSED}` });
    expect(cmds(calls)).toEqual([mergeArgs(12, "squash", HEAD), prRestArgs(12), mergeRestArgs(12, "squash", HEAD), prRestArgs(12)]);
  });

  it("an answer of the REST merge without merged: true is a failure, not a success", async () => {
    const { gh } = fakeGh({ merge: fail(OUTAGE), reads: [ok(pull()), ok(pull())], put: ok({ merged: false, message: "nope" }) });
    const r = await mergePullRequest(gh, REPO, 12, "squash", HEAD, { log: () => {} });
    expect(r).toMatchObject({ ok: false, status: 502, kind: "unknown" });
    expect(r.ok ? "" : r.error).toContain("Then the merge through GitHub's REST API failed too:");
  });
});
