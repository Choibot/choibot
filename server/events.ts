// server/events.ts
import { EventEmitter } from "node:events";
import type { QueueItem } from "./chief/queue/types.js";
import type { Issue } from "./issues/store.js";
import type { PromptKind } from "./agents/prompt.js";

export type AgentEvent =
  // quiet: the console ended the agent on purpose ("Sign out" of its login, agents/api.ts): the
  // page shows the status; no Telegram message, no notice and no digest line say "finished".
  | { type: "agent-status"; agentId: string; status: "running" | "idle" | "done" | "error"; quiet?: true }
  | { type: "agent-error"; agentId: string; message: string }
  | { type: "agent-notify"; agentId: string; level: "info" | "attention" | "error"; text: string }
  // A closed agent was used again and is back in the open list (agents/closed.ts).
  | { type: "agent-reopened"; agentId: string }
  // Chief on: an agent was closed (the user's ✕ or its lead's `agents close`);
  // the rail moves it to the Closed section.
  | { type: "agent-closed"; agentId: string }
  // The agent got a new title (POST /api/agents/:id/rename): the list and the header show it.
  | { type: "agent-renamed"; agentId: string; label: string };

// The terminal dialog an agent waits on changed (agents/prompt-watch.ts): one
// appeared (`kind` set), its options or selection changed (a new `rev`), or it
// went away (`kind` null, `rev` ""). The prompt card then reads
// GET /api/agents/:id/prompt. No screen text travels in the event.
export type AgentPromptEvent = { type: "agent-prompt"; agentId: string; kind: PromptKind | null; rev: string };

export type ServiceEvent = {
  type: "service-status";
  serviceId: string;
  status: "stopped" | "running" | "crashed";
  restartCount?: number;
  lastExitCode?: number | null;
  autoRestartDisabled?: boolean;
};

// telegram false: the job's notify policy keeps this run off Telegram (an OK
// run of an "on-failure" job); the fleet master still reads it.
// said: what the run said (server/cron/api.ts saidOf): one of the 3 states and one plain sentence
// (for did-not-finish the fixed reason words). Absent: a run with no result line (a task from
// before), whose Telegram message and digest line stay as before.
export type CronRunEvent = {
  type: "cron-run"; name: string; ok: boolean; summary: string; telegram?: false;
  said?: { state: "all-clear" | "needs-you" | "did-not-finish"; sentence: string | null };
};

// Emitted by the hook route for the Stop hook only: the agent finished a turn.
// `lastMessage` is the turn's final assistant text, "" when the turn ended on a
// tool call. The issue relay (server/issues/relay.ts) consumes it; it ignores
// agent-status idle, which also fires on Notification, boot, resume and switch.
export type AgentTurnEndEvent = { type: "agent-turn-end"; agentId: string; lastMessage: string };
// Emitted by the hook route when an agent stops and its last turn was cut by its Claude login:
// the plan or a model of it is at its limit, or the model does not work (agents/stopwhy.ts).
export type AgentStopEvent = { type: "agent-stop"; agentId: string; why: "limit" | "model" | "login" };
// Emitted by the hook route for EVERY hook it accepts (SessionStart included).
// The fleet master's inbox derives the master's turn state from it.
export type AgentHookEvent = { type: "agent-hook"; agentId: string; event: string; source?: string };

// Every IssueStore write. The fleet master's events (server/master/events.ts) read it.
export type IssueEvent = { type: "issue"; issue: Issue };

// The brain changed (spec §7): a distill run wrote a proposal
// (`proposed: true`), or Apply, Discard or Rollback changed BRAIN.md or
// removed the proposal (Task 1b-12). The Brain panel re-fetches on it.
export type BrainEvent = { type: "brain"; updatedAt: number; proposed: boolean };

// Every queue store write (chief spec §5.4 step 7, §7): add, answer, undo,
// snooze and its wake, withdraw, each delivery state, a PrWatch close. The
// Queue tab upserts the item from it.
export type QueueEvent = { type: "queue"; item: QueueItem };

// Every write of the chief's reminders.json (add, cancel, a delivery state).
// The Agents list re-fetches GET /api/reminders on it.
export type RemindersEvent = { type: "reminders" };

export type ConsoleEvent =
  | AgentEvent
  | AgentPromptEvent
  | ServiceEvent
  | CronRunEvent
  | AgentTurnEndEvent
  | AgentStopEvent
  | AgentHookEvent
  | IssueEvent
  | BrainEvent
  | QueueEvent
  | RemindersEvent;

export class EventHub {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  emitEvent(e: ConsoleEvent): void {
    this.emitter.emit("event", e);
  }
  subscribe(fn: (e: ConsoleEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}
