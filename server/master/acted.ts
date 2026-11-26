// server/master/acted.ts — which agents the fleet master itself just acted on,
// so its own stop/resume/delete does not come back to it as news. The CLI
// (bin/lib/agents.ts) sends ACTOR_HEADER: FLEET_ACTOR; the agent routes mark
// the id BEFORE they emit their agent-status event.
export const ACTOR_HEADER = "x-choibot-actor";
export const FLEET_ACTOR = "fleet-master";
export const ACT_SUPPRESS_MS = 60_000;

export class ActedLog {
  private at = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  mark(id: string): void { this.at.set(id, this.now()); }
  recent(id: string): boolean {
    const t = this.at.get(id);
    return t !== undefined && this.now() - t < ACT_SUPPRESS_MS;
  }
}
