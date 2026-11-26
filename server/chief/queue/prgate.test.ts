import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import type { PrStatus } from "../../gh/status.js";
import { gateRefusal, prLabel, prMergeState, type MergeGateDeps } from "./prgate.js";
import type { QueueItem } from "./types.js";

const URL1 = "https://github.com/example-org/app-shop/pull/7";
const rec = (o: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "a1", label: "x", repo: "/ws/app-shop", worktree: "/ws/wt", branch: "agent/x", baseBranch: "main",
  sessionId: null, hookToken: "t", status: "running", createdAt: 1, ...o,
});
const st = (prState: string): PrStatus => ({
  prState, mergeable: "MERGEABLE", reviewDecision: "", url: URL1, checks: { total: 0, passed: 0, failed: 0, pending: 0, rollup: "none" },
});
const item = (pr: QueueItem["pr"], o: Partial<QueueItem> = {}): QueueItem => ({
  id: "q00000001", kind: "pr", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "app-shop", area: "app-shop",
  title: "t", body: "", createdAt: 1, updatedAt: 1, status: "open", blocking: false, history: [], answerSeq: 0, ...(pr ? { pr } : {}), ...o,
});
const urlItem = () => item({ url: URL1, number: 7 });
const localItem = (aheadAtAdd?: boolean) => item({ local: { repo: "app-shop", branch: "agent/x", ...(aheadAtAdd === undefined ? {} : { aheadAtAdd }) } });

function deps(o: Partial<MergeGateDeps> & { agent?: AgentRecord | null } = {}) {
  const prStatus = vi.fn(o.prStatus ?? (async () => st("OPEN")));
  const isAncestor = vi.fn(o.isAncestor ?? (async () => false));
  const agent = o.agent === undefined ? rec() : o.agent;
  const d: MergeGateDeps = {
    agents: { load: async () => agent }, workspaceDir: "/ws",
    listRepos: o.listRepos ?? (async () => [{ name: "app-shop", slug: "example-org/app-shop", path: "/ws/app-shop" }]),
    prStatus, isAncestor, ...(o.callTimeoutMs !== undefined ? { callTimeoutMs: o.callTimeoutMs } : {}),
  };
  return { d, prStatus, isAncestor };
}

describe("prMergeState, an item with a PR URL", () => {
  it("MERGED → merged, read with gh in the PR's workspace repo", async () => {
    const { d, prStatus } = deps({ prStatus: async () => st("MERGED") });
    expect(await prMergeState(d, urlItem())).toEqual({ state: "merged" });
    expect(prStatus).toHaveBeenCalledWith("/ws/app-shop", 7);
  });
  it("OPEN and CLOSED → not merged", async () => {
    expect(await prMergeState(deps().d, urlItem())).toEqual({ state: "not-merged", detail: "open" });
    expect(await prMergeState(deps({ prStatus: async () => st("CLOSED") }).d, urlItem())).toEqual({ state: "not-merged", detail: "closed without a merge" });
  });
  it("the state is read fresh on every call (no cache)", async () => {
    const states = ["OPEN", "MERGED"];
    const { d, prStatus } = deps({ prStatus: async () => st(states.shift()!) });
    expect((await prMergeState(d, urlItem())).state).toBe("not-merged");
    expect((await prMergeState(d, urlItem())).state).toBe("merged");
    expect(prStatus).toHaveBeenCalledTimes(2);
  });
  it("fails closed: a gh error, an unknown state, a repo outside the workspace and a hung gh are all `unknown`", async () => {
    expect(await prMergeState(deps({ prStatus: async () => { throw new Error("gh: not authed\nrun gh auth login"); } }).d, urlItem()))
      .toEqual({ state: "unknown", why: "gh: not authed run gh auth login" });
    expect(await prMergeState(deps({ prStatus: async () => st("") }).d, urlItem())).toMatchObject({ state: "unknown" });
    const none = deps({ listRepos: async () => [] });
    expect(await prMergeState(none.d, urlItem())).toEqual({ state: "unknown", why: "its repository is not in the workspace" });
    expect(none.prStatus).not.toHaveBeenCalled();
    expect(await prMergeState(deps({ listRepos: async () => { throw new Error("EACCES"); } }).d, urlItem())).toEqual({ state: "unknown", why: "EACCES" });
    const hung = await prMergeState(deps({ prStatus: () => new Promise(() => {}), callTimeoutMs: 20 }).d, urlItem());
    expect(hung).toEqual({ state: "unknown", why: "gh pr view timed out after 20 ms" });
  });
  it("matches the repo slug without case", async () => {
    const { d } = deps({ prStatus: async () => st("MERGED"), listRepos: async () => [{ name: "app-shop", slug: "Example-Org/App-shop", path: "/ws/app-shop" }] });
    expect(await prMergeState(d, urlItem())).toEqual({ state: "merged" });
  });
});

describe("prMergeState, a local branch", () => {
  it("an ancestor of the record's base → merged; else not merged, naming the base", async () => {
    const yes = deps({ isAncestor: async () => true });
    expect(await prMergeState(yes.d, localItem(true))).toEqual({ state: "merged" });
    expect(yes.isAncestor).toHaveBeenCalledWith("/ws/app-shop", "agent/x", "main");
    expect(await prMergeState(deps().d, localItem(true))).toEqual({ state: "not-merged", detail: "not in main" });
  });
  it("asks git whatever aheadAtAdd says (that flag only guards PrWatch's own close)", async () => {
    for (const ahead of [true, false, undefined]) {
      expect((await prMergeState(deps({ isAncestor: async () => true }).d, localItem(ahead))).state).toBe("merged");
      expect((await prMergeState(deps().d, localItem(ahead))).state).toBe("not-merged");
    }
  });
  it("fails closed: no record, a record with no repo, a git error and a hung git are `unknown`", async () => {
    const gone = deps({ agent: null });
    expect(await prMergeState(gone.d, localItem(true))).toMatchObject({ state: "unknown" });
    expect(gone.isAncestor).not.toHaveBeenCalled();
    expect(await prMergeState(deps({ agent: rec({ repo: "" }) }).d, localItem(true))).toMatchObject({ state: "unknown" });
    expect(await prMergeState(deps({ isAncestor: async () => { throw new Error("fatal: bad ref"); } }).d, localItem(true)))
      .toEqual({ state: "unknown", why: "fatal: bad ref" });
    expect(await prMergeState(deps({ isAncestor: () => new Promise(() => {}), callTimeoutMs: 20 }).d, localItem(true)))
      .toEqual({ state: "unknown", why: "git merge-base timed out after 20 ms" });
  });
});

describe("prMergeState never says merged for an item that is not a pr", () => {
  it("another kind, or a pr item with no pr field → unknown", async () => {
    const { d, prStatus } = deps({ prStatus: async () => st("MERGED"), isAncestor: async () => true });
    expect(await prMergeState(d, item({ url: URL1, number: 7 }, { kind: "choice" }))).toMatchObject({ state: "unknown" });
    expect(await prMergeState(d, item(undefined))).toMatchObject({ state: "unknown" });
    expect(prStatus).not.toHaveBeenCalled();
  });
});

describe("gateRefusal", () => {
  it("names the PR or the branch and says what to do", () => {
    expect(prLabel(urlItem())).toBe("PR #7");
    expect(prLabel(localItem())).toBe("branch agent/x");
    expect(gateRefusal(urlItem(), { state: "not-merged", detail: "open" }))
      .toEqual({ reason: "pr-not-merged", error: "PR #7 is not merged (open). Merge it first: this item then closes on its own." });
    expect(gateRefusal(localItem(), { state: "unknown", why: "fatal: bad ref" }))
      .toEqual({ reason: "pr-state-unknown", error: "Could not read the state of branch agent/x (fatal: bad ref). Approve is refused. Try again." });
  });
  it("a long reason is cut", async () => {
    const st2 = await prMergeState(deps({ prStatus: async () => { throw new Error("x".repeat(500)); } }).d, urlItem());
    expect(st2.state === "unknown" && st2.why.length).toBe(160);
  });
});
