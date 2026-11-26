// src/lib/setupActions.ts — the Set-up page's side of the GitHub and repo actions
// (server/setup/actions.ts): the calls, and the plain words for each state. Every call goes out
// as the paired user (chiefFetch). Nothing here starts by itself: a button calls it.
import type { LoginView, SetupLoginReason } from "../../server/setup/actions";
import type { QueueItem } from "../../server/chief/queue/types";
import type { CommitNameView } from "../../server/setup/commitname";
import type { FirstView } from "../../server/setup/firstagent";
import type { CloneReason, CloneState, RepoPage } from "../../server/setup/repopick";
import { chiefFetch } from "./chief";
import type { SetupRow } from "./setup";

export type { CloneState, CommitNameView, FirstView, LoginView, RepoPage };
export type PickRow = RepoPage["repos"][number];

type Fetch = typeof chiefFetch;
const NO_ANSWER = "The console did not answer. Try again.";

// The JSON of an answer, or an error with the plain line the server gave.
async function ask<T>(f: Fetch, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await f(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(NO_ANSWER);
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: unknown; text?: unknown }) | null;
  if (!res.ok || json === null) {
    if (json?.error === "pair-required" || json?.error === "needs-pairing") throw new Error("Only a paired device can do this. Pair this device first.");
    throw new Error(typeof json?.error === "string" && / /.test(json.error) ? json.error : NO_ANSWER);
  }
  return json;
}

export const fetchLogin = (f: Fetch = chiefFetch): Promise<LoginView> => ask(f, "/api/setup/github/login");
export const startLogin = (fresh: boolean, f: Fetch = chiefFetch): Promise<LoginView> => ask(f, "/api/setup/github/login", { fresh });
export const fetchCommitName = (f: Fetch = chiefFetch): Promise<CommitNameView> => ask(f, "/api/setup/github/name");
export const saveCommitName = (f: Fetch = chiefFetch): Promise<{ ok: true }> => ask(f, "/api/setup/github/name", {});
export const fetchRepoPage = (o: { q: string; page: number; fresh?: boolean }, f: Fetch = chiefFetch): Promise<RepoPage> =>
  ask(f, `/api/setup/repos?q=${encodeURIComponent(o.q)}&page=${o.page}${o.fresh ? "&fresh=1" : ""}`);
export const fetchClone = (f: Fetch = chiefFetch): Promise<CloneState> => ask(f, "/api/setup/repos/clone");
export const startClone = (repo: string, f: Fetch = chiefFetch): Promise<CloneState> => ask(f, "/api/setup/repos/clone", { repo });

export const fetchFirst = (f: Fetch = chiefFetch): Promise<FirstView> => ask(f, "/api/setup/first");
// again: a new agent for the same task. repo: the name of a repo of the list in the view.
export const startFirst = (o: { again?: boolean; repo?: string } = {}, f: Fetch = chiefFetch): Promise<FirstView> =>
  ask(f, "/api/setup/first", { ...(o.again ? { again: true } : {}), ...(o.repo ? { repo: o.repo } : {}) });
// One ticket of the Queue, as the Queue view gets it.
export const fetchTicket = (id: string, f: Fetch = chiefFetch): Promise<QueueItem> => ask(f, `/api/queue/${encodeURIComponent(id)}`);

// The GitHub step is open only because git has no name for commits (the text of its check).
export const needsCommitName = (row: Pick<SetupRow, "text">): boolean => /for commits/.test(row.text);

// What the ChoiBot app reaches, said before the approval on GitHub. Set-up: the repos are chosen
// in its next step ("Pick a repo"). Settings has no next step: they are chosen on GitHub.
export function appReachLine(place: "setup" | "settings"): string {
  const where = place === "setup" ? "in the next step" : "on GitHub";
  return `ChoiBot then works only in the repos that you choose ${where}. There it can read and change the code, pull requests and issues, and read the checks.`;
}

// Step 2 of the code card of the ChoiBot app: the approval, and in the same line what it gives.
// GitHub's approval page says that the app "wants access to your GitHub account" (the owner's
// screen, 2026-11-26), and lists no right of the app. The fact behind this line, from GitHub's
// docs: "a user access token can only access resources that both the user and app can access"
// ("Generating a user access token for a GitHub App"), so with no repo picked it reaches none.
// One short line on purpose.
export function appApproveLine(place: "setup" | "settings"): string {
  const where = place === "setup" ? "that you pick next" : "that you pick on GitHub";
  return `Type the code, then approve. ChoiBot gets access only to the repos ${where}.`;
}

// The device page with the code in it: GitHub may fill in the code boxes. NOT in GitHub's docs
// (the device answer has only verification_uri and user_code): the first real try proves it. If
// GitHub does not fill them, the code is on the clipboard (press 1 copies it) and on the card.
// Only a code of GitHub's form (4 letters or digits, a dash, 4 more) goes into the link; any other
// code, or an address that has a query or a hash already, gives the plain page.
const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export function deviceLink(url: string, code: string): string {
  if (!USER_CODE_RE.test(code)) return url;
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  if (u.search || u.hash) return url;
  u.searchParams.set("user_code", code);
  return u.href;
}

// The one card "Connect GitHub" of the ChoiBot app in Set-up: the approval on GitHub. One short
// line at each press.
type OneStepPress = { code: string; href: string; line: string; button: string };
export type OneStepCard =
  | { kind: "starting"; line: string }
  | { kind: "approved"; line: string }
  | ({ kind: "connect" } & OneStepPress)
  | ({ kind: "approve" } & OneStepPress)
  | { kind: "failed"; line: string };
export const ONE_STEP_ACCESS = "ChoiBot gets access only to the repos that you pick next.";
export function oneStepCard(login: LoginView | null, pressed: boolean): OneStepCard {
  if (!login || login.state === "idle" || login.state === "starting") return { kind: "starting", line: "Asking GitHub for a code…" };
  if (login.state === "done") return { kind: "approved", line: "Approved on GitHub. One moment…" };
  if (login.state === "failed") return { kind: "failed", line: loginProblem(login.reason) };
  if (login.state !== "waiting") return { kind: "starting", line: "Asking GitHub for a code…" };
  const href = deviceLink(login.url, login.code);
  return pressed
    ? { kind: "approve", code: login.code, href, line: "Approve ChoiBot on GitHub. If it asks for the code, paste it.", button: "Open GitHub again" }
    : { kind: "connect", code: login.code, href, line: ONE_STEP_ACCESS, button: "Connect GitHub" };
}

// The repo part of that card: no list yet, no repo reached yet (choose them on GitHub), or a list.
export function repoChoice(page: RepoPage | null): "reading" | "choose" | "list" {
  if (!page) return "reading";
  return page.app !== undefined && page.listed === 0 ? "choose" : "list";
}

// Why a login ended with no success, and what to press.
export function loginProblem(reason: SetupLoginReason): string {
  switch (reason) {
    case "expired": return "The code ran out. Press New code.";
    case "denied": return "GitHub did not get your approval. Press New code, then approve on GitHub.";
    case "no-gh": return "The GitHub tool (gh) is not on your server. The install line of the console gets it: paste the install line on your server again. Then press Connect GitHub.";
    case "no-answer": return "GitHub did not answer your server. Check the internet connection of your server. Then press New code.";
    case "env-token": return "Your server uses a GitHub token from its settings, so it takes no login. Remove that token from the settings of the console, or put in one that works. Then press Check again.";
    case "disabled": return "The ChoiBot app on GitHub takes no login with a code: its owner must turn on its device flow.";
    case "bad-client": return "GitHub does not know the client id of the ChoiBot app in the settings of your server. Ask the person who runs your server to check it.";
    default: return "The login did not work. Press New code.";
  }
}

// "14 minutes", "1 minute", "less than 1 minute".
export function minutesLeft(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "less than 1 minute" : `${m} minute${m === 1 ? "" : "s"}`;
}

// "2 hours ago", "yesterday", "3 weeks ago".
export function ago(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? "" : "s"} ago`;
  if (s < 3600) return s < 120 ? "just now" : n(Math.floor(s / 60), "minute");
  if (s < 86_400) return n(Math.floor(s / 3600), "hour");
  if (s < 2 * 86_400) return "yesterday";
  if (s < 14 * 86_400) return n(Math.floor(s / 86_400), "day");
  if (s < 60 * 86_400) return n(Math.floor(s / (7 * 86_400)), "week");
  if (s < 730 * 86_400) return n(Math.floor(s / (30 * 86_400)), "month");
  return n(Math.floor(s / (365 * 86_400)), "year");
}

// "1.2 GB", "340 MB".
export function sizeText(kb: number): string {
  return kb >= 1_000_000 ? `${(kb / 1_000_000).toFixed(1)} GB` : `${Math.max(1, Math.round(kb / 1000))} MB`;
}

// Can the user pick this row? (The server checks again.)
export const canPick = (r: PickRow): boolean => r.push && !r.archived;

// The tag at the right of a repo row.
export function accessWord(r: PickRow): string {
  if (r.archived) return "Archived";
  return r.push ? "Read and push" : "Read only";
}

// The line under a repo name: what it is, or why it is off.
export function repoLine(r: PickRow, now: number): string {
  if (r.archived) return "This repo is archived on GitHub. Nobody can push to it.";
  if (!r.push) return "Agents cannot open pull requests here. Ask the owner for push access.";
  const parts = [r.private ? "Private" : null, r.language, r.pushedAt ? `pushed ${ago(r.pushedAt, now)}` : null, r.here ? "on your server" : null];
  return parts.filter(Boolean).join(" · ");
}

export function cloneProblem(reason: CloneReason): string {
  switch (reason) {
    case "auth": return "GitHub refused the copy, also on a second try. Check on github.com that your account can read this repo. For a repo of an organisation, an owner must allow “GitHub CLI” first.";
    case "disk": return "Your server has no free disk space for this repo. Make space, or pick a smaller repo.";
    case "network": return "GitHub did not answer during the copy. Press the button again.";
    case "empty": return "This repo has no commit yet. Add a first file on github.com, or pick another repo.";
    case "exists": return "A folder with the name of this repo is on your server already, with other content. Pick another repo.";
    case "timeout": return "The copy took more than 30 minutes and was stopped. Try again, or pick a smaller repo.";
    default: return "The copy did not work. Press the button again.";
  }
}

// One line while a copy runs.
export function cloneLine(s: Extract<CloneState, { state: "copying" }>): string {
  const far = s.percent === null ? "" : ` ${s.percent}%`;
  return `Copying ${s.repo} to your server…${far}${s.big ? " This repo is big. The copy can take some minutes." : ""}`;
}

// ------------------------------------------------------------- the first agent

// After this time with no pull request, the row says that the task takes long.
export const SLOW_MS = 8 * 60_000;

// "less than 1 minute", "2 minutes", "1 hour 5 minutes".
export function since(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "less than 1 minute";
  const min = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;
  if (m < 60) return min(m);
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}${m % 60 ? ` ${min(m % 60)}` : ""}`;
}

// What the "Start the first agent" row says and offers for a state of the first agent.
// start: the first press. again: a new agent for the same task. thread: open the agent.
export type FirstSay = { tone: "off" | "run" | "ok" | "warn"; line: string; hint?: string; acts: ("start" | "again" | "thread")[] };

export function firstSay(v: FirstView): FirstSay {
  const a = v.agent;
  if (!a) {
    return v.repo
      ? { tone: "off", line: `The agent works in its own copy of ${v.repo}. Your main branch is not touched.`, hint: "A first task takes 3 to 6 minutes.", acts: ["start"] }
      : { tone: "warn", line: "No repo with push access is on your server. Do the step “Pick a repo” first.", acts: [] };
  }
  if (v.ticket?.state === "open") return { tone: "ok", line: "The pull request is open. Its ticket is in the next step.", acts: ["thread"] };
  if (v.ticket?.state === "merged") return { tone: "ok", line: "The pull request is merged.", acts: [] };
  if (v.ticket) return { tone: "warn", line: "The pull request was closed and not merged. Start the task again.", acts: ["again", "thread"] };
  switch (a.state) {
    case "working": {
      const ms = v.now - a.startedAt;
      return ms >= SLOW_MS
        ? { tone: "run", line: `Working for ${since(ms)}. This takes longer than usual.`, hint: "Open its thread to see what it does. It can wait for an answer from you.", acts: ["thread"] }
        : { tone: "run", line: `Working · started ${since(ms)} ago`, hint: "A first task takes 3 to 6 minutes. You can close this page: the agent keeps working.", acts: ["thread"] };
    }
    case "waiting":
      return a.pullRequest
        ? { tone: "warn", line: "The agent opened a pull request, but its ticket did not come.", hint: "Open its thread and write: “Add the ticket of your pull request to the Queue.”", acts: ["thread"] }
        : { tone: "warn", line: "The agent stopped and opened no pull request.", hint: "Open its thread to read what it says. You can answer it there, or start the task again.", acts: ["thread", "again"] };
    case "error":
      return { tone: "warn", line: "The agent stopped with an error.", hint: "Open its thread to see the error, or start the task again.", acts: ["thread", "again"] };
    case "ended":
      return { tone: "warn", line: "The agent ended and opened no pull request.", hint: "Start the task again.", acts: ["again", "thread"] };
    case "closed":
      return { tone: "warn", line: "The agent was closed before it opened a pull request.", hint: "Start the task again.", acts: ["again"] };
    default:
      return { tone: "warn", line: "The agent is not there any more.", hint: "Start the task again.", acts: ["again"] };
  }
}

// What stands in the way of a merge, from the facts on the ticket, and what to do. Null:
// nothing known (the Merge button reads GitHub again when it is pressed).
export function mergeHint(i: Pick<QueueItem, "pr">): string | null {
  const pr = i.pr && "url" in i.pr ? i.pr : null;
  if (!pr) return null;
  if (pr.mergeable === "CONFLICTING") return "The pull request has conflicts with the main branch. Open the thread of the agent and write: “Update your branch.”";
  if (pr.checks === "failure") return "A check of the pull request fails. Open it on GitHub to see why, or ask the agent in its thread to repair it. Merge asks you first.";
  if (pr.checks === "pending") return "The checks of the pull request still run. You can wait, or merge now: Merge asks you first.";
  return null;
}
