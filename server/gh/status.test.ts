// server/gh/status.test.ts
import { describe, it, expect } from "vitest";
import { summarizePr, fetchPrStatus, describeChecks, prSlug, agentOpenPr } from "./status.js";

const view = (rollup: any[], extra = {}) => ({
  state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
  url: "https://github.com/o/r/pull/7", statusCheckRollup: rollup, ...extra,
});

describe("summarizePr", () => {
  it("counts a mix of CheckRun and StatusContext entries", () => {
    const s = summarizePr(view([
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
      { __typename: "StatusContext", state: "FAILURE" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
    ]));
    expect(s.checks).toEqual({ total: 4, passed: 2, failed: 1, pending: 1, rollup: "failure" });
    expect(s.prState).toBe("OPEN");
    expect(s.mergeable).toBe("MERGEABLE");
    expect(s.reviewDecision).toBe("APPROVED");
    expect(s.url).toBe("https://github.com/o/r/pull/7");
  });
  it("rollup is success when all pass", () => {
    expect(summarizePr(view([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }])).checks.rollup).toBe("success");
  });
  it("rollup is pending when none failed but some in flight", () => {
    expect(summarizePr(view([
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", status: "QUEUED", conclusion: null },
    ])).checks.rollup).toBe("pending");
  });
  it("rollup is none with no checks; tolerates missing statusCheckRollup", () => {
    expect(summarizePr(view([])).checks.rollup).toBe("none");
    expect(summarizePr({ state: "OPEN", mergeable: "UNKNOWN", reviewDecision: "", url: "u" }).checks.total).toBe(0);
  });
});

describe("describeChecks", () => {
  it("normalizes CheckRun and StatusContext entries with duration + url", () => {
    expect(describeChecks([
      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS",
        detailsUrl: "https://ci/run/1", startedAt: "2026-07-09T10:00:00Z", completedAt: "2026-07-09T10:01:42Z" },
      { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null, detailsUrl: "https://ci/run/2" },
      { __typename: "StatusContext", context: "vercel", state: "FAILURE", targetUrl: "https://vercel/d" },
    ])).toEqual([
      { name: "build", status: "passed", url: "https://ci/run/1", durationMs: 102_000 },
      { name: "test", status: "pending", url: "https://ci/run/2", durationMs: null },
      { name: "vercel", status: "failed", url: "https://vercel/d", durationMs: null },
    ]);
  });
  it("tolerates missing input", () => {
    expect(describeChecks(undefined as any)).toEqual([]);
  });
});

describe("prSlug", () => {
  it("extracts owner/repo from a PR url", () => {
    expect(prSlug("https://github.com/example-org/sorrel/pull/42")).toBe("example-org/sorrel");
  });
  it("returns null for non-PR urls", () => {
    expect(prSlug("https://github.com/example-org/sorrel")).toBeNull();
    expect(prSlug("")).toBeNull();
  });
});

describe("agentOpenPr", () => {
  const rec = { repo: "/r", branch: "agent/abc123" };
  const prView = (state: string) => async (a: string[]) =>
    ({ number: 7, url: "https://github.com/o/r/pull/7", state }) as any;

  it("looks up by recorded PR number when the console opened it", async () => {
    const calls: string[][] = [];
    const gh = async (a: string[]) => { calls.push(a); return { number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN" } as any; };
    const pr = await agentOpenPr({ ...rec, prNumber: 9 }, gh);
    expect(calls[0]).toEqual(["pr", "view", "9", "--json", "number,url,state"]);
    expect(pr).toEqual({ number: 9, url: "https://github.com/o/r/pull/9", state: "OPEN", slug: "o/r" });
  });

  it("falls back to the head branch when no PR is recorded (agent-opened PRs)", async () => {
    const calls: string[][] = [];
    const gh = async (a: string[]) => { calls.push(a); return { number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN" } as any; };
    const pr = await agentOpenPr(rec, gh);
    expect(calls[0]).toEqual(["pr", "view", "agent/abc123", "--json", "number,url,state"]);
    expect(pr?.number).toBe(7);
  });

  it("reports non-open states so the UI can hide the jump", async () => {
    expect((await agentOpenPr(rec, prView("MERGED")))?.state).toBe("MERGED");
  });

  it("returns null when gh finds no PR (or is unavailable)", async () => {
    const gh = async () => { throw new Error("no pull requests found for branch"); };
    expect(await agentOpenPr(rec, gh)).toBeNull();
  });

  it("returns null for a branchless (workspace) agent without calling gh", async () => {
    const gh = async () => { throw new Error("should not be called"); };
    expect(await agentOpenPr({ repo: "", branch: "" }, gh)).toBeNull();
  });
});

describe("fetchPrStatus", () => {
  it("calls gh pr view with the right fields and summarizes", async () => {
    const calls: string[][] = [];
    const fakeGhJson = async (a: string[]) => {
      calls.push(a);
      return view([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]) as any;
    };
    const s = await fetchPrStatus("/repo", 7, fakeGhJson);
    expect(calls[0]).toEqual(["pr", "view", "7", "--json", "state,mergeable,reviewDecision,url,statusCheckRollup"]);
    expect(s.checks.rollup).toBe("success");
  });
});
