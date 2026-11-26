import { describe, expect, it } from "vitest";
import type { QueueItem } from "../../server/chief/queue/types";
import type { Shown } from "./thread";
import { agentTickets, canUndo, closedAt, closedText, threadRows, ticketPhase, type Row } from "./threadTickets";

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const min = (n: number): number => T0 + n * 60_000;
const day = (): string => "d";

function ticket(id: string, at: number, p: Partial<QueueItem> = {}): QueueItem {
  return {
    id, kind: "choice", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "r", area: "x",
    title: `T ${id}`, body: "", createdAt: at, updatedAt: at, status: "open", blocking: false, history: [], answerSeq: 0, ...p,
  };
}
const user = (id: string, ts: number, text = "hi", p: Partial<Extract<Shown, { kind: "user" }>> = {}): Shown => ({ kind: "user", id, ts, text, ...p });
const agent = (id: string, ts: number, text = "ok"): Shown => ({ kind: "assistant", id, ts, text });
const step = (id: string, ts: number, end?: number): Shown => ({ kind: "step", id, ts, tool: "Bash", label: id, ...(end !== undefined ? { end } : {}) });
const answered = (id: string, at: number, answerAt: number, p: Partial<QueueItem> = {}): QueueItem =>
  ticket(id, at, { status: "answered", answer: { value: "A", by: "user", via: "tab", at: answerAt }, ...p });

const shape = (rows: Row[]): string[] => rows.map((r) =>
  r.type === "ticket" ? `ticket:${r.item.id}:${r.phase}${r.moved ? ":moved" : ""}`
    : r.type === "steps" ? `steps:${r.steps.map((s) => s.id).join("+")}`
    : r.type === "day" ? "day" : `${r.type}:${r.item.id}`);

describe("ticketPhase", () => {
  it("follows the Queue view's Open rule", () => {
    expect(ticketPhase(ticket("q1", T0), T0)).toBe("open");
    expect(ticketPhase(ticket("q1", T0, { status: "snoozed", snoozedUntil: min(60) }), min(1))).toBe("snoozed");
    expect(ticketPhase(ticket("q1", T0, { status: "snoozed", snoozedUntil: min(60) }), min(60))).toBe("open");
    expect(ticketPhase(answered("q1", T0, min(1)), min(2))).toBe("answered");
    expect(ticketPhase(ticket("q1", T0, { status: "auto" }), T0)).toBe("answered");
    expect(ticketPhase(ticket("q1", T0, { status: "withdrawn" }), T0)).toBe("withdrawn");
  });
});

describe("agentTickets", () => {
  it("keeps this agent's tickets, oldest first", () => {
    const items = [ticket("q3", min(3)), ticket("q1", min(1), { agentId: "a2" }), ticket("q2", min(2)), ticket("q0", min(2))];
    expect(agentTickets(items, "a1").map((i) => i.id)).toEqual(["q0", "q2", "q3"]);
    expect(agentTickets(items, "lead-app").map((i) => i.id)).toEqual([]);
  });
});

describe("threadRows", () => {
  it("is the plain block list with no tickets", () => {
    expect(shape(threadRows([user("u1", min(0)), agent("a1", min(1))], [], min(5), 0, day))).toEqual(["msg:u1", "msg:a1"]);
  });

  it("puts a ticket where the agent asked", () => {
    const items = [user("u1", min(0)), agent("a1", min(2)), agent("a2", min(6))];
    expect(shape(threadRows(items, [ticket("q1", min(3))], min(9), 0, day))).toEqual(["msg:u1", "msg:a1", "ticket:q1:open", "msg:a2"]);
  });

  it("puts a ticket after the last block when nothing came later", () => {
    const items = [user("u1", min(0)), agent("a1", min(2))];
    expect(shape(threadRows(items, [ticket("q1", min(3))], min(9), 0, day))).toEqual(["msg:u1", "msg:a1", "ticket:q1:open"]);
  });

  it("does not split a run of steps: the ticket follows the run it was made in", () => {
    const items = [user("u1", min(0)), step("s1", min(1), min(2)), step("s2", min(3), min(4)), step("s3", min(5), min(6)), agent("a1", min(7))];
    expect(shape(threadRows(items, [ticket("q1", min(4))], min(9), 0, day))).toEqual(["msg:u1", "steps:s1+s2+s3", "ticket:q1:open", "msg:a1"]);
  });

  it("keeps two tickets of one moment in the order they were made", () => {
    const items = [user("u1", min(0)), step("s1", min(1), min(2)), agent("a1", min(7))];
    const rows = threadRows(items, [ticket("q1", min(3), { kind: "pr" }), ticket("q2", min(4), { kind: "preview" })], min(9), 0, day);
    expect(shape(rows)).toEqual(["msg:u1", "steps:s1", "ticket:q1:open", "ticket:q2:open", "msg:a1"]);
  });

  it("shows an open ticket from before the loaded range at the bottom", () => {
    const items = [user("u1", min(10)), agent("a1", min(11))];
    const rows = threadRows(items, [ticket("q1", min(3)), ticket("q2", min(12))], min(20), 0, day);
    expect(shape(rows)).toEqual(["msg:u1", "msg:a1", "ticket:q2:open", "ticket:q1:open:moved"]);
  });

  it("hides a closed or snoozed ticket from before the loaded range until its page loads", () => {
    const old = [answered("q1", min(3), min(4)), ticket("q2", min(3), { status: "withdrawn" }), ticket("q3", min(3), { status: "snoozed", snoozedUntil: min(90) })];
    const items = [user("u1", min(10)), agent("a1", min(11))];
    expect(shape(threadRows(items, old, min(20), 0, day))).toEqual(["msg:u1", "msg:a1"]);
    const withOlder = [agent("a0", min(1)), ...items];
    expect(shape(threadRows(withOlder, old, min(20), 0, day))).toEqual([
      "msg:a0", "ticket:q1:answered", "ticket:q2:withdrawn", "ticket:q3:snoozed", "msg:u1", "msg:a1",
    ]);
  });

  it("keeps a ticket that was answered at the bottom there, as a line, while the undo window is open", () => {
    const items = [user("u1", min(10)), user("u2", min(21), "choice: A", { via: "queue", ref: "q1" })];
    const t = answered("q1", min(3), min(20));
    const tenMin = 10 * 60_000;
    expect(shape(threadRows(items, [t], min(22), tenMin, day))).toEqual(["msg:u1", "ticket:q1:answered:moved"]);
    // The window passed: the line goes (it shows in its own place when that page loads), the session line stays.
    expect(shape(threadRows(items, [t], min(31), tenMin, day))).toEqual(["msg:u1", "msg:u2"]);
    // A ticket withdrawn there has no undo: it goes at once.
    expect(shape(threadRows(items, [ticket("q1", min(3), { status: "withdrawn" })], min(22), tenMin, day))).toEqual(["msg:u1", "msg:u2"]);
  });

  it("shows a snoozed ticket again as open at the bottom when its snooze ended", () => {
    const items = [user("u1", min(10))];
    const t = ticket("q1", min(3), { status: "snoozed", snoozedUntil: min(30) });
    expect(shape(threadRows(items, [t], min(20), 0, day))).toEqual(["msg:u1"]);
    expect(shape(threadRows(items, [t], min(31), 0, day))).toEqual(["msg:u1", "ticket:q1:open:moved"]);
  });

  it("shows an open ticket of a thread with no messages", () => {
    expect(shape(threadRows([], [ticket("q1", min(3))], min(9), 0, day))).toEqual(["ticket:q1:open:moved"]);
  });

  it("shows the answer one time: the session line of a shown, answered ticket is left out", () => {
    const items = [
      user("u1", min(0)), agent("a1", min(2)),
      user("u2", min(5), "choice: A (first)", { via: "queue", ref: "q1" }), agent("a2", min(6)),
    ];
    const rows = threadRows(items, [answered("q1", min(3), min(5) - 400)], min(9), 0, day);
    expect(shape(rows)).toEqual(["msg:u1", "msg:a1", "ticket:q1:answered", "msg:a2"]);
  });

  it("keeps the session lines of an answer that was undone, and hides only the current answer", () => {
    const items = [
      agent("a1", min(2)),
      user("u2", min(5), "choice: A (first)", { via: "queue", ref: "q1" }),
      user("u3", min(6), "the earlier answer (A) is withdrawn; wait for the user", { via: "queue", ref: "q1" }),
      user("u4", min(8), "choice: B (second)", { via: "queue", ref: "q1" }),
    ];
    const open = ticket("q1", min(3), { history: [{ value: "A", by: "user", via: "tab", at: min(5) }] });
    expect(shape(threadRows(items, [open], min(7), 0, day))).toEqual(["msg:a1", "ticket:q1:open", "msg:u2", "msg:u3", "msg:u4"]);
    const again = answered("q1", min(3), min(8) - 300);
    expect(shape(threadRows(items, [again], min(9), 0, day))).toEqual(["msg:a1", "ticket:q1:answered", "msg:u2", "msg:u3"]);
  });

  it("keeps the session line when its ticket is not shown, and a line of another ticket", () => {
    const items = [user("u1", min(10)), user("u2", min(11), "pr: approved", { via: "queue", ref: "q1" }), user("u3", min(12), "x", { via: "queue", ref: "q9" })];
    const rows = threadRows(items, [answered("q1", min(3), min(11) - 200), answered("q2", min(10) + 5, min(13))], min(20), 0, day);
    expect(shape(rows)).toEqual(["msg:u1", "ticket:q2:answered", "msg:u2", "msg:u3"]);
  });

  it("keeps the session line of a withdrawn ticket's earlier answer", () => {
    const items = [agent("a1", min(2)), user("u2", min(5), "choice: A", { via: "queue", ref: "q1" })];
    const t = ticket("q1", min(3), { status: "withdrawn", closedAt: min(8) });
    expect(shape(threadRows(items, [t], min(9), 0, day))).toEqual(["msg:a1", "ticket:q1:withdrawn", "msg:u2"]);
  });

  it("ignores an item with no time when it places a ticket", () => {
    const items = [user("u0", 0), user("u1", min(1)), agent("a1", min(4))];
    expect(shape(threadRows(items, [ticket("q1", min(2))], min(9), 0, day))).toEqual(["msg:u0", "msg:u1", "ticket:q1:open", "msg:a1"]);
  });
});

describe("closedText", () => {
  it("names the answer by kind", () => {
    const a = (kind: QueueItem["kind"], value: string, text?: string, p: Partial<QueueItem> = {}): QueueItem =>
      ticket("q1", T0, { kind, status: "answered", answer: { value, ...(text !== undefined ? { text } : {}), by: "user", via: "tab", at: min(1) }, ...p });
    expect(closedText(a("pr", "approve"))).toBe("Approved");
    expect(closedText(a("preview", "approve"))).toBe("Looks good");
    expect(closedText(a("pr", "changes", "rename x"))).toBe("Changes requested: rename x");
    expect(closedText(a("choice", "B", undefined, { choice: { options: [{ key: "A", label: "one" }, { key: "B", label: "two" }] } }))).toBe("B · two");
    expect(closedText(a("choice", "reply", "neither"))).toBe("neither");
    expect(closedText(a("question", "reply", "at 5 pm"))).toBe("at 5 pm");
  });
  it("an answer of images and no text says how many; with text, the text", () => {
    const img = (n: number) => Array.from({ length: n }, (_, k) => ({ name: `a1-${k + 1}.png`, path: `.choibot/uploads/screenshot-1-${k}.png` }));
    const a = (kind: QueueItem["kind"], value: string, n: number, text?: string): QueueItem =>
      ticket("q1", T0, { kind, status: "answered", answer: { value, ...(text !== undefined ? { text } : {}), by: "user", via: "tab", at: min(1), images: img(n) } });
    expect(closedText(a("question", "reply", 2))).toBe("2 images");
    expect(closedText(a("choice", "reply", 1))).toBe("1 image");
    expect(closedText(a("preview", "changes", 1))).toBe("Changes requested: 1 image");
    expect(closedText(a("question", "reply", 3, "see these"))).toBe("see these");
  });
  it("marks an auto answer with its rules", () => {
    const t = ticket("q1", T0, { status: "auto", answer: { value: "A", by: "master", via: "cli", at: min(1), ruleIds: ["r7"] }, choice: { options: [{ key: "A", label: "one" }] } });
    expect(closedText(t)).toBe("Auto (rule r7): A · one");
  });
  it("says why a ticket closed with no answer", () => {
    expect(closedText(ticket("q1", T0, { status: "withdrawn" }))).toBe("Withdrawn");
    expect(closedText(ticket("q1", T0, { status: "withdrawn", lastError: "merged" }))).toBe("PR merged");
    expect(closedText(ticket("q1", T0, { status: "withdrawn", lastError: "closed" }))).toBe("PR closed");
    expect(closedText(ticket("q1", T0, { status: "withdrawn", lastError: "agent-gone" }))).toBe("Agent gone");
  });
});

describe("closedAt and canUndo", () => {
  it("uses the answer time, else the close time", () => {
    expect(closedAt(answered("q1", T0, min(4)))).toBe(min(4));
    expect(closedAt(ticket("q1", T0, { status: "withdrawn", closedAt: min(6) }))).toBe(min(6));
  });
  it("allows an undo only inside the window, and never read-only", () => {
    const t = answered("q1", T0, min(4));
    expect(canUndo(t, min(5), 10 * 60_000, false)).toBe(true);
    expect(canUndo(t, min(15), 10 * 60_000, false)).toBe(false);
    expect(canUndo(t, min(5), 10 * 60_000, true)).toBe(false);
    expect(canUndo(ticket("q1", T0, { status: "withdrawn" }), min(5), 10 * 60_000, false)).toBe(false);
  });
});
