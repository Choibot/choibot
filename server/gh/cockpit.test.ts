// server/gh/cockpit.test.ts
import { describe, it, expect } from "vitest";
import { fetchRepoCockpit, fetchCockpit } from "./cockpit.js";
import type { Repo } from "./repos.js";

const repo = (name: string): Repo => ({ name, slug: `example-org/${name}`, path: `/ws/${name}` });

describe("fetchRepoCockpit", () => {
  it("maps pr list (with rollup) and issue list", async () => {
    const ghJson = async (args: string[]) => {
      if (args[0] === "pr") return [
        { number: 5, title: "Add x", author: { login: "alice" }, state: "OPEN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "d1" }],
          url: "u5", mergeable: "MERGEABLE", reviewDecision: "APPROVED", updatedAt: "2026-07-08T10:00:00Z" },
      ] as any;
      return [{ number: 9, title: "Bug", author: { login: "bob" }, url: "u9", createdAt: "2026-07-01T10:00:00Z" }] as any;
    };
    const r = await fetchRepoCockpit(repo("sorrel"), ghJson);
    expect(r.prs).toEqual([{
      number: 5, title: "Add x", author: "alice", url: "u5", rollup: "success", mergeable: "MERGEABLE",
      reviewDecision: "APPROVED", updatedAt: "2026-07-08T10:00:00Z",
      checks: { total: 1, passed: 1, failed: 0, pending: 0, rollup: "success" },
      checkRuns: [{ name: "ci", status: "passed", url: "d1", durationMs: null }],
    }]);
    expect(r.issues).toEqual([{ number: 9, title: "Bug", author: "bob", url: "u9", createdAt: "2026-07-01T10:00:00Z" }]);
    expect(r.error).toBeUndefined();
  });

  it("tolerates a failing repo (returns error, empty lists)", async () => {
    const ghJson = async () => { throw new Error("gh boom"); };
    const r = await fetchRepoCockpit(repo("bad"), ghJson);
    expect(r.prs).toEqual([]);
    expect(r.issues).toEqual([]);
    expect(r.error).toContain("gh boom");
  });
});

describe("fetchCockpit", () => {
  it("aggregates repos; one failure does not sink the others", async () => {
    const ghJson = async (args: string[], opts?: { cwd?: string }) => {
      if (opts?.cwd === "/ws/bad") throw new Error("nope");
      return (args[0] === "pr" ? [] : []) as any;
    };
    const out = await fetchCockpit([repo("ok"), repo("bad")], ghJson);
    expect(out.map((r) => r.name)).toEqual(["ok", "bad"]);
    expect(out[0].error).toBeUndefined();
    expect(out[1].error).toContain("nope");
  });
});
