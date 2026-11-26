// src/lib/queueRow.ts — the Queue row in the Agents list (spec §8b, re-hosted): when the row
// exists, the open-ticket counts it and every agent row show, and what the Agents center shows.
// Pure; the page passes the one useQueue() instance's data down (no second fetch or stream).
import type { QueueItem } from "../../server/chief/queue/types"; // type-only: types.ts has a node:crypto import
import { sortOpen } from "../../server/chief/queue/priority";
import { CONSOLE_AGENT_ID } from "../../server/chief/deploy/ticket";
import type { QueueViewKind } from "./useQueue";

export const FLEET_MASTER_ID = "fleet-master"; // = server/master/paths.ts (a node module)

// The row and the counts exist only while the chief queue is on (404 hides them; 503 shows the
// row with its misconfigured line). Flag off: the Agents list is exactly as before.
export function queueRowShown(view: QueueViewKind): boolean {
  return view === "on" || view === "misconfigured";
}

// Open tickets, by the Queue view's Open rule (sortOpen: open, or a snooze that ended), in total
// and per item.agentId.
export function openCounts(items: QueueItem[], now: number): { total: number; byAgent: Record<string, number> } {
  const byAgent: Record<string, number> = {};
  const open = sortOpen(items, now);
  for (const i of open) {
    // The console's own deploy ticket shows in the fleet master's thread, so it counts on that row.
    // A rule suggestion (also the console's) shows in no thread: it counts in the total only.
    const row = i.agentId === CONSOLE_AGENT_ID && i.kind === "deploy" ? FLEET_MASTER_ID : i.agentId;
    byAgent[row] = (byAgent[row] ?? 0) + 1;
  }
  return { total: open.length, byAgent };
}

// The queue keys' `onQueueTab`: the old Queue tab is now the Agents tab with the Queue row selected.
export function onQueueRow(tab: string, queueOpen: boolean): boolean {
  return tab === "agents" && queueOpen;
}

export type AgentsCenter = "agent" | "lead" | "queue" | "master" | "empty";

// What the Agents section's center shows. An agent wins; the queue shows only while its row exists.
export function agentsCenter(s: { agentId: string | null; leadId: string | null; masterOpen: boolean; queueOpen: boolean; queueShown: boolean }): AgentsCenter {
  if (s.agentId) return "agent";
  if (s.leadId) return "lead";
  if (s.queueOpen && s.queueShown) return "queue";
  if (s.masterOpen) return "master";
  return "empty";
}

// The one sidebar row drawn as selected. GitHub (the cockpit), Recurring and Server are sidebar rows too; on any other
// tab (Settings: the footer's gear shows it; the deprecated console, editor, services) no row is
// selected.
export type SideRow = "github" | "recurring" | "server" | Exclude<AgentsCenter, "empty"> | null;
export function sideRow(tab: string, center: AgentsCenter): SideRow {
  if (tab === "cockpit") return "github";
  if (tab === "recurring") return "recurring";
  if (tab === "server") return "server";
  if (tab !== "agents" || center === "empty") return null;
  return center;
}

// The phone shell's one screen (A · Inset): the home list (the sidebar's rows) while nothing is
// open, else the screen of what is open. GitHub is the cockpit tab; Recurring, Server and Settings are tabs of their own; "tab" is
// a deprecated tab (console, editor, services) that some code still opens.
export type PhoneScreen = "home" | "github" | "recurring" | "server" | "settings" | "tab" | Exclude<AgentsCenter, "empty">;
export function phoneScreen(tab: string, center: AgentsCenter): PhoneScreen {
  if (tab === "cockpit") return "github";
  if (tab === "recurring") return "recurring";
  if (tab === "server") return "server";
  if (tab === "settings") return "settings";
  if (tab !== "agents") return "tab";
  return center === "empty" ? "home" : center;
}
