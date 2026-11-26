import { describe, it, expect } from "vitest";
import { issuePrompt, makeDispatcher } from "./dispatch.js";
import type { SpawnRequest, SpawnResult } from "../agents/spawn.js";
import { makeIssue } from "./testkit.js";

describe("issuePrompt", () => {
  it("has the task, the forward line, the text and the screenshot paths", () => {
    const p = issuePrompt(makeIssue({ forwardedFrom: "Dana", text: "Swap fails", photos: ["/d/t100/photo-1.jpg", "/d/t100/photo-2.jpg"] }));
    expect(p).toBe([
      "Fix this issue reported from Telegram. Investigate, fix, test,\nthen open a PR with `gh pr create`.",
      "Forwarded from: Dana\nSwap fails",
      "Screenshots (read them with the Read tool):\n/d/t100/photo-1.jpg\n/d/t100/photo-2.jpg",
    ].join("\n\n"));
  });
  it("omits empty parts", () => {
    expect(issuePrompt(makeIssue({ text: "Bug" }))).toBe(
      "Fix this issue reported from Telegram. Investigate, fix, test,\nthen open a PR with `gh pr create`.\n\nBug");
  });
  it("keeps the whole text, however long", () => {
    expect(issuePrompt(makeIssue({ text: "y".repeat(100_000) }))).toContain("y".repeat(100_000));
  });
});

describe("makeDispatcher", () => {
  const repos = async () => [{ name: "app-shop", path: "/ws/app-shop" }, { name: "choibot", path: "/ws/choibot" }];

  it("spawns a claude issue agent in the repo path with label and issue id", async () => {
    const reqs: SpawnRequest[] = [];
    const spawn = async (r: SpawnRequest): Promise<SpawnResult> => { reqs.push(r); return { ok: true, id: "agent-9", status: "running" }; };
    const id = await makeDispatcher({ spawn, listRepos: repos })(makeIssue());
    expect(id).toBe("agent-9");
    expect(reqs[0]).toMatchObject({
      repo: "/ws/choibot", runtime: "claude", kind: "issue", issueId: "t100",
      label: "issue: Login button broken",
    });
    expect(reqs[0].baseBranch).toBeUndefined();
    expect(reqs[0].prompt).toContain("Login button broken");
  });

  it("label never splits a surrogate pair at the 80-char cut", async () => {
    const reqs: SpawnRequest[] = [];
    const spawn = async (r: SpawnRequest): Promise<SpawnResult> => { reqs.push(r); return { ok: true, id: "a", status: "running" }; };
    await makeDispatcher({ spawn, listRepos: repos })(makeIssue({ summary: "x".repeat(72) + "😀" + "abc" }));
    const label = reqs[0].label!;
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(label).toBe("issue: " + "x".repeat(72) + "😀");
  });

  it("rejects with a reason when the repo is missing, unknown, or the spawn fails", async () => {
    const ok = async (): Promise<SpawnResult> => ({ ok: true, id: "x", status: "running" });
    const fail = async (): Promise<SpawnResult> => ({ ok: false, code: 400, error: "branch busy" });
    await expect(makeDispatcher({ spawn: ok, listRepos: repos })(makeIssue({ repo: null }))).rejects.toThrow("no repo chosen");
    await expect(makeDispatcher({ spawn: ok, listRepos: repos })(makeIssue({ repo: "gone" }))).rejects.toThrow("repo gone is not in the workspace");
    await expect(makeDispatcher({ spawn: fail, listRepos: repos })(makeIssue())).rejects.toThrow("branch busy");
  });
});
