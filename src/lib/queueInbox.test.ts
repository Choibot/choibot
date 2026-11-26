import { describe, expect, it } from "vitest";
import type { QueueItem } from "../../server/chief/queue/types";
import {
  ageText, agentWord, checksWord, clockText, countsLine, doneToday, inboxGroups, kindChip, mergeableWord, notMerged, openOrder, rowMeta, whereParts,
  sizeWords, snoozedRows,
} from "./queueInbox";

const MIN = 60_000, HOUR = 60 * MIN;
// Local noon, so "today" has 12 h on each side in any time zone.
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();
function item(p: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    kind: "choice", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "r", area: "x",
    title: "t", body: "", createdAt: NOW - 5 * MIN, updatedAt: NOW - 5 * MIN, status: "open", blocking: true,
    history: [], answerSeq: 0, ...p,
  };
}
const ans = (at: number, by: "user" | "master" = "user") => ({ value: "A", by, via: "tab" as const, at });
const ids = (l: QueueItem[]) => l.map((i) => i.id);

describe("openOrder / inboxGroups", () => {
  // Score: question 40, pr 35, choice 30, preview 20; blocking +25; +1 per 10 min of age (max 30).
  const oldQuestion = item({ id: "q-old", kind: "question", blocking: false, createdAt: NOW - 6 * HOUR }); // 70
  const blockPreview = item({ id: "q-bp", kind: "preview", preview: { images: [] } }); // 45
  const blockChoice = item({ id: "q-bc" }); // 55
  const pr = item({ id: "q-pr", kind: "pr", blocking: false, pr: { url: "https://github.com/o/r/pull/1", number: 1 } }); // 35

  it("the tickets that block an agent come first, also before a not-blocking ticket with a higher score", () => {
    expect(ids(openOrder([oldQuestion, blockPreview, blockChoice, pr], NOW))).toEqual(["q-bc", "q-bp", "q-old", "q-pr"]);
  });
  it("inside a group the order is the priority rule, then the oldest first", () => {
    const a = item({ id: "q-a", createdAt: NOW - 3 * MIN }), b = item({ id: "q-b", createdAt: NOW - 4 * MIN });
    expect(ids(openOrder([a, b], NOW))).toEqual(["q-b", "q-a"]);
  });
  it("only Open rows: an ended snooze is in, a running snooze and a closed ticket are out", () => {
    const due = item({ id: "q-due", status: "snoozed", snoozedUntil: NOW - 1 });
    const later = item({ id: "q-later", status: "snoozed", snoozedUntil: NOW + MIN });
    const closed = item({ id: "q-closed", status: "answered", answer: ans(NOW) });
    expect(ids(openOrder([due, later, closed], NOW))).toEqual(["q-due"]);
  });
  it("groups: blocking tickets, then the rest; the list order is kept", () => {
    const g = inboxGroups(openOrder([oldQuestion, blockPreview, blockChoice, pr], NOW));
    expect(ids(g.blocks)).toEqual(["q-bc", "q-bp"]);
    expect(ids(g.review)).toEqual(["q-old", "q-pr"]);
  });
  it("counts line", () => {
    expect(countsLine([blockChoice, blockPreview, pr])).toBe("3 open · 2 block an agent");
    expect(countsLine([blockChoice, pr])).toBe("2 open · 1 blocks an agent");
    expect(countsLine([pr])).toBe("1 open");
    expect(countsLine([])).toBe("0 open");
  });
});

describe("snoozedRows", () => {
  it("running snoozes only, the next to wake first", () => {
    const a = item({ id: "q-a", status: "snoozed", snoozedUntil: NOW + 2 * HOUR });
    const b = item({ id: "q-b", status: "snoozed", snoozedUntil: NOW + HOUR });
    const due = item({ id: "q-due", status: "snoozed", snoozedUntil: NOW });
    expect(ids(snoozedRows([a, b, due, item({ id: "q-open" })], NOW))).toEqual(["q-b", "q-a"]);
  });
});

describe("doneToday", () => {
  const U = 10 * MIN;
  it("answered, auto and withdrawn tickets of this day, the newest first", () => {
    const a = item({ id: "q-a", status: "answered", answer: ans(NOW - 3 * HOUR) });
    const m = item({ id: "q-m", status: "auto", answer: ans(NOW - HOUR, "master") });
    const w = item({ id: "q-w", status: "withdrawn", lastError: "merged", closedAt: NOW - 2 * HOUR });
    expect(ids(doneToday([a, m, w, item({ id: "q-open" })], NOW, U))).toEqual(["q-m", "q-w", "q-a"]);
  });
  it("a ticket closed before this day is out", () => {
    const y = item({ id: "q-y", status: "answered", answer: ans(NOW - 13 * HOUR) });
    const w = item({ id: "q-w", status: "withdrawn", closedAt: NOW - 30 * HOUR });
    expect(doneToday([y, w], NOW, U)).toEqual([]);
  });
  it("an answer from before midnight stays while it can be undone", () => {
    const start = (ts: number) => ts - 5 * MIN; // "midnight" was 5 min ago
    const late = item({ id: "q-late", status: "answered", answer: ans(NOW - 8 * MIN) });
    const gone = item({ id: "q-old", status: "answered", answer: ans(NOW - 11 * MIN) });
    expect(ids(doneToday([late, gone], NOW, U, start))).toEqual(["q-late"]);
  });
  it("an agent-gone ticket stays for its 24 h", () => {
    const g = item({ id: "q-g", status: "withdrawn", lastError: "agent-gone", closedAt: NOW - 20 * HOUR });
    const g2 = item({ id: "q-g2", status: "withdrawn", lastError: "agent-gone", closedAt: NOW - 25 * HOUR });
    expect(ids(doneToday([g, g2], NOW, U))).toEqual(["q-g"]);
  });
  it("a ticket with a stuck delivery is not here (it is in Undelivered)", () => {
    const u = item({ id: "q-u", status: "answered", answer: ans(NOW), delivery: { msgId: "m", state: "failed", attempts: 3 } });
    expect(doneToday([u], NOW, U)).toEqual([]);
  });
  it("open and snoozed tickets are never done", () => {
    expect(doneToday([item({ id: "q1" }), item({ id: "q2", status: "snoozed", snoozedUntil: NOW + MIN })], NOW, U)).toEqual([]);
  });
});

describe("ageText / clockText", () => {
  it("minutes, hours with minutes, days", () => {
    expect(ageText(0)).toBe("0 min");
    expect(ageText(6 * MIN + 30_000)).toBe("6 min");
    expect(ageText(3 * HOUR)).toBe("3 h");
    expect(ageText(100 * MIN)).toBe("1 h 40 min");
    expect(ageText(49 * HOUR)).toBe("2 d");
    expect(ageText(-5)).toBe("0 min");
  });
  it("the clock on this day, the day and the clock on another day", () => {
    expect(clockText(new Date(2026, 10, 10, 17, 38).getTime(), NOW)).toBe("17:38");
    expect(clockText(new Date(2026, 10, 11, 9, 5).getTime(), NOW)).toBe("11 Nov 09:05");
    expect(clockText(0, NOW)).toBe("");
  });
});

describe("whereParts", () => {
  it("an area with a lead comes first, marked for the avatar, and stands for a repo of the same name", () => {
    expect(whereParts({ repo: "choibot", area: "console" }, true)).toEqual([{ text: "console", lead: true }, { text: "choibot" }]);
    expect(whereParts({ repo: "app-shop", area: "app-shop" }, true)).toEqual([{ text: "app-shop", lead: true }]);
    expect(whereParts({ repo: "choibot", area: "console" }, false)).toEqual([{ text: "choibot" }]);
    expect(rowMeta(item({ id: "q1", repo: "choibot", area: "console", createdAt: NOW - 3 * HOUR }), NOW, true))
      .toEqual([{ text: "choice" }, { text: "console", lead: true }, { text: "choibot" }, { text: "3 h" }]);
  });
});

describe("notMerged / rowMeta", () => {
  const url = "https://github.com/o/r/pull/5";
  it("a pr ticket that still waits is not merged: the merge of its PR closes it (decision 60)", () => {
    expect(notMerged(item({ id: "q1", kind: "pr", pr: { url, number: 5 } }))).toBe(true);
    expect(notMerged(item({ id: "q1", kind: "pr", pr: { url, number: 5, checks: "none" } }))).toBe(true);
    expect(notMerged(item({ id: "q1", kind: "pr", status: "snoozed", snoozedUntil: NOW + MIN, pr: { url, number: 5 } }))).toBe(true);
    expect(notMerged(item({ id: "q1", kind: "pr", pr: { local: { repo: "r", branch: "b" } } }))).toBe(true);
  });
  it("a closed pr ticket and another kind say nothing", () => {
    expect(notMerged(item({ id: "q1", kind: "pr", status: "withdrawn", lastError: "merged", pr: { url, number: 5, checks: "success" } }))).toBe(false);
    expect(notMerged(item({ id: "q1" }))).toBe(false);
  });
  it("row meta: kind · repo · age", () => {
    expect(rowMeta(item({ id: "q1", repo: "app-shop", createdAt: NOW - 3 * HOUR }), NOW)).toEqual([{ text: "choice" }, { text: "app-shop" }, { text: "3 h" }]);
  });
  it("row meta: a pr ticket says not merged, in amber", () => {
    const i = item({ id: "q1", kind: "pr", repo: "choibot", createdAt: NOW - 6 * MIN, pr: { url, number: 5, checks: "none" } });
    expect(rowMeta(i, NOW)).toEqual([{ text: "pr" }, { text: "choibot" }, { text: "not merged", warn: true }, { text: "6 min" }]);
  });
  it("row meta: a preview ticket gives its image count", () => {
    const one = item({ id: "q1", kind: "preview", preview: { images: ["a.png"] } });
    const two = item({ id: "q2", kind: "preview", preview: { images: ["a.png", "b.png"] } });
    expect(rowMeta(one, NOW)[2]).toEqual({ text: "1 image" });
    expect(rowMeta(two, NOW)[2]).toEqual({ text: "2 images" });
    expect(rowMeta(item({ id: "q3", kind: "preview", preview: { images: [] } }), NOW).map((p) => p.text)).toEqual(["preview", "r", "5 min"]);
    // A pr ticket that carries the screenshots of its PR (decision 65).
    const prShots = item({ id: "q4", kind: "pr", blocking: false, pr: { url: "https://github.com/o/r/pull/1", number: 1 }, preview: { images: ["a.png", "b.png"] } });
    expect(rowMeta(prShots, NOW).map((p) => p.text)).toEqual(["pr", "r", "not merged", "2 images", "5 min"]);
  });
  it("row meta: a snoozed ticket says until when; an ended snooze gives the age again", () => {
    const until = new Date(2026, 10, 10, 13, 0).getTime();
    expect(rowMeta(item({ id: "q1", status: "snoozed", snoozedUntil: until }), NOW).at(-1)).toEqual({ text: "snoozed until 13:00" });
    expect(rowMeta(item({ id: "q1", status: "snoozed", snoozedUntil: NOW - 1 }), NOW).at(-1)).toEqual({ text: "5 min" });
  });
});

describe("kindChip / agentWord", () => {
  it("an open ticket: blocks the agent, for review, not blocking", () => {
    expect(kindChip(item({ id: "q1" }), NOW)).toEqual({ text: "choice · blocks the agent", block: true });
    expect(kindChip(item({ id: "q1", kind: "pr", blocking: false }), NOW)).toEqual({ text: "pr · for review", block: false });
    expect(kindChip(item({ id: "q1", kind: "preview", blocking: false }), NOW)).toEqual({ text: "preview · for review", block: false });
    expect(kindChip(item({ id: "q1", kind: "question", blocking: false }), NOW)).toEqual({ text: "question · not blocking", block: false });
  });
  it("a ticket that is not open says its state and is never amber", () => {
    expect(kindChip(item({ id: "q1", status: "snoozed", snoozedUntil: NOW + MIN }), NOW)).toEqual({ text: "choice · snoozed", block: false });
    expect(kindChip(item({ id: "q1", status: "answered", answer: ans(NOW) }), NOW)).toEqual({ text: "choice · answered", block: false });
    expect(kindChip(item({ id: "q1", status: "auto", answer: ans(NOW, "master") }), NOW)).toEqual({ text: "choice · answered", block: false });
    expect(kindChip(item({ id: "q1", status: "withdrawn" }), NOW)).toEqual({ text: "choice · closed", block: false });
  });
  it("agent words", () => {
    expect(agentWord("945f47da-179c-44d0-947d-eedc90ce7648")).toBe("agent 945f47da");
    expect(agentWord("agent-33062e99")).toBe("agent 33062e99");
    expect(agentWord("lead-console")).toBe("lead console");
    expect(agentWord("fleet-master")).toBe("fleet master");
    expect(agentWord("cron-master")).toBe("cron master");
  });
});

describe("pr fact words", () => {
  it("mergeable", () => {
    expect(mergeableWord("MERGEABLE")).toEqual({ text: "mergeable", tone: "good" });
    expect(mergeableWord("CONFLICTING")).toEqual({ text: "conflicts", tone: "bad" });
    expect(mergeableWord("UNKNOWN")).toEqual({ text: "mergeable: unknown" });
    expect(mergeableWord(undefined)).toEqual({ text: "mergeable: unknown" });
  });
  it("checks", () => {
    expect(checksWord("success")).toEqual({ text: "checks pass", tone: "good" });
    expect(checksWord("failure")).toEqual({ text: "checks fail", tone: "bad" });
    expect(checksWord("pending")).toEqual({ text: "checks run", tone: "warn" });
    expect(checksWord("none")).toEqual({ text: "no checks" });
    expect(checksWord(undefined)).toEqual({ text: "checks: unknown" });
  });
  it("size", () => {
    expect(sizeWords([{ additions: 1000, deletions: 20 }, { additions: 170, deletions: 30 }])).toEqual({ files: "2 files", plus: "+1,170", minus: "−50" });
    expect(sizeWords([{ additions: 1, deletions: 0 }])).toEqual({ files: "1 file", plus: "+1", minus: "−0" });
  });
});
