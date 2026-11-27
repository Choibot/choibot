// src/lib/guide.ts — the Set-up page's side of the guide (server/guide/api.ts): the calls, the
// guard of the chat box, and the plain words for each state. Every call goes out as the paired
// user (chiefFetch). Pure functions here; the hook is lib/useGuide.ts.
import { findSecret, stoppedLine, type SecretHit } from "../../server/guide/secret";
import type { GuideItem, GuideOff, GuideView } from "../../server/guide/types";
import { chiefFetch } from "./chief";

export type { GuideItem, GuideOff, GuideView };

type Fetch = typeof chiefFetch;
const NO_ANSWER = "The console did not answer. Try again.";
const JSON_POST = { method: "POST", headers: { "content-type": "application/json" } };

// none: this console has no guide (an install with the old names, an older server, a device
// that is not paired). The page then is the list alone, as before.
export type GuideRead = { on: true; view: GuideView } | { on: false };

async function readView(res: Response): Promise<GuideView | null> {
  const body = (await res.json().catch(() => null)) as Partial<GuideView> | null;
  if (!body || !Array.isArray(body.items)) return null;
  return { items: body.items, busy: body.busy === true, ...(body.off ? { off: body.off } : {}) };
}

// The thread. `sync`: also let the guide say what is new on the list.
export async function fetchGuide(o: { sync?: boolean } = {}, f: Fetch = chiefFetch): Promise<GuideRead | null> {
  let res: Response;
  try {
    res = await (o.sync ? f("/api/guide/sync", { ...JSON_POST, body: "{}" }) : f("/api/guide"));
  } catch {
    return null; // no answer: keep what was known
  }
  if (res.status === 404 || res.status === 403) return { on: false };
  if (!res.ok) return null;
  const view = await readView(res);
  return view ? { on: true, view } : null;
}

export type SendResult =
  | { ok: true; view: GuideView | null }
  // The guard of the chat box stopped the text. `line`: what the user reads.
  | { ok: false; stopped: SecretHit; line: string; view: GuideView | null }
  | { ok: false; error: string };

// Send what the user wrote. The guard runs first, in the browser: a text that looks like a
// secret does not leave it. The server gets only the kind, so the thread can say what happened
// and show the form where that secret belongs.
export async function sendToGuide(text: string, f: Fetch = chiefFetch): Promise<SendResult> {
  const hit = findSecret(text);
  if (hit) {
    let view: GuideView | null = null;
    try { view = await readView(await f("/api/guide/stopped", { ...JSON_POST, body: JSON.stringify({ secret: hit.kind }) })); } catch { /* the line below is shown in the page */ }
    return { ok: false, stopped: hit, line: stoppedLine(hit), view };
  }
  let res: Response;
  try {
    res = await f("/api/guide/message", { ...JSON_POST, body: JSON.stringify({ text }) });
  } catch {
    return { ok: false, error: NO_ANSWER };
  }
  if (res.ok) return { ok: true, view: await readView(res) };
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return { ok: false, error: typeof body?.error === "string" && / /.test(body.error) ? body.error : NO_ANSWER };
}

// ---------------------------------------------------------------- the words

// "14:05", or "tomorrow, 09:00", or "Mon 24 Nov, 09:00" for a time that is not today.
export function clockTime(at: number, now: number, locale?: string): string {
  const d = new Date(at), n = new Date(now);
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86_400_000;
  const days = day(d) - day(n);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow, ${time}`;
  return `${d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

// Why the guide cannot answer, in one plain line. A plan limit says when it ends when the
// console knows the time; else it says to try later. Never a line with no end.
export function offLine(off: GuideOff, now: number, locale?: string): string {
  if (off.why === "login") return "Claude is not logged in on your server.";
  if (off.why === "limit") {
    return off.until && off.until > now
      ? `Your Claude plan is at its limit until ${clockTime(off.until, now, locale)}.`
      : "Your Claude plan is at its limit. Try again later.";
  }
  return "The guide did not answer. Try again later.";
}

// The whole banner: "The guide is not available now. <why> All steps work from this list."
export const OFF_HEAD = "The guide is not available now.";
export const OFF_TAIL = "All steps work from this list.";

// The guide takes no message now (no login, the plan at its limit): the list is the page.
// After "no answer" the chat stays: a new message is a new try.
export const guideClosed = (off: GuideOff | undefined): boolean => off !== undefined && off.why !== "down";

// The page waits this long for an answer of the guide. The server ends a turn before that
// (its own limit is 90 seconds), so "writes…" never stays for ever.
export const BUSY_MAX_MS = 120_000;

export const BUSY_LATE_TEXT = "The guide did not answer. Ask again, or use the list.";

// ---------------------------------------------------------------- the thread

// Who speaks: the thread says it one time for each run of items of the same side.
export const sideOf = (i: GuideItem): "you" | "guide" => (i.kind === "user" ? "you" : "guide");

// "Next: Connect GitHub." at the start of a fixed line is its head; the rest is the reason.
export function nextParts(text: string): { head: string; rest: string } | null {
  const m = /^(Next: [^.\n]+\.)\s*([\s\S]*)$/.exec(text);
  return m ? { head: m[1], rest: m[2] } : null;
}

// "This console has a guide", as the last load found it, kept in this browser: the next load
// opens with the guide's place on its first frame. Only a hint (one flag, no text of the
// thread and no text of the box): the server is asked on every load.
export const GUIDE_HINT_KEY = "choibot.guide";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStore = (): Store | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
};
export function readGuideHint(store: Store | null = browserStore()): boolean {
  try { return store?.getItem(GUIDE_HINT_KEY) === "1"; } catch { return false; }
}
export function writeGuideHint(on: boolean, store: Store | null = browserStore()): void {
  try { if (on) store?.setItem(GUIDE_HINT_KEY, "1"); else store?.removeItem(GUIDE_HINT_KEY); } catch { /* storage blocked: no hint */ }
}
