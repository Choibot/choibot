// server/cron/result.ts — what the page says of one run, from the run's own text. The text is
// written by the task's agent: it is untrusted, shown as plain text only, one line, with a limit.
// The state is one of fixed values, and a run that did not finish is never anything else.
// A link is shown only for a ticket of this console or a GitHub pull request address.
import type { CronRunResult } from "../../bin/lib/cronspec.js";
import { plainLine, SENTENCE_MAX, WHY_WORDS } from "../../bin/lib/cron-result.mjs";
import { ITEM_ID_RE } from "../chief/queue/store.js";
import { PR_URL_RE } from "../master/events.js";

export { plainLine, SENTENCE_MAX };
// The runner keeps the last TAIL_CHARS of the output (bin/cron-runner.mjs): a tail of this
// length is cut, so its first line can start in the middle of a sentence.
const TAIL_CHARS = 4000;

/** The first line with text of a run's output, as plain text; null when the output is cut or empty. */
export function firstSentence(outputTail: string): string | null {
  if (outputTail.length >= TAIL_CHARS) return null;
  for (const line of outputTail.split("\n")) {
    const t = plainLine(line);
    if (/[\p{L}\p{N}]/u.test(t)) return t;
  }
  return null;
}

// ---- the result of a run -------------------------------------------------------

/** clear: all clear. needs: a person must look. failed: did not finish. done: finished, with no result line. */
export type RunState = "clear" | "needs" | "failed" | "done";
export type RunLink =
  | { kind: "pr"; url: string; label: string }
  | { kind: "ticket"; id: string; title: string; open: boolean };
export type RunView = { state: RunState; sentence: string | null; links: RunLink[] };

/** A ticket of this console's queue (null: no such ticket, or no queue). */
export type TicketLookup = (id: string) => Promise<{ title: string; open: boolean } | null>;

export const LINKS_MAX = 3;
const TICKET_TITLE_MAX = 80;
const STATES: Record<string, RunState> = { "all-clear": "clear", "needs-you": "needs" };

/** The fixed words of why a run did not finish; null for a value that is not one of RUN_WHYS. */
export function whyWords(why: unknown): string | null {
  return typeof why === "string" && Object.hasOwn(WHY_WORDS, why) ? WHY_WORDS[why as keyof typeof WHY_WORDS] : null;
}

// `noted`: the ticket that the reader of the run linked to it (`cron note`): the first link.
async function linksOf(refs: unknown, ticket: TicketLookup, noted?: string): Promise<RunLink[]> {
  const all = [...(noted ? [noted] : []), ...(Array.isArray(refs) ? refs.slice(0, 8) : [])];
  const links: RunLink[] = [];
  const seen = new Set<string>();
  // A run can name many things: only the first few are read at all.
  for (const raw of all) {
    if (links.length >= LINKS_MAX) break;
    if (typeof raw !== "string") continue;
    const ref = raw.trim();
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (PR_URL_RE.test(ref)) {
      const [, , , owner, repo, , number] = ref.split("/");
      links.push({ kind: "pr", url: ref, label: `PR #${number} · ${owner}/${repo}` });
    } else if (ITEM_ID_RE.test(ref)) {
      const t = await ticket(ref).catch(() => null);
      if (t) links.push({ kind: "ticket", id: ref, title: plainLine(t.title, TICKET_TITLE_MAX), open: t.open });
    }
  }
  return links;
}

/** The result state of a run that finished ("all-clear" or "needs-you"); null: none (or not one of these). */
export function resultState(run: Pick<CronRunResult, "result">): "all-clear" | "needs-you" | null {
  const s = run.result && typeof run.result === "object" ? run.result.state : undefined;
  return s === "all-clear" || s === "needs-you" ? s : null;
}

/**
 * What the page shows for one run. A run that did not finish (a non-zero exit, a time-out, no
 * start) is "failed" whatever the task wrote of itself: its only link is the ticket that the
 * reader of the run linked to it (`noted`, a ticket id of `cron note`).
 */
export async function runView(run: CronRunResult, ticket: TicketLookup = async () => null, noted?: string): Promise<RunView> {
  if (!run.ok) return { state: "failed", sentence: whyWords(run.why), links: await linksOf([], ticket, noted) };
  const r = run.result;
  const result = resultState(run);
  if (result === null) return { state: "done", sentence: firstSentence(run.outputTail), links: await linksOf([], ticket, noted) };
  const said = typeof r!.sentence === "string" ? plainLine(r!.sentence) : "";
  return { state: STATES[result], sentence: /[\p{L}\p{N}]/u.test(said) ? said : null, links: await linksOf(r!.refs, ticket, noted) };
}
