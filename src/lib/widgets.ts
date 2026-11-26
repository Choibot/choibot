import { chiefFetch } from "./chief";
// src/lib/widgets.ts — client side of agent widgets (spec 2026-10-22): fetch
// helpers for /api/agents/:id/widgets, the bootstrap script that runs inside
// each widget frame, and the parent half of the postMessage protocol. Pure
// functions only (no React, no DOM at import time) so vitest tests them in
// node: the console has no component test setup.

export type WidgetWidth = number | "wide";
export type WidgetStatus = { at: number; ok: boolean; mode: "script" | "agent"; error?: string };
export type WidgetInfo = {
  id: string; title: string; width: WidgetWidth; height: number; chrome: boolean;
  autoRefresh: number | null; order: number; hasRefresh: boolean;
  htmlMtime: number; dataMtime: number | null; status: WidgetStatus | null;
};
export type HistoryEntry = { at: number; data: unknown };
export type WidgetPayload = { html?: string; data: unknown; history: HistoryEntry[]; state: unknown };
export type RefreshReply = { mode: "script"; data: unknown; status: WidgetStatus } | { mode: "agent" };

// "asked agent…" gives up after this long with no new data.json.
export const ASK_TIMEOUT_MS = 5 * 60_000;
const HISTORY_KEEP = 5000; // = the largest historyMax

// ---- HTTP ----

export class WidgetApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown>) {
    super(message);
    this.name = "WidgetApiError";
  }
}

const enc = encodeURIComponent;
function url(agentId: string, wid?: string, tail = ""): string {
  return `/api/agents/${enc(agentId)}/widgets${wid ? `/${enc(wid)}` : ""}${tail}`;
}

async function request<T>(u: string, init?: RequestInit): Promise<T> {
  const r = await chiefFetch(u, init);
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new WidgetApiError(r.status, typeof body.error === "string" ? body.error : `failed (${r.status})`, body);
  return body as T;
}

function send(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export async function listWidgets(agentId: string): Promise<WidgetInfo[]> {
  return (await request<{ widgets: WidgetInfo[] }>(url(agentId))).widgets;
}

export function getWidget(agentId: string, wid: string, since?: number): Promise<WidgetPayload> {
  return request<WidgetPayload>(url(agentId, wid, since === undefined ? "" : `?since=${since}`));
}

export function refreshWidget(agentId: string, wid: string, body: { args?: unknown; confirmed?: true }): Promise<RefreshReply> {
  return request<RefreshReply>(url(agentId, wid, "/refresh"), send("POST", body));
}

export async function widgetAction(agentId: string, wid: string, name: string, args?: unknown): Promise<unknown> {
  return (await request<{ result: unknown }>(url(agentId, wid, "/action"), send("POST", { name, args }))).result;
}

export async function askWidget(agentId: string, wid: string, body: { text: string; confirmed?: true }): Promise<void> {
  await request(url(agentId, wid, "/ask"), send("POST", body));
}

export async function putWidgetState(agentId: string, wid: string, state: unknown): Promise<void> {
  await request(url(agentId, wid, "/state"), send("PUT", { state }));
}

export async function putWidgetUi(agentId: string, wid: string, ui: { width?: unknown; height?: unknown; autoRefresh?: unknown }): Promise<void> {
  await request(url(agentId, wid, "/ui"), send("PUT", ui));
}

export async function deleteWidget(agentId: string, wid: string): Promise<void> {
  await request(url(agentId, wid), { method: "DELETE" });
}

// The calls a frame can make, injectable for tests.
export type WidgetApi = {
  refresh(agentId: string, wid: string, body: { args?: unknown; confirmed?: true }): Promise<RefreshReply>;
  action(agentId: string, wid: string, name: string, args?: unknown): Promise<unknown>;
  ask(agentId: string, wid: string, body: { text: string; confirmed?: true }): Promise<void>;
  putState(agentId: string, wid: string, state: unknown): Promise<void>;
  putUi(agentId: string, wid: string, ui: { width?: unknown; height?: unknown; autoRefresh?: unknown }): Promise<void>;
};

export const widgetApi: WidgetApi = {
  refresh: refreshWidget, action: widgetAction, ask: askWidget, putState: putWidgetState, putUi: putWidgetUi,
};

// ---- frame ----

export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// The `choibot` API inside the frame (spec "Bootstrap API"). Every frame →
// parent message carries the mount's nonce; the nonce guards against pages
// the widget did not deliberately hand it to (every accepted call still goes
// through the confirm gate). Parent → frame messages are trusted by source only.
export function bootstrapScript(nonce: string): string {
  return `(function () {
  var NONCE = ${JSON.stringify(nonce)};
  var parentWin = window.parent;
  var seq = 0;
  var pending = {};
  function post(msg) { msg.choibot = 1; msg.nonce = NONCE; parentWin.postMessage(msg, "*"); }
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      seq += 1;
      pending[seq] = { resolve: resolve, reject: reject };
      post({ type: "call", reqId: seq, method: method, args: args });
    });
  }
  function emit(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail: detail })); }
  var choibot = {
    data: null, history: [], state: {}, theme: "dark", size: "box", widgetId: "",
    refresh: function (args) { return call("refresh", args); },
    action: function (name, args) { return call("action", { name: name, args: args }); },
    ask: function (text) { return call("ask", text).then(function () {}); },
    setState: function (obj) { return call("setState", obj).then(function () { choibot.state = obj; }); },
    resize: function (size) { return call("resize", size || {}).then(function () {}); },
    setAutoRefresh: function (seconds) { return call("setAutoRefresh", seconds === undefined ? null : seconds).then(function () {}); }
  };
  window.choibot = choibot;
  window.addEventListener("message", function (ev) {
    if (ev.source !== parentWin) return;
    var m = ev.data;
    if (!m || m.choibot !== 1) return;
    if (m.type === "init") {
      choibot.data = m.data === undefined ? null : m.data;
      choibot.history = m.history || [];
      choibot.state = m.state || {};
      choibot.theme = m.theme === "light" ? "light" : "dark";
      choibot.size = m.size === "large" ? "large" : "box";
      choibot.widgetId = String(m.widgetId || "");
      emit("choibot:theme", { theme: choibot.theme });
      emit("choibot:data", { data: choibot.data, history: choibot.history });
    } else if (m.type === "data") {
      choibot.data = m.data === undefined ? null : m.data;
      choibot.history = m.history || [];
      emit("choibot:data", { data: choibot.data, history: choibot.history });
    } else if (m.type === "theme") {
      choibot.theme = m.theme === "light" ? "light" : "dark";
      emit("choibot:theme", { theme: choibot.theme });
    } else if (m.type === "reply") {
      var p = pending[m.reqId];
      if (!p) return;
      delete pending[m.reqId];
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error || "failed"));
    }
  });
  post({ type: "ready" });
})();`;
}

// First child of <head>; with no head, after any doctype and <html> tag. The pattern
// needs whitespace or ">" after "head", so <header> is not taken for it.
export function injectBootstrap(html: string, js: string): string {
  const tag = `<script>${js}</script>`;
  const m = /<head(\s[^>]*)?>/i.exec(html);
  let at: number;
  if (m) at = m.index + m[0].length;
  else {
    // No head: keep a leading doctype first (else quirks mode), then <html>.
    at = 0;
    const d = /^[\s\uFEFF]*<!doctype[^>]*>/i.exec(html);
    if (d) at = d[0].length;
    const h = /^\s*<html(\s[^>]*)?>/i.exec(html.slice(at));
    if (h) at += h[0].length;
  }
  return html.slice(0, at) + tag + html.slice(at);
}

export type FrameMessage = { type: "ready" } | { type: "call"; reqId: number; method: string; args: unknown };
export type FrameReply = { choibot: 1; type: "reply"; reqId: number; ok: boolean; value?: unknown; error?: string };

// Spec "postMessage protocol": accept only from this frame's window, with
// this mount's nonce, and only while the frame has not navigated.
export function acceptFrameMessage(
  ev: { source: unknown; data: unknown },
  ctx: { frame: unknown; nonce: string; navigated: boolean },
): FrameMessage | null {
  if (ctx.navigated || !ctx.frame || ev.source !== ctx.frame) return null;
  const d = ev.data as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || d.choibot !== 1 || d.nonce !== ctx.nonce) return null;
  if (d.type === "ready") return { type: "ready" };
  if (d.type === "call" && typeof d.reqId === "number" && typeof d.method === "string") {
    return { type: "call", reqId: d.reqId, method: d.method, args: d.args };
  }
  return null;
}

// Navigation guard: load 1 is the srcdoc; any later load means the widget
// navigated away, and the parent remounts the iframe (new key, new nonce).
export function onFrameLoad(loads: number): { loads: number; navigated: boolean } {
  const next = loads + 1;
  return { loads: next, navigated: next > 1 };
}

export type CallDeps = {
  agentId: string;
  widgetId: string;
  // Shows the confirm bar with the exact text; true = Send, false = Cancel.
  confirm: (text: string) => Promise<boolean>;
  onRefreshed?: (r: RefreshReply) => void;
  onUiChanged?: () => void;
  api?: WidgetApi;
};

// A frame-started refresh (agent mode) or ask is never confirmed by the
// frame: the server answers 428 with the exact text, the user sees it in the
// confirm bar, and only Send repeats the call with confirmed: true.
async function withConfirm<T>(sendIt: (confirmed: boolean) => Promise<T>, confirm: (text: string) => Promise<boolean>): Promise<T> {
  try {
    return await sendIt(false);
  } catch (e) {
    if (!(e instanceof WidgetApiError) || e.status !== 428) throw e;
    const text = typeof e.body.text === "string" ? e.body.text : "";
    if (!text) throw new Error("confirm text missing");
    if (!(await confirm(text))) throw new Error("cancelled");
    return sendIt(true);
  }
}

export async function handleFrameCall(
  call: { reqId: number; method: string; args: unknown },
  deps: CallDeps,
): Promise<FrameReply> {
  const api = deps.api ?? widgetApi;
  const { agentId, widgetId: wid } = deps;
  const run = async (): Promise<unknown> => {
    switch (call.method) {
      case "refresh": {
        const r = await withConfirm(
          (confirmed) => api.refresh(agentId, wid, confirmed ? { args: call.args, confirmed: true } : { args: call.args }),
          deps.confirm,
        );
        deps.onRefreshed?.(r);
        return r.mode === "script" ? { mode: r.mode, data: r.data } : { mode: r.mode };
      }
      case "action": {
        const a = (call.args ?? {}) as { name?: unknown; args?: unknown };
        if (typeof a.name !== "string") throw new Error("action name required");
        return api.action(agentId, wid, a.name, a.args);
      }
      case "ask": {
        const text = call.args;
        if (typeof text !== "string" || !text.trim()) throw new Error("text required");
        await withConfirm(
          (confirmed) => api.ask(agentId, wid, confirmed ? { text, confirmed: true } : { text }),
          deps.confirm,
        );
        return undefined;
      }
      case "setState":
        await api.putState(agentId, wid, call.args ?? {});
        return undefined;
      case "resize": {
        const a = (call.args ?? {}) as { width?: unknown; height?: unknown };
        await api.putUi(agentId, wid, { width: a.width, height: a.height });
        deps.onUiChanged?.();
        return undefined;
      }
      case "setAutoRefresh":
        await api.putUi(agentId, wid, { autoRefresh: call.args ?? null });
        deps.onUiChanged?.();
        return undefined;
      default:
        throw new Error(`unknown method: ${call.method}`);
    }
  };
  try {
    return { choibot: 1, type: "reply", reqId: call.reqId, ok: true, value: await run() };
  } catch (e) {
    return { choibot: 1, type: "reply", reqId: call.reqId, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- small helpers ----

export function mergeHistory(prev: HistoryEntry[], incoming: HistoryEntry[]): HistoryEntry[] {
  const last = prev.length ? prev[prev.length - 1].at : -Infinity;
  return [...prev, ...incoming.filter((e) => e.at > last)].slice(-HISTORY_KEEP);
}

// Spec "User-facing behavior" 7: only with a script, a period, and while the
// strip is expanded and the tab visible (`active`).
export function autoRefreshSeconds(info: WidgetInfo, active: boolean): number | null {
  if (!active || !info.hasRefresh || !info.autoRefresh) return null;
  return Math.max(30, info.autoRefresh);
}

export function stripVisible(widgets: WidgetInfo[] | null): boolean {
  return !!widgets && widgets.length > 0;
}

// The strip is folded to one line unless the user opened it for this agent.
const OPEN_PREFIX = "choibot.widgets.open.";

export function readCollapsed(storage: Pick<Storage, "getItem"> | null, agentId: string): boolean {
  try { return storage?.getItem(OPEN_PREFIX + agentId) !== "1"; } catch { return true; }
}

export function writeCollapsed(storage: Pick<Storage, "setItem" | "removeItem"> | null, agentId: string, collapsed: boolean): void {
  try {
    if (collapsed) storage?.removeItem(OPEN_PREFIX + agentId);
    else storage?.setItem(OPEN_PREFIX + agentId, "1");
  } catch { /* private mode: the choice is not kept */ }
}

export function formatUpdated(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
