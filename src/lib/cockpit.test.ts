// src/lib/cockpit.test.ts
import { describe, it, expect } from "vitest";
import { triagePr, flattenCockpit, filterItems, groupByRepo, formatAge, ageDays, sortCheckRuns, formatDuration } from "./cockpit";
import type { CockpitPr, CockpitRepo } from "./gh";

const pr = (over: Partial<CockpitPr>): CockpitPr => ({
  number: 1, title: "t", author: "a", url: "u", rollup: "success", mergeable: "MERGEABLE", ...over,
});

describe("triagePr", () => {
  it("conflicts or red checks → failing", () => {
    expect(triagePr(pr({ mergeable: "CONFLICTING" }))).toBe("failing");
    expect(triagePr(pr({ rollup: "failure" }))).toBe("failing");
  });
  it("pending checks → inflight", () => {
    expect(triagePr(pr({ rollup: "pending" }))).toBe("inflight");
  });
  it("green or no checks → ready", () => {
    expect(triagePr(pr({ rollup: "success" }))).toBe("ready");
    expect(triagePr(pr({ rollup: "none", mergeable: "UNKNOWN" }))).toBe("ready");
  });
});

describe("flattenCockpit", () => {
  const repos: CockpitRepo[] = [
    {
      name: "console", slug: "example-org/console",
      prs: [
        pr({ number: 9, rollup: "pending", updatedAt: "2026-07-08T10:00:00Z" }),
        pr({ number: 2, rollup: "success", updatedAt: "2026-07-08T08:00:00Z" }),
      ],
      issues: [{ number: 3, title: "i", author: "a", url: "u", createdAt: "2026-07-01T00:00:00Z" }],
    },
    {
      name: "api", slug: "example-org/api",
      prs: [pr({ number: 5, rollup: "success", updatedAt: "2026-07-08T09:00:00Z" })],
      issues: [],
    },
  ];
  it("orders ready → failing → inflight → issues, newest first within a group", () => {
    const out = flattenCockpit(repos);
    expect(out.map((i) => `${i.group}:${i.kind === "pr" ? i.pr.number : i.issue.number}`))
      .toEqual(["ready:5", "ready:2", "inflight:9", "issues:3"]);
  });
  it("groups by repo alphabetically, urgency order kept inside, counts tallied", () => {
    const groups = groupByRepo(flattenCockpit(repos));
    expect(groups.map((g) => g.repo)).toEqual(["api", "console"]);
    const console_ = groups[1];
    expect(console_.items.map((i) => (i.kind === "pr" ? i.pr.number : i.issue.number))).toEqual([2, 9, 3]);
    expect(console_.counts).toEqual({ ready: 1, failing: 0, inflight: 1, issues: 1 });
  });
  it("filters by repo, kind, and query", () => {
    const items = flattenCockpit(repos);
    expect(filterItems(items, { q: "", repo: "example-org/api", kind: "all" })).toHaveLength(1);
    expect(filterItems(items, { q: "", repo: "", kind: "issues" })).toHaveLength(1);
    expect(filterItems(items, { q: "#5", repo: "", kind: "all" })).toHaveLength(1);
    expect(filterItems(items, { q: "zzz", repo: "", kind: "all" })).toHaveLength(0);
  });
});

describe("sortCheckRuns / formatDuration", () => {
  it("orders failed → pending → passed, alphabetical within a group", () => {
    const runs = [
      { name: "z-pass", status: "passed", url: "", durationMs: null },
      { name: "b-fail", status: "failed", url: "", durationMs: null },
      { name: "m-run", status: "pending", url: "", durationMs: null },
      { name: "a-fail", status: "failed", url: "", durationMs: null },
    ] as const;
    expect(sortCheckRuns([...runs]).map((r) => r.name)).toEqual(["a-fail", "b-fail", "m-run", "z-pass"]);
  });
  it("formats durations", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(58_000)).toBe("58s");
    expect(formatDuration(102_000)).toBe("1m 42s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
});

describe("formatAge / ageDays", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  it("formats minutes, hours, days", () => {
    expect(formatAge("2026-07-08T11:59:40Z", now)).toBe("now");
    expect(formatAge("2026-07-08T11:40:00Z", now)).toBe("20m");
    expect(formatAge("2026-07-08T10:00:00Z", now)).toBe("2h");
    expect(formatAge("2026-07-05T12:00:00Z", now)).toBe("3d");
  });
  it("dashes missing or bad timestamps", () => {
    expect(formatAge(undefined, now)).toBe("—");
    expect(formatAge("nope", now)).toBe("—");
  });
  it("ageDays floors to whole days", () => {
    expect(ageDays("2026-06-26T12:00:00Z", now)).toBe(12);
    expect(ageDays(undefined, now)).toBe(0);
  });
});
