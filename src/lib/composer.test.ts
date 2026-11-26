import { describe, it, expect } from "vitest";
import { Composer, QUEUE_PREFIX, DRAFT_PREFIX, RETRY_STARTING_MS, RETRY_NOT_LIVE_MS, BACKOFF_MIN_MS, type ComposerEnv } from "./composer";

class MemStorage {
  m = new Map<string, string>();
  throwOn: "none" | "all" = "none";
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { if (this.throwOn === "all") throw new Error("blocked"); return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.throwOn === "all") throw new Error("quota"); this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

type Reply = { status: number; body: unknown } | { error: string };

function harness(replies: Reply[] = []) {
  const storage = new MemStorage();
  const posts: { agentId: string; msgId: string; text: string }[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let t = 1_000;
  let n = 0;
  let tid = 0;
  const queue = [...replies];
  const env: ComposerEnv = {
    storage: () => storage,
    post: async (agentId, msgId, text) => {
      posts.push({ agentId, msgId, text });
      return queue.shift() ?? { status: 200, body: { delivered: true } };
    },
    now: () => t,
    newId: () => `m${String(++n).padStart(8, "0")}`,
    setTimer: (fn, ms) => { const id = ++tid; timers.push({ fn, ms, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  const c = new Composer(env);
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const fire = async () => { const tm = timers.shift(); tm?.fn(); await flush(); return tm?.ms; };
  return { c, storage, posts, timers, queue, flush, fire, tick: (ms: number) => { t += ms; } };
}

describe("Composer queue", () => {
  it("sends added messages in order and empties the queue", async () => {
    const h = harness();
    h.c.add("a1", "first");
    h.c.add("a1", "second\nline");
    await h.flush();
    expect(h.posts.map((p) => p.text)).toEqual(["first", "second\nline"]);
    expect(h.c.items("a1")).toEqual([]);
    expect([...h.storage.m.keys()].filter((k) => k.startsWith(QUEUE_PREFIX))).toEqual([]);
  });

  it("keeps one storage key per message and orders by time then seq", async () => {
    const notLive = { status: 409, body: { reason: "not-live" } };
    const h = harness([notLive, notLive, notLive]);
    h.c.add("a1", "one");
    await h.flush();
    h.c.add("a1", "two");
    h.c.add("a1", "three");
    await h.flush();
    expect([...h.storage.m.keys()]).toHaveLength(3);
    expect(h.c.items("a1").map((i) => i.text)).toEqual(["one", "two", "three"]);
    expect(h.c.items("a1")[0]).toMatchObject({ state: "waiting", note: "agent not live — Resume to send" });
  });

  it("a question of Claude on the agent's screen: the line waits and says so", async () => {
    const h = harness([{ status: 409, body: { reason: "starting", dialog: true } }]);
    h.c.add("a1", "hi");
    await h.flush();
    expect(h.c.items("a1")[0]).toMatchObject({ state: "waiting", note: "the agent asks a question — answer it first", why: "dialog" });
    expect(h.timers[0].ms).toBe(RETRY_STARTING_MS);
  });

  it("waits while the agent starts, then delivers the same msgId", async () => {
    const h = harness([{ status: 409, body: { reason: "starting" } }]);
    h.c.add("a1", "hi");
    await h.flush();
    expect(h.c.items("a1")[0]).toMatchObject({ state: "waiting", note: "waiting for agent to start" });
    expect(h.timers[0].ms).toBe(RETRY_STARTING_MS);
    await h.fire();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[0].msgId).toBe(h.posts[1].msgId);
    expect(h.c.items("a1")).toEqual([]);
  });

  it("retries not-live after its delay and network errors with backoff", async () => {
    const h = harness([{ status: 409, body: { reason: "not-live" } }, { error: "offline" }, { error: "offline" }, { status: 503, body: null }]);
    h.c.add("a1", "hi");
    await h.flush();
    expect(h.timers[0].ms).toBe(RETRY_NOT_LIVE_MS);
    await h.fire();
    expect(h.timers[0].ms).toBe(BACKOFF_MIN_MS);
    await h.fire();
    expect(h.timers[0].ms).toBe(BACKOFF_MIN_MS * 2);
    await h.fire();
    expect(h.timers[0].ms).toBe(BACKOFF_MIN_MS * 4);
    await h.fire();
    expect(h.posts).toHaveLength(5);
    expect(h.c.items("a1")).toEqual([]);
  });

  it("a 4xx marks the head failed and holds the queue behind it", async () => {
    const h = harness([{ status: 400, body: { error: "empty text" } }]);
    h.c.add("a1", "bad");
    await h.flush();
    h.c.add("a1", "next");
    await h.flush();
    expect(h.posts).toHaveLength(1);
    expect(h.c.items("a1").map((i) => [i.text, i.state])).toEqual([["bad", "failed"], ["next", "pending"]]);
    expect(h.c.items("a1")[0].note).toBe("failed: empty text");
    expect(h.timers).toEqual([]);
    h.c.retry("a1", h.c.items("a1")[0].id);
    await h.flush();
    expect(h.posts.map((p) => p.text)).toEqual(["bad", "bad", "next"]);
  });

  it("remove drops a failed head and the queue goes on", async () => {
    const h = harness([{ status: 413, body: null }]);
    h.c.add("a1", "huge");
    await h.flush();
    h.c.add("a1", "small");
    h.c.remove("a1", h.c.items("a1")[0].id);
    await h.flush();
    expect(h.posts.map((p) => p.text)).toEqual(["huge", "small"]);
    expect(h.c.items("a1")).toEqual([]);
  });

  it("only an agent-gone 404 forgets the agent; another 404 fails", async () => {
    const h = harness([{ status: 404, body: { error: "Not Found" } }]);
    h.c.add("a1", "x");
    await h.flush();
    expect(h.c.items("a1")[0].state).toBe("failed");

    const g = harness([{ status: 404, body: { reason: "agent-gone" } }]);
    g.c.setDraft("a1", "draft");
    g.c.add("a1", "x");
    g.c.add("a1", "y");
    await g.flush();
    expect(g.c.items("a1")).toEqual([]);
    expect(g.c.draft("a1")).toBe("");
    expect(g.storage.m.size).toBe(0);
  });

  it("kick cancels the wait and tries now", async () => {
    const h = harness([{ status: 409, body: { reason: "not-live" } }]);
    h.c.add("a1", "hi");
    await h.flush();
    expect(h.timers).toHaveLength(1);
    h.c.kick("a1");
    await h.flush();
    expect(h.timers).toHaveLength(0);
    expect(h.posts).toHaveLength(2);
    expect(h.c.items("a1")).toEqual([]);
  });

  it("scan starts flushers for messages left by a previous page", async () => {
    const h = harness();
    h.storage.setItem(`${QUEUE_PREFIX}a1.old-msg-1`, JSON.stringify({ text: "left", at: 5, seq: 1 }));
    h.storage.setItem(`${QUEUE_PREFIX}b2.old-msg-2`, JSON.stringify({ text: "other", at: 6, seq: 1 }));
    h.c.scan();
    await h.flush();
    expect(h.posts.map((p) => [p.agentId, p.msgId, p.text])).toEqual([["a1", "old-msg-1", "left"], ["b2", "old-msg-2", "other"]]);
  });

  it("sees items another tab added before its next attempt", async () => {
    const h = harness([{ status: 409, body: { reason: "starting" } }]);
    h.c.add("a1", "mine");
    await h.flush();
    h.storage.setItem(`${QUEUE_PREFIX}a1.zz-other-tab`, JSON.stringify({ text: "theirs", at: 99_999, seq: 1 }));
    h.c.onStorage(`${QUEUE_PREFIX}a1.zz-other-tab`);
    await h.flush();
    expect(h.posts.map((p) => p.text)).toEqual(["mine", "mine", "theirs"]);
  });

  it("drafts round-trip, and storage errors never throw", () => {
    const h = harness();
    h.c.setDraft("a1", "half typed");
    expect(h.storage.getItem(`${DRAFT_PREFIX}a1`)).toBe("half typed");
    expect(h.c.draft("a1")).toBe("half typed");
    h.c.setDraft("a1", "");
    expect(h.storage.getItem(`${DRAFT_PREFIX}a1`)).toBeNull();
    h.storage.throwOn = "all";
    expect(() => h.c.setDraft("a1", "x")).not.toThrow();
    expect(h.c.draft("a1")).toBe("");
    expect(h.c.add("a1", "x")).toBe(false); // caller keeps the text
    expect(h.c.items("a1")).toEqual([]);
  });

  it("ignores whitespace-only messages", () => {
    const h = harness();
    expect(h.c.add("a1", "  \n ")).toBe(false);
    expect(h.storage.m.size).toBe(0);
  });
});

describe("Composer hint", () => {
  it("shows the 200 hint for 6 s, then clears; a new send replaces it", async () => {
    const h = harness([{ status: 200, body: { delivered: true, hint: "Already a rule (r_1)." } }]);
    h.c.add("a1", "rule: x");
    await h.flush();
    expect(h.c.hint("a1")).toBe("Already a rule (r_1).");
    expect(h.timers.at(-1)?.ms).toBe(6_000);
    await h.fire();
    expect(h.c.hint("a1")).toBeNull();
    const h2 = harness([{ status: 200, body: { delivered: true, hint: "h" } }]);
    h2.c.add("a1", "one");
    await h2.flush();
    h2.c.add("a1", "two");
    expect(h2.c.hint("a1")).toBeNull();
  });
});

// What the thread view shows until the agent's session file has the message.
describe("Composer sent", () => {
  it("keeps a message it sent until the thread says the file has it", async () => {
    const h = harness();
    h.c.add("a1", "fix the header");
    await h.flush();
    expect(h.c.items("a1")).toEqual([]);
    expect(h.c.sent("a1")).toEqual([{ id: "m00000001", text: "fix the header", at: 1_000, sentAt: 1_000 }]);
    let calls = 0;
    h.c.subscribe("a1", () => { calls++; });
    h.c.settle("a1", "m00000001", "u9");
    expect(h.c.sent("a1")).toEqual([]);
    expect(h.c.claimed("a1")).toEqual(["u9"]);
    expect(calls).toBe(1);
    // A second settle of the same message changes nothing.
    h.c.settle("a1", "m00000001", "u9");
    expect(calls).toBe(1);
    expect(h.c.claimed("a1")).toEqual(["u9"]);
  });

  it("keeps the server's word that the agent was busy", async () => {
    const h = harness([{ status: 200, body: { delivered: true, busy: true } }]);
    h.c.add("a1", "also the docs");
    h.c.add("a1", "and the tests");
    await h.flush();
    expect(h.c.sent("a1").map((x) => `${x.text}:${x.busy ?? false}`)).toEqual(["also the docs:true", "and the tests:false"]);
  });

  it("does not hold a message that was not sent", async () => {
    const h = harness([{ status: 400, body: { error: "text over 32000 chars" } }]);
    h.c.add("a1", "too long");
    await h.flush();
    expect(h.c.sent("a1")).toEqual([]);
    expect(h.c.items("a1")).toMatchObject([{ text: "too long", state: "failed", why: "error", note: "failed: text over 32000 chars" }]);
    // Retry sends the same message again; the text was never lost.
    h.c.retry("a1", h.c.items("a1")[0].id);
    await h.flush();
    expect(h.posts.map((p) => p.text)).toEqual(["too long", "too long"]);
    expect(h.c.sent("a1").map((x) => x.text)).toEqual(["too long"]);
  });

  it("keeps the reason on screen while it tries again", async () => {
    const h = harness([{ error: "network" }]);
    const seen: string[] = [];
    h.c.subscribe("a1", () => { seen.push(h.c.items("a1")[0]?.state ?? "gone"); });
    h.c.add("a1", "hello");
    await h.flush();
    expect(h.c.items("a1")).toMatchObject([{ state: "waiting", why: "offline" }]);
    seen.length = 0;
    await h.fire();
    // The second try does not go through "sending": no flicker of the state line.
    expect(seen).not.toContain("sending");
    expect(h.c.sent("a1").map((x) => x.text)).toEqual(["hello"]);
  });

  it("forgets the sent messages of an agent that is gone", async () => {
    const h = harness();
    h.c.add("a1", "one");
    await h.flush();
    h.c.settle("a1", "m00000001", "u1");
    h.c.add("a1", "two");
    await h.flush();
    h.c.forget("a1");
    expect(h.c.sent("a1")).toEqual([]);
    expect(h.c.claimed("a1")).toEqual([]);
  });
});
