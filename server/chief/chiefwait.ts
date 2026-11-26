// server/chief/chiefwait.ts — the wait of the persistent agents for the second sign-in (the
// rule: "the person signs in a second time only when they turn on
// the fleet master, a lead or the background helper"). The fleet master, a lead and the
// Coordinator run as the second account (chiefaccount.ts), with that account's own Claude login.
// Without it, Claude would start at its login screen. So resumeAgent (agents/recovery.ts), the one
// path that starts them (boot, relaunch, reconcile, each ensure), asks first: while that login is
// not there, no session starts and the agent WAITS. It is not an error: no throw, no ticket, no
// status change, one log line per agent and process. When the sign-in ends, the console starts
// what waits.
import { runsAsChief } from "./chiefaccount.js";

export type ChiefWaitDeps = {
  // Whether the second account has its Claude login (agentlogin.ts AgentLoginStatus, kept 60 s).
  signedIn: () => Promise<boolean>;
  // Why the server cannot make that sign-in (its settings, its helper), null when it can: the
  // log line names it.
  cause?: () => string | null;
  log?: (s: string) => void;
  now?: () => number;
};

export class ChiefWait {
  private waiting = new Map<string, number>();
  // The agents that waited since this process started, until forgetWaited (the page names what
  // got lost meanwhile, one time).
  private waited = new Set<string>();
  private logged = new Set<string>();
  private listeners: Array<(ids: string[]) => void | Promise<void>> = [];
  constructor(private d: ChiefWaitDeps) {}

  // Whether `id` may start now. False: it waits for the second sign-in, and nothing starts.
  async mayStart(id: string): Promise<boolean> {
    if (!runsAsChief(id)) return true;
    if (await this.d.signedIn().catch(() => false)) {
      this.waiting.delete(id);
      return true;
    }
    if (!this.waiting.has(id)) this.waiting.set(id, (this.d.now ?? Date.now)());
    this.waited.add(id);
    if (!this.logged.has(id)) {
      this.logged.add(id);
      const cause = this.d.cause?.() ?? null;
      (this.d.log ?? ((s: string) => console.warn(s)))(`[chief] ${id} waits for the second sign-in (the login of the fleet master, the leads and the Coordinator): ${cause ? `the server is not ready for it: ${cause}` : "it is not signed in yet"}; it starts after it`);
    }
    return false;
  }

  // The agents that wait now, oldest first.
  waits(): string[] {
    return [...this.waiting.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  }
  waitsFor(id: string): boolean {
    return this.waiting.has(id);
  }

  hasWaited(id: string): boolean {
    return this.waited.has(id);
  }
  forgetWaited(id: string): void {
    this.waited.delete(id);
  }

  onSignedIn(fn: (ids: string[]) => void | Promise<void>): void {
    this.listeners.push(fn);
  }

  // The second sign-in ended: what waits starts (each listener starts its own kind).
  async signedInNow(): Promise<void> {
    const ids = this.waits();
    this.waiting.clear();
    this.logged.clear();
    for (const fn of this.listeners) {
      try { await fn(ids); } catch (e) { (this.d.log ?? console.warn)(`[chief] a start after the second sign-in failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
}

// The starts after the second sign-in. Each start runs on its own: one that fails stops no other
// (the master's failure never keeps a lead from starting). An agent whose start fails here comes
// back by its usual path: the fleet master at the next message or the next open of the Master
// tab (ensureFleet), the Coordinator by its feed (once a minute while it is down), a lead at the
// next order to it or the next boot (bootLeads).
export type WaitedStarts = {
  master: () => Promise<unknown>;
  masterKnown: () => Promise<boolean>;
  coordinator?: () => Promise<unknown>;
  coordinatorKnown: () => Promise<boolean>;
  lead?: (area: string) => Promise<unknown>;
  log?: (s: string) => void;
};

export async function startWaited(ids: string[], s: WaitedStarts): Promise<void> {
  const log = s.log ?? ((x: string) => console.warn(x));
  const one = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    try { await fn(); } catch (e) { log(`[chief] ${what} did not start after the second sign-in: ${e instanceof Error ? e.message : String(e)}`); }
  };
  if (ids.includes("fleet-master") || (await s.masterKnown().catch(() => false))) await one("fleet-master", s.master);
  if (s.coordinator && (ids.includes("coordinator") || (await s.coordinatorKnown().catch(() => false)))) await one("coordinator", s.coordinator);
  const lead = s.lead;
  if (lead) for (const id of ids.filter((x) => x.startsWith("lead-"))) await one(id, () => lead(id.slice("lead-".length)));
}
