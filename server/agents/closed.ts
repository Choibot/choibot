// server/agents/closed.ts
// Closed agents. The rail's ✕ does not delete an agent: it sets `closedAt`,
// stops its session for real (claude, dtach and every process they started, so
// the memory is freed) and moves it to the Closed section. The record,
// worktree, branch, transcript and sessionId stay, so it can be resumed later.
// A closed agent starts again only on an explicit action: Reopen/Resume in the
// rail, `choibot agents resume <id>`, or a new prompt sent to it. Boot never
// restarts it (reconcileAgents skips it). The masters can never be closed.
// This purge deletes a closed agent for good once it has been closed longer than
// CLOSED_TTL_MS. With the chief on, an open reminder keeps it (a due reminder
// reopens it), and the TTL runs from its last reminder's end if that is later.
import { isPersistentKind, type AgentRecord, type SessionStore } from "./store.js";
import type { AgentEvent } from "../events.js";

export const CLOSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ReopenDeps = {
  store: Pick<SessionStore, "load" | "patch">;
  emit: (e: AgentEvent) => void;
};

// A closed agent that is used again goes back to the open list: it got a new
// prompt, it was resumed, or the user pressed Enter in its tab. Returns true
// when it was closed. The rail moves it on the agent-reopened event.
// `liveOnly`: reopen only an agent whose session is still up (status running
// or idle). Enter in a tab uses it, so a keypress never reopens a stopped agent.
export async function reopenIfClosed(
  deps: ReopenDeps, id: string, opts: { liveOnly?: boolean } = {},
): Promise<boolean> {
  const rec = await deps.store.load(id);
  if (!rec || rec.closedAt === undefined) return false;
  if (opts.liveOnly && rec.status !== "running" && rec.status !== "idle") return false;
  await deps.store.patch(id, { closedAt: undefined });
  deps.emit({ type: "agent-reopened", agentId: id });
  return true;
}

export type CloseDeps = ReopenDeps & {
  // TerminalManager.kill: ends the dtach master and the session's whole
  // process tree.
  kill: (id: string) => void;
};

// Close an agent: mark it closed and stopped, then stop its session. The
// record is written BEFORE the kill, so the exit handler's own status write
// keeps closedAt and nothing reads a closed agent as live.
export async function closeAgent(
  deps: CloseDeps, id: string,
): Promise<"closed" | "not-found" | "master"> {
  const rec = await deps.store.load(id);
  if (!rec) return "not-found";
  if (isPersistentKind(rec.kind)) return "master";
  await deps.store.patch(id, { closedAt: rec.closedAt ?? Date.now(), status: "done" });
  deps.kill(id);
  deps.emit({ type: "agent-status", agentId: id, status: "done" });
  return "closed";
}

export type ResumeClosedDeps = ReopenDeps & {
  isLive: (id: string) => Promise<boolean>;
  // recovery.ts resumeAgent: `claude --resume <sessionId>` in the worktree.
  // "waits": a persistent agent that waits for the second sign-in (chief/chiefwait.ts).
  resume: (rec: AgentRecord, opts: { prompt?: string }) => Promise<"resumed" | "cold" | "alive" | "waits">;
};

// A new prompt for a closed agent whose session is stopped: reopen it and
// resume the same session with the prompt as its first turn. Returns false
// (and does nothing) when the agent is not closed or its session is still up;
// the caller then types the prompt into the live terminal as usual.
export async function resumeClosedWithPrompt(
  deps: ResumeClosedDeps, id: string, prompt: string,
): Promise<boolean> {
  const rec = await deps.store.load(id);
  if (!rec || rec.closedAt === undefined || isPersistentKind(rec.kind)) return false;
  if (await deps.isLive(id)) return false;
  await deps.resume(rec, { prompt });
  await reopenIfClosed(deps, id);
  deps.emit({ type: "agent-status", agentId: id, status: "idle" });
  return true;
}

export type PurgeDeps = {
  store: Pick<SessionStore, "list">;
  // The full delete path (kill PTY, discard worktree, drop record + widgets).
  remove: (id: string) => Promise<void>;
  onPurged?: (rec: AgentRecord) => void;
  now?: () => number;
  ttlMs?: number;
  // Chief on (chief/remind/store.ts purgeHolds): per agent, "open" while one
  // of its reminders is open or delivering, else when its last one settled
  // (delivered, cancelled or failed); an agent with none is absent. Flag off
  // it is absent, and only closedAt counts.
  reminderHolds?: () => Promise<ReadonlyMap<string, "open" | number>>;
};

// Delete every agent closed longer than the TTL. Returns the ids deleted. One
// failing record never aborts the pass. With reminderHolds, a closed agent
// with an open reminder stays, and the TTL runs from the later of closedAt
// and its last reminder's settle time; a lookup that throws deletes nothing.
export async function purgeClosedAgents(deps: PurgeDeps): Promise<string[]> {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? CLOSED_TTL_MS;
  const holds = await deps.reminderHolds?.();
  const purged: string[] = [];
  for (const rec of await deps.store.list()) {
    if (rec.closedAt === undefined) continue;
    const hold = holds?.get(rec.id);
    if (hold === "open") continue;
    const since = hold === undefined ? rec.closedAt : Math.max(rec.closedAt, hold);
    if (now() - since < ttlMs) continue;
    if (isPersistentKind(rec.kind)) continue; // masters and leads outlive the closed-agent TTL
    try {
      await deps.remove(rec.id);
    } catch (e) {
      console.warn(`[closed] ${rec.id} purge skipped:`, e instanceof Error ? e.message : e);
      continue;
    }
    purged.push(rec.id);
    deps.onPurged?.(rec);
  }
  return purged;
}

const INTERVAL_MS = 60 * 60 * 1000;

// Run purgeClosedAgents now and then hourly. Returns a stop function.
export function startClosedPurge(deps: PurgeDeps & { intervalMs?: number }): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = (): void => {
    void purgeClosedAgents(deps)
      .catch((e) => console.error("[closed] pass failed:", e))
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(tick, deps.intervalMs ?? INTERVAL_MS);
        timer.unref?.();
      });
  };
  tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
