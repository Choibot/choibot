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
  // A release or archive install (server/update): the release that root's updater offers, in
  // place of the commits above, and the person's press of Update.
  release?: ReleaseOffer;
  update?: UpdateRun;
};

// A release that the updater of this server offers (root's status file, its `available`): newer
// than the version that runs. `notes`: the release's notes, plain text, at most NOTES_SHOWN.
export type ReleaseOffer = {
  version: number; commit: string; builtAt: string; security: boolean;
  notes: string[]; more: number;
  // The version that runs (the console's own release record; 0: the image's console).
  running: { version: number; commit: string | null };
};

// The press of Update and what root's updater made of it (server/update/service.ts nextRun):
//   asked, running        a press under way (no button);
//   not-started           the ask file is still there after ASK_WAIT_MS: root did not take it;
//   refused               root refused before any change: the same release can be asked again;
//   unreachable           root could not reach the release host: nothing changed;
//   not-finished          root ended with no update (or the press is older than RUN_MAX_MS);
//   updated, failed-back (the way back passed: nothing lost), failed-stuck (it failed): the end.
// The states between "asked" and the end keep the ticket open with the button.
export const UPDATE_STATES = ["asked", "running", "not-started", "refused", "unreachable", "not-finished", "updated", "failed-back", "failed-stuck"] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];
export type UpdateRun = {
  state: UpdateState; via: "tab" | "telegram"; askedAt: number; endedAt?: number;
  // Root's step (a fixed word of its list), for a refusal and a failure.
  step?: string;
  // from: the version that ran at the press; to: the release on the ticket, and after the end the
  // version that runs (root takes the newest signed release, which can be newer than the ticket's).
  from: number; to: number;
};

// Root's step words in a sentence ("Update refused at the signature check."). A word that is not
// in the list is shown as it is (it passed the status file's form: letters and "-" only).
const STEP_WORDS: Record<string, string> = {
  // release-format.md §10, in the order of root's chain.
  download: "the download", inputs: "the updater's own files", signature: "the signature check", index: "the index check",
  channel: "the channel check", expired: "the age check of the release", replay: "the check against an older release list",
  arch: "the system check", hold: "a hold on the release", bad: "a release that failed here before", limit: "the press limit",
  version: "the version check", size: "the size check", disk: "the disk space check", hash: "the hash check",
  entries: "the file check", build: "the build check", "root-parts": "the root files check", layout: "the code folder check",
  port: "the port check", stage: "the unpack", stop: "the stop", swap: "the swap", start: "the start",
  health: "the health check", repair: "the repair", "clean-up": "the clean-up",
  // An older word of the same step.
  rootparts: "the root files check",
};
export const stepWords = (step: string | undefined): string => (step ? STEP_WORDS[step.toLowerCase()] ?? step : "a step");
// The person's own case, not a check of the release: a fifth press in an hour (root counts them).
export const pressLimit = (u: Pick<UpdateRun, "state" | "step"> | undefined): boolean => u?.state === "refused" && u.step?.toLowerCase() === "limit";

export const PR_LIST_MAX = 12;
// Why a deploy ticket closed (QueueItem.lastError).
export const DEPLOY_CLOSED = { deployed: "deployed", live: "live", updated: "updated", updateFailed: "update-failed" } as const;
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

export const isRunning = (d: DeployInfo | undefined): boolean =>
  d?.run?.phase === "running" || d?.update?.state === "asked" || d?.update?.state === "running";

// ---- the release variant (server/update): its words, one short line each ----

export const NOTES_SHOWN = 12;
export const NOTE_CHARS = 200;

export const updateTitle = (version: number): string => `ChoiBot ${version} is ready`;

// The ticket body: the release's notes (plain text, cut). The versions are the panel's line (and
// the card's note), never twice.
export function updateBody(r: Pick<ReleaseOffer, "notes" | "more">): string {
  const lines = r.notes.slice(0, NOTES_SHOWN);
  const more = r.more + Math.max(0, r.notes.length - NOTES_SHOWN);
  if (more > 0) lines.push(`and ${more} more`);
  return lines.length > 0 ? lines.join("\n") : "No notes for this release.";
}

// The versions of an offer: "Version 848 → 849".
export const updateVersions = (r: Pick<ReleaseOffer, "version" | "running">): string => `Version ${r.running.version} → ${r.version}`;

// One note as plain text: one line, no control character, at most NOTE_CHARS.
export function plainNote(s: string): string {
  const one = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return one.length > NOTE_CHARS ? `${one.slice(0, NOTE_CHARS - 1)}…` : one;
}

// The one line of a press, at the place of the button.
export function updateLine(u: UpdateRun | undefined): string {
  if (!u) return "";
  switch (u.state) {
    case "asked": return "Update asked";
    case "running": return "Updating";
    case "not-started": return "The server did not start the update.";
    case "refused": return pressLimit(u) ? "Too many presses in an hour. Press again later." : `Update refused at ${stepWords(u.step)}. Nothing changed.`;
    case "unreachable": return "The release could not be downloaded. Nothing changed.";
    case "not-finished": return "The update did not finish.";
    case "updated": return `Updated to version ${u.to}`;
    case "failed-back": return `Failed at ${stepWords(u.step)}. Back on version ${u.from}. Nothing lost.`;
    case "failed-stuck": return "Update failed. The console needs help.";
  }
}

// The run line of either variant: a deploy's or an update's.
export const ticketLine = (d: DeployInfo | undefined): string => (d?.update ? updateLine(d.update) : runLine(d?.run));
