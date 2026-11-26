import { describe, it, expect } from "vitest";
import { Coalescer, mergeMessages, type MergedMessage } from "./coalesce.js";
import { summaryOf } from "./store.js";
import { tgMessage } from "./testkit.js";

function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      pending.push(t);
      return { clear: () => { t.cleared = true; } };
    },
    fire: () => { for (const t of pending.splice(0)) if (!t.cleared) t.fn(); },
  };
}

// onFlush runs on a microtask after the timer fires; let it settle.
const tick = () => new Promise((r) => setImmediate(r));

const photo = (id: string) => [{ file_id: `${id}-s`, width: 90, height: 90 }, { file_id: id, width: 1280, height: 960 }];

describe("Coalescer", () => {
  it("merges an album into one logical message with every photo", async () => {
    const timers = manualTimers();
    const out: MergedMessage[] = [];
    const c = new Coalescer({ onFlush: (m) => { out.push(m); }, setTimer: timers.setTimer });
    c.push(tgMessage(11, { media_group_id: "g", photo: photo("p1"), caption: "Checkout broken" }));
    c.push(tgMessage(12, { media_group_id: "g", photo: photo("p2") }));
    expect(out).toEqual([]);
    expect(timers.pending.at(-1)?.ms).toBe(1500);
    timers.fire();
    await tick();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ firstMessageId: 11, messageIds: [11, 12], text: "Checkout broken" });
    expect(out[0].photos.map((p) => p.file_id)).toEqual(["p1", "p2"]);
  });

  it("merges a forward and the comment typed after it; the summary comes from the forwarded text", async () => {
    const timers = manualTimers();
    const out: MergedMessage[] = [];
    const c = new Coalescer({ onFlush: (m) => { out.push(m); }, setTimer: timers.setTimer });
    c.push(tgMessage(20, { text: "Swap fails on mobile", forward_origin: { type: "hidden_user", sender_user_name: "Dana" } }));
    c.push(tgMessage(21, { text: "can you look?" }));
    timers.fire();
    await tick();
    expect(out[0]).toMatchObject({ firstMessageId: 20, forwardedFrom: "Dana", text: "Swap fails on mobile\n\ncan you look?" });
    expect(summaryOf(out[0].text)).toBe("Swap fails on mobile");
  });

  it("starts a new logical message after the window expires", async () => {
    const timers = manualTimers();
    const out: MergedMessage[] = [];
    const c = new Coalescer({ onFlush: (m) => { out.push(m); }, setTimer: timers.setTimer });
    c.push(tgMessage(30, { text: "one" }));
    timers.fire();
    await tick();
    c.push(tgMessage(31, { text: "two" }));
    timers.fire();
    await tick();
    expect(out.map((m) => m.firstMessageId)).toEqual([30, 31]);
  });

  it("stop clears pending timers and ignores later pushes", async () => {
    const timers = manualTimers();
    const out: MergedMessage[] = [];
    const c = new Coalescer({ onFlush: (m) => { out.push(m); }, setTimer: timers.setTimer });
    c.push(tgMessage(40, { text: "pending" }));
    c.stop();
    expect(timers.pending.every((t) => t.cleared)).toBe(true);
    c.push(tgMessage(41, { text: "after stop" }));
    timers.fire();
    await tick();
    expect(out).toEqual([]);
  });

  it("mergeMessages orders by message id", () => {
    const m = mergeMessages([tgMessage(5, { text: "b" }), tgMessage(4, { text: "a" })]);
    expect(m).toMatchObject({ firstMessageId: 4, text: "a\n\nb" });
  });
});
