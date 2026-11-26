// server/agents/sweep.ts
// Mid-life death detection. reconcileAgents() heals agents at boot, but a
// session can also die while the server keeps running — an OOM kill, an
// external `pkill`, a crash. Nothing then corrects the record, so the rail goes
// on showing "running" for an agent with no terminal behind it. This sweep runs
// on a timer and marks those records `error`, which turns the row red, swaps
// Stop for Resume, and (via the Notifier) sends one Telegram ping.
//
// It never relaunches anything: an OOM-killed agent that is auto-resumed tends
// to be killed again, and a sweep that resumes on every tick would thrash.
// Recovery stays a deliberate click on Resume.
import type { AgentRecord, SessionStore } from "./store.js";
import type { TerminalManager } from "./terminal.js";

export type SweepDeps = {
  store: Pick<SessionStore, "list" | "patch">;
  terminals: Pick<TerminalManager, "has" | "hasSession">;
  // Called after the record is patched — the caller emits the status event.
  onDead: (rec: AgentRecord) => void;
  now?: () => number;
  graceMs?: number;
  // Ids to leave alone: index.ts passes `relaunching.has` — a chief relaunch
  // (spec §5.2) kills the PTY on purpose, and between the exit and the respawn
  // the record has no terminal and no session.
  skip?: (id: string) => boolean;
  // Agents that WAIT for a login (the second sign-in's wait, chief/chiefwait.ts, or the hold of
  // a signed-out login, loginhold.ts): they have no session on purpose. Not dead: no "error", no
  // ping (before, the sweep marked such a fleet master "error" while it only waited).
  waits?: (id: string) => boolean;
};

// A record is only "born" once its PTY is spawned, which happens a beat after
// store.save() (see the create route in api.ts). Ignore anything younger than
// this so a just-created agent is never buried in that window.
const GRACE_MS = 30_000;

// `done`/`error` are terminal: the user has seen them. Re-marking would resend
// the Telegram ping on every tick.
function isLiveStatus(s: AgentRecord["status"]): boolean {
  return s === "running" || s === "idle";
}

// Mark every agent the store believes is alive but whose session is gone.
// Returns the ids marked. One failing record never aborts the pass.
export async function sweepDeadAgents(deps: SweepDeps): Promise<string[]> {
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? GRACE_MS;
  const marked: string[] = [];
  for (const rec of await deps.store.list()) {
    if (!isLiveStatus(rec.status)) continue;
    if (now() - rec.createdAt <= graceMs) continue;
    if (deps.skip?.(rec.id)) continue;                 // being relaunched
    if (deps.waits?.(rec.id)) continue;                // waits for a login
    if (deps.terminals.has(rec.id)) continue;          // attached here
    try {
      if (await deps.terminals.hasSession(rec.id)) continue; // reattachable
      // Re-check after the await, with no await before the patch: a relaunch
      // may have started (skip) or finished (has) meanwhile. skip first, has
      // second: the respawn is tracked before the id leaves the set, so one
      // of the two holds in every interleaving.
      if (deps.skip?.(rec.id)) continue;
      if (deps.terminals.has(rec.id)) continue;
      // A closed agent whose session ended (one closed before close stopped
      // sessions) is just stopped: no error, no Telegram ping.
      if (rec.closedAt !== undefined) {
        await deps.store.patch(rec.id, { status: "done" });
        continue;
      }
      await deps.store.patch(rec.id, { status: "error" });
    } catch (e) {
      console.warn(`[sweep] ${rec.id} skipped:`, e instanceof Error ? e.message : e);
      continue;
    }
    marked.push(rec.id);
    deps.onDead(rec);
  }
  return marked;
}

export type SweepLoopDeps = SweepDeps & {
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
};

const INTERVAL_MS = 60_000;

// Run sweepDeadAgents forever, rescheduling only after each pass completes so
// two passes can never overlap. Returns a stop function.
export function startDeadAgentSweep(deps: SweepLoopDeps): () => void {
  const intervalMs = deps.intervalMs ?? INTERVAL_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.(); // a pending sweep must never hold the process open
    return { clear: () => clearTimeout(h) };
  });
  let timer: { clear: () => void } | null = null;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimer(tick, intervalMs);
  };
  function tick(): void {
    void sweepDeadAgents(deps)
      .catch((e) => console.error("[sweep] pass failed:", e))
      .finally(schedule);
  }
  schedule();
  return () => { stopped = true; timer?.clear(); timer = null; };
}
