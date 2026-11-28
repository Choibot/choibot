// server/guide/actions.ts — the typed actions of the guide, and the last error of a step.
//
// The guide is a model with no tool: no shell, no file, no web. All it can do is write. In what
// it writes, the server reads three actions and nothing more, each one alone on a line:
//   [check <step>]   put the result of the check of a step in the thread
//   [error <step>]   put the last error of a step in the thread
//   [card <step>]    put the form or the button of a step in the thread
// Every other line is text for the user. So nothing the guide writes can run a command, change a
// setting or mark a step done: a check on the server decides "done", and the form or the button
// on a card runs only when the paired user presses it (the routes of setup/actions.ts).
//
// How the design's four actions map: "run a check" is [check] (the server runs every check
// before each turn of the guide, and [check] shows its result). "run a step" and "show a form"
// are both [card]: a step starts when the user presses the button on its card. "read the last
// error" is [error].
import type { SetupLoginReason, SetupLoginState } from "../setup/actions.js";
import type { FirstView } from "../setup/firstagent.js";
import type { CloneReason, CloneState } from "../setup/repopick.js";
import { STEPS, type StepId, type StepStatus } from "../setup/steps.js";
import type { GuideAction, GuideBlock } from "./types.js";

const STEP_IDS = new Set<string>(STEPS.map((s) => s.id));
export const isStepId = (v: unknown): v is StepId => typeof v === "string" && STEP_IDS.has(v);

// A line that is one action: a word and one step, in square brackets.
const ACTION_LINE = /^\[([a-z]+)\s+([a-z-]+)\]$/;
// A line that has the shape of an action (a word, then anything, in square brackets) but is
// not one of the three: it is dropped, never shown as text and never run.
const ACTION_LIKE = /^\[[a-z]+(\s[^\]]*)?\]$/i;
const VERBS = new Set(["check", "error", "card"]);

// One reply holds at most this much text, this many actions and this many cards.
export const REPLY_TEXT_MAX = 2_000;
export const REPLY_ACTIONS_MAX = 6;
export const REPLY_CARDS_MAX = 2;

// A reply of the guide → what it says and the actions it asks for, in order. Fail soft: a line
// that is not a valid action is text, or nothing when it only looks like an action.
export function parseReply(raw: string): GuideBlock[] {
  const out: GuideBlock[] = [];
  let say: string[] = [];
  let actions = 0, cards = 0, chars = 0;
  const seen = new Set<string>();
  const flush = () => {
    const text = say.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    say = [];
    if (!text || chars >= REPLY_TEXT_MAX) return;
    const cut = text.slice(0, REPLY_TEXT_MAX - chars);
    chars += cut.length;
    out.push({ say: cut });
  };
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const t = line.trim();
    const m = ACTION_LINE.exec(t);
    if (m && VERBS.has(m[1]) && isStepId(m[2])) {
      flush();
      const key = `${m[1]} ${m[2]}`;
      if (seen.has(key) || actions >= REPLY_ACTIONS_MAX) continue;
      if (m[1] === "card" && cards >= REPLY_CARDS_MAX) continue;
      seen.add(key);
      actions++;
      if (m[1] === "card") cards++;
      out.push({ do: m[1] as GuideAction["do"], step: m[2] });
      continue;
    }
    if (ACTION_LIKE.test(t)) continue;
    say.push(line);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- the last error

// What the actions of the Set-up page say about themselves now. Read only.
export type ActionFacts = {
  login: SetupLoginState;
  clone: CloneState;
  // Null: this console cannot start the first agent from the page.
  first: FirstView | null;
};

// Facts, not instructions: the guide says in its own words what to do, and the card has the button.
const LOGIN_ERROR: Record<SetupLoginReason, string> = {
  expired: "The one-time code ran out after 15 minutes. GitHub did not get an approval in that time.",
  denied: "The login was not approved on GitHub.",
  "no-gh": "The GitHub tool (gh) is not on your server.",
  "no-answer": "GitHub did not answer your server.",
  "env-token": "Your server uses a GitHub token from the settings of the console, so GitHub takes no login.",
  disabled: "The ChoiBot app on GitHub does not take a login with a code (its device flow is off).",
  "bad-client": "GitHub does not know the client id of the ChoiBot app in the settings of your server.",
  failed: "The login to GitHub did not work.",
};

const CLONE_ERROR: Record<CloneReason, string> = {
  auth: "GitHub refused the copy of the repo.",
  disk: "Your server has no free disk space for the repo.",
  network: "GitHub did not answer during the copy.",
  empty: "The repo has no commit yet.",
  exists: "A folder with the name of the repo is on your server already, with other content.",
  timeout: "The copy took more than 30 minutes and was stopped.",
  failed: "The copy of the repo did not work.",
};

function firstError(v: FirstView): string | null {
  const a = v.agent;
  if (!a || v.ticket?.state === "open" || v.ticket?.state === "merged") return null;
  if (v.ticket) return "The pull request of the first agent was closed and not merged.";
  if (a.dialog && (a.state === "working" || a.state === "waiting")) return "Claude asks the first agent a question. Its answers are on the step card.";
  if (a.noSession && (a.state === "working" || a.state === "waiting")) return "The first agent has no session yet. Claude may wait for an answer on its terminal screen.";
  switch (a.state) {
    case "working": return null;
    case "waiting": return a.pullRequest
      ? "The first agent opened a pull request, but its ticket did not come to the Queue."
      : "The first agent stopped and opened no pull request.";
    case "error": return "The first agent stopped with an error.";
    case "ended": return "The first agent ended and opened no pull request.";
    case "closed": return "The first agent was closed before it opened a pull request.";
    default: return "The first agent is not there any more.";
  }
}

// The failure of the action of a step (a login that ended, a copy that failed, a first agent
// that stopped), in plain words, or null. Only an open step has one: for a step that is done
// or that waits for another step, an old failure says nothing.
export function actionError(status: StepStatus | undefined, facts: ActionFacts): string | null {
  if (!status || status.state !== "todo") return null;
  if (status.id === "github" && facts.login.state === "failed") return LOGIN_ERROR[facts.login.reason];
  if (status.id === "repo" && facts.clone.state === "failed") return `${facts.clone.repo}: ${CLONE_ERROR[facts.clone.reason]}`;
  if (status.id === "agent" && facts.first) return firstError(facts.first);
  return null;
}

// The last error of a step: the failure of its action, else the error its check saw.
export function lastError(status: StepStatus | undefined, facts: ActionFacts): string | null {
  if (!status || status.state !== "todo") return null;
  return actionError(status, facts) ?? status.error ?? null;
}
