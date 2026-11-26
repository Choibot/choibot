// src/lib/reminders.ts — the ⏰ badge on Agents list rows: GET /api/reminders
// (any session, as GET /api/queue), its cancel (POST
// /api/reminders/:id/cancel, the paired user only) and pure helpers. Reminder
// text is agent-written: callers render it as plain text (a title attribute).
import { chiefFetch, getChiefState, hasUserToken, refusalSentence } from "./chief";
import type { QueueViewKind } from "./useQueue";

export type ReminderRow = { id: string; agentId: string; dueAt: number; text: string; state: string };
export type RemindersView = { state: "off" } | { state: "on"; reminders: ReminderRow[]; serverNow: number };
export type NextReminder = { id: string; dueAt: number; text: string; count: number };

type FetchDeps = Parameters<typeof chiefFetch>[2];

// 404 = flag off, 503 = misconfigured: no badge either way. Any other failure
// rejects; the caller keeps its last list.
export async function fetchReminders(deps?: FetchDeps): Promise<RemindersView> {
  const res = await chiefFetch("/api/reminders", undefined, deps);
  if (res.status === 404 || res.status === 503) return { state: "off" };
  if (!res.ok) throw new Error(`reminders: ${res.status}`);
  const body = (await res.json()) as { reminders?: ReminderRow[]; serverNow?: number };
  return { state: "on", reminders: Array.isArray(body.reminders) ? body.reminders : [], serverNow: body.serverNow ?? Date.now() };
}

// The badge exists only while the chief is on: the Queue fetch already tells
// (404 off, 503 misconfigured), so with the flag off no reminder request is sent.
export function remindersEnabled(queueView: QueueViewKind): boolean {
  return queueView === "on";
}

const isOpen = (r: ReminderRow): boolean => r.state === "open" || r.state === "delivering";

// Each agent's earliest open reminder (the one the badge shows and its ×
// cancels) and how many it has open.
export function nextByAgent(list: ReminderRow[]): Record<string, NextReminder> {
  const out: Record<string, NextReminder> = {};
  for (const r of list) {
    if (!isOpen(r)) continue;
    const cur = out[r.agentId];
    if (!cur) out[r.agentId] = { id: r.id, dueAt: r.dueAt, text: r.text, count: 1 };
    else out[r.agentId] = r.dueAt < cur.dueAt ? { id: r.id, dueAt: r.dueAt, text: r.text, count: cur.count + 1 } : { ...cur, count: cur.count + 1 };
  }
  return out;
}

// The badge's × shows only on a paired device (a stored user token, and no
// pair-required answer since); unpaired, the badge alone.
export function cancelAllowed(storage?: Pick<Storage, "getItem"> | null): boolean {
  return !getChiefState().pairRequired && hasUserToken(storage);
}

export type CancelResult = { ok: true } | { ok: false; text: string };

const CANCEL_FAILED = "Cancel failed — try again";

// Cancel one open reminder as the paired user. A refusal gives the line the
// rail shows under the row: the pair sentence, the server's 409 reason
// (being delivered, already delivered …), gone, or a fixed failure. The list
// updates on the `reminders` event the cancel emits.
export async function cancelReminder(id: string, deps?: FetchDeps): Promise<CancelResult> {
  let res: Response;
  try {
    res = await chiefFetch(`/api/reminders/${encodeURIComponent(id)}/cancel`, { method: "POST" }, deps);
  } catch {
    return { ok: false, text: CANCEL_FAILED };
  }
  if (res.ok) return { ok: true };
  type Body = { error?: string; userAuth?: string };
  let body: Body | null = null;
  try { body = (await res.json()) as Body; } catch { /* not JSON */ }
  const refusal = refusalSentence(res.status, body, "Cancelling a reminder");
  if (refusal) return { ok: false, text: refusal };
  if (res.status === 409 && typeof body?.error === "string") return { ok: false, text: `Not cancelled: ${body.error}` };
  if (res.status === 404) return { ok: false, text: "Not cancelled: the reminder is gone" };
  return { ok: false, text: CANCEL_FAILED };
}

const M = 60_000, H = 60 * M, D = 24 * H;

// Time until dueAt, to the nearest unit: days from 23.5 h on, then hours
// from 59.5 min, then minutes (at least 1); "now" once due (the console waits
// for the agent to be free). A just-set 3d reminder reads 3d, not 2d.
export function badgeLabel(dueAt: number, now: number): string {
  const ms = dueAt - now;
  if (ms <= 0) return "now";
  if (ms >= D - H / 2) return `${Math.round(ms / D)}d`;
  if (ms >= H - M / 2) return `${Math.round(ms / H)}h`;
  return `${Math.max(1, Math.round(ms / M))}m`;
}

export function badgeTitle(n: NextReminder, now: number): string {
  const when = badgeLabel(n.dueAt, now);
  return `${when === "now" ? "Reminder due now" : `Reminder in ${when}`}: ${n.text}${n.count > 1 ? ` (+${n.count - 1} more)` : ""}`;
}
