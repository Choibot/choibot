import { describe, it, expect } from "vitest";
import vm from "node:vm";
import {
  acceptFrameMessage, autoRefreshSeconds, bootstrapScript, formatUpdated, handleFrameCall,
  injectBootstrap, mergeHistory, newNonce, onFrameLoad, readCollapsed, stripVisible, writeCollapsed,
  WidgetApiError, type RefreshReply, type WidgetApi, type WidgetInfo,
} from "./widgets";

function info(over: Partial<WidgetInfo> = {}): WidgetInfo {
  return {
    id: "w", title: "W", width: 260, height: 180, chrome: true, autoRefresh: null, order: 0,
    hasRefresh: false, htmlMtime: 1, dataMtime: null, status: null, ...over,
  };
}

describe("injectBootstrap", () => {
  const js = "window.x=1";
  it("puts the script first inside <head>", () => {
    expect(injectBootstrap("<html><head><title>t</title></head><body></body></html>", js))
      .toBe("<html><head><script>window.x=1</script><title>t</title></head><body></body></html>");
  });
  it("matches <head> with attributes, in any case", () => {
    expect(injectBootstrap('<HEAD lang="en"><meta></HEAD>', js))
      .toBe('<HEAD lang="en"><script>window.x=1</script><meta></HEAD>');
  });
  it("prepends when there is no head, and does not take <header> for one", () => {
    expect(injectBootstrap("<header>h</header><p>x</p>", js))
      .toBe("<script>window.x=1</script><header>h</header><p>x</p>");
  });
});

describe("injectBootstrap without a head", () => {
  const js = "window.x=1";
  it("keeps a leading doctype first", () => {
    expect(injectBootstrap("<!doctype html><p>x</p>", js)).toBe("<!doctype html><script>window.x=1</script><p>x</p>");
    expect(injectBootstrap("\uFEFF  <!DOCTYPE html><p>x</p>", js)).toBe("\uFEFF  <!DOCTYPE html><script>window.x=1</script><p>x</p>");
  });
  it("goes after the <html> start tag", () => {
    expect(injectBootstrap('<!DOCTYPE html><html lang="en"><body>x', js))
      .toBe('<!DOCTYPE html><html lang="en"><script>window.x=1</script><body>x');
  });
  it("still prepends for plain markup", () => {
    expect(injectBootstrap("<p>x</p>", js)).toBe("<script>window.x=1</script><p>x</p>");
  });
});

describe("newNonce", () => {
  it("is 32 hex chars and new each time", () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(a);
  });
});

// Runs the real bootstrap in a fresh JS realm with a fake window.
function runBootstrap(nonce = "n1") {
  const posted: Array<Record<string, any>> = [];
  const listeners: Array<(ev: { source: unknown; data: unknown }) => void> = [];
  const events: Array<{ type: string; detail: any }> = [];
  const parent = { postMessage: (m: Record<string, any>, origin: string) => { posted.push({ ...m, origin }); } };
  const win: Record<string, any> = {
    parent,
    addEventListener: (t: string, f: (ev: { source: unknown; data: unknown }) => void) => { if (t === "message") listeners.push(f); },
    dispatchEvent: (e: { type: string; detail: any }) => { events.push(e); return true; },
  };
  class CustomEvent {
    type: string; detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; }
  }
  vm.runInNewContext(bootstrapScript(nonce), { window: win, CustomEvent });
  const send = (data: unknown, source: unknown = parent) => { for (const f of listeners) f({ source, data }); };
  return { choibot: win.choibot, posted, events, send };
}

describe("bootstrap (inside the frame)", () => {
  it("says ready with the nonce, to any origin", () => {
    const b = runBootstrap("abc");
    expect(b.posted).toEqual([{ choibot: 1, nonce: "abc", type: "ready", origin: "*" }]);
  });
  it("takes init from the parent and fires choibot:theme then choibot:data", () => {
    const b = runBootstrap();
    b.send({ choibot: 1, type: "init", data: { n: 1 }, history: [{ at: 1, data: { n: 1 } }], state: { s: 1 }, theme: "light", size: "large", widgetId: "w" });
    expect(b.choibot.data).toEqual({ n: 1 });
    expect(b.choibot.state).toEqual({ s: 1 });
    expect([b.choibot.theme, b.choibot.size, b.choibot.widgetId]).toEqual(["light", "large", "w"]);
    expect(b.events.map((e) => e.type)).toEqual(["choibot:theme", "choibot:data"]);
    expect(b.events[1].detail.history).toHaveLength(1);
  });
  it("ignores messages from any window but the parent", () => {
    const b = runBootstrap();
    b.send({ choibot: 1, type: "data", data: { x: 1 }, history: [] }, {});
    expect(b.choibot.data).toBeNull();
    expect(b.events).toEqual([]);
  });
  it("resolves a call with its reply, by reqId", async () => {
    const b = runBootstrap();
    const p = b.choibot.action("go", { a: 1 });
    const call = b.posted[1];
    expect(call).toMatchObject({ choibot: 1, nonce: "n1", type: "call", method: "action", args: { name: "go", args: { a: 1 } } });
    b.send({ choibot: 1, type: "reply", reqId: call.reqId + 99, ok: true, value: "wrong" });
    b.send({ choibot: 1, type: "reply", reqId: call.reqId, ok: true, value: { done: true } });
    await expect(p).resolves.toEqual({ done: true });
  });
  it("rejects a call with the server's error message", async () => {
    const b = runBootstrap();
    const p = b.choibot.refresh();
    b.send({ choibot: 1, type: "reply", reqId: b.posted[1].reqId, ok: false, error: "agent not running" });
    await expect(p).rejects.toMatchObject({ message: "agent not running" });
  });
  it("setState updates choibot.state once the parent confirms", async () => {
    const b = runBootstrap();
    const p = b.choibot.setState({ tab: 2 });
    expect(b.choibot.state).toEqual({});
    b.send({ choibot: 1, type: "reply", reqId: b.posted[1].reqId, ok: true });
    await p;
    expect(b.choibot.state).toEqual({ tab: 2 });
  });
});

describe("acceptFrameMessage", () => {
  const frame = {};
  const ctx = { frame, nonce: "n", navigated: false };
  it("accepts ready and call from the frame with the nonce", () => {
    expect(acceptFrameMessage({ source: frame, data: { choibot: 1, nonce: "n", type: "ready" } }, ctx)).toEqual({ type: "ready" });
    expect(acceptFrameMessage({ source: frame, data: { choibot: 1, nonce: "n", type: "call", reqId: 3, method: "ask", args: "x" } }, ctx))
      .toEqual({ type: "call", reqId: 3, method: "ask", args: "x" });
  });
  it("refuses another source, a wrong or missing nonce, and a non-choibot message", () => {
    const ok = { choibot: 1, nonce: "n", type: "ready" };
    expect(acceptFrameMessage({ source: {}, data: ok }, ctx)).toBeNull();
    expect(acceptFrameMessage({ source: frame, data: { ...ok, nonce: "x" } }, ctx)).toBeNull();
    expect(acceptFrameMessage({ source: frame, data: { choibot: 1, type: "ready" } }, ctx)).toBeNull();
    expect(acceptFrameMessage({ source: frame, data: { nonce: "n", type: "ready" } }, ctx)).toBeNull();
    expect(acceptFrameMessage({ source: frame, data: "ready" }, ctx)).toBeNull();
  });
  it("refuses a call with no numeric reqId or no method, and unknown types", () => {
    expect(acceptFrameMessage({ source: frame, data: { choibot: 1, nonce: "n", type: "call", reqId: "1", method: "ask" } }, ctx)).toBeNull();
    expect(acceptFrameMessage({ source: frame, data: { choibot: 1, nonce: "n", type: "call", reqId: 1 } }, ctx)).toBeNull();
    expect(acceptFrameMessage({ source: frame, data: { choibot: 1, nonce: "n", type: "other" } }, ctx)).toBeNull();
  });
  it("refuses everything once the frame has navigated, and when there is no frame", () => {
    const data = { choibot: 1, nonce: "n", type: "ready" };
    expect(acceptFrameMessage({ source: frame, data }, { ...ctx, navigated: true })).toBeNull();
    expect(acceptFrameMessage({ source: null, data }, { ...ctx, frame: null })).toBeNull();
  });
});

describe("onFrameLoad (navigation guard)", () => {
  it("the first load is the srcdoc; a second one means the widget navigated away", () => {
    expect(onFrameLoad(0)).toEqual({ loads: 1, navigated: false });
    expect(onFrameLoad(1)).toEqual({ loads: 2, navigated: true });
  });
  it("after a remount (new counter, new nonce) the frame is answered again", () => {
    const frame = {};
    const after = onFrameLoad(0);
    expect(acceptFrameMessage(
      { source: frame, data: { choibot: 1, nonce: "fresh", type: "ready" } },
      { frame, nonce: "fresh", navigated: after.navigated },
    )).toEqual({ type: "ready" });
  });
});

function fakeApi(over: Partial<WidgetApi> = {}) {
  const log: unknown[] = [];
  const api: WidgetApi = {
    refresh: async (_a, _w, body) => { log.push(["refresh", body]); return { mode: "script", data: { n: 1 }, status: { at: 1, ok: true, mode: "script" } }; },
    action: async (_a, _w, name, args) => { log.push(["action", name, args]); return { r: 1 }; },
    ask: async (_a, _w, body) => { log.push(["ask", body]); },
    putState: async (_a, _w, state) => { log.push(["state", state]); },
    putUi: async (_a, _w, ui) => { log.push(["ui", ui]); },
    ...over,
  };
  return { api, log };
}
const needConfirm = (text: string) => new WidgetApiError(428, "confirm", { needsConfirm: true, text });
const deps = (api: WidgetApi, extra: Partial<Parameters<typeof handleFrameCall>[1]> = {}) =>
  ({ agentId: "a", widgetId: "w", api, confirm: async () => true, ...extra });

describe("handleFrameCall", () => {
  it("refresh in script mode replies with mode and data, no confirm", async () => {
    const { api } = fakeApi();
    let asked = false;
    const reply = await handleFrameCall({ reqId: 1, method: "refresh", args: { d: 1 } }, deps(api, { confirm: async () => { asked = true; return true; } }));
    expect(reply).toEqual({ choibot: 1, type: "reply", reqId: 1, ok: true, value: { mode: "script", data: { n: 1 } } });
    expect(asked).toBe(false);
  });
  it("agent-mode refresh opens the confirm bar with the server's text; Send retries with confirmed", async () => {
    const log: unknown[] = [];
    const asked: string[] = [];
    const refreshed: string[] = [];
    const { api } = fakeApi({
      refresh: async (_a, _w, body): Promise<RefreshReply> => {
        log.push(body);
        if (!body.confirmed) throw needConfirm("[widget w] Refresh: get fresh data");
        return { mode: "agent" };
      },
    });
    const reply = await handleFrameCall({ reqId: 7, method: "refresh", args: undefined }, deps(api, {
      confirm: async (t: string) => { asked.push(t); return true; },
      onRefreshed: (r: RefreshReply) => { refreshed.push(r.mode); },
    }));
    expect(asked).toEqual(["[widget w] Refresh: get fresh data"]);
    expect(log).toEqual([{ args: undefined }, { args: undefined, confirmed: true }]);
    expect(refreshed).toEqual(["agent"]);
    expect(reply).toEqual({ choibot: 1, type: "reply", reqId: 7, ok: true, value: { mode: "agent" } });
  });
  it("Cancel replies with error cancelled and sends nothing more", async () => {
    let calls = 0;
    const { api } = fakeApi({ ask: async () => { calls++; throw needConfirm("[widget w] hi"); } });
    const reply = await handleFrameCall({ reqId: 2, method: "ask", args: "hi" }, deps(api, { confirm: async () => false }));
    expect(reply).toEqual({ choibot: 1, type: "reply", reqId: 2, ok: false, error: "cancelled" });
    expect(calls).toBe(1);
  });
  it("ask goes through the confirm bar and then sends confirmed", async () => {
    const bodies: unknown[] = [];
    const { api } = fakeApi({ ask: async (_a, _w, body) => { bodies.push(body); if (!body.confirmed) throw needConfirm("[widget w] hi"); } });
    const reply = await handleFrameCall({ reqId: 3, method: "ask", args: "hi" }, deps(api));
    expect(reply.ok).toBe(true);
    expect(bodies).toEqual([{ text: "hi" }, { text: "hi", confirmed: true }]);
  });
  it("ask with empty text is an error reply", async () => {
    const { api } = fakeApi();
    expect((await handleFrameCall({ reqId: 4, method: "ask", args: " " }, deps(api))).error).toBe("text required");
  });
  it("action passes name and args and replies with the result", async () => {
    const { api, log } = fakeApi();
    const reply = await handleFrameCall({ reqId: 5, method: "action", args: { name: "go", args: { x: 1 } } }, deps(api));
    expect(reply.value).toEqual({ r: 1 });
    expect(log).toEqual([["action", "go", { x: 1 }]]);
  });
  it("setState, resize and setAutoRefresh write state and ui; ui changes are reported", async () => {
    const { api, log } = fakeApi();
    let uiChanged = 0;
    const d = deps(api, { onUiChanged: () => { uiChanged++; } });
    await handleFrameCall({ reqId: 6, method: "setState", args: { t: 1 } }, d);
    await handleFrameCall({ reqId: 7, method: "resize", args: { width: 400, height: 300, junk: 1 } }, d);
    await handleFrameCall({ reqId: 8, method: "setAutoRefresh", args: null }, d);
    expect(log).toEqual([["state", { t: 1 }], ["ui", { width: 400, height: 300 }], ["ui", { autoRefresh: null }]]);
    expect(uiChanged).toBe(2);
  });
  it("an unknown method and a server error become error replies", async () => {
    const { api } = fakeApi({ action: async () => { throw new WidgetApiError(409, "agent not running", {}); } });
    expect((await handleFrameCall({ reqId: 9, method: "nope", args: null }, deps(api))).error).toBe("unknown method: nope");
    expect((await handleFrameCall({ reqId: 10, method: "action", args: { name: "x" } }, deps(api))).error).toBe("agent not running");
  });
});

describe("handleFrameCall confirm hardening", () => {
  it("a 428 without text is rejected, not shown as an empty bar", async () => {
    let asked = false;
    const { api } = fakeApi({ ask: async () => { throw new WidgetApiError(428, "confirm", { needsConfirm: true }); } });
    const reply = await handleFrameCall({ reqId: 1, method: "ask", args: "hi" }, deps(api, { confirm: async () => { asked = true; return true; } }));
    expect(reply).toEqual({ choibot: 1, type: "reply", reqId: 1, ok: false, error: "confirm text missing" });
    expect(asked).toBe(false);
  });
  it("frame args cannot set a top-level confirmed on the first request", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { api } = fakeApi({
      refresh: async (_a, _w, body) => { bodies.push(body); return { mode: "agent" }; },
      ask: async (_a, _w, body) => { bodies.push(body); },
    });
    await handleFrameCall({ reqId: 1, method: "refresh", args: { confirmed: true } }, deps(api));
    expect(bodies[0]).toEqual({ args: { confirmed: true } });
    expect("confirmed" in bodies[0]).toBe(false);
    const r = await handleFrameCall({ reqId: 2, method: "ask", args: { text: "x", confirmed: true } }, deps(api));
    expect(r.ok).toBe(false);
    expect(bodies).toHaveLength(1);
  });
});

describe("small helpers", () => {
  it("mergeHistory appends only newer entries", () => {
    expect(mergeHistory([{ at: 1, data: 1 }, { at: 2, data: 2 }], [{ at: 2, data: 2 }, { at: 3, data: 3 }]))
      .toEqual([{ at: 1, data: 1 }, { at: 2, data: 2 }, { at: 3, data: 3 }]);
  });
  it("autoRefreshSeconds needs an active strip, a script and a period (min 30)", () => {
    expect(autoRefreshSeconds(info({ hasRefresh: true, autoRefresh: 60 }), true)).toBe(60);
    expect(autoRefreshSeconds(info({ hasRefresh: true, autoRefresh: 5 }), true)).toBe(30);
    expect(autoRefreshSeconds(info({ hasRefresh: true, autoRefresh: 60 }), false)).toBeNull();
    expect(autoRefreshSeconds(info({ hasRefresh: false, autoRefresh: 60 }), true)).toBeNull();
    expect(autoRefreshSeconds(info({ hasRefresh: true, autoRefresh: null }), true)).toBeNull();
  });
  it("stripVisible only with at least one widget", () => {
    expect(stripVisible(null)).toBe(false);
    expect(stripVisible([])).toBe(false);
    expect(stripVisible([info()])).toBe(true);
  });
  it("collapse state is kept per agent and survives a throwing storage", () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
    // Folded unless the user opened it for this agent.
    expect(readCollapsed(storage, "a1")).toBe(true);
    writeCollapsed(storage, "a1", false);
    expect(readCollapsed(storage, "a1")).toBe(false);
    expect(readCollapsed(storage, "a2")).toBe(true);
    writeCollapsed(storage, "a1", true);
    expect(readCollapsed(storage, "a1")).toBe(true);
    const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    expect(readCollapsed(broken, "a1")).toBe(true);
    expect(() => writeCollapsed(broken, "a1", false)).not.toThrow();
    expect(readCollapsed(null, "a1")).toBe(true);
  });
  it("formatUpdated gives HH:MM, empty for no time", () => {
    expect(formatUpdated(new Date(2026, 9, 22, 14, 4).getTime())).toBe("14:04");
    expect(formatUpdated(null)).toBe("");
  });
});
