import { describe, expect, it } from "vitest";
import type { QueueItem } from "../../server/chief/queue/types";
import type { Shown } from "./thread";
import { threadRows, type Row } from "./threadTickets";
import { hideActivity, isQuietReply } from "./quietChecks";

let n = 0;
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const at = () => T0 + (n++) * 1000;
const user = (text: string, via?: "events" | "queue" | "reminder"): Shown => ({ kind: "user", id: `u${n}`, ts: at(), text, ...(via ? { via } : {}) });
const agent = (text: string): Shown => ({ kind: "assistant", id: `a${n}`, ts: at(), text });
const step = (label: string): Shown => { const ts = at(); return { kind: "step", id: `s${n}`, ts, tool: "Bash", label, end: ts + 500 }; };
const rowsOf = (items: Shown[], tickets: QueueItem[] = []): Row[] => threadRows(items, tickets, T0 + 3_600_000, 0, () => "d");
const types = (rows: { type: string }[]): string[] => rows.map((r) => r.type);

const texts = (rows: Row[]): string[] => rows.map((r) => (r.type === "msg" ? `${r.item.kind}:${"text" in r.item ? r.item.text : ""}` : r.type));

describe("hideActivity (the fleet master's chat with Show activity off)", () => {
  it("a digest turn that ends with (quiet) is not shown: the digest line, the steps and the reply", () => {
    const rows = rowsOf([user("hello"), agent("Hi."), user("[events] agent-1 waiting", "events"), step("agents list"), agent("(quiet)"), user("status?"), agent("All good.")]);
    const r = hideActivity(rows);
    expect(texts(r.rows)).toEqual(["user:hello", "assistant:Hi.", "user:status?", "assistant:All good."]);
    expect(r.hidden).toBe(1);
  });

  it("many digest turns in a row: none is shown, and the count says how many", () => {
    const rows = rowsOf([user("hello"), user("e1", "events"), agent("(quiet)"), user("e2", "events"), step("x"), agent("(quiet) nothing new"), user("e3", "events"), agent("(quiet)")]);
    const r = hideActivity(rows);
    expect(texts(r.rows)).toEqual(["user:hello"]);
    expect(r.hidden).toBe(3);
  });

  it("never hides the user's own line, a queue answer or a reminder, also when the reply starts with (quiet)", () => {
    const rows = rowsOf([user("status?"), agent("(quiet) is the word I use"), user("choice: A", "queue"), agent("(quiet)"), user("check the canary", "reminder"), agent("(quiet)")]);
    const r = hideActivity(rows);
    expect(r.rows).toEqual(rows);
    expect(r.hidden).toBe(0);
  });

  it("a digest turn in which the fleet master wrote something else: the digest line goes, its steps and its text stay", () => {
    const rows = rowsOf([user("[events] agent-1 errored", "events"), step("agents list"), agent("agent-1 failed: the build is broken."), agent("(quiet)")]);
    const r = hideActivity(rows);
    expect(texts(r.rows)).toEqual(["steps", "assistant:agent-1 failed: the build is broken."]);
    expect(r.hidden).toBe(1);
  });

  it("a digest turn still in progress shows no digest line and no step", () => {
    const r = hideActivity(rowsOf([user("hello"), agent("Hi."), user("[events] cron nightly ok", "events"), step("cron show nightly")]));
    expect(texts(r.rows)).toEqual(["user:hello", "assistant:Hi."]);
  });

  it("a ticket made in a hidden turn is always shown; a day with nothing left shows no line", () => {
    const ticket = { id: "q1", kind: "question", agentId: "fleet-master", createdBy: { agentId: "fleet-master", kind: "fleet-master" }, repo: "", area: "", title: "T", body: "b",
      createdAt: T0 + 1500, updatedAt: T0 + 1500, status: "open", blocking: false, history: [], answerSeq: 0 } as unknown as QueueItem;
    n = 0;
    const rows = rowsOf([user("[events] cron cost failed", "events"), step("queue add"), agent("(quiet)")], [ticket]);
    const r = hideActivity(rows);
    expect(r.rows.map((x) => x.type)).toEqual(["ticket"]);
    n = 0;
    const only = hideActivity(rowsOf([user("[events] cron nightly ok", "events"), agent("(quiet)")]));
    expect(only.rows).toEqual([]);
  });

  it("a day line with nothing left under it is not shown", () => {
    n = 0;
    const [digest, reply, line] = rowsOf([user("[events] cron nightly ok", "events"), agent("(quiet)"), user("status?")]);
    const day = (key: string): Row => ({ type: "day", key, ts: T0 });
    expect(hideActivity([day("d1"), digest, reply, day("d2"), line]).rows.map((r) => r.key)).toEqual(["d2", line.key]);
    expect(hideActivity([day("d1"), line, day("d2"), digest, reply]).rows.map((r) => r.key)).toEqual(["d1", line.key]);
  });

  it("a reply that only names (quiet) later is not a quiet reply", () => {
    expect(isQuietReply("  (quiet) app-shop: nothing new")).toBe(true);
    expect(isQuietReply("I wrote (quiet) before.")).toBe(false);
  });
});
