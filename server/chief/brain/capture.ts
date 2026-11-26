// server/chief/brain/capture.ts — a user line into the brain (spec §6.2
// sources 1–2). Callers pass only lines the user typed: a composer line of a
// USER caller, an issue-thread reply, a Master-topic message. Every line goes
// to brain/decisions.jsonl; a line that starts with `rule:` also makes a
// user-line candidate from the rest of its first line, which then reaches the
// user as one "Make this a rule?" queue item (suggest.ts; no Telegram card).
// Best effort: an error is logged and never reaches the caller, so the line
// is still delivered.
import type { SessionStore } from "../../agents/store.js";
import { repoNameOf } from "../../master/events.js";
import { levelOfKind } from "../auth.js";
import { normalizeRuleText, type DecisionLog, type Rule, type RuleStore, type Via } from "./store.js";

export type CaptureLine = { text: string; via: Via; agentId?: string; prUrl?: string; repo?: string };
// onCandidate: a new candidate was made (index.ts: the suggester's sync). Never awaited.
export type CaptureDeps = { decisions: DecisionLog; rules: RuleStore; onCandidate?: (r: Rule) => void | Promise<void>; log?: (s: string) => void };

const RULE_PREFIX = /^rule:/i;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The candidate text of a `rule:` line: the rest of its first line, trimmed,
// or null. Not cut here: RuleStore.add redacts, then cuts to 200, then
// redacts again, so a secret across the cut is still found.
function ruleTextOf(text: string): string | null {
  const t = text.trim();
  if (!RULE_PREFIX.test(t)) return null;
  const rest = t.slice("rule:".length).split(/\r?\n/, 1)[0]!.trim();
  return normalizeRuleText(rest) ? rest : null;
}

// Never rejects. onCandidate is not awaited: the composer's 200 and the
// Telegram route must not wait on it.
export async function captureUserLine(d: CaptureDeps, line: CaptureLine): Promise<{ hint?: string }> {
  const log = d.log ?? ((s: string) => console.warn(s));
  const ids = {
    ...(line.agentId !== undefined ? { agentId: line.agentId } : {}),
    ...(line.prUrl !== undefined ? { prUrl: line.prUrl } : {}),
  };
  try {
    await d.decisions.append({ by: "user", correction: null, via: line.via, ...ids,
      ...(line.repo !== undefined ? { repo: line.repo } : {}), text: line.text });
  } catch (e) {
    log(`[chief] capture: decision line failed: ${errText(e)}`);
  }
  const text = ruleTextOf(line.text);
  if (text === null) return {};
  try {
    const { rule, duplicate } = await d.rules.add({ text, state: "candidate", scope: { area: "*", audience: "all" },
      kind: "preference", source: { origin: "user-line", via: line.via, ...ids } });
    if (duplicate) return { hint: `Already a rule (${rule.id}).` };
    const next = d.onCandidate;
    if (next) {
      void Promise.resolve().then(() => next(rule))
        .catch((e: unknown) => log(`[chief] capture: candidate ${rule.id} follow-up failed: ${errText(e)}`));
    }
  } catch (e) {
    log(`[chief] capture: rule candidate failed: ${errText(e)}`);
  }
  return {};
}

// The `via`, `prUrl` and `repo` of a composer line, from the agent record
// (spec §6.2): `master-tab` for the fleet master, `composer` for every other
// kind (the cron master and leads included). No record: `composer` alone.
export async function composerLineOf(agents: Pick<SessionStore, "load">, agentId: string):
  Promise<{ via: "composer" | "master-tab"; prUrl?: string; repo?: string }> {
  const rec = await agents.load(agentId);
  if (!rec) return { via: "composer" };
  return { via: levelOfKind(rec.kind) === "master" ? "master-tab" : "composer", repo: repoNameOf(rec),
    ...(rec.prUrl ? { prUrl: rec.prUrl } : {}) };
}
