// src/lib/setup.ts — the Set-up page's side of the step list (GET /api/setup/steps). The list
// itself (titles, the one line of why, the order) is server/setup/steps.ts, which the browser
// imports too: the rows are on screen at once, and the answer of the server fills in each state.
// Only a machine check on the server marks a step done; nothing here can.
import { STEPS, type StepId, type StepStatus } from "../../server/setup/steps";
import { USER_CLI } from "../../server/brand";
import { chiefFetch } from "./chief";

// protection: "strong" when the agents run under their own account on the server.
// githubApp: the ChoiBot GitHub app switch is on: "Connect GitHub" and "Pick a repo" are one row.
export type SetupAnswer = { steps: StepStatus[]; checkedAt: number; home: boolean; protection?: "strong" | "basic"; githubApp?: boolean };

// done: its check passes. turn: open, and nothing is in its way. waits: a step before it is
// open. optional: open, and the set-up is done without it. checking: no answer yet.
export type RowState = "done" | "turn" | "waits" | "optional" | "checking";

export type SetupRow = {
  id: StepId; title: string; why: string; optional: boolean; state: RowState;
  // done: a short note. turn, optional: why the step is open. waits: the step to do first.
  text: string;
  error?: string;
  // The one row "Connect GitHub" of the ChoiBot app (githubApp): `app`, and the part that it draws
  // now: the GitHub approval, then the choice of the repo ("Pick a repo"'s own check).
  app?: true;
  part?: "github" | "repo";
};

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// Every step of the list, in its order, with the state the server gave. A step the answer does
// not hold (an older server, no answer yet) is "checking": never done. A step that a console
// may leave out (`sometimes`: the second sign-in) is shown only when the answer holds it.
export function setupRows(answer: SetupAnswer | null): SetupRow[] {
  const got = new Map((answer?.steps ?? []).filter((s) => s && str(s.id)).map((s) => [s.id, s]));
  const rows = STEPS.filter((step) => !step.sometimes || got.has(step.id)).map((step): SetupRow => {
    const optional = step.optional === true;
    const s = got.get(step.id);
    const base = { id: step.id, title: step.title, why: step.why, optional };
    if (!s || !str(s.text)) return { ...base, state: "checking", text: "" };
    const state: RowState = s.state === "done" ? "done" : s.state === "blocked" ? "waits" : optional ? "optional" : "turn";
    return { ...base, state, text: s.text, ...(str(s.error) ? { error: s.error } : {}) };
  });
  return answer?.githubApp === true ? oneGithubStep(rows) : rows;
}

const titleOf = (id: StepId): string => STEPS.find((s) => s.id === id)?.title ?? id;

// The ChoiBot GitHub app: GitHub's two screens (the approval, then the choice of repos) are one
// step on the page. The two checks of the server stay two; here "Pick a repo" goes into the row
// "Connect GitHub": that row draws the approval until it is done, then the choice of the repo.
// A row that waits for "Pick a repo" waits for "Connect GitHub".
export function oneGithubStep(rows: SetupRow[]): SetupRow[] {
  const gh = rows.find((r) => r.id === "github");
  const repo = rows.find((r) => r.id === "repo");
  if (!gh || !repo) return rows;
  let one: SetupRow;
  if (gh.state === "done" && repo.state === "done") one = { ...gh, text: `${gh.text} · ${repo.text}`, app: true };
  else if (gh.state === "done") {
    const { error: _gone, ...ghBase } = gh;
    one = { ...ghBase, state: repo.state === "checking" ? "checking" : "turn", text: repo.text, ...(repo.error ? { error: repo.error } : {}), app: true, part: "repo" };
  } else one = { ...gh, app: true, part: "github" };
  const waitRepo = `First: ${titleOf("repo")}.`;
  return rows.filter((r) => r.id !== "repo").map((r) => {
    if (r.id === "github") return one;
    return r.state === "waits" && r.text === waitRepo ? { ...r, text: `First: ${gh.title}.` } : r;
  });
}

// The required steps: how many are done.
export function progress(rows: SetupRow[]): { done: number; total: number } {
  const main = rows.filter((r) => !r.optional);
  return { done: main.filter((r) => r.state === "done").length, total: main.length };
}

// The step to do now: the first required step that is the user's turn.
export function firstTurn(rows: SetupRow[]): SetupRow | null {
  return rows.find((r) => r.state === "turn") ?? null;
}

// The words at the right of a row.
export function stateWord(row: SetupRow): string {
  if (row.state === "done") return "Done";
  if (row.state === "turn") return "Your turn";
  if (row.state === "waits") return "Waits";
  if (row.state === "optional") return "Optional";
  return "Checking…";
}

// One line for the head of the page: "Step 5 of 8 · Connect GitHub".
export function headline(rows: SetupRow[]): string {
  const { done, total } = progress(rows);
  if (rows.every((r) => r.state === "checking")) return "Checking the steps…";
  if (done === total) return "Set-up is done";
  const next = firstTurn(rows);
  if (!next) return `${done} of ${total} steps done`;
  return `Step ${rows.filter((r) => !r.optional).indexOf(next) + 1} of ${total} · ${next.title}`;
}

// The status line of the Set-up row of Settings: a green dot only when every required step is
// done; open steps are a quiet hollow dot, never a warning.
export function setupStatus(done: number, total: number, known: boolean, failed: boolean): { tone: "ok" | "off" | "err" | "load"; text: string } {
  if (!known) return failed ? { tone: "err", text: "The console did not answer" } : { tone: "load", text: "Checking…" };
  return done === total ? { tone: "ok", text: "Set-up is done" } : { tone: "off", text: `${done} of ${total} steps done` };
}

export async function fetchSetup(deps: { fetch?: typeof chiefFetch } = {}): Promise<SetupAnswer> {
  const res = await (deps.fetch ?? chiefFetch)("/api/setup/steps");
  if (!res.ok) throw new Error(`steps: ${res.status}`);
  const body = (await res.json()) as Partial<SetupAnswer>;
  if (!Array.isArray(body.steps)) throw new Error("steps: no list");
  return {
    steps: body.steps, checkedAt: typeof body.checkedAt === "number" ? body.checkedAt : 0, home: body.home === true,
    protection: body.protection === "strong" ? "strong" : "basic",
    ...(body.githubApp === true ? { githubApp: true } : {}),
  };
}

// Is the Set-up page the home of this console? Null: no answer (keep what was known).
export async function fetchSetupHome(deps: { fetch?: typeof chiefFetch } = {}): Promise<boolean | null> {
  try {
    const res = await (deps.fetch ?? chiefFetch)("/api/setup/home");
    if (!res.ok) return res.status === 404 ? false : null; // an older server has no such page
    return ((await res.json()) as { home?: unknown }).home === true;
  } catch {
    return null;
  }
}

// The last answer of "home", kept in this browser: the next load opens on the right page in its
// first frame. Only a hint: the server is asked on every load.
export const SETUP_HOME_KEY = "choibot.setupHome";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStore = (): Store | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
};
export function readHomeHint(store: Store | null = browserStore()): boolean {
  try { return store?.getItem(SETUP_HOME_KEY) === "1"; } catch { return false; }
}
export function writeHomeHint(home: boolean, store: Store | null = browserStore()): void {
  try { if (home) store?.setItem(SETUP_HOME_KEY, "1"); else store?.removeItem(SETUP_HOME_KEY); } catch { /* storage blocked: no hint */ }
}

// What a user does today for the step "access" (its own action is a later part). The row of
// the list and the "Add a device" panel both say it. The command does the server side that
// needs no root, and shows the commands that only root can run (bin/lib/access.ts).
export const ACCESS_TODAY = `Run \`${USER_CLI} access\` on your server. It says how to install Tailscale and to sign in, and then it turns the private address on. Use the same Tailscale account on each device.`;
