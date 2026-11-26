import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TermSocket, WS_CLOSE_FINAL, openTermWs } from "./termSocket";
import { USER_TOKEN_KEY } from "./chief";

class FakeWs {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  url = "";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

class Target {
  hidden = false;
  private fns = new Map<string, Set<() => void>>();
  addEventListener(t: string, fn: () => void) { (this.fns.get(t) ?? this.fns.set(t, new Set()).get(t)!).add(fn); }
  removeEventListener(t: string, fn: () => void) { this.fns.get(t)?.delete(fn); }
  fire(t: string) { this.fns.get(t)?.forEach((f) => f()); }
}

let sockets: FakeWs[];
let doc: Target, win: Target, clock: number;
const last = () => sockets[sockets.length - 1];

function make(extra: Partial<ConstructorParameters<typeof TermSocket>[0]> = {}) {
  const events: string[] = [];
  const ts = new TermSocket({
    url: "ws://x/t",
    create: (url) => { const s = new FakeWs(); s.url = url; sockets.push(s); return s; },
    doc, win, now: () => clock,
    onData: (d) => events.push(`data:${d}`),
    onOpen: (r) => events.push(`open:${r}`),
    onLost: () => events.push("lost"),
    onReplay: () => events.push("replay"),
    ...extra,
  });
  return { ts, events };
}

const sync = (offset: number, resumed: boolean, epoch = "e1") =>
  new TextEncoder().encode(JSON.stringify({ t: "sync", epoch, offset, resumed })).buffer;

beforeEach(() => { vi.useFakeTimers(); sockets = []; doc = new Target(); win = new Target(); clock = 0; });
afterEach(() => { vi.useRealTimers(); });

describe("TermSocket", () => {
  it("reconnects after an unexpected close and flags the reopen", () => {
    const { events } = make();
    last().open();
    last().drop();
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    last().open();
    expect(events).toEqual(["open:false", "lost", "open:true"]);
  });

  it("backs off up to 10 s and resets the backoff after a good open", () => {
    make();
    last().open();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const n = sockets.length;
      last().drop();
      let waited = 0;
      while (sockets.length === n) { vi.advanceTimersByTime(100); waited += 100; }
      delays.push(waited);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
    last().open();
    last().drop();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(9);
  });

  it("announces a lost connection once per outage", () => {
    const { events } = make();
    last().open();
    last().drop(); vi.advanceTimersByTime(500);
    last().drop(); vi.advanceTimersByTime(1000);
    expect(events.filter((e) => e === "lost")).toHaveLength(1);
  });

  it("does not retry a final close, but tries again on return to the tab", () => {
    const { events } = make();
    last().open();
    last().drop(WS_CLOSE_FINAL);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(events).not.toContain("lost");
    doc.hidden = true; doc.fire("visibilitychange");
    doc.hidden = false; doc.fire("visibilitychange");
    expect(sockets).toHaveLength(2);
  });

  it("waits while hidden and reconnects at once on return", () => {
    make();
    last().open();
    doc.hidden = true; doc.fire("visibilitychange");
    last().drop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    doc.hidden = false; doc.fire("visibilitychange");
    expect(sockets).toHaveLength(2);
  });

  it("replaces a socket that looks open after a long hidden spell", () => {
    make();
    const first = (last().open(), last());
    doc.hidden = true; doc.fire("visibilitychange");
    clock += 31_000;
    doc.hidden = false; doc.fire("visibilitychange");
    expect(sockets).toHaveLength(2);
    expect(first.closed).toBe(true);
    // The replaced socket's late close must not schedule another connect.
    first.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(20_000);
    expect(sockets).toHaveLength(2);
  });

  it("keeps an open socket after a short hidden spell", () => {
    make();
    last().open();
    doc.hidden = true; doc.fire("visibilitychange");
    clock += 5_000;
    doc.hidden = false; doc.fire("visibilitychange");
    expect(sockets).toHaveLength(1);
  });

  it("reconnects at once when the network comes back", () => {
    make();
    last().open();
    last().drop();
    win.fire("online");
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
  });

  it("sends only while open and stops everything on dispose", () => {
    const { ts } = make();
    ts.send({ t: "input", data: "a" });
    last().open();
    ts.send({ t: "input", data: "b" });
    expect(last().sent).toEqual([JSON.stringify({ t: "input", data: "b" })]);
    ts.dispose();
    expect(last().closed).toBe(true);
    win.fire("online");
    vi.advanceTimersByTime(20_000);
    expect(sockets).toHaveLength(1);
  });

  it("asks for arraybuffer frames, so sync frames can be decoded", () => {
    make();
    expect((last() as unknown as { binaryType: string }).binaryType).toBe("arraybuffer");
  });

  it("does not treat a sync frame as output", () => {
    const { events } = make();
    last().open();
    last().onmessage?.({ data: sync(0, false) });
    last().onmessage?.({ data: "hello" });
    expect(events).toEqual(["open:false", "data:hello"]);
  });

  it("reconnects from the last offset and does not reset when the server resumes", () => {
    const { events } = make();
    expect(last().url).toBe("ws://x/t");
    last().open();
    last().onmessage?.({ data: sync(100, false) });
    last().onmessage?.({ data: "hello" });
    last().onmessage?.({ data: "wörld" });
    last().drop();
    vi.advanceTimersByTime(500);
    expect(last().url).toBe("ws://x/t?epoch=e1&since=110");
    last().open();
    last().onmessage?.({ data: sync(110, true) });
    last().onmessage?.({ data: "more" });
    expect(events).toEqual(["open:false", "data:hello", "data:wörld", "lost", "open:true", "data:more"]);
    last().drop();
    vi.advanceTimersByTime(500);
    expect(last().url).toBe("ws://x/t?epoch=e1&since=114");
  });

  it("resets before a full replay when the server cannot resume", () => {
    const { events } = make();
    last().open();
    last().onmessage?.({ data: sync(0, false) });
    last().onmessage?.({ data: "old" });
    last().drop();
    vi.advanceTimersByTime(500);
    last().open();
    last().onmessage?.({ data: sync(0, false, "e2") });
    last().onmessage?.({ data: "history" });
    expect(events).toEqual(["open:false", "data:old", "lost", "open:true", "replay", "data:history"]);
    last().drop();
    vi.advanceTimersByTime(500);
    expect(last().url).toBe("ws://x/t?epoch=e2&since=7");
  });

  it("resets on a reconnect to a route that sends no sync frame", () => {
    const { events } = make();
    last().open();
    last().onmessage?.({ data: "first" });
    last().drop();
    vi.advanceTimersByTime(500);
    expect(last().url).toBe("ws://x/t");
    last().open();
    last().onmessage?.({ data: "history" });
    expect(events).toEqual(["open:false", "data:first", "lost", "open:true", "replay", "data:history"]);
  });

  it("forgets the offset when a reopened socket says there is no terminal", () => {
    const { events } = make();
    last().open();
    last().onmessage?.({ data: sync(0, false) });
    last().drop();
    vi.advanceTimersByTime(500);
    last().open();
    last().onmessage?.({ data: "[no live terminal]" });
    last().drop(WS_CLOSE_FINAL);
    expect(events).toContain("replay");
  });

  it("heal connects at once after a final close and leaves a live socket alone", () => {
    const { ts } = make();
    last().open();
    ts.heal();
    expect(sockets).toHaveLength(1);
    last().drop(WS_CLOSE_FINAL);
    ts.heal();
    expect(sockets).toHaveLength(2);
    ts.heal(); // still connecting
    expect(sockets).toHaveLength(2);
  });

  it("adds the jitter to the retry delay", () => {
    make({ retryJitter: () => 1000 });
    last().open();
    last().drop();
    vi.advanceTimersByTime(1400);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
  });
});

// Spec §3: a browser WebSocket cannot carry a header, so the stored user token
// goes as the one offered subprotocol; none stored → exactly `new WebSocket(url)`.
describe("openTermWs", () => {
  const TOKEN = "Ab-_" + "x".repeat(39);
  let made: Ctor[];
  class Ctor {
    readyState = 0;
    args: unknown[];
    constructor(...args: unknown[]) { this.args = args; made.push(this); }
    close() {}
  }
  const storage = (v: string | null) => ({ getItem: (k: string) => (k === USER_TOKEN_KEY ? v : null) });
  beforeEach(() => { made = []; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("offers [token] only when a token is stored", () => {
    openTermWs("ws://x/t", { WebSocket: Ctor as never, storage: storage(TOKEN) });
    openTermWs("ws://x/t", { WebSocket: Ctor as never, storage: storage(null) });
    openTermWs("ws://x/t", { WebSocket: Ctor as never, storage: null });
    expect(made.map((m) => m.args)).toEqual([["ws://x/t", [TOKEN]], ["ws://x/t"], ["ws://x/t"]]);
  });

  // new WebSocket throws on a protocol with a separator or a space: a broken
  // stored value must not break the terminal.
  it.each(["a b", "a,b", "a/b", "é", "a\nb"])("a stored value a subprotocol cannot carry (%j) → no protocols", (v) => {
    openTermWs("ws://x/t", { WebSocket: Ctor as never, storage: storage(v) });
    expect(made.map((m) => m.args)).toEqual([["ws://x/t"]]);
  });

  it("a storage that throws → no protocols", () => {
    openTermWs("ws://x/t", { WebSocket: Ctor as never, storage: { getItem: () => { throw new Error("denied"); } } });
    expect(made.map((m) => m.args)).toEqual([["ws://x/t"]]);
  });

  // The agent, shell and service terminals all open through TermSocket's
  // default create. The token is read at each connect: a device paired since
  // the first socket is used by the next one.
  it("TermSocket's default socket carries the token stored at connect time", () => {
    let stored: string | null = null;
    vi.stubGlobal("WebSocket", Ctor);
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === USER_TOKEN_KEY ? stored : null) });
    const ts = new TermSocket({ url: "ws://x/t", doc, win, onData: () => {}, onOpen: () => {} });
    stored = TOKEN;
    ts.heal(); // the first socket is still connecting: no new one
    made[0].readyState = 3;
    ts.heal();
    expect(made.map((m) => m.args)).toEqual([["ws://x/t"], ["ws://x/t", [TOKEN]]]);
    ts.dispose();
  });
});
