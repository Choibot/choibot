import { describe, it, expect } from "vitest";
import { checksLine, fileSections, readRailOpen, RAIL_OPEN_KEY, RAIL_WIDE_PX } from "./rail";
import type { ChangedFile } from "./agents";
import type { CheckRun, PrCi } from "./gh";

const f = (rel: string, state: ChangedFile["state"]): ChangedFile =>
  ({ rel, path: `/w/${rel}`, status: state === "untracked" ? "untracked" : "modified", state });
const run = (name: string, status: CheckRun["status"]): CheckRun => ({ name, status, url: "", durationMs: null });
const ci = (checkRuns: CheckRun[], deployments: PrCi["deployments"] = []): PrCi => ({ checkRuns, deployments, logs: [] });

describe("readRailOpen", () => {
  const store = (v: string | null) => ({ getItem: (k: string) => (k === RAIL_OPEN_KEY ? v : null) });
  it("keeps the browser's choice", () => {
    expect(readRailOpen(store("1"), 800)).toBe(true);
    expect(readRailOpen(store("0"), 2000)).toBe(false);
  });
  it("with no choice, opens on a wide screen only", () => {
    expect(readRailOpen(store(null), RAIL_WIDE_PX)).toBe(true);
    expect(readRailOpen(store(null), RAIL_WIDE_PX - 1)).toBe(false);
    expect(readRailOpen(null, 1600)).toBe(true);
  });
  it("falls back to the default when storage throws", () => {
    const bad = { getItem: () => { throw new Error("blocked"); } };
    expect(readRailOpen(bad, 1600)).toBe(true);
    expect(readRailOpen(bad, 900)).toBe(false);
  });
});

describe("fileSections", () => {
  it("puts tree work (edits and new files) before committed work, in list order", () => {
    const s = fileSections([f("a", "committed"), f("b", "uncommitted"), f("c", "untracked")]);
    expect(s.map((x) => [x.label, x.files.map((y) => y.rel)])).toEqual([
      ["Uncommitted", ["b", "c"]],
      ["Committed", ["a"]],
    ]);
  });
  it("leaves out an empty section", () => {
    expect(fileSections([f("a", "committed")]).map((x) => x.label)).toEqual(["Committed"]);
    expect(fileSections([])).toEqual([]);
  });
});

describe("checksLine", () => {
  it("failing beats running beats green", () => {
    expect(checksLine(ci([run("a", "passed"), run("b", "failed"), run("c", "pending")])))
      .toEqual({ tone: "err", text: "Checks 1 failing · 1 of 3 pass" });
    expect(checksLine(ci([run("a", "passed"), run("b", "passed"), run("c", "pending")])))
      .toEqual({ tone: "run", text: "Checks 2 of 3 pass · 1 running" });
    expect(checksLine(ci([run("a", "passed")]))).toEqual({ tone: "ok", text: "Checks 1 of 1 pass" });
  });
  it("with no check runs, the latest deployment speaks", () => {
    expect(checksLine(ci([], [{ environment: "Preview", state: "success", url: "u" }])))
      .toEqual({ tone: "ok", text: "Preview ready · Preview" });
    expect(checksLine(ci([], [{ environment: "Preview", state: "error", url: "u" }]))?.tone).toBe("err");
    expect(checksLine(ci([], [{ environment: "Preview", state: "pending", url: "u" }]))?.tone).toBe("run");
    expect(checksLine(ci([]))).toBeNull();
  });
});
