// src/lib/serverAudit.ts — the Clean-up tab of the Server page: the reads (server/audit/api.ts)
// and the pure parts (the head line, the line of the AI step, the words of a row).
import type { AuditView } from "../../server/audit/audit";
import type { Row, Sure } from "../../server/audit/words";
import { size, span } from "../../server/health/words";
import { chiefFetch } from "./chief";

export type { AuditView, Row };
export type AuditGot = { ok: true; view: AuditView } | { ok: false; text: string };

const PAIR = "The clean-up audit is for a paired device only. Add this device in Settings, under Devices.";

async function ask(init: RequestInit | undefined, deps: { fetch?: typeof chiefFetch }, url = "/api/server/audit"): Promise<{ status: number; body: Record<string, unknown> } | null> {
  try {
    const res = await (deps.fetch ?? chiefFetch)(url, init);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return null;
  }
}

const refusal = (r: { status: number; body: Record<string, unknown> } | null): string =>
  !r ? "Your server did not answer." : r.body.error === "pair-required" ? PAIR : typeof r.body.text === "string" ? r.body.text : "Your server did not answer.";

export async function fetchAudit(deps: { fetch?: typeof chiefFetch } = {}): Promise<AuditGot> {
  const r = await ask(undefined, deps);
  return r && r.status === 200 ? { ok: true, view: r.body as unknown as AuditView } : { ok: false, text: refusal(r) };
}

// Starts an audit. An audit that runs already is no error: the page waits for it.
export async function startAudit(deps: { fetch?: typeof chiefFetch } = {}): Promise<{ ok: true } | { ok: false; text: string }> {
  const r = await ask({ method: "POST" }, deps);
  return r && (r.status === 202 || r.status === 409) ? { ok: true } : { ok: false, text: refusal(r) };
}

// Removes the thing of one row, or every row of the safe group, after the user's confirm. The
// server gets an id (or "all safe") and the time of the result on the screen, never a path.
async function remove(what: { id: string } | { all: "safe" }, checkedAt: number, deps: { fetch?: typeof chiefFetch }): Promise<{ ok: true } | { ok: false; text: string }> {
  const r = await ask({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...what, checkedAt }) }, deps, "/api/server/audit/remove");
  return r && r.status === 202 ? { ok: true } : { ok: false, text: refusal(r) };
}
export const removeRow = (id: string, checkedAt: number, deps: { fetch?: typeof chiefFetch } = {}) => remove({ id }, checkedAt, deps);
export const removeAllSafe = (checkedAt: number, deps: { fetch?: typeof chiefFetch } = {}) => remove({ all: "safe" }, checkedAt, deps);

// What the confirm of a row says: what goes, its size, what happens after. A "check first" row
// says first that nothing brings it back.
export function confirmLine(r: Row): string {
  const what = `${r.what.replace(/\.$/, "")} (${size(r.bytes)})`;
  return r.group === "check"
    ? `This cannot be undone, and the audit cannot know if you need it. Remove for good: ${what}? ${r.effect}`
    : `Remove for good: ${what}? ${r.effect}`;
}

// The rows of a group that "Remove all" takes, and what its confirm says.
export const removable = (rows: Row[]): Row[] => rows.filter((r) => !r.noRemove);
export function confirmAllLine(rows: Row[]): string {
  const n = removable(rows).length;
  return `Remove ${n} ${n === 1 ? "thing" : "things"} (${size(sum(removable(rows)))}) for good? A tool makes each of them again. It stops at the first one that cannot be removed.`;
}

// The first line of a result: how much space the safe rows give back.
export function headLine(r: { safeBytes: number; checkBytes: number; rows: Row[]; freedCount?: number }): string {
  if (r.rows.length === 0) return r.freedCount ? "You removed everything of the list." : "The audit found nothing big to remove.";
  if (r.safeBytes === 0) return `Nothing is safe to remove with no check. ${size(r.checkBytes)} can come back after you check.`;
  return `You can free about ${size(r.safeBytes)}.${r.checkBytes > 0 ? ` ${size(r.checkBytes)} more can come back after you check.` : ""}`;
}

// Why the words of the rows are the fixed ones, or null when the AI step ran.
export function aiLine(ai: string): string | null {
  if (ai === "ok") return null;
  const why = ai === "login" ? "Claude is not logged in on your server"
    : ai === "limit" ? "your Claude plan is at its limit"
    : ai === "none" ? "this server has no AI step" : "Claude gave no answer";
  return `The AI part did not run: ${why}. The list is complete; its words are the fixed ones.`;
}

const SURE: Record<Sure, string> = { high: "Sure", medium: "Quite sure", low: "Not sure" };
export const sureWord = (s: Sure): string => SURE[s];

// "changed 3 days ago", "changed today".
export function ageWord(days: number | null): string {
  if (days === null) return "";
  return days < 1 ? "changed today" : `changed ${span(days * 86400)} ago`;
}

export const rowsOf = (rows: Row[], group: Row["group"]): Row[] => rows.filter((r) => r.group === group);
export const sum = (rows: Row[]): number => rows.reduce((n, r) => n + r.bytes, 0);
