// src/lib/coordinator.ts — the Coordinator's row in Settings (GET /api/coordinator): the
// console's background agent. It has no row in the sidebar; this is the one place it shows.
import { chiefFetch } from "./chief";
import { reportAge } from "./leads";

export const COORDINATOR_ID = "coordinator"; // = server/coordinator/paths.ts (a node module)

// waits-sign-in: it waits for the second sign-in (server/chief/chiefwait.ts): not "Needs you".
// droppedEvents: older events dropped while it waited, until its first digest (0 on an older server).
export type CoordinatorState = "not-started" | "starting" | "asks" | "working" | "waiting" | "stopped" | "waits-sign-in";
// waitsLogin: its wait is for a Claude login that was signed out in Settings (not the second sign-in).
export type CoordinatorView = { id: string; state: CoordinatorState; lastActivityAt: number | null; queuedEvents: number; model: string; droppedEvents?: number; waitsLogin?: boolean };

// null: this console has no Coordinator (the chief of staff is off, or an older server).
export async function fetchCoordinator(): Promise<CoordinatorView | null> {
  const res = await chiefFetch("/api/coordinator");
  if (res.status === 404 || res.status === 503) return null;
  if (!res.ok) throw new Error(`coordinator: ${res.status}`);
  return (await res.json()) as CoordinatorView;
}

const WORD: Record<CoordinatorState, string> = {
  "not-started": "Not started", starting: "Starting", asks: "Needs you", working: "Working", waiting: "Waiting", stopped: "Stopped",
  "waits-sign-in": "Waits for its sign-in",
};

// The dot of the row (the tones of the Settings kit's Dot). "Waiting" is its healthy rest state.
// "Needs you" is the one state that asks for a look.
export function coordinatorTone(state: CoordinatorState): "run" | "ok" | "off" | "warn" {
  // A wait for the sign-in is no fault: a quiet dot, never the "Needs you" one.
  return state === "asks" ? "warn" : state === "working" || state === "starting" ? "run" : state === "waiting" ? "ok" : "off";
}

// "Waiting · last activity 3m ago", "Not started · it starts with the first event".
export function coordinatorLine(v: CoordinatorView, now = Date.now()): string {
  if (v.state === "not-started") return `${WORD[v.state]} · it starts with the first event`;
  if (v.state === "asks") return `${WORD[v.state]} · Claude asks a question in its thread`;
  if (v.state === "starting") return `${WORD[v.state]} · it reads the events when its session is ready`;
  if (v.state === "waits-sign-in" && v.waitsLogin) return `${WORD[v.state]} · it starts again when you log in again in Settings, Claude accounts${droppedLine(v)}`;
  if (v.state === "waits-sign-in") return `${WORD[v.state]} · it starts after "Sign in for your assistant" on the Set-up page${droppedLine(v)}`;
  const tail = v.state === "stopped" ? "the console starts it again in a minute" : v.lastActivityAt ? `last activity ${reportAge(v.lastActivityAt, now)}` : "no activity yet";
  return `${WORD[v.state]} · ${tail}${droppedLine(v)}`;
}

// The events that the queue (at most 50) dropped while it waited: named one time, until the
// Coordinator read its first digest.
function droppedLine(v: CoordinatorView): string {
  const n = v.droppedEvents ?? 0;
  return n > 0 ? ` · ${n} older ${n === 1 ? "event was" : "events were"} dropped while it waited` : "";
}
