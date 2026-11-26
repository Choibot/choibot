import { describe, expect, it } from "vitest";
import { speakerHeads, speakerOf } from "./threadWho";
import type { Row } from "./threadTickets";
import type { Message, Step } from "./thread";

const user = (id: string, ts: number, via?: "events" | "reminder" | "queue"): Row =>
  ({ type: "msg", key: id, item: { kind: "user", id, ts, text: "hi", ...(via ? { via } : {}) } as Message });
const agent = (id: string, ts: number): Row => ({ type: "msg", key: id, item: { kind: "assistant", id, ts, text: "ok" } });
const steps = (id: string, ts: number): Row => ({
  type: "steps", key: id, from: ts, to: ts + 1, steps: [{ kind: "step", id, ts, tool: "Bash", label: "x" } as Step],
});
const day = (key: string, ts: number): Row => ({ type: "day", key, ts });

describe("speakerOf", () => {
  it("names the user, the console, a reminder, a peer and the agent", () => {
    expect(speakerOf({ kind: "user", id: "a", ts: 0, text: "" })).toEqual({ name: "You", mine: true });
    expect(speakerOf({ kind: "user", id: "a", ts: 0, text: "", via: "queue" })).toEqual({ name: "You", mine: true });
    expect(speakerOf({ kind: "user", id: "a", ts: 0, text: "", via: "events" })).toEqual({ name: "Console", mine: false });
    expect(speakerOf({ kind: "user", id: "a", ts: 0, text: "", via: "reminder" })).toEqual({ name: "Reminder", mine: false });
    expect(speakerOf({ kind: "peer", id: "a", ts: 0, text: "", from: "lead-app" })).toEqual({ name: "lead-app", mine: false });
    expect(speakerOf({ kind: "assistant", id: "a", ts: 0, text: "" })).toEqual({ name: "Claude", mine: false, agent: true });
  });
});

describe("speakerHeads", () => {
  it("names the speaker once per group of rows from the same speaker", () => {
    const heads = speakerHeads([user("u1", 10), steps("s1", 20), agent("a1", 30), steps("s2", 40), agent("a2", 50), user("u2", 60), user("u3", 70), agent("a3", 80)]);
    expect([...heads.keys()]).toEqual(["u1", "s1", "u2", "a3"]);
    expect(heads.get("s1")).toEqual({ name: "Claude", mine: false, agent: true, ts: 20 });
    expect(heads.get("u1")).toEqual({ name: "You", mine: true, ts: 10 });
  });

  it("starts a new group after a day line", () => {
    const heads = speakerHeads([agent("a1", 10), day("d", 15), agent("a2", 20)]);
    expect([...heads.keys()]).toEqual(["a1", "a2"]);
  });

  it("starts a new group when the console speaks between two user messages", () => {
    const heads = speakerHeads([user("u1", 10), user("e1", 20, "events"), user("u2", 30)]);
    expect([...heads.keys()]).toEqual(["u1", "e1", "u2"]);
  });
});
