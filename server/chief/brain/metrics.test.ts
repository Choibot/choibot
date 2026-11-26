import { describe, expect, it } from "vitest";
import { foldMetrics, isoWeek } from "./metrics.js";
import type { ClassifiedEntry, DecisionLine } from "./store.js";

const NOW = Date.UTC(2026, 10, 9, 12); // Mon 2026-11-09 = 2026-W46
const DAY = 86_400_000;
const line = (at: number, o: Partial<DecisionLine> = {}): DecisionLine =>
  ({ at, via: "composer", by: "user", text: "t", correction: null, ...o });
const week0 = (m: ReturnType<typeof foldMetrics>) => m.weeks[0]!;

describe("isoWeek", () => {
  it("handles year boundaries in UTC", () => {
    expect(isoWeek(Date.UTC(2026, 10, 9))).toBe("2026-W46");
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe("2026-W01");
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe("2026-W53");
    expect(isoWeek(Date.UTC(2024, 11, 30))).toBe("2025-W01");
    expect(isoWeek(Date.UTC(2026, 10, 8, 23, 59))).toBe("2026-W45");
  });
});

describe("foldMetrics", () => {
  const o = { weeks: 3, now: NOW };
  it("lists the last N weeks newest first with zeros", () => {
    const m = foldMetrics([], [], o);
    expect(m.weeks).toEqual([
      { week: "2026-W46", decisions: 0, corrections: 0 },
      { week: "2026-W45", decisions: 0, corrections: 0 },
      { week: "2026-W44", decisions: 0, corrections: 0 }]);
  });
  it("counts a null line classified true by distill as a correction", () => {
    const c: ClassifiedEntry[] = [{ at: NOW - 1000, correction: true, by: "distill" }];
    expect(week0(foldMetrics([line(NOW - 1000)], c, o))).toMatchObject({ decisions: 1, corrections: 1 });
  });
  it("leaves an unclassified line in neither number", () => {
    expect(week0(foldMetrics([line(NOW - 1000)], [], o))).toMatchObject({ decisions: 0, corrections: 0 });
  });
  it("lets the latest entry win (master-chat flips distill false)", () => {
    const c: ClassifiedEntry[] = [{ at: NOW - 1000, correction: false, by: "distill" },
      { at: NOW - 1000, correction: true, by: "master-chat" }];
    expect(week0(foldMetrics([line(NOW - 1000)], c, o))).toMatchObject({ decisions: 1, corrections: 1 });
  });
  it("counts one master-chat correction once (lookup hit)", () => {
    const at = NOW - 5000;
    const l = line(at, { via: "master-tab" });
    const c: ClassifiedEntry[] = [{ at, correction: true, by: "master-chat" }];
    expect(week0(foldMetrics([l], c, o))).toMatchObject({ decisions: 1, corrections: 1 });
  });
  it("counts a master line once and excludes its refAt user line", () => {
    const u = line(NOW - 5000, { via: "master-tab" });
    const m = line(NOW - 4000, { by: "master", via: "master-tab", reason: "master-chat", correction: true, refAt: u.at });
    expect(week0(foldMetrics([u, m], [], o))).toMatchObject({ decisions: 1, corrections: 1 });
    // even when the user line was classified
    const c: ClassifiedEntry[] = [{ at: u.at, correction: false, by: "distill" }];
    expect(week0(foldMetrics([u, m], c, o))).toMatchObject({ decisions: 1, corrections: 1 });
  });
  it("counts a master-chat hit on a refAt-named line: two master corrections count twice", () => {
    const u = line(NOW - 5000, { via: "master-tab" });
    const m = line(NOW - 4000, { by: "master", via: "master-tab", reason: "master-chat", correction: true, refAt: u.at });
    const c: ClassifiedEntry[] = [{ at: u.at, correction: true, by: "master-chat" }];
    expect(week0(foldMetrics([u, m], c, o))).toMatchObject({ decisions: 2, corrections: 2 });
  });
  it("two master lines naming one line count twice and the line stays out (unchanged)", () => {
    const u = line(NOW - 5000, { via: "master-tab" });
    const m = (at: number) => line(at, { by: "master", via: "master-tab", reason: "master-chat", correction: true, refAt: u.at });
    const c: ClassifiedEntry[] = [{ at: u.at, correction: true, by: "distill" }];
    expect(week0(foldMetrics([u, m(NOW - 4000), m(NOW - 3000)], c, o))).toMatchObject({ decisions: 2, corrections: 2 });
  });
  it("counts undo-own as a decision only", () => {
    const l = line(NOW - 1000, { correction: false, reason: "undo-own" });
    expect(week0(foldMetrics([l], [], o))).toMatchObject({ decisions: 1, corrections: 0 });
  });
  it("ignores lines outside the weeks window", () => {
    const l = line(NOW - 40 * DAY, { correction: true, prUrl: "p", agentId: "a" });
    const m = foldMetrics([l], [], o);
    expect(m.weeks.every((w) => w.decisions === 0)).toBe(true);
    expect(m.byPr).toEqual([]);
    expect(m.byAgent).toEqual([]);
  });
  it("groups by PR and agent", () => {
    const ls = [
      line(NOW - 1, { correction: true, prUrl: "pr1", agentId: "a1" }),
      line(NOW - 2, { correction: false, prUrl: "pr1", agentId: "a2" }),
      line(NOW - 3, { correction: false, prUrl: "pr2", agentId: "a1" }),
      line(NOW - 4, { correction: null, prUrl: "pr2", agentId: "a1" }),
      line(NOW - 5, { correction: true })];
    const m = foldMetrics(ls, [], o);
    expect(m.byPr).toEqual([
      { prUrl: "pr1", decisions: 2, corrections: 1 }, { prUrl: "pr2", decisions: 1, corrections: 0 }]);
    expect(m.byAgent).toEqual([
      { agentId: "a1", decisions: 2, corrections: 1 }, { agentId: "a2", decisions: 1, corrections: 0 }]);
  });
});
