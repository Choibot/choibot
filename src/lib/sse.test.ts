import { describe, expect, it } from "vitest";
import { RETRY_MS, SILENCE_MS, SseParser, openEventStream } from "./sse";

const enc = new TextEncoder();

describe("SseParser", () => {
  it("joins an event split across two chunks", () => {
    const p = new SseParser();
    expect(p.feed(enc.encode('data: {"a":'))).toEqual([]);
    expect(p.feed(enc.encode('1}\n\n'))).toEqual(['{"a":1}']);
  });

  it("joins the lines of a multi-line data field with LF", () => {
    expect(new SseParser().feed("data: one\ndata: two\ndata:three\n\n")).toEqual(["one\ntwo\nthree"]);
  });

  it("takes CRLF and CR as line ends, a CRLF split across chunks too", () => {
    expect(new SseParser().feed("data: a\r\n\r\ndata: b\r\rdata: c\n\n")).toEqual(["a", "b", "c"]);
    const p = new SseParser();
    expect(p.feed("data: x\r")).toEqual([]);
    // The LF after the CR is the same line end; the CR after it is the blank line.
    expect(p.feed("\n\r")).toEqual(["x"]);
    expect(p.feed("\ndata: y\n\n")).toEqual(["y"]);
  });

  it("ignores comment lines (the ping), other fields and a block with no data", () => {
    expect(new SseParser().feed(": ping\n\nid: 7\nevent: x\nretry: 10\ndata: d\n\n: ping\n\n")).toEqual(["d"]);
  });

  it("gives two events of one chunk in order", () => {
    expect(new SseParser().feed("data: 1\n\ndata: 2\n\n")).toEqual(["1", "2"]);
  });

  it("joins a UTF-8 character split across chunks", () => {
    const bytes = enc.encode("data: é✓😀\n\n");
    const p = new SseParser();
    const got: string[] = [];
    for (let i = 0; i < bytes.length; i++) got.push(...p.feed(bytes.subarray(i, i + 1)));
    expect(got).toEqual(["é✓😀"]);
  });

  it("keeps a value's own leading spaces after the first one, and takes a field with no colon", () => {
    expect(new SseParser().feed("data:  two spaces\n\ndata\n\n")).toEqual([" two spaces", ""]);
  });
});

// A fake clock and a fake fetch that the test feeds by hand.
function rig() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  const streams: { push: (s: string) => void; end: () => void; fail: () => void; signal: AbortSignal }[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  let answer: "stream" | "error" | "html" | number = "stream";
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (answer === "error") throw new TypeError("network");
    if (typeof answer === "number") return new Response("{}", { status: answer });
    if (answer === "html") return new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    const signal = init!.signal!;
    signal.addEventListener("abort", () => { try { ctl.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } });
    streams.push({ push: (s) => ctl.enqueue(enc.encode(s)), end: () => ctl.close(), fail: () => ctl.error(new TypeError("reset")), signal });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const deps = {
    fetch: fetch as never,
    setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (id: unknown) => { const i = timers.findIndex((t) => t.id === id); if (i !== -1) timers.splice(i, 1); },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await flush();
    }
    await flush();
  };
  return { deps, streams, calls, flush, advance, set answer(a: typeof answer) { answer = a; }, timers };
}

describe("openEventStream", () => {
  it("opens, gives each event, and asks for an event stream with no cache", async () => {
    const r = rig();
    const got: string[] = [];
    let opens = 0;
    openEventStream("/api/events", { event: (d) => got.push(d), open: () => opens++ }, r.deps);
    await r.flush();
    expect(r.calls[0].url).toBe("/api/events");
    expect(new Headers(r.calls[0].init?.headers).get("accept")).toBe("text/event-stream");
    expect(r.calls[0].init?.cache).toBe("no-store");
    r.streams[0].push("data: 1\n\n: ping\n\ndata: 2\n\n");
    await r.flush();
    expect([opens, got]).toEqual([1, ["1", "2"]]);
  });

  it("opens again 3 s after the stream ends or fails, and after a network error, with onOpen each time", async () => {
    const r = rig();
    let opens = 0;
    openEventStream("/api/events", { event: () => {}, open: () => opens++ }, r.deps);
    await r.flush();
    r.streams[0].end();
    await r.flush();
    await r.advance(RETRY_MS - 1);
    expect(r.calls.length).toBe(1);
    await r.advance(1);
    expect([r.calls.length, opens]).toEqual([2, 2]);
    r.streams[1].fail();
    await r.flush();
    r.answer = "error";
    await r.advance(RETRY_MS);
    expect([r.calls.length, opens]).toEqual([3, 2]);
    r.answer = "stream";
    await r.advance(RETRY_MS);
    expect([r.calls.length, opens]).toEqual([4, 3]);
  });

  it("closes and opens again a stream that is silent for 60 s; a ping keeps it", async () => {
    const r = rig();
    openEventStream("/api/events", { event: () => {} }, r.deps);
    await r.flush();
    await r.advance(SILENCE_MS - 1000);
    r.streams[0].push(": ping\n\n");
    await r.flush();
    await r.advance(SILENCE_MS - 1000);
    expect(r.streams[0].signal.aborted).toBe(false);
    await r.advance(1000);
    expect(r.streams[0].signal.aborted).toBe(true);
    await r.advance(RETRY_MS);
    expect(r.calls.length).toBe(2);
  });

  it("stops on an answer that is not 2xx, as EventSource does", async () => {
    const r = rig();
    let opens = 0;
    r.answer = 401;
    openEventStream("/api/events", { event: () => {}, open: () => opens++ }, r.deps);
    await r.flush();
    await r.advance(RETRY_MS * 10);
    expect([r.calls.length, opens, r.timers.length]).toEqual([1, 0, 0]);
  });

  it("stops on a 200 that is not an event stream (a sign-in page), as EventSource does", async () => {
    const r = rig();
    let opens = 0;
    r.answer = "html";
    openEventStream("/api/events", { event: () => {}, open: () => opens++ }, r.deps);
    await r.flush();
    await r.advance(RETRY_MS * 10);
    expect([r.calls.length, opens, r.timers.length]).toEqual([1, 0, 0]);
  });

  it("tries again 3 s after a 5xx (a proxy in front while the console restarts)", async () => {
    const r = rig();
    let opens = 0;
    r.answer = 502;
    openEventStream("/api/events", { event: () => {}, open: () => opens++ }, r.deps);
    await r.flush();
    await r.advance(RETRY_MS - 1);
    expect(r.calls.length).toBe(1);
    await r.advance(1);
    expect(r.calls.length).toBe(2);
    r.answer = "stream";
    await r.advance(RETRY_MS);
    expect([r.calls.length, opens]).toEqual([3, 1]);
  });

  it("goes on after a handler that throws, with the next events of the same chunk and no new connection", async () => {
    const r = rig();
    const got: string[] = [];
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (e: unknown) => { errors.push(e); };
    try {
      openEventStream("/api/events", { open: () => { throw new Error("open"); }, event: (d) => { if (d === "bad") throw new Error("event"); got.push(d); } }, r.deps);
      await r.flush();
      r.streams[0].push("data: 1\n\ndata: bad\n\ndata: 2\n\n");
      await r.flush();
      r.streams[0].push("data: 3\n\n");
      await r.flush();
    } finally {
      console.error = log;
    }
    expect(got).toEqual(["1", "2", "3"]);
    expect(errors.length).toBe(2);
    expect([r.calls.length, r.streams[0].signal.aborted]).toEqual([1, false]);
  });

  it("lets the connection go when a stream ends or fails", async () => {
    const r = rig();
    openEventStream("/api/events", { event: () => {} }, r.deps);
    await r.flush();
    r.streams[0].end();
    await r.flush();
    expect(r.streams[0].signal.aborted).toBe(true);
    await r.advance(RETRY_MS);
    r.streams[1].fail();
    await r.flush();
    expect(r.streams[1].signal.aborted).toBe(true);
  });

  it("close() aborts the stream, gives no more events and opens nothing again", async () => {
    const r = rig();
    const got: string[] = [];
    const s = openEventStream("/api/events", { event: (d) => got.push(d) }, r.deps);
    await r.flush();
    s.close();
    await r.flush();
    expect(r.streams[0].signal.aborted).toBe(true);
    await r.advance(RETRY_MS * 10 + SILENCE_MS);
    expect([r.calls.length, got, r.timers.length]).toEqual([1, [], 0]);
  });

  it("a close while the retry waits ends the retry", async () => {
    const r = rig();
    const s = openEventStream("/api/events", { event: () => {} }, r.deps);
    await r.flush();
    r.streams[0].end();
    await r.flush();
    s.close();
    await r.advance(RETRY_MS * 2);
    expect(r.calls.length).toBe(1);
  });
});
