// bin/lib/cron-result.mjs — the result line of a run. The runner adds one fixed paragraph to a
// task's instructions; the task's agent then ends its answer with one line:
//   RESULT: all-clear | <one sentence>
//   RESULT: needs-you | <one sentence> | <a pull request address or a ticket id> | …
// (a task is told of the pull request only: a ticket id comes from who opened the ticket)
// The runner reads the line and keeps it with the run. Plain JS: the runner imports it with a
// bare `node`; the server (server/cron/result.ts) reads what the runner kept and trusts none of
// it: the line is text of an agent.

export const RESULT_STATES = ["all-clear", "needs-you"];
// What the runner keeps of a line, at most (the server cuts the sentence again for the page).
export const RESULT_SENTENCE_MAX = 300;
export const RESULT_REFS_MAX = 4;
export const RESULT_REF_MAX = 200;
// Why a run did not finish: fixed values only.
export const RUN_WHYS = ["timeout", "exit", "start", "account", "login", "refused", "killed"];
// The same reasons in the user's words: the task page, `cron show` and Telegram say these.
export const WHY_WORDS = {
  timeout: "It ran longer than its time limit.",
  exit: "It stopped with an error.",
  start: "It did not start.",
  account: "Its Claude login was not found.",
  login: "Its Claude login is signed out.",
  refused: "Your server refused to start it.",
  killed: "It was stopped.",
};
// The 3 states of a run in the user's words. The keys are the words of a digest line and of
// `cron show`: the 2 result states, and did-not-finish (the run failed or ran out of time).
export const STATE_WORDS = { "all-clear": "All clear", "needs-you": "Needs you", "did-not-finish": "Did not finish" };
// A task name (NAME_RE of bin/lib/cronspec.ts: a test keeps the two the same).
export const TASK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** The longest sentence of a run that the page and Telegram show. */
export const SENTENCE_MAX = 160;

export const RESULT_INSTRUCTION = [
  "---",
  "End your answer with one last line in this exact form. Write nothing after it.",
  "RESULT: all-clear | <one short sentence that says what you found>",
  "or",
  "RESULT: needs-you | <one short sentence that says what a person must look at>",
  "Use needs-you only when a person must do or decide something.",
  "If you opened a pull request for it, add its full address at the end of the line, after one more \" | \".",
].join("\n");

/** The task's instructions with the result paragraph after them. */
export function withResultInstruction(prompt) {
  return `${String(prompt).trimEnd()}\n\n${RESULT_INSTRUCTION}`;
}

const LINE_RE = /^[\s>*_`-]*RESULT[*_`]*\s*:[*_`]*\s*(all-clear|needs-you)[*_`]*\s*(?:\|(.*))?$/i;
// The line is the end of the answer: only the last lines with text are read.
const LAST_LINES = 3;

/**
 * Reads the result line of an answer. `result` is null when the answer has none. `text` is the
 * answer with no result line (what a person reads).
 * @param {string} stdout
 * @returns {{ result: { state: string, sentence: string, refs: string[] } | null, text: string }}
 */
export function readResultLine(stdout) {
  const lines = String(stdout).split("\n");
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < LAST_LINES; i--) {
    if (!lines[i].trim()) continue;
    seen += 1;
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    const parts = (m[2] ?? "").split("|").map((p) => p.replace(/[*_`]+$/, "").trim());
    const sentence = (parts[0] ?? "").slice(0, RESULT_SENTENCE_MAX);
    const refs = [...new Set(parts.slice(1).filter(Boolean).map((r) => r.slice(0, RESULT_REF_MAX)))].slice(0, RESULT_REFS_MAX);
    const text = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trim();
    return { result: { state: m[1].toLowerCase(), sentence, refs }, text };
  }
  return { result: null, text: String(stdout).trim() };
}

/**
 * One line of plain text: control and format characters (bidi marks, zero width) out, white
 * space folded, the Markdown marks of a heading, a list item, a quote or bold text off, at most
 * `max` characters.
 * @param {string} text
 * @param {number} [max]
 */
export function plainLine(text, max = SENTENCE_MAX) {
  let t = String(text).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:#{1,6}|>|[-*+]|\d{1,2}[.)])\s+/, "");
  t = t.replace(/(\*\*|__|`)(.+?)\1/g, "$2").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * The address of a task's page in the console (`<origin>/#recurring=<name>`). null when the
 * console has no address (CHIEF_CONSOLE_URL) or the name is not a task name.
 * @param {string | undefined} origin
 * @param {string} name
 */
export function taskPageUrl(origin, name) {
  const o = String(origin ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s"'<>]+$/.test(o) || !TASK_NAME_RE.test(name)) return null;
  return `${o}/#recurring=${name}`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Telegram refuses a message longer than this. The whole message stays under it, also as the
// plain text that a sender posts again when the HTML is refused.
export const TELEGRAM_MAX = 4096;
const QUOTE_OPEN = "<blockquote expandable>";
const QUOTE_CLOSE = "</blockquote>";

// The end of `text`, escaped, in at most `room` characters: whole characters only (never half of
// an escape), and "…" first when the start is cut (the runner keeps the end of an answer too).
function escapedTail(text, room) {
  const all = esc(text);
  if (all.length <= room) return all;
  const parts = [];
  let used = 2; // "…\n"
  for (let i = text.length - 1; i >= 0; i--) {
    const e = esc(text[i]);
    if (used + e.length > room) break;
    parts.push(e);
    used += e.length;
  }
  return `…\n${parts.reverse().join("").replace(/^[^\n]*\n/, "")}`;
}

/**
 * The Telegram message (parse mode HTML) of a run that has a state:
 *   Recurring · <task>: Needs you. <the run's own sentence>
 *   Open the task                      (a link to the task's page, when the console has an address)
 *   <the task's answer, folded>        (a run that finished: its answer with no result line)
 * The sentence is text of an agent: one plain line, escaped. For did-not-finish it is the fixed
 * reason words, and no text of the run goes with it. The answer is escaped and folded in an
 * expandable quote; none when it is empty or says only the sentence. The whole message is at
 * most TELEGRAM_MAX characters: the answer keeps its end when it is too long.
 * @param {{ name: string, state: "all-clear" | "needs-you" | "did-not-finish", sentence?: string | null, url?: string | null, text?: string | null }} run
 */
export function runMessageHtml({ name, state, sentence, url, text }) {
  const said = sentence ? plainLine(sentence) : "";
  let out = `<b>${esc(`Recurring · ${name}`)}</b>: ${STATE_WORDS[state]}.${said ? ` ${esc(said)}` : ""}`;
  if (url) out += `\n<a href="${esc(url)}">Open the task</a>`;
  const answer = state === "did-not-finish" ? "" : String(text ?? "").trim();
  if (answer && plainLine(answer, TELEGRAM_MAX) !== plainLine(said, TELEGRAM_MAX)) {
    const room = TELEGRAM_MAX - out.length - 1 - QUOTE_OPEN.length - QUOTE_CLOSE.length;
    if (room > 2) out += `\n${QUOTE_OPEN}${escapedTail(answer, room)}${QUOTE_CLOSE}`;
  }
  return out;
}
