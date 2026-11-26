// bin/lib/triage.ts — `choibot brain triage`: the one-time cleanup of the candidate rules made
// before pick A "Quiet rules" (2026-11-19). Each candidate is a standing rule (kept: an edit
// with its own text marks it, and it then reaches the user as a "Make this a rule?" queue item
// under the suggestion limits, brain/suggest.ts) or a one-time answer (retired, why "triage").
// A jev score from 0.2 to 0.8 is not a decision (the user's rule for jev): that text is kept
// too, in its own "not sure" list, and the user decides on its "Make this a rule?" item. The test is the one of standing.ts; the
// texts it does not settle go to `jev` (one batch call) when jev is on PATH, else to the marker
// words. Active rules that BRAIN.md shows in other words get that wording, so the prompt (now
// the active rules) says what it said before. Dry run by default; the plan is printed as JSON.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULE_LINE } from "../../server/chief/brain/prompt.js";
import { hasStandingMarker, oneTimeReason } from "../../server/chief/brain/standing.js";
import { WEEK_MAX } from "../../server/chief/brain/suggest.js";
import { run } from "./exec.js";

export type TriageRule = { id: string; text: string; state: string };
// The yes-probability that each text is a standing rule, by id; null when no judge ran.
export type Judge = (texts: { id: string; text: string }[]) => Promise<Map<string, number> | null>;
export type TriagePlan = {
  candidates: number; judge: "jev" | "markers";
  keep: { id: string; text: string; why: string }[];
  // Kept as keep is: jev was not sure (a score from DROP_BELOW to KEEP_FROM).
  notSure: { id: string; text: string; why: string }[];
  drop: { id: string; text: string; why: string }[];
  reword: { id: string; from: string; to: string }[];
  // How many weeks the kept rules (keep + notSure) take to be asked, at WEEK_MAX a week.
  weeks: number;
};

// jev: a score of KEEP_FROM or more keeps, below DROP_BELOW drops, the band between is not sure.
export const KEEP_FROM = 0.8;
export const DROP_BELOW = 0.2;
export const TRIAGE_WHY = "triage";

const QUESTION = "Is `text` a standing rule for a fleet of coding agents: an instruction the user wants applied to all"
  + " later work (like \"always …\", \"never …\", \"from now on …\", \"use X for Y\")? Answer no for a one-time"
  + " answer, a question, feedback on one design or screen, a status remark, or an order for one task.";

// One `jev batch` call: each text is its own question over its own state field.
export const jevJudge: Judge = async (texts) => {
  if (texts.length === 0) return new Map();
  const dir = mkdtempSync(join(tmpdir(), "choibot-triage-"));
  try {
    const file = join(dir, "batch.json");
    const state: Record<string, string> = {};
    const questions: Record<string, { type: "noul"; instructions: string }> = {};
    for (const t of texts) {
      state[t.id] = t.text;
      questions[t.id] = { type: "noul", instructions: QUESTION.replace("`text`", `\`${t.id}\``) };
    }
    writeFileSync(file, JSON.stringify({ state, questions }), { mode: 0o600 });
    const r = await run("jev", ["batch", file, "-v"]);
    if (r.code !== 0) return null;
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    const m = new Map<string, number>();
    for (const t of texts) if (typeof out[t.id] === "number") m.set(t.id, out[t.id] as number);
    return m;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// The rule texts BRAIN.md shows, by id: a line that cites one rule only.
function brainWording(brain: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of brain.split(/\r?\n/)) {
    const m = RULE_LINE.exec(line);
    if (!m || (line.match(/\[r_/g)?.length ?? 0) !== 1) continue;
    const text = line.slice(2, line.lastIndexOf(" [")).trim();
    if (text) out.set(m[1], text);
  }
  return out;
}

export async function triagePlan(rules: TriageRule[], brain: string, judge: Judge | null): Promise<TriagePlan> {
  const cands = rules.filter((r) => r.state === "candidate");
  const keep: TriagePlan["keep"] = [];
  const notSure: TriagePlan["notSure"] = [];
  const drop: TriagePlan["drop"] = [];
  const open: { id: string; text: string }[] = [];
  for (const r of cands) {
    const why = oneTimeReason(r.text);
    if (why !== null) drop.push({ id: r.id, text: r.text, why });
    else open.push({ id: r.id, text: r.text });
  }
  const p = judge ? await judge(open) : null;
  for (const r of open) {
    const yes = p?.get(r.id);
    if (yes !== undefined) {
      (yes >= KEEP_FROM ? keep : yes < DROP_BELOW ? drop : notSure).push({ id: r.id, text: r.text, why: `jev ${yes.toFixed(2)}` });
    } else {
      const marked = hasStandingMarker(r.text);
      (marked ? keep : drop).push({ id: r.id, text: r.text, why: marked ? "a marker word" : "no marker word" });
    }
  }
  const words = brainWording(brain);
  const reword: TriagePlan["reword"] = [];
  for (const r of rules) {
    const to = words.get(r.id);
    if (r.state === "active" && to !== undefined && to !== r.text) reword.push({ id: r.id, from: r.text, to });
  }
  const weeks = Math.ceil((keep.length + notSure.length) / WEEK_MAX);
  return { candidates: cands.length, judge: p ? "jev" : "markers", keep, notSure, drop, reword, weeks };
}
