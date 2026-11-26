import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MasterInbox, InboxError, turnAfterHook, waitForHook, BUSY_TIMEOUT_MS, DIGEST_GAP_MS, QUIET_MS, SEEN_MSG_IDS_MAX } from "./inbox.js";
import { InputTracker } from "./draft.js";
import { EventHub } from "../events.js";
import { EventQueue } from "./events.js";

function setup(o: {
  digest?: string | null; sendOk?: boolean; ready?: () => boolean; waits?: () => boolean;
  // Called before a send records its text; false or a throw fails the send.
  send?: (text: string) => Promise<boolean>;
  agentId?: string;
} = {}) {
  let t = 10_000_000;
  const now = () => t;
  const hub = new EventHub();
  const sent: string[] = [];
  const queued: string[] = [];
  let digest = o.digest ?? null;
  let cleared = 0;
  const tracker = new InputTracker(now);
  const inbox = new MasterInbox({
    hub, tracker, now,
    events: { size: () => (digest ? 1 : 0), digest: () => digest, clear: () => { digest = null; cleared++; } },
    send: async (text) => {
      if (o.sendOk === false) return false;
      if (o.send && !(await o.send(text))) return false;
      sent.push(text);
      return true;
    },
    onQueued: (r) => queued.push(r),
    ...(o.agentId ? { agentId: o.agentId } : {}),
    ...(o.ready ? { ready: o.ready } : {}),
    ...(o.waits ? { waits: o.waits } : {}),
  });
  const hook = (event: string, source?: string) =>
    hub.emitEvent({ type: "agent-hook", agentId: "fleet-master", event, ...(source ? { source } : {}) });
  return {
    hub, inbox, sent, queued, tracker, hook,
    advance: (ms: number) => { t += ms; },
    setDigest: (d: string | null) => { digest = d; },
    cleared: () => cleared,
  };
}

describe("turnAfterHook", () => {
  it("follows the spec's turn table", () => {
    expect(turnAfterHook("idle", "UserPromptSubmit")).toBe("busy");
    expect(turnAfterHook("busy", "Stop")).toBe("idle");
    for (const s of ["startup", "resume", "clear"]) expect(turnAfterHook("busy", "SessionStart", s)).toBe("idle");
    expect(turnAfterHook("busy", "SessionStart", "compact")).toBe("busy");
    expect(turnAfterHook("busy", "Notification")).toBe("busy");
  });
});

describe("MasterInbox turn state", () => {
  it("takes the turn from the record at start and from master hooks only", () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    expect(s.inbox.turn()).toBe("busy");
    s.hub.emitEvent({ type: "agent-hook", agentId: "some-worker", event: "Stop" });
    expect(s.inbox.turn()).toBe("busy");
    s.hook("Stop");
    expect(s.inbox.turn()).toBe("idle");
    s.hook("UserPromptSubmit");
    expect(s.inbox.turn()).toBe("busy");
    s.hook("SessionStart", "compact");
    expect(s.inbox.turn()).toBe("busy");
  });

  it("busy timeout: a lost Stop delivers once after 3 min, then waits for a real hook (Review Focus 3)", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.inbox.pushTelegram("one");
    await s.inbox.tick();
    expect(s.sent).toEqual([]);
    s.advance(BUSY_TIMEOUT_MS);
    await s.inbox.tick();
    expect(s.sent).toEqual(["one"]);
    s.inbox.pushTelegram("two");
    s.advance(BUSY_TIMEOUT_MS * 3);
    await s.inbox.tick();
    expect(s.sent).toEqual(["one"]); // disarmed
    s.hook("UserPromptSubmit");      // a real hook re-arms the timeout
    s.advance(BUSY_TIMEOUT_MS);
    await s.inbox.tick();
    expect(s.sent).toEqual(["one", "two"]);
  });

  it("Notification never counts as a signal", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.advance(BUSY_TIMEOUT_MS - 1);
    s.hook("Notification");
    s.advance(1);
    expect(s.inbox.turn()).toBe("idle");
  });
});

describe("MasterInbox delivery rules", () => {
  it("delivers queued Telegram text after a turn-end, joined with a blank line", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.inbox.pushTelegram("first");
    s.inbox.pushTelegram("second");
    await s.inbox.tick();
    expect(s.sent).toEqual([]);
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.sent).toEqual(["first\n\nsecond"]);
    expect(s.inbox.queuedMessages()).toBe(0);
    expect(s.inbox.turn()).toBe("busy"); // we just fed it a prompt
  });

  it("waits for an unsent draft, and for 30 s of web quiet", async () => {
    const s = setup();
    s.inbox.start("idle", { tickMs: 0 });
    s.inbox.onWebInput("fleet-master", "half");
    s.inbox.pushTelegram("hi");
    s.advance(QUIET_MS);
    await s.inbox.tick();
    expect(s.sent).toEqual([]);
    expect(s.inbox.blockedBy()).toBe("draft");
    s.inbox.onWebInput("fleet-master", "\r");
    expect(s.inbox.blockedBy()).toBe("quiet");
    s.advance(QUIET_MS - 1);
    await s.inbox.tick();
    expect(s.sent).toEqual([]);
    s.advance(1);
    await s.inbox.tick();
    expect(s.sent).toEqual(["hi"]);
  });

  it("ignores web input for other agents", () => {
    const s = setup();
    s.inbox.start("idle", { tickMs: 0 });
    s.inbox.onWebInput("worker-1", "typing");
    expect(s.inbox.blockedBy()).toBeNull();
  });

  it("never mixes a digest with Telegram text, and spaces digests 60 s apart", async () => {
    const s = setup({ digest: "[events] agent-1a2b3c4d r waiting" });
    s.inbox.start("idle", { tickMs: 0 });
    s.inbox.pushTelegram("question");
    await s.inbox.tick();
    expect(s.sent).toEqual(["question"]);
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.sent).toEqual(["question", "[events] agent-1a2b3c4d r waiting"]);
    expect(s.cleared()).toBe(1);
    s.hook("Stop");
    s.setDigest("[events] agent-5e6f7a8b r errored");
    await s.inbox.tick();
    expect(s.sent).toHaveLength(2);
    s.advance(DIGEST_GAP_MS);
    await s.inbox.tick();
    expect(s.sent).toHaveLength(3);
  });

  it("keeps text and events when the paste fails (terminal not live)", async () => {
    const s = setup({ digest: "[events] x", sendOk: false });
    s.inbox.start("idle", { tickMs: 0 });
    s.inbox.pushTelegram("keep me");
    await s.inbox.tick();
    expect(s.inbox.queuedMessages()).toBe(1);
    expect(s.cleared()).toBe(0);
    expect(s.inbox.turn()).toBe("idle");
  });

  it("posts one Queued notice per wait period, naming the blocking cause", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.inbox.pushTelegram("a");
    s.inbox.pushTelegram("b");
    await s.inbox.tick();
    await s.inbox.tick();
    expect(s.queued).toEqual(["busy"]);
    s.hook("Stop");
    await s.inbox.tick(); // delivered: the wait period ends
    s.hook("Stop");
    s.inbox.onWebInput("fleet-master", "draft");
    s.inbox.pushTelegram("c");
    await s.inbox.tick();
    expect(s.queued).toEqual(["busy", "draft"]);
  });

  it("posts no notice when only the quiet window blocks", async () => {
    const s = setup();
    s.inbox.start("idle", { tickMs: 0 });
    s.inbox.onWebInput("fleet-master", "ok\r");
    s.inbox.pushTelegram("x");
    await s.inbox.tick();
    expect(s.queued).toEqual([]);
  });
});

describe("MasterInbox ready gate", () => {
  it("does nothing while no master exists, then delivers once it does", async () => {
    let exists = false;
    const s = setup({ digest: "[events] x", ready: () => exists });
    s.inbox.start("idle", { tickMs: 0 });
    s.inbox.pushTelegram("hello");
    await s.inbox.tick();
    await s.inbox.tick();
    expect(s.sent).toEqual([]); // send() succeeds when called, so [] means never called
    expect(s.queued).toEqual([]);
    expect(s.cleared()).toBe(0);
    exists = true;
    await s.inbox.tick();
    expect(s.sent).toEqual(["hello"]);
  });
});

describe("MasterInbox surface", () => {
  it("starts on tab, flips to telegram on Telegram input and back on a submitted tab line", () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    expect(s.inbox.surface).toBe("tab");
    s.inbox.pushTelegram("x");
    expect(s.inbox.surface).toBe("telegram");
    s.inbox.onWebInput("fleet-master", "typing");
    expect(s.inbox.surface).toBe("telegram");
    s.inbox.onWebInput("fleet-master", "\r");
    expect(s.inbox.surface).toBe("tab");
  });

  it("delivery of Telegram text sets surface back to telegram after a tab submit", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.inbox.pushTelegram("from phone");
    s.inbox.onWebInput("fleet-master", "typed in tab\r");
    expect(s.inbox.surface).toBe("tab");
    s.hook("Stop");
    s.advance(QUIET_MS);
    await s.inbox.tick();
    expect(s.sent).toEqual(["from phone"]);
    expect(s.inbox.surface).toBe("telegram");
  });

  it("a failed Telegram delivery leaves the surface unchanged", async () => {
    const s = setup({ sendOk: false });
    s.inbox.start("idle", { tickMs: 0 });
    s.inbox.pushTelegram("x");
    s.inbox.surface = "tab";
    await s.inbox.tick();
    expect(s.inbox.surface).toBe("tab");
  });
});

describe("MasterInbox markStarting", () => {
  it("holds delivery as busy until SessionStart, with the busy timeout armed", async () => {
    const s = setup({ digest: "[events] x" });
    s.inbox.start("idle", { tickMs: 0 });
    s.advance(DIGEST_GAP_MS);
    s.inbox.markStarting();
    expect(s.inbox.turn()).toBe("busy");
    await s.inbox.tick();
    expect(s.sent).toEqual([]);
    s.hook("SessionStart", "startup");
    expect(s.inbox.turn()).toBe("idle");
    await s.inbox.tick();
    expect(s.sent).toEqual(["[events] x"]);
  });

  it("a lost SessionStart is bounded by the 3 min busy timeout", async () => {
    const s = setup();
    s.inbox.start("idle", { tickMs: 0 });
    s.advance(BUSY_TIMEOUT_MS * 2);
    s.inbox.markStarting();
    s.advance(BUSY_TIMEOUT_MS - 1);
    expect(s.inbox.turn()).toBe("busy");
    s.advance(1);
    expect(s.inbox.turn()).toBe("idle");
  });

  it("re-arms a disarmed timeout", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.inbox.pushTelegram("one");
    s.advance(BUSY_TIMEOUT_MS);
    await s.inbox.tick(); // delivered via timeout: disarmed
    expect(s.sent).toEqual(["one"]);
    s.inbox.markStarting();
    s.advance(BUSY_TIMEOUT_MS);
    expect(s.inbox.turn()).toBe("idle");
  });
});

describe("waitForHook", () => {
  it("resolves true on the hook, false on timeout", async () => {
    const hub = new EventHub();
    const p = waitForHook(hub, "fleet-master", "SessionStart", 1_000);
    hub.emitEvent({ type: "agent-hook", agentId: "fleet-master", event: "SessionStart", source: "resume" });
    expect(await p).toBe(true);
    expect(await waitForHook(hub, "fleet-master", "SessionStart", 10)).toBe(false);
  });
});

describe("MasterInbox robustness", () => {
  it("a queue line added while a digest is sent is not lost: it goes in the next digest", async () => {
    const t = 10_000_000;
    const events = new EventQueue({
      hub: new EventHub(), agents: { load: async () => null }, issues: { list: async () => [] }, acted: { recent: () => false },
    });
    const sent: string[] = [];
    const sends: ((ok: boolean) => void)[] = [];
    const inbox = new MasterInbox({
      hub: new EventHub(), tracker: new InputTracker(() => t), now: () => t, events,
      send: (text) => { sent.push(text); return new Promise<boolean>((r) => { sends.push(r); }); },
    });
    inbox.start("idle", { tickMs: 0 });
    events.addQueue("qaaaaaaa1", "choice", "app-shop", "w1");
    const tick = inbox.tick();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    events.addQueue("qaaaaaaa2", "question", "app-shop", "w1");
    sends[0]!(true);
    await tick;
    expect(sent).toEqual(["[events] queue qaaaaaaa1 choice app-shop"]);
    expect(events.digest()).toBe("[events] queue qaaaaaaa2 question app-shop");
    inbox.stop();
  });

  it("keeps the event queue when a digest-only paste fails", async () => {
    const s = setup({ digest: "[events] agent-1a2b3c4d r waiting", sendOk: false });
    s.inbox.start("idle", { tickMs: 0 });
    await s.inbox.tick();
    expect(s.cleared()).toBe(0);
    expect(s.inbox.turn()).toBe("idle");
  });

  it("a rejected send on the interval is logged, not an unhandled rejection, and the next tick delivers", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: string[] = [];
    let calls = 0;
    const inbox = new MasterInbox({
      hub: new EventHub(),
      tracker: new InputTracker(),
      events: { size: () => 0, digest: () => null, clear: () => {} },
      send: async (text) => { if (calls++ === 0) throw new Error("pty gone"); sent.push(text); return true; },
    });
    try {
      inbox.start("idle", { tickMs: 5 });
      inbox.pushTelegram("retry me");
      for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setImmediate(r));
      expect(sent).toEqual(["retry me"]);
      expect(err).toHaveBeenCalledWith("[master] inbox tick failed:", expect.any(Error));
      expect(unhandled).toEqual([]);
    } finally {
      inbox.stop();
      err.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("start() is idempotent and stop() unsubscribes from hooks", () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.inbox.start("idle", { tickMs: 0 });
    expect(s.inbox.turn()).toBe("busy");
    s.inbox.stop();
    s.hook("Stop");
    expect(s.inbox.turn()).toBe("busy");
  });
});

// pushConsole (spec §5.4 step 3, §15). Only setTimeout is faked, so the
// message timers are under test control while setImmediate stays real.
type Outcome = { state: "pending" | "resolved" | "rejected"; error?: unknown };
function track(p: Promise<void>): Outcome {
  const o: Outcome = { state: "pending" };
  p.then(() => { o.state = "resolved"; }, (e: unknown) => { o.state = "rejected"; o.error = e; });
  return o;
}
const flush = () => new Promise<void>((r) => setImmediate(r));
const reason = (o: Outcome) => (o.error instanceof InboxError ? o.error.reason : o.error);

// A send the test settles by hand; `calls` lists every attempted batch.
function heldSend() {
  const calls: string[] = [];
  let release: (ok: boolean) => void = () => {};
  let fail: (e: Error) => void = () => {};
  let auto: boolean | null = null; // non-null: answer at once with this value
  const send = (text: string) => {
    calls.push(text);
    if (auto !== null) return Promise.resolve(auto);
    return new Promise<boolean>((res, rej) => { release = res; fail = rej; });
  };
  return {
    send, calls,
    release: (ok: boolean) => release(ok),
    fail: (e: Error) => fail(e),
    answerAtOnce: (ok: boolean) => { auto = ok; },
  };
}

describe("MasterInbox pushConsole", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("resolves when the batch send returns true, and goes before a digest", async () => {
    const s = setup({ digest: "[events] x" });
    s.inbox.start("idle", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("[queue q1] choice: A", "tab", { msgId: "q1-1" }));
    const b = track(s.inbox.pushConsole("[queue q2] choice: B", "tab", { msgId: "q2-1" }));
    expect(s.inbox.queuedMessages()).toBe(2);
    await flush();
    expect([a.state, b.state]).toEqual(["pending", "pending"]);
    await s.inbox.tick();
    await flush();
    expect(s.sent).toEqual(["[queue q1] choice: A\n\n[queue q2] choice: B"]);
    expect([a.state, b.state]).toEqual(["resolved", "resolved"]);
    expect(s.inbox.queuedMessages()).toBe(0);
    expect(s.cleared()).toBe(0);
    expect(s.inbox.turn()).toBe("busy");
  });

  it("stays pending while the send is in flight and while the master is busy", async () => {
    const h = heldSend();
    const s = setup({ send: h.send });
    s.inbox.start("busy", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("line", "tab", { msgId: "q1-1", timeoutMs: BUSY_TIMEOUT_MS }));
    await s.inbox.tick();
    await flush();
    expect(h.calls).toEqual([]);
    expect(a.state).toBe("pending");
    s.hook("Stop");
    const t = s.inbox.tick();
    await flush();
    expect(h.calls).toEqual(["line"]);
    expect(a.state).toBe("pending");
    h.release(true);
    await t;
    await flush();
    expect(a.state).toBe("resolved");
  });

  it("with timeoutMs and a busy master: rejects timeout, leaves the queue, and a re-push sends it once", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    const line = "[queue q1] choice: B (Registry-driven)";
    const first = track(s.inbox.pushConsole(line, "tab", { msgId: "q1-1", timeoutMs: BUSY_TIMEOUT_MS, since: 5 }));
    await s.inbox.tick();
    vi.advanceTimersByTime(BUSY_TIMEOUT_MS - 1);
    await flush();
    expect(first.state).toBe("pending");
    expect(s.inbox.queuedMessages()).toBe(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(first.state).toBe("rejected");
    expect(first.error).toBeInstanceOf(InboxError);
    expect(reason(first)).toBe("timeout");
    expect(s.inbox.queuedMessages()).toBe(0);
    const again = track(s.inbox.pushConsole(line, "tab", { msgId: "q1-1", timeoutMs: BUSY_TIMEOUT_MS, since: 5 }));
    s.hook("Stop");
    await s.inbox.tick();
    await flush();
    expect(s.sent).toEqual([line]);
    expect(again.state).toBe("resolved");
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.sent).toEqual([line]);
  });

  it("a message without timeoutMs never times out", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("line", "tab", { msgId: "q1-1" }));
    vi.advanceTimersByTime(BUSY_TIMEOUT_MS * 10);
    await flush();
    expect(a.state).toBe("pending");
    expect(s.inbox.queuedMessages()).toBe(1);
  });

  it("a timer that fires during an in-flight send waits for it: true → resolves", async () => {
    const h = heldSend();
    const s = setup({ send: h.send });
    s.inbox.start("idle", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("line", "tab", { msgId: "q1-1", timeoutMs: 1_000 }));
    const t = s.inbox.tick();
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(a.state).toBe("pending");
    expect(s.inbox.queuedMessages()).toBe(1);
    h.release(true);
    await t;
    await flush();
    expect(a.state).toBe("resolved");
    expect(s.inbox.queuedMessages()).toBe(0);
  });

  it("a timer that fires during an in-flight send waits for it: false → removed and rejected, never re-sent", async () => {
    const h = heldSend();
    const s = setup({ send: h.send });
    s.inbox.start("idle", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("timed", "tab", { msgId: "q1-1", timeoutMs: 1_000 }));
    const b = track(s.inbox.pushConsole("untimed", "tab", { msgId: "q2-1" }));
    const t = s.inbox.tick();
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(a.state).toBe("pending");
    h.release(false);
    await t;
    await flush();
    expect(a.state).toBe("rejected");
    expect(reason(a)).toBe("timeout");
    expect(b.state).toBe("pending"); // a failed send keeps the rest of the batch queued, as today
    expect(s.inbox.queuedMessages()).toBe(1);
    h.answerAtOnce(true);
    await s.inbox.tick();
    await flush();
    expect(h.calls).toEqual(["timed\n\nuntimed", "untimed"]);
    expect(b.state).toBe("resolved");
  });

  it("a send that throws after the timer fired rejects timeout and still throws to the tick's caller", async () => {
    const h = heldSend();
    const s = setup({ send: h.send });
    s.inbox.start("idle", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("line", "tab", { msgId: "q1-1", timeoutMs: 1_000 }));
    const t = s.inbox.tick();
    const tick = t.then(() => "ok", (e: unknown) => e);
    vi.advanceTimersByTime(1_000);
    h.fail(new Error("pty gone"));
    expect(await tick).toEqual(new Error("pty gone"));
    await flush();
    expect(a.state).toBe("rejected");
    expect(reason(a)).toBe("timeout");
    expect(s.inbox.queuedMessages()).toBe(0);
  });

  it("bridge held > 3 min: pushTelegram behind a draft for 4 min stays queued, is delivered when the draft clears, no rejection reaches process", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const s = setup();
      s.inbox.start("idle", { tickMs: 0 });
      s.inbox.onWebInput("fleet-master", "half a thought");
      s.inbox.pushTelegram("from phone");
      const line = track(s.inbox.pushConsole("[queue q1] question: yes", "telegram", { msgId: "q1-1", timeoutMs: BUSY_TIMEOUT_MS }));
      for (let i = 0; i < 8; i++) {
        s.advance(30_000);
        vi.advanceTimersByTime(30_000);
        await s.inbox.tick();
      }
      await flush();
      expect(s.sent).toEqual([]);
      expect(s.queued).toEqual(["draft"]);
      expect(line.state).toBe("rejected"); // the Deliverer line times out ...
      expect(reason(line)).toBe("timeout");
      expect(s.inbox.queuedMessages()).toBe(1); // ... the bridge message never does
      s.inbox.onWebInput("fleet-master", "\r");
      s.advance(QUIET_MS);
      await s.inbox.tick();
      expect(s.sent).toEqual(["from phone"]);
      expect(s.inbox.queuedMessages()).toBe(0);
      await flush();
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a tab and a telegram message never share a batch and keep arrival order", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    void s.inbox.pushConsole("t1", "tab");
    void s.inbox.pushConsole("t2", "tab");
    s.inbox.pushTelegram("g1");
    void s.inbox.pushConsole("g2", "telegram");
    void s.inbox.pushConsole("t3", "tab");
    for (let i = 0; i < 4; i++) {
      s.hook("Stop");
      await s.inbox.tick();
    }
    expect(s.sent).toEqual(["t1\n\nt2", "g1\n\ng2", "t3"]);
  });

  it("surface: telegram right after a telegram push, unchanged after a tab push, the batch's surface after a flush", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    void s.inbox.pushConsole("t1", "tab");
    expect(s.inbox.surface).toBe("tab");
    void s.inbox.pushConsole("g1", "telegram");
    expect(s.inbox.surface).toBe("telegram");
    void s.inbox.pushConsole("t2", "tab");
    expect(s.inbox.surface).toBe("telegram");
    s.inbox.pushTelegram("g2");
    expect(s.inbox.surface).toBe("telegram");
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.sent).toEqual(["t1"]);
    expect(s.inbox.surface).toBe("tab");
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.sent).toEqual(["t1", "g1"]);
    expect(s.inbox.surface).toBe("telegram");
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.inbox.surface).toBe("tab");
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.sent).toEqual(["t1", "g1", "t2", "g2"]);
    expect(s.inbox.surface).toBe("telegram");
  });

  it("a surface-neutral push (null, as a digest) never changes the surface and never shares a batch", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.inbox.surface = "telegram";
    void s.inbox.pushConsole("r1", null, { msgId: "r_aaaaaaa1" });
    expect(s.inbox.surface).toBe("telegram");
    void s.inbox.pushConsole("t1", "tab");
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.sent).toEqual(["r1"]);
    expect(s.inbox.surface).toBe("telegram");
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.sent).toEqual(["r1", "t1"]);
    expect(s.inbox.surface).toBe("tab");
    void s.inbox.pushConsole("r2", null);
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.sent).toEqual(["r1", "t1", "r2"]);
    expect(s.inbox.surface).toBe("tab");
  });

  it("a failed send of a tab batch leaves the surface unchanged", async () => {
    const s = setup({ sendOk: false });
    s.inbox.start("idle", { tickMs: 0 });
    s.inbox.pushTelegram("g1");
    void s.inbox.pushConsole("t1", "tab", { since: 0 });
    await s.inbox.tick();
    expect(s.inbox.surface).toBe("telegram");
    expect(s.inbox.queuedMessages()).toBe(2);
  });

  it("onQueued never fires for pushConsole messages, only for a waiting bridge message", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    void s.inbox.pushConsole("t1", "tab", { msgId: "q1-1" });
    void s.inbox.pushConsole("g1", "telegram", { msgId: "q2-1" });
    await s.inbox.tick();
    s.inbox.onWebInput("fleet-master", "draft");
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.queued).toEqual([]);
    s.inbox.pushTelegram("from phone");
    await s.inbox.tick();
    expect(s.queued).toEqual(["draft"]);
  });

  it("a message re-pushed with an older since is sent before newer ones", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    void s.inbox.pushConsole("newer", "tab", { since: 9_000_000 });
    s.inbox.pushTelegram("phone");
    void s.inbox.pushConsole("older", "tab", { since: 8_000_000 });
    void s.inbox.pushConsole("oldest-phone", "telegram", { since: 1_000 });
    for (let i = 0; i < 3; i++) {
      s.hook("Stop");
      await s.inbox.tick();
    }
    expect(s.sent).toEqual(["oldest-phone", "older\n\nnewer", "phone"]);
  });

  it("a message pushed during an in-flight send stays queued, even when its since is older", async () => {
    const h = heldSend();
    const s = setup({ send: h.send });
    s.inbox.start("idle", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("in flight", "tab", { msgId: "q1-1" }));
    const t = s.inbox.tick();
    const b = track(s.inbox.pushConsole("re-pushed", "tab", { msgId: "q2-1", since: 1 }));
    h.release(true);
    await t;
    await flush();
    expect(a.state).toBe("resolved");
    expect(b.state).toBe("pending");
    expect(s.inbox.queuedMessages()).toBe(1);
    h.answerAtOnce(true);
    s.hook("Stop");
    await s.inbox.tick();
    await flush();
    expect(h.calls).toEqual(["in flight", "re-pushed"]);
    expect(b.state).toBe("resolved");
  });

  it("pushTelegram alone keeps today's sequence: one batch, surface telegram, one notice", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.inbox.pushTelegram("a");
    s.inbox.pushTelegram("b");
    await s.inbox.tick();
    s.hook("Stop");
    s.inbox.pushTelegram("c");
    await s.inbox.tick();
    expect(s.sent).toEqual(["a\n\nb\n\nc"]);
    expect(s.queued).toEqual(["busy"]);
    expect(s.inbox.surface).toBe("telegram");
    expect(s.inbox.queuedMessages()).toBe(0);
  });
});

// Phase 2a ruling 2a-6-a: only the first push of a msgId sets the surface; a
// re-push of the same msgId (a Deliverer retry) keeps the surface it finds.
describe("MasterInbox surface on the first push of a msgId", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); });
  const submitOnTab = (s: ReturnType<typeof setup>) => s.inbox.onWebInput("fleet-master", "typed in tab\r");
  const deliverNow = async (s: ReturnType<typeof setup>) => {
    s.hook("Stop");
    s.advance(QUIET_MS);
    await s.inbox.tick();
    await flush();
  };

  it("a re-push keeps the tab surface, after the push and after its batch is sent", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    const first = track(s.inbox.pushConsole("qa line", "telegram", { msgId: "qa-1", timeoutMs: BUSY_TIMEOUT_MS }));
    expect(s.inbox.surface).toBe("telegram");
    vi.advanceTimersByTime(BUSY_TIMEOUT_MS);
    await flush();
    expect(reason(first)).toBe("timeout");
    submitOnTab(s);
    expect(s.inbox.surface).toBe("tab");
    const again = track(s.inbox.pushConsole("qa line", "telegram", { msgId: "qa-1", timeoutMs: BUSY_TIMEOUT_MS }));
    expect(s.inbox.surface).toBe("tab");
    await deliverNow(s);
    expect(s.sent).toEqual(["qa line"]);
    expect(again.state).toBe("resolved");
    expect(s.inbox.surface).toBe("tab");
  });

  it("a first push of a new msgId with telegram still sets telegram, at push and at send", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    submitOnTab(s);
    expect(s.inbox.surface).toBe("tab");
    const p = track(s.inbox.pushConsole("qb line", "telegram", { msgId: "qb-1" }));
    expect(s.inbox.surface).toBe("telegram");
    submitOnTab(s);
    expect(s.inbox.surface).toBe("tab");
    await deliverNow(s);
    expect(s.sent).toEqual(["qb line"]);
    expect(p.state).toBe("resolved");
    expect(s.inbox.surface).toBe("telegram");
  });

  it("a batch of a re-push and a fresh telegram msgId sets telegram", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    void s.inbox.pushConsole("qa line", "telegram", { msgId: "qa-1", timeoutMs: BUSY_TIMEOUT_MS }).catch(() => {});
    vi.advanceTimersByTime(BUSY_TIMEOUT_MS);
    await flush();
    submitOnTab(s);
    void s.inbox.pushConsole("qa line", "telegram", { msgId: "qa-1", timeoutMs: BUSY_TIMEOUT_MS });
    expect(s.inbox.surface).toBe("tab");
    void s.inbox.pushConsole("qc line", "telegram", { msgId: "qc-1", timeoutMs: BUSY_TIMEOUT_MS });
    expect(s.inbox.surface).toBe("telegram");
    submitOnTab(s);
    expect(s.inbox.surface).toBe("tab");
    await deliverNow(s);
    expect(s.sent).toEqual(["qa line\n\nqc line"]);
    expect(s.inbox.surface).toBe("telegram");
  });

  it("messages without a msgId set the surface on every push, as today", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    void s.inbox.pushConsole("one", "telegram");
    submitOnTab(s);
    void s.inbox.pushConsole("two", "telegram");
    expect(s.inbox.surface).toBe("telegram");
    submitOnTab(s);
    await deliverNow(s);
    expect(s.sent).toEqual(["one\n\ntwo"]);
    expect(s.inbox.surface).toBe("telegram");
  });

  it(`remembers at most ${SEEN_MSG_IDS_MAX} msgIds: the oldest is evicted and then counts as new again`, async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    const gone = () => { vi.advanceTimersByTime(1_000); };
    void s.inbox.pushConsole("old", "telegram", { msgId: "old-1", timeoutMs: 1_000 }).catch(() => {});
    gone();
    for (let i = 1; i < SEEN_MSG_IDS_MAX; i++) void s.inbox.pushConsole(`t${i}`, "tab", { msgId: `t-${i}` });
    // SEEN_MSG_IDS_MAX ids remembered; old-1 is the oldest and still a re-push.
    submitOnTab(s);
    void s.inbox.pushConsole("old", "telegram", { msgId: "old-1", timeoutMs: 1_000 }).catch(() => {});
    expect(s.inbox.surface).toBe("tab");
    gone();
    void s.inbox.pushConsole("newest", "tab", { msgId: `t-${SEEN_MSG_IDS_MAX}` });
    expect(s.inbox.surface).toBe("tab");
    void s.inbox.pushConsole("old", "telegram", { msgId: "old-1" });
    expect(s.inbox.surface).toBe("telegram");
  });
});

// cancel (spec §5.4 step 3 "New MasterInbox.cancel(msgId)", §5.6 undo table, master row).
describe("MasterInbox cancel", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("queued → removed: the promise rejects cancelled, its timer is gone, the next tick sends nothing", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("[queue q1] choice: B", "tab", { msgId: "q1-1", timeoutMs: BUSY_TIMEOUT_MS }));
    expect(s.inbox.cancel("q1-1")).toBe("removed"); // synchronous, right after the push
    await flush();
    expect(a.state).toBe("rejected");
    expect(a.error).toBeInstanceOf(InboxError);
    expect(reason(a)).toBe("cancelled");
    expect(s.inbox.queuedMessages()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    s.hook("Stop");
    await s.inbox.tick();
    expect(s.sent).toEqual([]);
    expect(s.inbox.cancel("q1-1")).toBe("absent");
  });

  it("removes only the named message and keeps the order of the rest", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("a", "tab", { msgId: "q1-1" }));
    const b = track(s.inbox.pushConsole("b", "tab", { msgId: "q2-1" }));
    const c = track(s.inbox.pushConsole("c", "tab", { msgId: "q3-1" }));
    expect(s.inbox.cancel("q2-1")).toBe("removed");
    s.hook("Stop");
    await s.inbox.tick();
    await flush();
    expect(s.sent).toEqual(["a\n\nc"]);
    expect([a.state, b.state, c.state]).toEqual(["resolved", "rejected", "resolved"]);
  });

  it("in flight + send true → in-flight, then the promise resolves", async () => {
    const h = heldSend();
    const s = setup({ send: h.send });
    s.inbox.start("idle", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("line", "tab", { msgId: "q1-1", timeoutMs: BUSY_TIMEOUT_MS }));
    const t = s.inbox.tick();
    expect(s.inbox.cancel("q1-1")).toBe("in-flight");
    await flush();
    expect(a.state).toBe("pending");
    h.release(true);
    await t;
    await flush();
    expect(a.state).toBe("resolved");
    expect(s.inbox.queuedMessages()).toBe(0);
    expect(s.inbox.cancel("q1-1")).toBe("absent");
  });

  it("in flight + send false → rejects cancelled and is never re-sent; an uncancelled batch-mate stays queued", async () => {
    const h = heldSend();
    const s = setup({ send: h.send });
    s.inbox.start("idle", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("answer", "tab", { msgId: "q1-1", timeoutMs: BUSY_TIMEOUT_MS }));
    const b = track(s.inbox.pushConsole("other", "tab", { msgId: "q2-1", timeoutMs: BUSY_TIMEOUT_MS }));
    const t = s.inbox.tick();
    expect(s.inbox.cancel("q1-1")).toBe("in-flight");
    h.release(false);
    await t;
    await flush();
    expect(a.state).toBe("rejected");
    expect(reason(a)).toBe("cancelled");
    expect(b.state).toBe("pending");
    expect(s.inbox.queuedMessages()).toBe(1);
    expect(s.inbox.cancel("q1-1")).toBe("absent");
    h.answerAtOnce(true);
    await s.inbox.tick();
    await flush();
    expect(h.calls).toEqual(["answer\n\nother", "other"]);
    expect(b.state).toBe("resolved");
  });

  it("in flight, timer fired and cancelled, send false → rejects cancelled, not timeout", async () => {
    const h = heldSend();
    const s = setup({ send: h.send });
    s.inbox.start("idle", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("line", "tab", { msgId: "q1-1", timeoutMs: 1_000 }));
    const t = s.inbox.tick();
    vi.advanceTimersByTime(1_000);
    expect(s.inbox.cancel("q1-1")).toBe("in-flight");
    h.release(false);
    await t;
    await flush();
    expect(a.state).toBe("rejected");
    expect(reason(a)).toBe("cancelled");
    expect(s.inbox.queuedMessages()).toBe(0);
  });

  it("in flight + send throws → rejects cancelled, and the error still reaches the tick's caller", async () => {
    const h = heldSend();
    const s = setup({ send: h.send });
    s.inbox.start("idle", { tickMs: 0 });
    const a = track(s.inbox.pushConsole("line", "tab", { msgId: "q1-1" }));
    const tick = s.inbox.tick().then(() => "ok", (e: unknown) => e);
    expect(s.inbox.cancel("q1-1")).toBe("in-flight");
    h.fail(new Error("pty gone"));
    expect(await tick).toEqual(new Error("pty gone"));
    await flush();
    expect(a.state).toBe("rejected");
    expect(reason(a)).toBe("cancelled");
    expect(s.inbox.queuedMessages()).toBe(0);
  });

  it("an unknown msgId → absent, and a bridge message can never be cancelled", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.inbox.pushTelegram("from phone");
    void s.inbox.pushConsole("line", "tab", { msgId: "q1-1" });
    expect(s.inbox.cancel("q9-1")).toBe("absent");
    expect(s.inbox.cancel("")).toBe("absent");
    expect(s.inbox.queuedMessages()).toBe(2);
  });

  it("final fix wave: an empty or missing msgId → absent, never a bridge message or an empty-id push", async () => {
    const s = setup();
    s.inbox.start("busy", { tickMs: 0 });
    s.inbox.pushTelegram("from phone"); // no msgId
    void s.inbox.pushConsole("odd", "tab", { msgId: "" }).catch(() => {});
    expect(s.inbox.cancel(undefined as unknown as string)).toBe("absent");
    expect(s.inbox.cancel("")).toBe("absent");
    expect(s.inbox.queuedMessages()).toBe(2);
  });
});

describe("MasterInbox agentId", () => {
  it("follows its own agent's hooks and ignores the master's", () => {
    const s = setup({ agentId: "lead-app-shop" });
    s.inbox.start("busy", { tickMs: 0 });
    s.hook("Stop"); // fleet-master
    expect(s.inbox.turn()).toBe("busy");
    s.hub.emitEvent({ type: "agent-hook", agentId: "lead-app-shop", event: "Stop" });
    expect(s.inbox.turn()).toBe("idle");
  });
  it("feeds the tracker from its own agent's web input only", () => {
    const s = setup({ agentId: "lead-app-shop" });
    s.inbox.onWebInput("fleet-master", "typing");
    expect(s.tracker.hasDraft()).toBe(false);
    s.inbox.onWebInput("lead-app-shop", "typing");
    expect(s.tracker.hasDraft()).toBe(true);
  });
  it("logs a failed tick with its own id; the master's keeps [master]", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fail = async (): Promise<boolean> => { throw new Error("boom"); };
    const lead = setup({ agentId: "lead-app-shop", digest: "[events] x", send: fail });
    const master = setup({ digest: "[events] x", send: fail });
    lead.inbox.start("idle", { tickMs: 5 });
    master.inbox.start("idle", { tickMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    lead.inbox.stop();
    master.inbox.stop();
    const tags = new Set(error.mock.calls.map((c) => String(c[0])));
    error.mockRestore();
    expect([...tags].sort()).toEqual(["[lead-app-shop] inbox tick failed:", "[master] inbox tick failed:"]);
  });
});

// The fleet master WAITS for the second sign-in (chief/chiefwait.ts): it has a record, but no
// session. What the inbox did before this change, and what it does now.
describe("MasterInbox while its agent waits for the second sign-in", () => {
  it("before (no waits): the 3 min starting hold ends in a send to a session that does not exist, which fails, and the text stays, with no word to anybody", async () => {
    const tries: string[] = [];
    const s = setup({ send: async (t) => { tries.push(t); return false; } });
    s.inbox.markStarting();
    s.inbox.pushTelegram("hello");
    await s.inbox.tick();
    expect(tries).toEqual([]);
    s.advance(BUSY_TIMEOUT_MS + 1);
    await s.inbox.tick();
    expect(tries).toEqual(["hello"]);
    expect(s.inbox.queuedMessages()).toBe(1);
    // The only notice ("busy") went out while it was held; nothing says that the send fails.
    expect(s.queued).toEqual(["busy"]);
  });

  it("now: while it waits, no send at all (also after the hold), every message is kept, nothing times out; after the start, they go", async () => {
    let waits = true;
    const s = setup({ waits: () => waits });
    s.inbox.start("idle", { tickMs: 3_600_000 });
    s.inbox.markStarting();
    s.inbox.pushTelegram("hello");
    const page = s.inbox.pushConsole("from the page", "tab");
    for (const step of [0, BUSY_TIMEOUT_MS + 1, 60 * 60_000]) { s.advance(step); await s.inbox.tick(); }
    expect(s.sent).toEqual([]);
    expect(s.inbox.queuedMessages()).toBe(2);
    // The bridge tells the person (WAITS_TEXT); the inbox itself posts no "busy" notice meanwhile.
    expect(s.queued).toEqual([]);
    // The start after the sign-in: the session says hello, the kept messages go in one turn.
    waits = false;
    s.hook("SessionStart", "startup");
    s.advance(QUIET_MS + 1);
    await s.inbox.tick();
    expect(s.sent).toEqual(["hello"]);
    // One surface per turn: the page's line goes in the next one.
    s.hook("UserPromptSubmit");
    s.hook("Stop");
    s.advance(QUIET_MS + 1);
    await s.inbox.tick();
    expect(s.sent).toEqual(["hello", "from the page"]);
    await expect(page).resolves.toBeUndefined();
    s.inbox.stop();
  });
});
