// server/agents/exit.ts
// The TerminalManager onExit handler of index.ts: a PTY exit → the terminal is
// forgotten by the manager; reflect it as status + persist. One rule on top of
// today's: an id in `relaunching` is a PTY a chief relaunch killed on purpose
// (spec §5.2), so it gets no `done` patch and no `agent-status` event (no
// Telegram "finished", no digest line). The handler only reads the set;
// relaunchForChief owns adding and removing ids.
import type { EventHub } from "../events.js";
import type { SessionStore } from "./store.js";

export function agentExitHandler(d: {
  // Getter: index.ts assigns `services` after `new TerminalManager`.
  // Exits never fire before it is set (no PTY is spawned until a route hits).
  services: () => { handleExit(id: string, code: number, killed: boolean): boolean };
  store: Pick<SessionStore, "patch">;
  hub: Pick<EventHub, "emitEvent">;
  relaunching: ReadonlySet<string>;
  // The ids that the console ends on purpose and in silence ("Sign out" of a login, agents/api.ts
  // adds them before the kill): their record is "done", and the event says `quiet`. The handler
  // takes each id out of the set.
  quiet?: Set<string>;
}): (id: string, code: number, killed: boolean) => void {
  return (id, code, killed) => {
    // A service PTY (svc:…) is managed by the ServiceManager — it owns
    // auto-restart/backoff/breaker, so don't fall through to the agent path.
    if (d.services().handleExit(id, code, killed)) return;
    if (d.relaunching.has(id)) return;
    if (d.quiet?.delete(id)) {
      void d.store.patch(id, { status: "done" }).catch((e) =>
        console.warn(`[exit] ${id} patch failed:`, e instanceof Error ? e.message : e));
      d.hub.emitEvent({ type: "agent-status", agentId: id, status: "done", quiet: true });
      return;
    }
    const status = killed || code === 0 ? "done" : "error";
    // Fire-and-forget, but never unhandled: a rejection would become an
    // uncaughtException, and index.ts exits on those.
    void d.store.patch(id, { status }).catch((e) =>
      console.warn(`[exit] ${id} patch failed:`, e instanceof Error ? e.message : e));
    d.hub.emitEvent({ type: "agent-status", agentId: id, status });
  };
}
