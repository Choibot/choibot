// server/gh/pr.test.ts
import { describe, it, expect } from "vitest";
import { suggestFromLog, createPr } from "./pr.js";

describe("suggestFromLog", () => {
  it("uses first commit line as title, rest as body", () => {
    const log = "feat: add widget\n\nlonger explanation\nsecond line\n";
    expect(suggestFromLog(log, "agent/x")).toEqual({ title: "feat: add widget", body: "longer explanation\nsecond line" });
  });
  it("falls back to the branch name when the log is empty", () => {
    expect(suggestFromLog("   \n", "agent/x")).toEqual({ title: "agent/x", body: "" });
  });
});

describe("createPr", () => {
  it("calls gh pr create with base/head/title/body and parses the url+number", async () => {
    const calls: string[][] = [];
    const fakeGh: (a: string[], o?: { cwd?: string }) => Promise<string> = async (a) => {
      calls.push(a);
      return "https://github.com/example-org/sorrel/pull/42\n";
    };
    const pr = await createPr({ repoPath: "/r", base: "main", head: "agent/x", title: "T", body: "B" }, fakeGh);
    expect(pr).toEqual({ url: "https://github.com/example-org/sorrel/pull/42", number: 42 });
    expect(calls[0]).toEqual(["pr", "create", "--base", "main", "--head", "agent/x", "--title", "T", "--body", "B"]);
  });
  it("adds --draft when requested", async () => {
    const calls: string[][] = [];
    const fakeGh = async (a: string[]) => { calls.push(a); return "https://github.com/o/r/pull/1\n"; };
    await createPr({ repoPath: "/r", base: "main", head: "b", title: "T", body: "B", draft: true }, fakeGh);
    expect(calls[0]).toContain("--draft");
  });
});
