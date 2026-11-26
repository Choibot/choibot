import { describe, it, expect } from "vitest";
import { outbox, outLabel, sameText, MATCH_SLACK_MS, SENT_GIVE_UP_MS, STALE_AFTER_MS, type OutboxInput } from "./outbox";
import type { ComposerItem, SentItem } from "./composer";
import type { Message, Shown, Waiting } from "./thread";

// This browser's clock is 2 s behind the server's.
const SKEW = 2_000;
const NOW = 1_000_000;
const SRV = NOW + SKEW;
const local = (id: string, text: string, state: ComposerItem["state"] = "sending", over: Partial<ComposerItem> = {}): ComposerItem =>
  ({ id, text, at: NOW - 100, seq: 1, state, ...over });
const sent = (id: string, text: string, over: Partial<SentItem> = {}): SentItem => ({ id, text, at: NOW - 400, sentAt: NOW - 100, ...over });
const row = (id: string, text: string, ts = SRV - 50): Message => ({ kind: "user", id, ts, text });
const say = (id: string, ts: number): Shown => ({ kind: "assistant", id, ts, text: "answer" });
const waits = (id: string, text: string, ts = SRV - 50, over: object = {}): Waiting => ({ item: { kind: "user", id, ts, text, ...over } });
const run = (over: Partial<OutboxInput>) =>
  outbox({ items: [], waiting: [], local: [], sent: [], claimed: [], status: "idle", skew: SKEW, now: NOW, ...over });
const states = (r: ReturnType<typeof run>): string[] => r.rows.map((x) => `${x.item.text}:${x.state}`);

describe("outbox: the optimistic entry", () => {
  it("shows a message at once, before the server has it", () => {
    const r = run({ local: [local("m1", "fix the header", "pending")] });
    expect(r.rows).toEqual([{ key: "o:m1", localId: "m1", state: "sending", item: { kind: "user", id: "o:m1", ts: NOW - 100 + SKEW, text: "fix the header" } }]);
    expect(outLabel(r.rows[0])).toBe("Sending…");
  });

  it("shows no state once the agent has it and is idle", () => {
    const r = run({ sent: [sent("m1", "fix the header")] });
    expect(states(r)).toEqual(["fix the header:sent"]);
    expect(outLabel(r.rows[0])).toBeNull();
    expect(r.settle).toEqual([]);
  });

  it("says that it waits when the agent worked at the send, before the file says so", () => {
    const r = run({ sent: [sent("m1", "fix the header", { busy: true })], status: "running" });
    expect(states(r)).toEqual(["fix the header:waiting"]);
    expect(outLabel(r.rows[0])).toBe("Waits. The agent reads it when it is ready.");
  });

  it("does not say that it waits when the message itself started the turn", () => {
    // The status is "running" a moment after the send to an idle agent.
    const r = run({ sent: [sent("m1", "fix the header")], status: "running" });
    expect(states(r)).toEqual(["fix the header:sent"]);
    expect(outLabel(r.rows[0])).toBeNull();
  });

  it("replace: the file's row takes the place of the sent message, with no second bubble", () => {
    const r = run({ sent: [sent("m1", "fix the header")], items: [say("a0", SRV - 9_000), row("u9", "fix the header")] });
    expect(r.rows).toEqual([]);
    expect(r.settle).toEqual([{ id: "m1", by: "u9" }]);
  });

  it("replace: the file's wait line takes the place of the sent message", () => {
    const r = run({ sent: [sent("m1", "fix the header")], waiting: [waits("q:1", "fix the header")], status: "running" });
    expect(r.rows.map((x) => `${x.key}:${x.state}`)).toEqual(["m:q:1:waiting"]);
    expect(r.settle).toEqual([{ id: "m1", by: "q:1" }]);
  });

  it("no duplicate while the request is still open and the file has the row already", () => {
    const r = run({ local: [local("m1", "fix the header", "sending")], items: [row("u9", "fix the header")] });
    expect(r.rows).toEqual([]);
    expect(r.settle).toEqual([]); // the composer still owns it
  });

  it("does not take an older row with the same text for a new message", () => {
    const old = row("u1", "ok", SRV - 60_000);
    const r = run({ sent: [sent("m2", "ok")], items: [old] });
    expect(states(r)).toEqual(["ok:sent"]);
    // The row of the first "ok" stands for the first message only.
    const twice = run({ sent: [sent("m2", "ok")], items: [row("u1", "ok")], claimed: ["u1"] });
    expect(states(twice)).toEqual(["ok:sent"]);
  });

  it("two messages with the same text in a row take one row each", () => {
    const both = [sent("m1", "ok", { at: NOW - 900 }), sent("m2", "ok", { at: NOW - 300 })];
    const one = run({ sent: both, items: [row("u1", "ok")] });
    expect(one.settle).toEqual([{ id: "m1", by: "u1" }]);
    expect(one.rows.map((x) => x.localId)).toEqual(["m2"]);
    const two = run({ sent: both, items: [row("u1", "ok"), row("u2", "ok")] });
    expect(two.settle).toEqual([{ id: "m1", by: "u1" }, { id: "m2", by: "u2" }]);
    expect(two.rows).toEqual([]);
  });

  it("takes a row a little older than the send (two clocks) and not an older one", () => {
    const at = NOW - 400;
    expect(run({ sent: [sent("m1", "hi", { at })], items: [row("u1", "hi", at + SKEW - MATCH_SLACK_MS)] }).rows).toEqual([]);
    expect(run({ sent: [sent("m1", "hi", { at })], items: [row("u1", "hi", at + SKEW - MATCH_SLACK_MS - 1)] }).rows).toHaveLength(1);
  });

  it("gives up on a sent message that the file never shows, once the thread went on", () => {
    const old = sent("m1", "/some-command", { at: NOW - SENT_GIVE_UP_MS - 500, sentAt: NOW - SENT_GIVE_UP_MS - 1 });
    expect(run({ sent: [old] }).rows).toHaveLength(1); // nothing new in the file: it stays
    const r = run({ sent: [old], items: [say("a1", SRV - 10)] });
    expect(r.rows).toEqual([]);
    expect(r.settle).toEqual([{ id: "m1" }]);
  });
});

describe("outbox: failure", () => {
  it("a message that could not be sent stays, with its text, as not sent", () => {
    const r = run({ local: [local("m1", "a long message", "failed", { note: "failed: text over 32000 chars", why: "error" })] });
    expect(states(r)).toEqual(["a long message:failed"]);
    expect(r.rows[0].localId).toBe("m1");
    expect(outLabel(r.rows[0])).toBe("Not sent: text over 32000 chars");
    expect(outLabel({ state: "failed" })).toBe("Not sent");
  });

  it("says in plain words why a message is not sent yet", () => {
    const why = (w: ComposerItem["why"], note: string): string | null =>
      outLabel(run({ local: [local("m1", "hi", "waiting", { note, why: w })] }).rows[0]);
    expect(why("offline", "offline — retrying")).toBe("No connection. Trying again.");
    expect(why("starting", "waiting for agent to start")).toBe("Waits for the agent to start.");
    expect(why("dialog", "the agent asks a question — answer it first")).toBe("The agent asks a question. Answer it in its card first.");
    expect(why("not-live", "agent not live — Resume to send")).toBe("The agent is stopped. Resume it to send.");
    expect(why("server", "server 502 — retrying")).toBe("The server did not take it. Trying again.");
  });

  it("a failed message is never taken for a row of the file", () => {
    const r = run({ local: [local("m1", "fix the header", "failed", { note: "failed: HTTP 400" })], items: [row("u9", "fix the header")] });
    expect(states(r)).toEqual(["fix the header:failed"]);
  });

  it("keeps the order: the wait line, then what was sent, then what is not sent yet", () => {
    const r = run({
      waiting: [waits("q:1", "from the phone")], sent: [sent("m1", "second", { busy: true })],
      local: [local("m2", "third", "sending"), local("m3", "fourth", "pending")], status: "running",
    });
    expect(states(r)).toEqual(["from the phone:waiting", "second:waiting", "third:sending", "fourth:sending"]);
  });
});

describe("outbox: the wait line of the session file", () => {
  it("shows a message of another browser that waits", () => {
    const r = run({ waiting: [waits("q:1", "from the phone")], status: "running" });
    expect(r.rows).toEqual([{ key: "m:q:1", state: "waiting", item: { kind: "user", id: "q:1", ts: SRV - 50, text: "from the phone" } }]);
  });

  it("shows no state for a message the agent took this moment", () => {
    const r = run({ waiting: [{ ...waits("q:1", "from the phone"), taken: true }], status: "running" });
    expect(outLabel(r.rows[0])).toBeNull();
  });

  it("a message in the line of an agent that does not run was not read", () => {
    const fresh = run({ waiting: [waits("q:1", "hello", SRV - STALE_AFTER_MS)], status: "idle" });
    expect(states(fresh)).toEqual(["hello:waiting"]); // an idle agent takes it in a moment
    const stale = run({ waiting: [waits("q:1", "hello", SRV - STALE_AFTER_MS - 1)], status: "done" });
    expect(states(stale)).toEqual(["hello:stale"]);
    expect(outLabel(stale.rows[0])).toBe("Not read. The session stopped first.");
    expect(states(run({ waiting: [waits("q:1", "hello", SRV - 600_000)], status: "running" }))).toEqual(["hello:waiting"]);
  });

  it("a console digest in the line is not the entry of a message the user sent", () => {
    const r = run({ sent: [sent("m1", "agent-1 waiting")], waiting: [waits("q:1", "agent-1 waiting", SRV - 50, { via: "events" })], status: "running" });
    // Both show: the digest on the Console's side, the user's own message as sent.
    expect(r.rows.map((x) => x.key)).toEqual(["m:q:1", "o:m1"]);
    expect(r.settle).toEqual([]);
  });
});

describe("sameText", () => {
  it("takes the same text with other white space", () => {
    expect(sameText("fix the header", "  fix the  header\n")).toBe(true);
    expect(sameText("fix the header", "fix the footer")).toBe(false);
  });
  it("takes a longer file text that holds the sent text (an image marker)", () => {
    expect(sameText("look at uploads/shot-1.png\n[image]", "look at uploads/shot-1.png")).toBe(true);
    expect(sameText("okay then", "ok")).toBe(false); // a short text must be the whole text
  });
});
