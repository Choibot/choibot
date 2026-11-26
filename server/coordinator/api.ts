// server/coordinator/api.ts — the Coordinator's two routes:
//   GET  /api/coordinator        any session: its state and its last activity (the Settings row)
//   POST /api/coordinator/task   the fleet master or the user: a task for the Coordinator. The console
//                                types it as a `[master]` line, so no other session can pose as
//                                the fleet master to the Coordinator (a SendMessage is peer text there).
// Registered only with the chief flag on (no route = no row); 503 while misconfigured.
import type { FastifyInstance } from "fastify";
import type { SessionStore } from "../agents/store.js";
import { gateRoute, pairRequired, type ChiefGate } from "../chief/gate.js";
import { COORDINATOR_ID, COORDINATOR_MODEL } from "./paths.js";

// not-started: no record yet (it starts with the Master or with the first event).
// starting: its session is up and did not say hello yet. asks: Claude shows a dialog on its
// screen (a question that only the user can answer, in its thread); it gets no line meanwhile.
// waits-sign-in: it waits for the second sign-in (chief/chiefwait.ts): not an error, not "asks".
export type CoordinatorState = "not-started" | "starting" | "asks" | "working" | "waiting" | "stopped" | "waits-sign-in";
// droppedEvents: the older events that the queue (at most 50) dropped and that no digest named
// yet: shown once, gone after its first digest.
export type CoordinatorView = {
  id: string; state: CoordinatorState; lastActivityAt: number | null; queuedEvents: number; model: string; droppedEvents: number;
  // waits-sign-in for a Claude login that was signed out on the page (agents/loginhold.ts).
  waitsLogin?: true;
};

export function coordinatorState(status: string | undefined, o: { live?: boolean; blocked?: "dialog" | "starting" | null } = {}): CoordinatorState {
  if (status === undefined) return "not-started";
  if (o.live && o.blocked === "dialog") return "asks";
  if (o.live && o.blocked === "starting") return "starting";
  if (status === "running") return "working";
  return status === "idle" ? "waiting" : "stopped";
}

export const TASK_MAX = 2000;
export const TASK_REFUSAL = "only the fleet master or the user gives the Coordinator a task";

// The line the Coordinator gets. Lines after the first are indented: they can never start a
// line of their own kind (`[queue <id>]`, `[events]`, a second `[master]`).
export function taskLine(text: string): string {
  return `[master] ${text.trim().split(/[\r\n\u2028\u2029\u0085]+/).map((l) => l.trim()).filter(Boolean).join("\n  ")}`;
}

export function registerCoordinatorApi(app: FastifyInstance, d: {
  gate: ChiefGate; agents: Pick<SessionStore, "load">;
  lastActivityAt: () => number | null; queuedEvents: () => number;
  // The feed's view (feed.ts `blocked`) and whether its PTY is attached in this process.
  blocked?: () => "dialog" | "starting" | null; live?: () => boolean;
  // Asked at each read: is a dialog of Claude on its screen now? (The feed's view is as old as its last try to type.)
  dialogOn?: () => Promise<boolean>;
  // Queues the line for the Coordinator (its inbox types it when the Coordinator is idle).
  task: (line: string) => void;
  // It waits for the second sign-in (chief/chiefwait.ts), and the older events dropped meanwhile.
  waitsSignIn?: () => boolean;
  waitsLogin?: () => boolean;
  droppedEvents?: () => number;
}): void {
  app.post("/api/coordinator/task", async (req, reply) => {
    if (!gateRoute(d.gate, reply)) return reply;
    const caller = await d.gate.caller(req);
    if (caller.level !== "user" && caller.level !== "master") {
      return caller.agentHeaders ? reply.code(403).send({ error: TASK_REFUSAL }) : pairRequired(d.gate, reply);
    }
    const text = (req.body as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "text: a non-empty string" });
    if (text.length > TASK_MAX) return reply.code(400).send({ error: `text: at most ${TASK_MAX} characters` });
    d.task(taskLine(text));
    return reply.code(202).send({ queued: true });
  });

  app.get("/api/coordinator", async (_req, reply): Promise<CoordinatorView | unknown> => {
    if (!gateRoute(d.gate, reply)) return reply;
    const rec = await d.agents.load(COORDINATOR_ID);
    const waits = d.waitsSignIn?.() === true;
    return {
      id: COORDINATOR_ID,
      state: waits ? "waits-sign-in" : coordinatorState(rec?.status, { live: d.live?.(), blocked: (await d.dialogOn?.().catch(() => false)) ? "dialog" : d.blocked?.() === "dialog" ? null : d.blocked?.() }),
      lastActivityAt: d.lastActivityAt(), queuedEvents: d.queuedEvents(), model: COORDINATOR_MODEL, droppedEvents: d.droppedEvents?.() ?? 0,
      ...(waits && d.waitsLogin?.() ? { waitsLogin: true as const } : {}),
    };
  });
}
