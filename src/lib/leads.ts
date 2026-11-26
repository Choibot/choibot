// src/lib/leads.ts — Master pane: the area leads (GET /api/leads).
import { useSyncExternalStore } from "react";
import { chiefFetch } from "./chief";
import { avatarVariant } from "./leadAvatar";

// `avatar`: the user's "Change avatar" pick for the area (0 or absent = the name's own creature).
export type LeadRow = {
  area: string; repos: string[]; leadId?: string | null; status?: string | null; reportAt?: number | null; avatar?: number;
  // True while the lead waits for the second sign-in (server/chief/chiefwait.ts).
  waits?: boolean;
  // That wait is for a Claude login that was signed out in Settings.
  waitsLogin?: boolean;
};

// The areas that have a lead, each with its avatar pick: what LeadAvatar and the Queue need to
// draw a lead the same way everywhere. Every read of GET /api/leads fills it (the sidebar, the
// Master pane and Settings read it anyway); null until the first read.
type Looks = ReadonlyMap<string, number>;
const NO_LOOKS: Looks = new Map();
let looks: Looks | null = null;
let asked = false;
const subs = new Set<() => void>();

function noteLeads(rows: LeadRow[]): void {
  const next = new Map(rows.filter((r) => r.leadId).map((r) => [r.area, avatarVariant(r.avatar)]));
  if (looks && next.size === looks.size && [...next].every(([a, v]) => looks?.get(a) === v)) return;
  looks = next;
  for (const f of subs) f();
}
const subscribe = (f: () => void): (() => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const leadLooks = (): Looks => looks ?? NO_LOOKS;
export function useLeadLooks(): Looks {
  return useSyncExternalStore(subscribe, leadLooks, () => NO_LOOKS);
}
// For a view that shows leads but does not read them itself (the Queue): one read, if none was made.
export function ensureLeadLooks(): void {
  if (looks !== null || asked) return;
  asked = true;
  void fetchLeadsState().catch(() => { asked = false; });
}

type FetchDeps = Parameters<typeof chiefFetch>[2];

// 404 (chief off or no leads route) is an empty list, not an error; `missing`
// tells a poller the route does not exist, so it can stop.
export async function fetchLeadsState(deps?: FetchDeps): Promise<{ rows: LeadRow[]; missing: boolean }> {
  const res = await chiefFetch("/api/leads", undefined, deps);
  if (res.status === 404) { noteLeads([]); return { rows: [], missing: true }; }
  if (!res.ok) throw new Error(`leads: ${res.status}`);
  const rows = (await res.json()) as LeadRow[];
  noteLeads(rows);
  return { rows, missing: false };
}

export async function fetchLeads(deps?: FetchDeps): Promise<LeadRow[]> {
  return (await fetchLeadsState(deps)).rows;
}

// "3m ago" / "no report" for the last report time (epoch ms).
export function reportAge(at: number | null | undefined, now = Date.now()): string {
  if (!at) return "no report";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return `${s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`} ago`;
}
