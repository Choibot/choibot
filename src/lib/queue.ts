// src/lib/queue.ts — the Queue tab's client: one fetch of GET /api/queue, pure
// helpers for sections/header/undo, and thin wrappers over the action routes.
// All item text is untrusted: callers render it as plain text.
import type { QueueItem } from "../../server/chief/queue/types"; // type-only: types.ts has a node:crypto import
import { sortOpen } from "../../server/chief/queue/priority";
import { isGone, isRecentAuto, isUndelivered } from "../../server/chief/queue/sections";
import type { MergeBlock, MergeView } from "../../server/chief/queue/merge"; // type-only
import { chiefFetch, refusalSentence } from "./chief";
import { USER_CLI } from "../../server/brand";

export type QueueResponse = {
  items: QueueItem[]; counts: { open: number; auto: number; undelivered: number };
  metrics: { week: { decisions: number; corrections: number } };
  serverNow: number; undoMs: number; hardened: boolean; userAuth: "telegram" | "log";
};
export type QueueView = { state: "off" } | { state: "misconfigured" } | { state: "on"; data: QueueResponse };
export type QueueResult = { ok: true; item: QueueItem } | { ok: false; status: number; item?: QueueItem; error?: string };

type Deps = { fetch?: typeof fetch; storage?: Pick<Storage, "getItem"> | null };

// 404 = flag off, 503 = misconfigured. Any other failure (500, network error, bad JSON)
// REJECTS: the caller must catch and keep its previous view.
export async function fetchQueue(deps: Deps = {}): Promise<QueueView> {
  const res = await chiefFetch("/api/queue?status=all", undefined, deps);
  if (res.status === 404) return { state: "off" };
  if (res.status === 503) return { state: "misconfigured" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { state: "on", data: (await res.json()) as QueueResponse };
}

// The first fetch's retry delays while the view is "loading": 2 s, 5 s, 15 s, then every 60 s.
const LOAD_RETRY_MS = [2_000, 5_000, 15_000];
export const loadRetryDelay = (attempt: number): number => LOAD_RETRY_MS[attempt] ?? 60_000;

export function upsertItem(items: QueueItem[], item: QueueItem): QueueItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = item;
  return next;
}

export function sections(items: QueueItem[], now: number): { open: QueueItem[]; undelivered: QueueItem[]; auto: QueueItem[]; gone: QueueItem[] } {
  return {
    open: sortOpen(items, now),
    undelivered: items.filter(isUndelivered),
    auto: items.filter((i) => isRecentAuto(i, now)),
    gone: items.filter((i) => isGone(i, now)),
  };
}

export function latestUndoable(items: QueueItem[], now: number, undoMs: number): QueueItem | null {
  let best: QueueItem | null = null;
  for (const i of items) {
    if ((i.status !== "answered" && i.status !== "auto") || !i.answer) continue;
    if (now - i.answer.at > undoMs) continue;
    if (!best || i.answer.at > (best.answer?.at ?? 0)) best = i;
  }
  return best;
}

// A preview image served by GET /api/queue/:id/media/:name (any session; a plain <img> works).
export const previewSrc = (item: QueueItem, name: string): string => `${url(item.id, "media")}/${encodeURIComponent(name)}`;

export function metricsLine(d: QueueResponse): string {
  const { decisions, corrections } = d.metrics.week;
  const pct = decisions > 0 ? Math.round((corrections / decisions) * 100) : 0;
  return `This week: ${decisions} decisions · ${corrections} corrections · ${pct}%`;
}

export const EMPTY_TEXT = "Nothing waits on you.";

// Pairing empty state (spec §8b); log mode names the command on the server instead of Telegram.
export function pairingText(userAuth: "telegram" | "log" | null): string {
  const how = userAuth === "log"
    ? `on a paired device, open Settings, Devices and press “Add a device”. With no paired device, run \`${USER_CLI} brain pair <label>\` on your server`
    : "send `/pair <label>` in the Telegram Master topic and open the link the bot sends you privately";
  return `Pair this device — ${how}. Items stay visible read-only below.`;
}


export function openLink(url: string, w: Pick<Window, "open"> | undefined = typeof window === "undefined" ? undefined : window): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !w) return false;
  w.open(u.href, "_blank", "noopener,noreferrer");
  return true;
}

// ---- route wrappers ----

async function post(url: string, body: unknown, deps: Deps = {}): Promise<QueueResult> {
  try {
    const res = await chiefFetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
    }, deps);
    const b = (await res.json().catch(() => null)) as (Partial<QueueItem> & { error?: string; item?: QueueItem }) | null;
    if (res.ok && b) return { ok: true, item: b as QueueItem };
    return {
      ok: false, status: res.status,
      ...(b?.item ? { item: b.item } : {}),
      error: typeof b?.error === "string" ? b.error : `HTTP ${res.status}`,
    };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "network error" };
  }
}

const url = (id: string, route: string) => `/api/queue/${encodeURIComponent(id)}/${route}`;

// `images`: the draft names of the answer's images (lib/answerImages).
export const answer = (id: string, body: { value: string; text?: string; images?: string[] }, deps?: Deps) => post(url(id, "answer"), body, deps);
export const undo = (id: string, deps?: Deps) => post(url(id, "undo"), {}, deps);
export const snooze = (id: string, minutes: number, deps?: Deps) => post(url(id, "snooze"), { minutes }, deps);
export const withdraw = (id: string, deps?: Deps) => post(url(id, "withdraw"), {}, deps);
export const delivery = (id: string, action: "resend" | "mark-delivered", slot: "answer" | "withdrawal" = "answer", deps?: Deps) =>
  post(url(id, "delivery"), { action, slot }, deps);

// ---- the Merge button of a pr ticket (server/chief/queue/merge.ts; USER only) ----

export type MergeMethod = "squash" | "merge" | "rebase";
export type MergeRead = { ok: true; view: MergeView } | { ok: false; status: number; error: string; reason?: string };
export type MergeCall =
  | { ok: true; item: QueueItem }
  | { ok: false; status: number; error: string; reason?: string; blocked?: MergeBlock; checks?: string; item?: QueueItem };

type MergeBody = Partial<MergeView> & { error?: string; reason?: string; userAuth?: string; merged?: boolean; item?: QueueItem };
async function mergeFetch(id: string, init: RequestInit | undefined, deps: Deps): Promise<{ status: number; ok: boolean; b: MergeBody | null }> {
  const res = await chiefFetch(url(id, "merge"), init, deps);
  return { status: res.status, ok: res.ok, b: (await res.json().catch(() => null)) as MergeBody | null };
}
const mergeError = (status: number, b: MergeBody | null): string =>
  refusalSentence(status, b, "Merge") ?? (typeof b?.error === "string" ? b.error : `HTTP ${status}`);

// The PR's facts, read fresh by the server: what the confirm step shows.
export async function readMerge(id: string, deps: Deps = {}): Promise<MergeRead> {
  try {
    const { status, ok, b } = await mergeFetch(id, undefined, deps);
    if (ok && b?.facts) return { ok: true, view: { facts: b.facts, blocked: b.blocked ?? null, checks: b.checks ?? null } };
    return { ok: false, status, error: mergeError(status, b), ...(typeof b?.reason === "string" ? { reason: b.reason } : {}) };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "network error" };
  }
}

// The merge. `head`: the head commit the confirm showed (the server and GitHub merge only that
// one). `acceptChecks`: the user said "Merge anyway" to the checks ask.
export async function mergeTicket(id: string, method: MergeMethod, head: string, acceptChecks: boolean, deps: Deps = {}): Promise<MergeCall> {
  try {
    const { status, ok, b } = await mergeFetch(id, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, head, ...(acceptChecks ? { checks: "accept" } : {}) }),
    }, deps);
    if (ok && b?.merged && b.item) return { ok: true, item: b.item };
    return {
      ok: false, status, error: mergeError(status, b),
      ...(typeof b?.reason === "string" ? { reason: b.reason } : {}),
      ...(b?.blocked ? { blocked: b.blocked } : {}),
      ...(typeof b?.checks === "string" ? { checks: b.checks } : {}),
      ...(b?.item ? { item: b.item } : {}),
    };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "network error" };
  }
}

// The merge method, remembered per repo in this browser. Default: squash, as the GitHub tab.
const METHOD_KEY = "choibot.mergeMethod.";
export function savedMergeMethod(slug: string, store: Pick<Storage, "getItem"> | null = safeStorage()): MergeMethod {
  try {
    const v = store?.getItem(METHOD_KEY + slug);
    return v === "merge" || v === "rebase" || v === "squash" ? v : "squash";
  } catch { return "squash"; }
}
export function saveMergeMethod(slug: string, m: MergeMethod, store: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try { store?.setItem(METHOD_KEY + slug, m); } catch { /* private mode: the choice lasts this page only */ }
}
function safeStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
