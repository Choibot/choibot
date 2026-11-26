// server/chief/remind/schema.ts — what `choibot remind add` may ask for: a due
// time (a duration like 3d or 1d12h, or an ISO date-time) between now + 5 min
// and now + 30 days, and a text of 1..1000 chars after trim, with the decision
// log's secret redaction applied.
import { randomInt } from "node:crypto";
import { redactSecrets } from "../brain/store.js";

export const MIN_AHEAD_MS = 5 * 60_000;
export const MAX_AHEAD_MS = 30 * 86_400_000;
export const TEXT_MAX = 1000;
// At most this many open reminders per target agent.
export const MAX_OPEN_PER_AGENT = 10;

export const REMINDER_ID_RE = /^r_[0-9a-z]{8}$/;

const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";
export function newReminderId(): string {
  let s = "r_";
  for (let i = 0; i < 8; i++) s += B36[randomInt(36)];
  return s;
}

// Days, hours, minutes, in that order, each at most once: 30m, 6h, 3d, 1d12h.
const DURATION_RE = /^(?:(\d{1,4})d)?(?:(\d{1,5})h)?(?:(\d{1,6})m)?$/;
const UNIT_MS = [86_400_000, 3_600_000, 60_000] as const;

// Milliseconds, or null for an empty, zero or malformed duration.
export function parseDuration(s: string): number | null {
  const m = DURATION_RE.exec(s);
  if (!m || s === "") return null;
  const ms = UNIT_MS.reduce((sum, unit, i) => sum + Number(m[i + 1] ?? 0) * unit, 0);
  return ms > 0 && Number.isSafeInteger(ms) ? ms : null;
}

// A date and a time, optional seconds and zone (none: the server's local time).
const AT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

export type ReminderInput = { dueAt: number; text: string };
export type Parsed = { ok: true; value: ReminderInput } | { ok: false; error: string };

const fail = (error: string): Parsed => ({ ok: false, error });

// The body of POST /api/reminders, without the target: {in | at, text}.
export function parseReminderInput(body: unknown, now: number): Parsed {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("body must be a JSON object");
  const b = body as { in?: unknown; at?: unknown; text?: unknown };
  const hasIn = b.in !== undefined, hasAt = b.at !== undefined;
  if (hasIn === hasAt) return fail("give exactly one of in or at");
  let dueAt: number;
  if (hasIn) {
    const ms = typeof b.in === "string" ? parseDuration(b.in) : null;
    if (ms === null) return fail("in must be a duration like 30m, 6h, 3d or 1d12h");
    dueAt = now + ms;
  } else {
    const t = typeof b.at === "string" && AT_RE.test(b.at) ? Date.parse(b.at.replace(" ", "T")) : NaN;
    if (!Number.isFinite(t)) return fail("at must be an ISO date-time like 2026-11-12T09:00:00Z");
    dueAt = t;
  }
  if (dueAt < now + MIN_AHEAD_MS) return fail("the reminder must be due at least 5 minutes from now");
  if (dueAt > now + MAX_AHEAD_MS) return fail("the reminder must be due within 30 days");
  if (typeof b.text !== "string") return fail("text must be a string");
  const text = b.text.trim();
  if (!text) return fail("text is empty");
  if (text.length > TEXT_MAX) return fail(`text over ${TEXT_MAX} chars`);
  return { ok: true, value: { dueAt, text: redactSecrets(text).text } };
}
