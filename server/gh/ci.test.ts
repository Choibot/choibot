// server/gh/ci.test.ts
import { describe, it, expect } from "vitest";
import { fetchPrCi, extractRunId, tailOf, vercelCommentPreviews } from "./ci.js";
import type { Repo } from "./repos.js";

const repo: Repo = { name: "sorrel", slug: "example-org/sorrel", path: "/ws/sorrel" };

describe("extractRunId / tailOf", () => {
  it("pulls the actions run id from a details url", () => {
    expect(extractRunId("https://github.com/o/r/actions/runs/123456/job/9")).toBe("123456");
    expect(extractRunId("https://vercel.com/deploy/abc")).toBeNull();
  });
  it("tails long output by lines and bytes", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    const tail = tailOf(text);
    expect(tail.startsWith("line-120")).toBe(true);
    expect(tail.endsWith("line-199")).toBe(true);
  });
});

describe("fetchPrCi", () => {
  it("returns runs, latest deployment per environment, and failed log tails", async () => {
    const ghJson = async (args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.startsWith("pr view")) return {
        headRefOid: "abc123",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE",
            detailsUrl: "https://github.com/o/r/actions/runs/777/job/1" },
          { __typename: "StatusContext", context: "vercel", state: "SUCCESS", targetUrl: "https://vercel.com/insp" },
        ],
      } as any;
      if (cmd.includes("deployments?sha=abc123")) return [
        { id: 2, environment: "Preview" },
        { id: 1, environment: "Preview" }, // older — must be dropped (latest per env wins)
      ] as any;
      if (cmd.includes("deployments/2/statuses")) return [
        { state: "success", environment_url: "https://myapp-git-branch.vercel.app" },
      ] as any;
      if (cmd.includes("deployments/1/statuses")) return [
        { state: "inactive", environment_url: "https://old.vercel.app" },
      ] as any;
      throw new Error(`unexpected ghJson: ${cmd}`);
    };
    const ghText = async (args: string[]) => {
      expect(args).toEqual(["run", "view", "777", "--log-failed"]);
      return "step 1 ok\nassert failed: expected 2 got 3\nFAIL src/x.test.ts\n";
    };
    const ci = await fetchPrCi(repo, 5, ghJson as any, ghText);
    expect(ci.checkRuns.map((r) => r.status)).toEqual(["failed", "passed"]);
    expect(ci.deployments).toEqual([
      { environment: "Preview", state: "success", url: "https://myapp-git-branch.vercel.app" },
    ]);
    expect(ci.logs).toEqual([
      { runId: "777", tail: "step 1 ok\nassert failed: expected 2 got 3\nFAIL src/x.test.ts" },
    ]);
  });

  it("tolerates deployment/log API failures — runs still come back", async () => {
    const ghJson = async (args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.startsWith("pr view")) return {
        headRefOid: "abc123",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE",
            detailsUrl: "https://github.com/o/r/actions/runs/9/job/1" },
        ],
      } as any;
      throw new Error("api down");
    };
    const ghText = async () => { throw new Error("log fetch failed"); };
    const ci = await fetchPrCi(repo, 5, ghJson as any, ghText);
    expect(ci.checkRuns).toHaveLength(1);
    expect(ci.deployments).toEqual([]);
    expect(ci.logs).toEqual([]);
  });

  it("takes the preview URL from the Vercel bot's comment when the head commit has no deployment", async () => {
    const calls: string[] = [];
    const ghJson = async (args: string[]) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd.endsWith("--json statusCheckRollup,headRefOid")) return {
        headRefOid: "abc123",
        statusCheckRollup: [{ __typename: "StatusContext", context: "Vercel", state: "SUCCESS", targetUrl: "https://vercel.com/insp" }],
      } as any;
      if (cmd.includes("deployments?sha=abc123")) return [] as any;
      if (cmd.endsWith("--json comments")) return { comments: [
        { author: { login: "someone" }, body: "[Preview](https://evil.test)" },
        { author: { login: "vercel" }, body: "| [dapp](https://vercel.com/o/dapp) | [Ready](https://vercel.com/o/dapp/1) | [Preview](https://dapp-git-x.vercel.app) |" },
      ] } as any;
      throw new Error(`unexpected ghJson: ${cmd}`);
    };
    const ci = await fetchPrCi(repo, 5, ghJson as any, async () => "");
    expect(ci.deployments).toEqual([{ environment: "Preview", state: "success", url: "https://dapp-git-x.vercel.app" }]);
    expect(calls.filter((c) => c.endsWith("--json comments"))).toHaveLength(1);
  });

  it("reads no comments for a repo with no Vercel check", async () => {
    const calls: string[] = [];
    const ghJson = async (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "pr") return { headRefOid: "abc123", statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] } as any;
      return [] as any;
    };
    const ci = await fetchPrCi(repo, 5, ghJson as any, async () => "");
    expect(ci.deployments).toEqual([]);
    expect(calls.some((c) => c.endsWith("--json comments"))).toBe(false);
  });
});

describe("vercelCommentPreviews", () => {
  it("keeps each preview URL once and tolerates other shapes", () => {
    const body = "[Visit Preview](https://a.vercel.app) and [Preview](https://a.vercel.app) and [Preview](javascript:alert(1))";
    expect(vercelCommentPreviews([{ author: { login: "vercel[bot]" }, body }], "pending")).toEqual([
      { environment: "Preview", state: "pending", url: "https://a.vercel.app" },
    ]);
    expect(vercelCommentPreviews(undefined, "success")).toEqual([]);
    expect(vercelCommentPreviews([{ body: 3 }, null], "success")).toEqual([]);
  });
});
