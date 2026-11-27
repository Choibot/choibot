// src/lib/agentGroups.ts — the Agents list grouped by lead (chief on, at least one lead): one
// section per lead with the workers it spawned (spawnedBy === lead id), "Other agents" for the
// rest, Closed at the bottom. Pure, plus the per-browser open/closed memory of a lead section.
// GET /api/agents leaves the persistent kinds out (masters and leads), so the lead rows come from
// GET /api/leads (the Master pane's source) and the workers from GET /api/agents.
import type { LeadRow } from "./leads";
import { limitWord } from "./accounts";

type Rec = { id: string; spawnedBy?: string; closedAt?: number };
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
// waits: it waits for the second sign-in (server/chief/chiefwait.ts).
export type Lead = { id: string; area: string; status: string; waits?: boolean; waitsLogin?: boolean; model?: string; account?: string };
export type AgentGroups<T extends Rec, L extends { id: string } = Lead> = { leads: { lead: L; workers: T[] }[]; other: T[]; closed: T[] };

// The started leads that have a record (the Master pane's rule for an openable lead), in order.
export function leadsOf(rows: LeadRow[]): Lead[] {
  return rows.flatMap((r) => (r.leadId && r.status != null ? [{ id: r.leadId, area: r.area, status: r.status, ...(r.waits ? { waits: true } : {}), ...(r.model ? { model: r.model } : {}), ...(r.account ? { account: r.account } : {}) }] : []));
}

// Keeps the list order (the server's saved rail order) inside every section. A record whose id is
// a lead's is that lead's row, never a worker.
export function groupAgents<T extends Rec, L extends { id: string }>(sessions: T[], leads: L[]): AgentGroups<T, L> {
  const open = sessions.filter((s) => !s.closedAt);
  const leadSet = new Set(leads.map((l) => l.id));
  const rows = open.filter((s) => !leadSet.has(s.id));
  const grouped = leads.map((lead) => ({ lead, workers: rows.filter((s) => s.spawnedBy === lead.id) }));
  const other = rows.filter((s) => !(s.spawnedBy && leadSet.has(s.spawnedBy)));
  const closed = sessions.filter((s) => s.closedAt).sort((x, y) => (y.closedAt ?? 0) - (x.closedAt ?? 0));
  return { leads: grouped, other, closed };
}

// An agent was closed (this browser's ✕, or the agent-closed event of a close made elsewhere, as a
// lead's `agents close`): its row leaves its section for Closed. An already closed row keeps its time.
export function markClosed<T extends Rec>(sessions: T[], id: string, now: number): T[] {
  return sessions.map((x) => (x.id === id && !x.closedAt ? { ...x, closedAt: now } : x));
}

// The drag section of every open worker row: "lead:<id>" (a lead's workers) or "other".
export function sectionOf<T extends Rec, L extends { id: string }>(g: AgentGroups<T, L>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { lead, workers } of g.leads) {
    for (const w of workers) out[w.id] = `lead:${lead.id}`;
  }
  for (const o of g.other) out[o.id] = "other";
  return out;
}

// Drag-to-reorder inside one section: the dragged row takes the target's place in the full list
// (the saved order still covers every open agent); any other row keeps its relative order.
// A move across sections, onto itself or onto an unknown row returns the same list.
export function moveWithinSection<T extends Rec>(list: T[], dragId: string, overId: string, section: Record<string, string>): T[] {
  if (dragId === overId || !section[dragId] || section[dragId] !== section[overId]) return list;
  const from = list.findIndex((x) => x.id === dragId);
  const to = list.findIndex((x) => x.id === overId);
  if (from < 0 || to < 0) return list;
  const next = list.slice();
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  return next;
}

// A collapsed lead row: how many agents it runs, and the open tickets of the lead and of them.
export function leadSummary(lead: { id: string }, workers: Rec[], byAgent: Record<string, number>): { agents: number; open: number } {
  return { agents: workers.length, open: [lead, ...workers].reduce((n, x) => n + (byAgent[x.id] ?? 0), 0) };
}

// A sidebar row shows one count, and it is always the same thing: the open tickets that wait for
// the user. These words are its title and aria-label (and the agents count of a lead's chevron).
export const ticketsWord = (n: number): string => `${n} open ticket${n === 1 ? "" : "s"}`;
export const agentsWord = (n: number): string => (n === 0 ? "no agents" : `${n} agent${n === 1 ? "" : "s"}`);

// A lead row's count: folded, the open tickets of the lead and its agents; unfolded, the lead's
// own (each agent row under it shows its own).
export function leadCount(leadId: string, expanded: boolean, sum: { agents: number; open: number }, byAgent: Record<string, number>): { n: number; title: string } {
  if (expanded || sum.agents === 0) {
    const n = byAgent[leadId] ?? 0;
    return { n, title: `${ticketsWord(n)} of the lead` };
  }
  return { n: sum.open, title: `${ticketsWord(sum.open)}: the lead's and its agents'` };
}

export const leadOpenKey = (area: string): string => `choibot.leadOpen.${area}`;

// Default open. Storage may be missing or throw (private window, blocked site data).
export function readLeadOpen(store: Store | null, area: string): boolean {
  try { return store?.getItem(leadOpenKey(area)) !== "0"; } catch { return true; }
}

export function writeLeadOpen(store: Store | null, area: string, open: boolean): void {
  try { store?.setItem(leadOpenKey(area), open ? "1" : "0"); } catch { /* per-browser convenience only */ }
}

// window.localStorage, or null where reading it throws or it does not exist (server render).
export function browserStore(): Store | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

// A sidebar row's status, drawn as a dot in the token colours; the word is its title and
// aria-label. idle = the agent waits for you ("your turn").
export type Dot = "turn" | "run" | "ok" | "err" | "idle";
export function statusDot(status: string): { dot: Dot; word: string } {
  switch (status) {
    case "running": return { dot: "run", word: "running" };
    case "idle": return { dot: "turn", word: "your turn" };
    case "done": return { dot: "ok", word: "done" };
    case "error": return { dot: "err", word: "error" };
    default: return { dot: "idle", word: status || "unknown" };
  }
}

// The dot of an agent in the list. A limit in its way (its turn was cut, or it waits for a
// login with room) is said in plain words: such an agent is not "your turn".
export function agentDot(a: { status: string; stop?: { why: "limit" | "model" | "login"; text: string }; waitsLogin?: { until: number | null } }): { dot: Dot; word: string } {
  const word = limitWord(a);
  return word ? { dot: a.waitsLogin ? "idle" : "err", word } : statusDot(a.status);
}

// A Closed row: a session that still runs keeps its live dot; a stopped one is the empty ring.
export function closedDot(status: string): { dot: Dot; word: string } {
  return status === "running" || status === "idle" ? statusDot(status) : { dot: "idle", word: "stopped" };
}
