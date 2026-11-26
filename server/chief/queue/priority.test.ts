import { describe, expect, it } from "vitest";
import type { QueueItem } from "./types.js";
import { score, sortOpen } from "./priority.js";

const MIN = 60_000;
const NOW = 1_000_000_000;
const mk = (o: Partial<QueueItem> = {}): QueueItem => ({
  id: "q7k2m9x1a", kind: "choice", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "r", area: "r",
  title: "t", body: "b", createdAt: NOW, updatedAt: NOW, status: "open", blocking: false, history: [], answerSeq: 0, ...o,
});
const pr = (checks: "success" | "failure" | "pending" | "none", mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN") =>
  mk({ kind: "pr", pr: { url: "u", number: 1, checks, mergeable } as QueueItem["pr"] });

describe("score", () => {
  it.each([["question", 40], ["pr", 35], ["choice", 30], ["preview", 20]] as const)("base %s = %i", (kind, n) => {
    expect(score(mk({ kind }), NOW)).toBe(n);
  });
  it("blocking +25", () => { expect(score(mk({ blocking: true }), NOW)).toBe(55); });
  it("pr success + MERGEABLE +10", () => { expect(score(pr("success", "MERGEABLE"), NOW)).toBe(45); });
  it("pr failure -15", () => { expect(score(pr("failure", "MERGEABLE"), NOW)).toBe(20); });
  it("pr success but not MERGEABLE +0", () => { expect(score(pr("success", "CONFLICTING"), NOW)).toBe(35); });
  it("local pr has no check bonus", () => {
    expect(score(mk({ kind: "pr", pr: { local: { repo: "r", branch: "b" } } }), NOW)).toBe(35);
  });
  it("age +1 per 10 min, floored", () => {
    expect(score(mk({ createdAt: NOW - 25 * MIN }), NOW)).toBe(32);
    expect(score(mk({ createdAt: NOW - 9 * MIN }), NOW)).toBe(30);
  });
  it("age caps at +30", () => { expect(score(mk({ createdAt: NOW - 600 * MIN }), NOW)).toBe(60); });
  it("future createdAt adds no age", () => { expect(score(mk({ createdAt: NOW + MIN }), NOW)).toBe(30); });
  it("recommend +5", () => {
    expect(score(mk({ recommend: { value: "A", why: "w", ruleIds: [], by: "m", at: 1 } }), NOW)).toBe(35);
  });
});

describe("sortOpen", () => {
  it("sorts by score desc, then createdAt asc", () => {
    const a = mk({ id: "qa", createdAt: NOW - 5 * MIN });
    const b = mk({ id: "qb", createdAt: NOW - 8 * MIN });
    const c = mk({ id: "qc", kind: "question" });
    expect(sortOpen([a, b, c], NOW).map((i) => i.id)).toEqual(["qc", "qb", "qa"]);
  });
  it("excludes closed statuses", () => {
    const items = (["answered", "auto", "undone", "withdrawn"] as const).map((status) => mk({ status }));
    expect(sortOpen([...items, mk({ id: "qo" })], NOW).map((i) => i.id)).toEqual(["qo"]);
  });
  it("hides snoozed until snoozedUntil, then counts as open", () => {
    const hidden = mk({ id: "qh", status: "snoozed", snoozedUntil: NOW + 1 });
    const due = mk({ id: "qd", status: "snoozed", snoozedUntil: NOW });
    expect(sortOpen([hidden, due], NOW).map((i) => i.id)).toEqual(["qd"]);
  });
  it("does not mutate the input", () => {
    const items = [mk({ id: "qa" }), mk({ id: "qb", kind: "question" })];
    sortOpen(items, NOW);
    expect(items.map((i) => i.id)).toEqual(["qa", "qb"]);
  });
});
