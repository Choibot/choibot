// server/chief/deploy/ticket.ts — the deploy ticket: its data and its words (spec §5.7), one copy
// for the Queue view, the thread card and the Telegram card. Pure, and with no import at all: the
// Next client imports it. PR titles are untrusted text: callers render every string as plain text.
//
// The deploy ticket is the one queue item the console makes itself. It deploys the console's own
// checkout (branch `main`, remote `origin`) and restarts the console's own unit. None of these is
// a field of the ticket: the ticket only shows what the console's own check found.

// The `agentId` of the console's own ticket. No agent record has this id, and no caller can be it.
export const CONSOLE_AGENT_ID = "console";
// Fixed in code (spec §5.7): the action never takes a repo, a branch or a commit from a request.
export const DEPLOY_REPO = "choibot";
export const DEPLOY_BRANCH = "main";
export const DEPLOY_REMOTE = "origin";

// The runner's steps, in order. `install` is skipped when no package file changed. `check`: the
// new server's page and every file it links answer 200 (a failed check rolls the build back).
export const DEPLOY_STEPS = ["fetch", "fast-forward", "install", "typecheck", "build", "restart", "check"] as const;
export type DeployStep = (typeof DEPLOY_STEPS)[number];

export type DeployRun = {
  id: string;
  via: "tab" | "telegram";
  startedAt: number;
  endedAt?: number;
  // `running` also covers the restart and the check: the runner sets `done` (or `failed`) after
  // the check; a runner with no check leaves it to the new server, at its boot.
  phase: "running" | "done" | "failed";
  step: DeployStep;
  // The commit that was live when the run started: the rollback commit.
  from: string;
  // The commit this run deploys: origin/main as the console saw it when Deploy was pressed.
  to: string;
  // Steps the runner did not need (`install` when no package file changed).
  skipped?: DeployStep[];
  // Done after the check: how many /_next/static files of the page answered 200.
  checked?: number;
  // Failed: one line that says why, and the end of the failed command's output.
  error?: string;
  tail?: string;
  // Done: the reconcile result of the new server (absent when reconcile itself failed): agents
  // found alive, agents it had to start again, agents it could not start.
  alive?: number;
  resumed?: number;
  failed?: number;
};

export type DeployPr = { number: number; title: string };

export type DeployInfo = {
  // The running build's commit (recorded at build time; read once at boot).
  live: string;
  // origin/main.
  target: string;
  // Commits on main's own line (first parent) that the running build does not have: one per
  // merged PR, one per commit made on main itself.
  count: number;
  // The merged PRs among them, newest first (at most PR_LIST_MAX), and how many more there are.
  prs: DeployPr[];
  more: number;
  // Why Deploy will be refused as things are now (e.g. a file with uncommitted changes).
  note?: string;
  run?: DeployRun;
};

export const PR_LIST_MAX = 12;
// Why a deploy ticket closed (QueueItem.lastError).
export const DEPLOY_CLOSED = { deployed: "deployed", live: "live" } as const;
export const short = (sha: string | undefined | null): string => (sha ? sha.slice(0, 7) : "unknown");

export function deployTitle(count: number): string {
  return `Console: ${count} commit${count === 1 ? "" : "s"} merged, not live`;
}

// The ticket body: the merged PRs, then the two commits. Shown by every surface as it is.
export function deployBody(d: Pick<DeployInfo, "live" | "target" | "prs" | "more">): string {
  const lines = d.prs.map((p) => `#${p.number} ${p.title}`);
  if (d.more > 0) lines.push(`and ${d.more} more`);
  if (lines.length === 0) lines.push("No merged PR among these commits.");
  lines.push(`Live: ${short(d.live)} · main: ${short(d.target)}`);
  return lines.join("\n");
}

const STEP_WORD: Record<DeployStep, string> = {
  "fetch": "fetch", "fast-forward": "fast-forward", "install": "install", "typecheck": "typecheck", "build": "build", "restart": "restart",
  "check": "check",
};
export const stepWord = (s: DeployStep): string => STEP_WORD[s] ?? String(s);

// "3 of 6": where the run is.
export function stepCount(step: DeployStep): string {
  const n = DEPLOY_STEPS.indexOf(step);
  return n < 0 ? "" : `${n + 1} of ${DEPLOY_STEPS.length}`;
}

function agentsText(run: DeployRun): string {
  if (run.alive === undefined) return "agents: not checked";
  const again = run.resumed ? ` · ${run.resumed} started again` : "";
  const dead = run.failed ? ` · ${run.failed} failed` : "";
  return `${run.alive} agent${run.alive === 1 ? "" : "s"} alive${again}${dead}`;
}

// One line for the run's state; "" when the ticket has no run.
export function runLine(run: DeployRun | undefined): string {
  if (!run) return "";
  if (run.phase === "running") return `Deploy runs: ${stepWord(run.step)} (${stepCount(run.step)})`;
  if (run.phase === "done") {
    const checked = run.checked !== undefined ? ` · page and ${run.checked} files load` : "";
    return `Deployed · live ${short(run.to)}${checked} · ${agentsText(run)} · rollback ${short(run.from)}`;
  }
  const rest = run.step === "restart" || run.step === "check" ? "" : " Nothing restarted.";
  return `Deploy failed at ${stepWord(run.step)}: ${run.error ?? "unknown error"}.${rest}`;
}

export const isRunning = (d: DeployInfo | undefined): boolean => d?.run?.phase === "running";
