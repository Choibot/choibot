// src/lib/gh.test.ts
import { describe, it, expect, vi } from "vitest";
import { ciLabel, repoSummary } from "./gh";

describe("ciLabel", () => {
  it("summarizes passing checks + mergeable + approved", () => {
    expect(ciLabel({ pr: 7, prState: "OPEN", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
      checks: { total: 3, passed: 3, failed: 0, pending: 0, rollup: "success" } }))
      .toBe("✓ 3/3 checks · mergeable · approved");
  });
  it("shows failures and conflicts", () => {
    expect(ciLabel({ pr: 7, prState: "OPEN", mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED",
      checks: { total: 3, passed: 1, failed: 2, pending: 0, rollup: "failure" } }))
      .toBe("✗ 2 failing · conflicts · changes requested");
  });
  it("shows pending and merged state", () => {
    expect(ciLabel({ pr: 7, prState: "MERGED", mergeable: "UNKNOWN", reviewDecision: "",
      checks: { total: 2, passed: 1, failed: 0, pending: 1, rollup: "pending" } }))
      .toBe("● 1 pending · merged");
  });
  it("no checks", () => {
    expect(ciLabel({ pr: 7, prState: "OPEN", mergeable: "MERGEABLE", reviewDecision: "",
      checks: { total: 0, passed: 0, failed: 0, pending: 0, rollup: "none" } }))
      .toBe("no checks · mergeable");
  });
});

describe("repoSummary", () => {
  const base = { name: "sorrel", slug: "example-org/sorrel", prs: [], issues: [] };
  it("pluralizes counts", () => {
    expect(repoSummary({ ...base, prs: [1, 2] as any, issues: [1] as any }))
      .toBe("example-org/sorrel · 2 PRs · 1 issue");
  });
  it("handles singular PR and zero issues", () => {
    expect(repoSummary({ ...base, prs: [1] as any, issues: [] as any }))
      .toBe("example-org/sorrel · 1 PR · 0 issues");
  });
});

describe("mergePr refusal sentences", () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  async function run(r: Response) {
    vi.resetModules();
    vi.doMock("./chief", async () => ({ ...(await vi.importActual<typeof import("./chief")>("./chief")), chiefFetch: async () => r }));
    const m = await import("./gh");
    return m.mergePr("o/r", 1, "squash");
  }
  it("403 pair-required (telegram) gives the pairing sentence", async () => {
    expect(await run(res(403, { error: "pair-required", userAuth: "telegram" })))
      .toEqual({ ok: false, error: "Merge needs a paired device — send /pair <label> in the Master topic" });
  });
  it("403 pair-required (log) gives the box sentence", async () => {
    expect(await run(res(403, { error: "pair-required", userAuth: "log" })))
      .toEqual({ ok: false, error: "Merge needs a paired device. On a paired device: Settings, Devices, “Add a device”. With no paired device: run `pnpm choibot brain pair <label>` on your server" });
  });
  it("503 gives the misconfigured text", async () => {
    expect(await run(res(503, { error: "chief-misconfigured" })))
      .toEqual({ ok: false, error: "Chief misconfigured — see `pnpm choibot doctor`" });
  });
  it("409 keeps today's message", async () => {
    expect(await run(res(409, { error: "not mergeable" }))).toEqual({ ok: false, error: "not mergeable" });
  });
});
