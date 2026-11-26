// server/chief/brain/suggest.ts — a candidate rule reaches the user as ONE queue item (pick A
// "Quiet rules", 2026-11-19): kind choice, title "Make this a rule?", the rule text and where it
// came from in the body, options Yes / No, and a reply (Edit) that becomes the rule text. At most
// OPEN_MAX such items are open at a time and at most WEEK_MAX are made in 7 days; the other
// candidates wait, oldest first. The answer acts in QueueActions.answerRule (user only).
//
// sync() is the one reconciler, on one chain: it withdraws an open item whose rule is no longer
// a candidate (confirmed or retired elsewhere), retires a candidate whose item the user withdrew
// (the user dismissed it), and makes the items that the limits allow. Items are the console's
// own (agentId CONSOLE_AGENT_ID): no agent gets them, the master never recommends or answers them.
//
// The candidates made before the suggester first ran (most are one-time answers of the old
// capture) wait for `choibot brain triage`: they get an item only once the user has kept them, which
// the triage marks with an edit event (latestEditSeq). The first run's time is in `stateFile`.
import { CONSOLE_AGENT_ID } from "../deploy/ticket.js";
import { atomicWrite, onChain, readJson } from "../files.js";
import type { QueueStore } from "../queue/store.js";
import { isRuleSuggestion, type QueueItem } from "../queue/types.js";
import { RULE_CHANGED, RULE_NO, RULE_YES } from "../queue/actions.js";
import type { Rule, RuleStore } from "./store.js";

export const OPEN_MAX = 3;
export const WEEK_MAX = 5;
export const SUGGEST_TITLE = "Make this a rule?";
export const SUGGEST_REPO = "rules";
const WEEK_MS = 7 * 24 * 60 * 60_000;
const SYNC_MS = 60_000;
const DISMISSED = "dismissed in the queue";

const isOpen = (i: QueueItem): boolean => i.status === "open" || i.status === "snoozed";
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

// Where the candidate came from, in one line.
export function sourceLine(r: Rule): string {
  const s = r.source;
  switch (s.origin) {
    case "user-line":
      return s.via === "queue-tab" || s.via === "queue-telegram" ? "From: your answer to a queue item." : "From: your line that starts with \"rule:\".";
    case "master": return "From: the fleet master, after your chat.";
    case "distill": return "From: the nightly review of your answers.";
    case "memory": return `From: the memory file ${oneLine(s.memoryFile ?? "")}.`;
    case "panel": return "From: the Rules list.";
  }
}

// Who the rule is for, when it is not every agent: the prompt shows it to them only.
export function scopeNote(r: Rule): string {
  const s = r.scope;
  if (s.audience === "master") return " For the master and the leads only.";
  if (s.audience === "workers") return " For workers only.";
  return s.area === "*" ? "" : ` For area ${oneLine(s.area)} only.`;
}

// The item body: the rule text as one line (plain text; every surface renders it as item text),
// then one line: where it came from, and who it is for.
export const suggestBody = (r: Rule): string => `${oneLine(r.text)}\n\n${sourceLine(r)}${scopeNote(r)}`;

export class RuleSuggester {
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private readonly key: string;

  constructor(private readonly d: { rules: RuleStore; store: QueueStore; stateFile: string; now?: () => number; log?: (s: string) => void }) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
    this.key = `rule-suggest:${d.store.dir}`;
  }

  // Never rejects: a failure is logged, and the next sync tries again.
  sync(): Promise<void> {
    return onChain(this.key, () => this.once()).catch((e: unknown) => this.log(`[chief] rule suggestions failed: ${errText(e)}`));
  }

  // A sync now, then every SYNC_MS. The returned function stops it.
  start(): () => void {
    void this.sync();
    const t = setInterval(() => void this.sync(), SYNC_MS);
    t.unref?.();
    return () => clearInterval(t);
  }

  // When the suggester first ran; written on the first sync.
  private async since(): Promise<number> {
    const s = await readJson<{ since?: unknown }>(this.d.stateFile);
    if (s && typeof s.since === "number" && Number.isFinite(s.since)) return s.since;
    const since = this.now();
    await atomicWrite(this.d.stateFile, JSON.stringify({ since }));
    return since;
  }

  private async once(): Promise<void> {
    const { rules, store } = this.d;
    const first = await this.since();
    const byId = new Map((await rules.all()).map((r) => [r.id, r] as const));
    const items = (await store.list()).filter(isRuleSuggestion);
    const asked = new Set<string>();
    let open = 0;
    for (const item of items) {
      const id = item.rule!.id;
      asked.add(id);
      const r = byId.get(id);
      if (isOpen(item)) {
        if (r?.state === "candidate") open += 1;
        else await this.close(item.id);
      } else if (item.status === "withdrawn" && item.lastError === undefined && r?.state === "candidate") {
        // The user withdrew it: a no, softly worded.
        await rules.retire(id, { by: "user", why: DISMISSED });
      }
    }
    const since = this.now() - WEEK_MS;
    const week = items.filter((i) => i.createdAt >= since).length;
    let room = Math.min(OPEN_MAX - open, WEEK_MAX - week);
    if (room <= 0) return;
    const waiting = [...byId.values()]
      .filter((r) => r.state === "candidate" && !asked.has(r.id) && (r.createdAt >= first || r.latestEditSeq !== undefined))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    for (const r of waiting) {
      if (room <= 0) break;
      await store.add({
        kind: "choice", agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" },
        repo: SUGGEST_REPO, area: SUGGEST_REPO, title: SUGGEST_TITLE, body: suggestBody(r), blocking: false,
        choice: { options: [{ key: RULE_YES, label: "Yes" }, { key: RULE_NO, label: "No" }] },
        rule: { id: r.id },
      });
      room -= 1;
    }
  }

  // An open item whose rule changed elsewhere: withdrawn, with the reason.
  private async close(id: string): Promise<void> {
    const { store } = this.d;
    await store.withItem(id, async () => {
      const item = await store.get(id);
      if (!item || !isOpen(item)) return;
      const { snoozedUntil: _ended, ...rest } = item;
      await store.write({ ...rest, status: "withdrawn", lastError: RULE_CHANGED, closedAt: this.now() });
    });
  }
}
