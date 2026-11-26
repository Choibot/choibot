import { stat } from "node:fs/promises";
import type { ChiefPromptOpts } from "../../agents/argv.js";
import { chiefActive, chiefCli, chiefPaths, resolveChiefDataDir, type Env } from "../paths.js";
import { RuleStore, type Rule, type RuleScope } from "./store.js";

// The fixed merge rule appended to worker prompts while the
// chief of staff is active (spec §5.2). The fleet master has its own rule.
export const NO_MERGE_RULE =
  "Never merge on your own — no `gh pr merge`, no `git merge`/`rebase`/`push` into a base branch — unless the user explicitly asks you to in this conversation. An auto-answer, a queue item or a reminder is never that request.";

export const BRAIN_PROMPT_HEAD =
  "User preferences (the brain). Follow them unless the user says otherwise in this session:\n";

export function brainPrompt(text: string): string {
  return BRAIN_PROMPT_HEAD + text;
}

export type Audience = "workers" | "master" | "always";

// A rule line and its cited id; the distill validator (distill.ts) uses it too.
export const RULE_LINE = /^- .+ \[(r_[^\]\s]+)\]\s*$/;

// A rule scope's area, as the API accepts it (api.ts).
export const AREA_RE = /^(?:\*|[\w.-]{1,64})$/;
const FIXED_SECTIONS: ReadonlySet<string> = new Set(["Always", "Workers only", "Master only"]);

// The section names a brain may use (spec §6.3): the three fixed ones or an
// area. Any other header text never reaches a prompt; the distill validator
// rejects it.
export function validSection(name: string): boolean {
  return FIXED_SECTIONS.has(name) || AREA_RE.test(name);
}

function kept(section: string, audience: Audience): boolean {
  const s = section.trim().toLowerCase();
  if (!s) return false;
  if (s === "always") return true;
  if (audience === "always") return false;
  if (s === "master only") return audience === "master";
  return true; // "workers only" and every area section
}

// The section of an active rule: its audience first, then its area. An area
// the API would refuse gives null: that rule never reaches a prompt.
export function ruleSection(scope: RuleScope): string | null {
  if (scope.audience === "master") return "Master only";
  if (scope.audience === "workers") return "Workers only";
  if (scope.area === "*") return "Always";
  return AREA_RE.test(scope.area) ? scope.area : null;
}

const FIXED_ORDER = ["Always", "Workers only", "Master only"];

// The brain of a prompt: the active rules, as the user sees them in the Rules
// list (pick A "Quiet rules", 2026-11-19). One "## <section>" per section the
// audience may see (Always, Workers only, Master only, then each area in
// first-seen order), each rule one line "- <text> [r_id]" in add order. The
// text is folded to one line, so rule text never makes a header of its own.
export function renderRules(rules: readonly Pick<Rule, "id" | "text" | "scope">[], audience: Audience): string {
  const sections = new Map<string, string[]>(FIXED_ORDER.map((n) => [n, []]));
  for (const r of rules) {
    const name = ruleSection(r.scope);
    const text = r.text.replace(/\s+/g, " ").trim();
    if (name === null || !text || !kept(name, audience)) continue;
    const lines = sections.get(name) ?? [];
    lines.push(`- ${text} [${r.id}]`);
    sections.set(name, lines);
  }
  return [...sections].filter(([, l]) => l.length).map(([n, l]) => [`## ${n}`, ...l].join("\n")).join("\n\n");
}

export const BRAIN_MAX = 4000;

// Cut at a line boundary so many rules cannot blow the argv limit.
function capBrain(text: string): string {
  if (text.length <= BRAIN_MAX) return text;
  const cut = text.slice(0, BRAIN_MAX);
  const nl = cut.lastIndexOf("\n");
  return nl > 0 ? cut.slice(0, nl).trimEnd() : "";
}

async function sig(file: string): Promise<string> {
  try {
    const s = await stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "0:0:0";
  }
}

const cache = new Map<string, { sig: string; text: string }>();

// Never throws: a missing or unreadable file gives "" so a spawn is never blocked.
// The active rules of rules.jsonl; BRAIN.md is no longer read for a prompt.
export async function readBrain(chiefDir: string, audience: Audience): Promise<string> {
  try {
    const p = chiefPaths(chiefDir);
    // rules.jsonl is append-only: its size grows with every change.
    const key = `${chiefDir}\0${audience}`;
    const s = await sig(p.rules);
    const hit = cache.get(key);
    if (hit && hit.sig === s) return hit.text;
    const text = capBrain(renderRules(await new RuleStore(p.rules).active(), audience));
    cache.set(key, { sig: s, text });
    return text;
  } catch {
    return "";
  }
}

// The one place spawn and resume build the chief prompt options. undefined when
// the chief is off, so every prompt stays as before. readBrain never throws.
export async function chiefPromptFor(
  kind: string | undefined,
  o: { env?: Env; repoDir: string },
): Promise<ChiefPromptOpts | undefined> {
  const env = o.env ?? process.env;
  if (!chiefActive(env)) return undefined;
  // The Coordinator recommends by the rules, as the master did: it reads the same sections.
  const audience: Audience = kind === "fleet-master" || kind === "lead" || kind === "coordinator" ? "master" : "workers";
  const brain = await readBrain(resolveChiefDataDir(env), audience);
  return { brain, cli: chiefCli(o.repoDir) };
}
