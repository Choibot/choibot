// server/agents/stopwhy.ts — why the last turn of a Claude agent stopped, from its session
// file: the last line of the conversation is an error of the Claude program that says "your
// plan is at its limit", "this model does not work" or "this login is signed out". Then the
// agent did not end its work: it was cut. The console shows that in plain words, and after a
// move to another login it tells the agent to go on (api.ts).
// A limit can also cut a turn with no error line at the end: Claude tells the agent that the
// limit is reached and gives it a short allowance, and the agent ends with a note of its own
// ("the usage limit was reached, so I stop here"). That turn is cut too (LIMIT_NOTE_RE).
//
// Pure but for readStop (one read of the end of the file). No line of the file leaves this
// module but the one error line, cut to one short line.
import { LOGIN_RE } from "./loginwords.mjs";
import { openTranscript, type Transcript } from "./sessionread.js";

// The end of the file that is read: the last lines of a session.
const TAIL_BYTES = 128 * 1024;
const TEXT_MAX = 200;

export type StopWhy = {
  // limit: the plan, or one model of it, has no room. model: the model of the session does not
  // work for this login (not there, no access). login: the login is signed out (its token was
  // revoked or is gone): no agent can work on it until the user signs in again.
  why: "limit" | "model" | "login";
  // The line of the Claude program, as one short line.
  text: string;
  // The time of that line in the session file (ms), when it has one.
  lineAt?: number;
};

// The words of Claude Code for a plan at its limit ("You've hit your Fable limit · resets …",
// "Claude usage limit reached", "out of extra usage").
const LIMIT_RE = /usage limit|limit reached|hit your [\w .-]{0,40}limit|out of (extra )?usage|rate[_ -]?limit|\b429\b/i;
// "There's an issue with the selected model (…). It may not exist or you may not have access to it."
const MODEL_RE = /issue with the selected model|model[^.]{0,60}(may not exist|not (found|available|supported)|do(es)? not have access|no access)|invalid model/i;

// A login that is signed out: LOGIN_RE of loginwords.mjs (one list with the cron runner).
// The note of Claude to the agent when the limit is reached in a turn (a line of the harness,
// not of the user), and the two notes that say the limit is over.
const LIMIT_NOTE_RE = /^\[?\s*usage limit reached\b/i;
const LIMIT_OVER_RE = /usage[- ]limit notes no longer apply|usage limit has reset/i;

export function classifyStop(text: string): StopWhy["why"] | null {
  if (LOGIN_RE.test(text)) return "login";
  if (LIMIT_RE.test(text)) return "limit";
  if (MODEL_RE.test(text)) return "model";
  return null;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);

const textOf = (l: Record<string, unknown>): string => {
  const content = (l.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content)
    ? content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join(" ")
    : typeof content === "string" ? content : "";
};
// A line of the user (typed, or sent by the console or another session): not a result of a
// tool, and not a note of the harness.
const isUserTurn = (l: Record<string, unknown>): boolean => {
  if (l.type !== "user" || l.isMeta === true) return false;
  const content = (l.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type !== "tool_result");
};

// Why the last turn in `tail` (the end of a session file) was cut, read from its end back to
// the last line of the user:
// - the last line of the conversation is an error of the Claude program of the three kinds;
// - or Claude told the agent in this turn that the usage limit is reached (and did not say
//   later that it is over): the agent ended the turn itself, with or without a note.
// A line of a subagent and a line that is not of the conversation do not count. Null: the
// last turn ended in another way (the agent answered, or the user wrote last).
export function stopOfTail(tail: string): StopWhy | null {
  const lines = tail.split("\n");
  // The newest line of the conversation was seen: an error line is a stop only as that line.
  let sawLast = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; } // the first line of the tail can be cut
    if (!o || typeof o !== "object") continue;
    const l = o as Record<string, unknown>;
    if (l.isSidechain === true) continue;
    if (l.type !== "assistant" && l.type !== "user") continue;
    const lineAt = typeof l.timestamp === "string" ? Date.parse(l.timestamp) : NaN;
    const at = Number.isFinite(lineAt) ? { lineAt } : {};
    if (l.type === "user" && l.isMeta === true) {
      const text = textOf(l);
      if (LIMIT_OVER_RE.test(text)) return null;
      if (LIMIT_NOTE_RE.test(text)) return { why: "limit", text: "Usage limit reached", ...at };
      continue; // another note of the harness: not of the conversation
    }
    if (isUserTurn(l)) return null;
    if (l.type === "assistant" && l.isApiErrorMessage === true) {
      const text = textOf(l);
      const why = classifyStop(text);
      // An error line that is not the newest line: the turn went on after it.
      if (!why || sawLast) return null;
      return { why, text: oneLine(text), ...at };
    }
    // An answer or a step of the agent, or the result of a tool: look further back for the
    // limit note of this turn.
    sawLast = true;
  }
  return null;
}

// A read of the stop mark: ok false when the file could not be read (no file, a link, an error),
// which is not the same as a file that has no mark (ok true, stop null).
export type StopRead = { ok: true; stop: StopWhy | null } | { ok: false };

// The same for a session file.
export async function readStopFile(path: string): Promise<StopRead> {
  let t: Transcript | null = null;
  try {
    // Never through a link; with strong protection, read by the helper as the agent (sessionread.ts).
    t = await openTranscript(path);
    if (!t) return { ok: false };
    const size = t.facts.size;
    const from = Math.max(0, size - TAIL_BYTES);
    return { ok: true, stop: stopOfTail((await t.read(from, size - from)).toString("utf8")) };
  } catch {
    return { ok: false };
  } finally {
    await t?.close();
  }
}

// The same, with null also when the file cannot be read.
export async function readStop(path: string): Promise<StopWhy | null> {
  const r = await readStopFile(path);
  return r.ok ? r.stop : null;
}

export { CONSOLE_MARK, consoleNote, continueText, goOnText } from "./consoleline.js";
