// server/master/quiet.ts — the fleet master's quiet policy (order of
// 2026-11-10): the queue is the one place the user looks at, so the master's
// digest carries only alerts. Built in index.ts on an active chief core only;
// with the flag off nothing here runs.
//
// What the policy does to the master's digest (EventQueue, `quiet` dep):
//   errored, lead-errored, service crashed   always pass
//   cron <name> all-clear | needs-you |      always pass: the reader of the runs
//     did-not-finish | ok (no result line)   adds a queue item when one needs the user
//   waiting      held until the agent waited BLOCKED_ALERT_MS and the user did
//                not type to it within USER_PRESENT_MS
//   finished, pr-opened                      not alerts: no line
//   queue pr | preview                       no line (never the master's to answer)
//   queue choice | question                  a line only when an active brain
//                                            rule can match the item
//   lead-report                              a line unless the lead marked the
//                                            report `needs: "none"`
// The user's own lines, `[queue <id>]` answers and `[reminder <id>]` lines do
// not go through the EventQueue: nothing here can filter them.
// A lead's queue has its own version of this policy: chief/leads/quiet.ts.
import { isPersistentAgentId, type ItemKind } from "../chief/kinds.js";
import type { Rule } from "../chief/brain/store.js";
import type { QueueItem } from "../chief/queue/types.js";
import { stripReports } from "./draft.js";

// The user is "present" in an agent's chat for this long after the last line
// sent from its composer or key typed in its terminal or its prompt card. A
// queue answer or a reminder the console types for the user does not count.
export const USER_PRESENT_MS = 10 * 60_000;
// A waiting agent is an alert only after this long with no status change.
export const BLOCKED_ALERT_MS = 15 * 60_000;

// Test only: an isolated instance (scripts/chief-instance.sh, CHIEF_TEST=1)
// may shorten the two windows with CHIEF_TEST_QUIET_PRESENT_MS and
// CHIEF_TEST_QUIET_BLOCKED_MS, so a scripted scene needs no 15 minute wait.
// Without CHIEF_TEST=1 (the live console never has it) both are ignored.
export function quietWindows(env: Record<string, string | undefined> = process.env): { presentMs: number; blockedMs: number } {
  const test = (key: string, std: number): number => {
    const n = Number(env[key]);
    return env.CHIEF_TEST === "1" && Number.isSafeInteger(n) && n > 0 ? n : std;
  };
  return {
    presentMs: test("CHIEF_TEST_QUIET_PRESENT_MS", USER_PRESENT_MS),
    blockedMs: test("CHIEF_TEST_QUIET_BLOCKED_MS", BLOCKED_ALERT_MS),
  };
}

// What the EventQueue asks of the policy.
export type QuietPolicy = {
  // Default BLOCKED_ALERT_MS (quietWindows gives another value only under CHIEF_TEST=1).
  blockedMs?: number;
  userPresent(agentId: string): boolean;
  // May a choice or question item's line go to the master?
  queueEcho(itemId: string): Promise<boolean>;
  now?: () => number;
  // A lead's queue only (chief/leads/quiet.ts): a `finished` is held as a `waiting` is, a due
  // held line goes out only when explained() is false, and no service line enters.
  lead?: { explained(agentId: string): Promise<boolean> };
};

// When the user last typed to each agent from the browser. In memory only: a
// restart forgets it, and then a waiting agent's line passes (the safe side).
export class UserPresence {
  private at = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}

  // `data`: a web input chunk. The browser's own terminal reports (focus,
  // cursor position) are not typing.
  mark(agentId: string, data: string): void {
    if (stripReports(data) !== "") this.touch(agentId);
  }

  // The user sent a composer line to the agent.
  touch(agentId: string): void {
    this.at.set(agentId, this.now());
  }

  recent(agentId: string, windowMs: number = USER_PRESENT_MS): boolean {
    const t = this.at.get(agentId);
    return t !== undefined && this.now() - t < windowMs;
  }
}

// The kinds the master may recommend on or auto-answer (spec §5.6 check 2).
// Never the console's own deploy ticket (spec §5.7): that one is the user's.
export function masterMayAnswer(kind: ItemKind): boolean {
  return kind === "choice" || kind === "question";
}

// The pre-filter of the queue echo: an active rule whose scope fits the item
// (spec §5.6 check 10). The master then decides to recommend, to auto-answer
// or to do nothing.
export function ruleCanMatch(rule: Pick<Rule, "state" | "scope">, item: Pick<QueueItem, "area" | "repo" | "kind">): boolean {
  if (rule.state !== "active") return false;
  const s = rule.scope;
  return (s.area === "*" || s.area === item.area)
    && (s.repo === undefined || s.repo === item.repo)
    && (s.kind === undefined || s.kind === item.kind);
}

// QuietPolicy.queueEcho on the queue and rule stores. An item of a master or
// a lead is the user's alone (§5.3): no line. A read that fails, or an item
// that is not found, passes: when the console cannot tell, the master gets
// the line, as before.
export function masterQueueEcho(d: {
  queue: { get(id: string): Promise<QueueItem | null> };
  rules: { active(): Promise<Rule[]> };
  log?: (s: string) => void;
}): (itemId: string) => Promise<boolean> {
  const log = d.log ?? ((s: string) => console.warn(s));
  return async (itemId) => {
    try {
      const item = await d.queue.get(itemId);
      if (!item) return true;
      if (!masterMayAnswer(item.kind) || isPersistentAgentId(item.agentId)) return false;
      return (await d.rules.active()).some((r) => ruleCanMatch(r, item));
    } catch (e) {
      log(`[master] queue echo check of ${itemId} failed (the line passes): ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
  };
}

// `choibot leads report` stdin {"text": "...", "needs": "none" | "decision" | "problem"}.
export const LEAD_REPORT_NEEDS = ["none", "decision", "problem"] as const;
export type LeadReportNeeds = (typeof LEAD_REPORT_NEEDS)[number];

// A lead report reaches the master unless the lead marked it a pure status
// report. A report with no `needs` (a lead launched before this field) passes.
export function leadReportIsAlert(needs: LeadReportNeeds | undefined): boolean {
  return needs !== "none";
}
