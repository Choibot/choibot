import { chiefFetch, refusalSentence } from "./chief";
// src/lib/accounts.ts — the Claude logins this box has (see server/agents/accounts.ts).
// `default` is the box's own ~/.claude login; the others are extra logins the
// console created. A new one reads loggedIn:false until the user logs in to it from the page
// (Settings, Claude accounts).
export const DEFAULT_ACCOUNT = "default";

// How much of its plan a login has used (server/agents/loginuse.ts). Percent of the 5-hour
// window and of the week window; `until`: when a login at its limit works again (epoch ms).
// `models`: the models whose own week window is full on this login ("Fable"). Absent: an older server.
export type LoginUse = { session: number | null; week: number | null; atLimit: boolean; until: number | null; models?: { name: string; until: number | null }[] };

export type AccountInfo = {
  id: string;
  label: string;      // email once logged in, else the id
  email: string | null;
  loggedIn: boolean;
  // Claude said that this login is signed out, and nobody signed in again since. Then
  // loggedIn is false. Absent: not so, or an older server.
  signedOut?: boolean;
  isDefault: boolean;
  // Null: not known (not logged in, or the console could not read the usage). Absent: an older server.
  use?: LoginUse | null;
  // The agents on this login that are not closed.
  agents?: number;
  // The second sign-in (the login of the fleet master, the leads and the helper for tickets),
  // and those of them that wait for it (their ids). Absent: a console with one login.
  persistent?: true;
  waits?: string[];
  // Basic protection's main login: the Claude login of your server's own user (also of a terminal
  // there). Sign out says so. Absent: another login, or an older server.
  userLogin?: true;
};

export async function fetchAccounts(): Promise<AccountInfo[]> {
  return (await fetchAccountsState()).accounts;
}

// The accounts plus the one new agents get by default (CLAUDE_DEFAULT_ACCOUNT
// on the server; "default" when unset).
export async function fetchAccountsState(): Promise<{ accounts: AccountInfo[]; preferred: string }> {
  const r = await chiefFetch("/api/accounts");
  if (!r.ok) throw new Error("load accounts");
  const j = (await r.json()) as { accounts: AccountInfo[]; preferred?: string };
  return { accounts: j.accounts, preferred: j.preferred ?? DEFAULT_ACCOUNT };
}

export async function createAccount(id: string): Promise<{ ok: boolean; account?: AccountInfo; error?: string }> {
  const r = await chiefFetch("/api/accounts", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
  });
  const body = await r.json().catch(() => ({}));
  // With chief on, adding a login is a USER action: an unpaired browser gets the pairing sentence.
  if (!r.ok) return { ok: false, error: refusalSentence(r.status, body, "Adding a login") ?? body.error ?? `failed (${r.status})` };
  return { ok: true, account: body.account };
}

export async function deleteAccount(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await chiefFetch(`/api/accounts/${encodeURIComponent(id)}/delete`, { method: "POST" });
  if (r.ok) return { ok: true };
  const body = await r.json().catch(() => ({}));
  return { ok: false, error: body.error ?? `failed (${r.status})` };
}

// Move an agent to another login. A live agent is relaunched with its
// conversation resumed; a dead one just records it for its next Resume. "waits": a lead or
// the fleet master is busy now, and moves when it is quiet.
export type SwitchOutcome = "resumed" | "cold" | "patched" | "unchanged" | "waits";
// A device that is not paired (the move of a lead or the fleet master is the paired user's): the
// pairing sentence.
export async function switchAgentAccount(agentId: string, account: string, f: typeof chiefFetch = chiefFetch): Promise<SwitchOutcome> {
  const r = await f(`/api/agents/${agentId}/account`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(refusalSentence(r.status, body, "A move of this agent") ?? body.error ?? "switch failed");
  return body.outcome as SwitchOutcome;
}

// ---- the Claude login of an account, from the page (server/agents/claudelogin.ts) ----
// The console runs the login of Claude Code for the account. The page shows the sign-in link
// and takes the code that the page of Claude gives. No terminal.
export type ClaudeLoginReason = "wrong-code" | "expired" | "no-claude" | "no-answer" | "not-saved" | "failed";
export type ClaudeLoginView =
  | { state: "idle" }
  | { state: "starting" | "checking"; account: string }
  | { state: "waiting"; account: string; url: string; leftMs: number }
  | { state: "done"; account: string; email: string | null; plan: string | null }
  | { state: "failed"; account: string; reason: ClaudeLoginReason };

const NO_ANSWER = "The console did not answer. Try again.";
type Fetch = typeof chiefFetch;

async function loginCall(f: Fetch, url: string, body?: unknown): Promise<ClaudeLoginView> {
  let r: Response;
  try {
    r = await f(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(NO_ANSWER);
  }
  const json = (await r.json().catch(() => null)) as (ClaudeLoginView & { error?: string }) | null;
  if (!r.ok || json === null) throw new Error(refusalSentence(r.status, json, "A Claude login") ?? (typeof json?.error === "string" && / /.test(json.error) ? json.error : NO_ANSWER));
  return json;
}

// `account`: which login's flow (the second sign-in has its own: PERSISTENT_LOGIN). None: the
// first login, as before.
const forAccount = (account?: string) => (account ? { account } : {});
export const fetchClaudeLogin = (f: Fetch = chiefFetch, account?: string): Promise<ClaudeLoginView> =>
  loginCall(f, account ? `/api/accounts/login?account=${encodeURIComponent(account)}` : "/api/accounts/login");
export const startClaudeLogin = (account: string, fresh = false, f: Fetch = chiefFetch): Promise<ClaudeLoginView> =>
  loginCall(f, `/api/accounts/${encodeURIComponent(account)}/login`, { fresh });
export const sendClaudeLoginCode = (code: string, f: Fetch = chiefFetch, account?: string): Promise<ClaudeLoginView> => loginCall(f, "/api/accounts/login/code", { code, ...forAccount(account) });
export const cancelClaudeLogin = (f: Fetch = chiefFetch, account?: string): Promise<ClaudeLoginView> => loginCall(f, "/api/accounts/login/cancel", forAccount(account));

// The second sign-in (server/agents/api.ts PERSISTENT_LOGIN): the login of the fleet master, the
// leads and the helper for tickets, where the console has it.
export const PERSISTENT_LOGIN = "persistent";

// Why a login ended with no success, and what to press.
export function claudeLoginProblem(reason: ClaudeLoginReason): string {
  switch (reason) {
    case "wrong-code": return "Claude did not accept the code. A code works one time, with the link it came from. Press New link, sign in again, and paste the new code.";
    case "expired": return "The sign-in link ran out. Press New link.";
    case "no-claude": return "The Claude program is not on your server. Run the install line of the console again: it installs Claude.";
    case "no-answer": return "Claude gave no sign-in link. Check the internet connection of your server. Then press New link.";
    case "not-saved": return "Claude did not save the sign-in. Press New link and sign in again.";
    default: return "The login did not work. Press New link.";
  }
}

// "Logged in as ada@example.com. Plan: Max."
export function claudeLoginDone(v: { email: string | null; plan: string | null }): string {
  return `Logged in${v.email ? ` as ${v.email}` : ""}.${v.plan ? ` Plan: ${v.plan}.` : ""}`;
}

// The name of a new login. The user gives none: the e-mail of the account is its name after
// the login. "login-2", "login-3", … the first one that is free.
export function freeLoginName(taken: string[]): string {
  for (let n = 2; ; n++) if (!taken.includes(`login-${n}`)) return `login-${n}`;
}

// ---- a login at its limit: the use, the default login, the move of agents ----

// "Make default": the login that new agents start on.
export async function makeDefaultLogin(id: string, f: Fetch = chiefFetch): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await f("/api/accounts/default", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    if (r.ok) return { ok: true };
    const body = (await r.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: refusalSentence(r.status, body, "A change of the default login") ?? (body?.error && / /.test(body.error) ? body.error : NO_ANSWER) };
  } catch {
    return { ok: false, error: NO_ANSWER };
  }
}

// "Move all agents" of one login to another one. What the server did: `moved` (also an agent
// with no session: it gets the new login for its next start), `waits` (a lead, the fleet master
// or the helper for tickets is busy now and moves by itself when it is quiet), `working` (the
// login works and the agent works now: it stays, so its turn is not cut), `failed`.
export type MoveResult = { moved: number; waits: number; failed: number; working: number };
export async function moveAllAgents(from: string, to: string, f: Fetch = chiefFetch): Promise<({ ok: true } & MoveResult) | { ok: false; error: string }> {
  try {
    const r = await f(`/api/accounts/${encodeURIComponent(from)}/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to }) });
    const body = (await r.json().catch(() => null)) as (Partial<MoveResult> & { error?: string }) | null;
    if (!r.ok || !body) return { ok: false, error: refusalSentence(r.status, body, "A move of agents") ?? (body?.error && / /.test(body.error) ? body.error : NO_ANSWER) };
    return { ok: true, moved: body.moved ?? 0, waits: body.waits ?? 0, failed: body.failed ?? 0, working: body.working ?? 0 };
  } catch {
    return { ok: false, error: NO_ANSWER };
  }
}

// The result line of a move: "7 agents moved to ada@example.com. They keep their conversations."
// Then the agents that wait, stay or failed, each in one sentence. `to`: the name of the login.
export function movedText(r: Omit<MoveResult, "working"> & { working?: number }, to?: string): string {
  const n = (v: number) => `${v} agent${v === 1 ? "" : "s"}`;
  const one = (v: number, a: string, b: string) => (v === 1 ? a : b);
  const working = r.working ?? 0;
  if (!r.moved && !r.waits && !r.failed && !working) return "No open agent was on this login.";
  const parts = [r.moved
    ? `${n(r.moved)} moved${to ? ` to ${to}` : ""}. ${one(r.moved, "It keeps its conversation.", "They keep their conversations.")}`
    : "No agent moved yet."];
  if (r.waits) parts.push(`${n(r.waits)} ${one(r.waits, "is", "are")} busy now: ${one(r.waits, "it moves by itself when it is", "they move by themselves when they are")} quiet.`);
  if (working) parts.push(`${n(working)} ${one(working, "works now, so it did not move. Move it when it is", "work now, so they did not move. Move them when they are")} quiet.`);
  if (r.failed) parts.push(`${n(r.failed)} did not move. Try again.`);
  return parts.join(" ");
}

// Why the agents of a login must go to another login: Claude said that it is signed out, it is
// not logged in, or it is at its limit. Null: the login works, and its agents stay. The second
// sign-in (your assistant's) is never moved from: its agents can be on it only.
export type MoveWhy = "signed-out" | "not-logged-in" | "limit";
export function moveWhy(a: AccountInfo): MoveWhy | null {
  if (a.persistent) return null;
  if (!a.loggedIn) return a.signedOut ? "signed-out" : "not-logged-in";
  return a.use?.atLimit ? "limit" : null;
}

// The move of all agents of one login (Settings, Claude accounts): how many agents, why they must
// move, the logins they can go to, and the one picked: the user's pick while it is in the list,
// else the first login with room. Null when no login has room: then the user must pick.
export type MoveFacts = { n: number; why: MoveWhy | null; choices: MoveChoice[]; to: MoveChoice | null };
export function moveFacts(a: AccountInfo, rows: AccountInfo[], pick: string | undefined, now: number): MoveFacts {
  const n = a.agents ?? 0;
  const why = moveWhy(a);
  const choices = why && n > 0 ? moveChoices(rows, a.id, [], now) : [];
  return { n, why, choices, to: choices.find((c) => c.id === pick) ?? choices.find((c) => c.room) ?? null };
}

// The quiet text of a login's row: its use, and how many agents are on it (also when it is signed
// out: they must move). The second sign-in that is not logged in has its own line (waitersText).
export function loginMeta(a: AccountInfo, now: number): string {
  const n = a.agents ?? 0;
  if (a.persistent && !a.loggedIn) return "";
  return [a.loggedIn ? useText(a.use, now) : "", n > 0 ? `${n} agent${n === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
}

// "14:00", or "Fri 14:00" when that is not today.
export function clockText(ms: number, now: number): string {
  const d = new Date(ms), n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return same ? time : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${time}`;
}

// "At its limit until 14:00" / "At its limit"
export function limitText(use: LoginUse, now: number): string {
  return use.until ? `At its limit until ${clockText(use.until, now)}` : "At its limit";
}

// The models that have no room on a login: "No room for Fable until Fri 14:00". Each model
// has its own week window; the other models still work. Empty: each model has room.
export function modelsText(use: LoginUse | null | undefined, now: number): string {
  const full = use?.models ?? [];
  if (full.length === 0) return "";
  const names = full.map((m) => m.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  // One time for the line: the last one, when each time is known.
  const until = full.every((m) => m.until !== null) ? Math.max(...full.map((m) => m.until!)) : null;
  return `No room for ${list}${until ? ` until ${clockText(until, now)}` : ""}`;
}

// The use of a login in one short line: "5-hour window 42% · week 10%". A model with no room
// comes first. Empty: not known.
export function useText(use: LoginUse | null | undefined, now: number): string {
  if (!use) return "";
  if (use.atLimit) return limitText(use, now);
  const parts = [modelsText(use, now), use.session !== null ? `5-hour window ${use.session}%` : "", use.week !== null ? `week ${use.week}%` : ""].filter(Boolean);
  return parts.join(" · ");
}

// The login to move to from `from`: logged in, not at its limit, and with the most room in
// its 5-hour window. A login whose use is not known comes last. `models`: the move is for
// these models (their week window is full on `from`), so a login where one of them is full
// too is no help. Null: no such login.
export function loginToMoveTo(accounts: AccountInfo[], from: string, models: string[] = []): AccountInfo | null {
  const ok = accounts.filter((a) => a.id !== from && a.loggedIn && !a.use?.atLimit
    && !(a.use?.models ?? []).some((m) => models.includes(m.name)));
  const room = (a: AccountInfo) => (a.use ? 100 - (a.use.session ?? 0) : -1);
  return ok.sort((a, b) => room(b) - room(a))[0] ?? null;
}

// The logins that the user can pick for a move from `from`: each other login that is logged
// in. The ones with room come first (the most room first: the first one is the pick of
// loginToMoveTo), then the ones with no room. `label`: the name with one word of its state, so
// the user sees what each pick gives. `models`: as in loginToMoveTo. The second sign-in (your
// assistant's) is not a pick: it is for the persistent agents only.
export type MoveChoice = { id: string; name: string; room: boolean; label: string };
export function moveChoices(accounts: AccountInfo[], from: string, models: string[] = [], now: number = Date.now()): MoveChoice[] {
  const others = accounts.filter((a) => a.id !== from && a.loggedIn && !a.persistent);
  const fullHere = (a: AccountInfo) => (a.use?.models ?? []).filter((m) => models.includes(m.name)).map((m) => m.name);
  const hasRoom = (a: AccountInfo) => !a.use?.atLimit && fullHere(a).length === 0;
  const room = (a: AccountInfo) => (a.use ? 100 - (a.use.session ?? 0) : -1);
  const state = (a: AccountInfo): string => {
    if (!a.use) return "use not known";
    if (a.use.atLimit) return limitText(a.use, now).replace(/^At/, "at");
    const full = fullHere(a);
    if (full.length) return `no room for ${full.join(", ")}`;
    return a.use.session !== null ? `5-hour window ${a.use.session}%` : a.use.week !== null ? `week ${a.use.week}%` : "has room";
  };
  return [...others.filter(hasRoom).sort((a, b) => room(b) - room(a)), ...others.filter((a) => !hasRoom(a))]
    .map((a) => ({ id: a.id, name: loginName(a), room: hasRoom(a), label: `${loginName(a)} · ${state(a)}` }));
}

// ---- "Sign out" of a login (POST /api/accounts/:id/logout) ----

// What the sign-out of one login does to its agents, before the user presses it (the confirm
// block of Settings). "move": they move to another login that works first (the move of "Move
// all"); "stop": no other login works, so their Claude ends (they keep their conversations);
// "none": no agent is on it. The second sign-in is always "stop" (its agents can be on it only).
export type SignOutMode = "move" | "stop" | "none";
export type SignOutFacts = { n: number; mode: SignOutMode; choices: MoveChoice[]; to: MoveChoice | null };
export function signOutFacts(a: AccountInfo, rows: AccountInfo[], pick: string | undefined, now: number): SignOutFacts {
  const n = a.agents ?? 0;
  const choices = n > 0 && !a.persistent ? moveChoices(rows, a.id, [], now) : [];
  const mode: SignOutMode = n === 0 ? "none" : choices.length ? "move" : "stop";
  return { n, mode, choices, to: choices.find((c) => c.id === pick) ?? choices.find((c) => c.room) ?? choices[0] ?? null };
}

// The text of the confirm block: what the press does, before it is pressed. `to`: the name of the
// login that the agents move to (mode "move").
export function signOutNote(a: Pick<AccountInfo, "persistent" | "userLogin">, f: Pick<SignOutFacts, "n" | "mode">, to?: string): string {
  const n = (v: number) => `${v} agent${v === 1 ? "" : "s"}`;
  const its = f.n === 1 ? "It keeps its conversation" : "They keep their conversations";
  const parts: string[] = [];
  if (a.persistent) {
    parts.push(f.n > 0
      ? "Your assistant (the fleet master), the leads and the helper for tickets stop. They start again by themselves after your next second sign-in."
      : "Your assistant (the fleet master), the leads and the helper for tickets start after your next second sign-in.");
    parts.push("Your server forgets this sign-in.");
  } else if (f.mode === "move") {
    parts.push(`First ${f.n === 1 ? "its agent moves" : `its ${n(f.n)} move`} to ${to ?? "the login you pick"}. ${its}. Then your server forgets this login.`);
    parts.push("An agent that works now does not move, and then nothing signs out: sign out when it is quiet.");
  } else if (f.mode === "stop") {
    parts.push(`No other login works, so ${f.n === 1 ? "its agent stops" : `its ${n(f.n)} stop`}. ${its}. Then your server forgets this login.`);
    parts.push("When you log in again, your assistant (the fleet master), the leads and the helper for tickets start again by themselves; you start a worker again from its pane. While an agent works, nothing signs out: sign out when it is quiet.");
  } else {
    parts.push("Your server forgets this login. To use it again, log in again on this page.");
  }
  if (a.userLogin) parts.push("This is the Claude login of your server's user: Claude also signs out there, for example in a terminal on your server, and the console's own help (the guide, Fill in) stops until you log in again.");
  return parts.join(" ");
}

// What the server did. `signedOut`: Claude signed out and the login is not on your server any
// more. The counts: the moves (as "Move all"), the agents whose Claude ended (`stopped`) or did
// not end (`notEnded`), and the Recurring tasks that run on the login. `why`: why it did not
// sign out.
export type SignOutWhy = "busy" | "moves" | "recurring" | "still-there" | "no-claude" | "old-helper" | "failed";
// `waiting`: the persistent agents among `stopped` that wait for a login and start again by
// themselves; `restarted`: those that started again at once (the login was still there).
export type SignOutResult = MoveResult & { signedOut: boolean; stopped: number; notEnded: number; waiting: string[]; restarted: string[]; recurring: string[]; why?: SignOutWhy };
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
export async function signOutLogin(id: string, to: string | undefined, f: Fetch = chiefFetch): Promise<({ ok: true } & SignOutResult) | { ok: false; error: string }> {
  try {
    const r = await f(`/api/accounts/${encodeURIComponent(id)}/logout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(to ? { to } : {}) });
    const body = (await r.json().catch(() => null)) as (Partial<SignOutResult> & { error?: string }) | null;
    // A decided answer (signed out or not, and why) has the counts; a refusal has only `error`.
    if (!body || typeof body.signedOut !== "boolean") {
      return { ok: false, error: refusalSentence(r.status, body, "A sign-out") ?? (body?.error && / /.test(body.error) ? body.error : NO_ANSWER) };
    }
    return {
      ok: true, signedOut: body.signedOut, moved: body.moved ?? 0, waits: body.waits ?? 0, failed: body.failed ?? 0, working: body.working ?? 0,
      stopped: body.stopped ?? 0, notEnded: body.notEnded ?? 0, waiting: ids(body.waiting), restarted: ids(body.restarted), recurring: ids(body.recurring), ...(body.why ? { why: body.why } : {}),
    };
  } catch {
    return { ok: false, error: NO_ANSWER };
  }
}

// The result line of a sign-out, in plain words. Each part says only what happened: a move, a
// stop and a sign-out that did not happen are never said as done, and "Nothing changed" only when
// nothing did. `second`: the second sign-in (its agents start again after the next one).
export function signedOutText(r: SignOutResult, name: string, to?: string, second = false): string {
  const n = (v: number) => `${v} agent${v === 1 ? "" : "s"}`;
  const one = (v: number, a: string, b: string) => (v === 1 ? a : b);
  const tasks = (names: string[]) => names.map((x) => `"${x}"`).join(", ");
  // "busy": nothing moved (the counts are of the agents that are busy).
  const moves = r.why !== "busy" && (r.moved || r.waits || r.failed || r.working) ? movedText(r, to) : "";
  const workers = Math.max(0, r.stopped - r.waiting.length - r.restarted.length);
  const stops: string[] = [];
  if (workers) stops.push(`${n(workers)} stopped and ${one(workers, "keeps its conversation", "keep their conversations")}: start ${one(workers, "it", "them")} again from ${one(workers, "its pane", "their panes")}${r.signedOut ? " after you log in again" : ""}.`);
  if (r.waiting.length) {
    const w = r.waiting.length;
    stops.push(`${persistentList(r.waiting)} ${one(w, "waits", "wait")} and ${one(w, "starts", "start")} again by ${one(w, "itself", "themselves")} ${second ? "after your next second sign-in" : "when you log in again"}.`);
  }
  if (r.restarted.length) stops.push(`${persistentList(r.restarted)} stopped and ${one(r.restarted.length, "started", "started")} again at once.`);
  if (r.notEnded) stops.push(`${n(r.notEnded)} did not stop: ${one(r.notEnded, "it works", "they work")} now.${r.signedOut ? ` Stop ${one(r.notEnded, "it", "them")} when ${one(r.notEnded, "it is", "they are")} quiet, else Claude can sign this login in again.` : ""}`);
  if (!r.signedOut) {
    const changed = Boolean(moves || r.stopped || r.notEnded);
    const why = ((): string => {
      switch (r.why) {
        case "busy": return r.waits
          ? `${n(r.waits)} moved off this login a moment ago and ${one(r.waits, "runs", "run")} on it until ${one(r.waits, "it is", "they are")} quiet. Sign out after that.`
          : `${n(r.working)} ${one(r.working, "works", "work")} now. Sign out when ${one(r.working, "it is", "they are")} quiet: a sign-out now would cut ${one(r.working, "its turn", "their turns")}.`;
        case "moves": return "Sign out again when each agent has moved.";
        case "recurring": return `The Recurring ${one(r.recurring.length, "task", "tasks")} ${tasks(r.recurring)} ${one(r.recurring.length, "runs", "run")} on this login now. Sign out when ${one(r.recurring.length, "it ends", "they end")}.`;
        case "still-there": return "Claude signed out, but the login was back on your server after two tries. Stop the agents and the Recurring tasks on it, then try again.";
        case "old-helper": return `Your server needs its update before this login can sign out.${changed ? "" : " Nothing changed."}`;
        case "no-claude": return `The Claude program is not on your server.${changed ? "" : " Nothing changed."}`;
        default: return `Claude did not sign out.${changed ? "" : " Nothing changed."} Try again.`;
      }
    })();
    return [moves, `${name} is not signed out.`, why, ...stops].filter(Boolean).join(" ");
  }
  const parts = [moves, `${name} is signed out: your server forgot this login.`, ...stops];
  if (r.recurring.length) parts.push(`The Recurring ${one(r.recurring.length, "task", "tasks")} ${tasks(r.recurring)} started on this login during the sign-out. If the login shows here again, sign out again.`);
  return parts.filter(Boolean).join(" ");
}

// What the console knows about one agent and the limits (the record of the agent: stopwhy.ts,
// spawn.ts). stop: its last turn was cut. waitsLogin: it has no session yet, no login had room.
// startedOn: it started on another login than the default one.
export type AgentLimitFacts = {
  status?: string;
  stop?: { why: "limit" | "model" | "login"; text: string };
  waitsLogin?: { until: number | null };
  startedOn?: { from: string; until: number | null };
};

// The words of an agent in the list when a limit is in its way, else null (the usual word).
export function limitWord(a: AgentLimitFacts): string | null {
  if (a.waitsLogin) return "waits for a login";
  if (a.stop && a.status !== "running") return a.stop.why === "limit" ? "stopped at a limit" : a.stop.why === "login" ? "its Claude login is signed out" : "stopped: model error";
  return null;
}

// The same in two words at most, for the row of the agent in the list.
export function limitTag(a: AgentLimitFacts): string | null {
  if (a.waitsLogin) return "waits";
  if (a.stop && a.status !== "running") return a.stop.why === "limit" ? "at a limit" : a.stop.why === "login" ? "signed out" : "model error";
  return null;
}

// The line under the header of an agent. head: what is so. quiet: what it means. act: the
// button ("move": to another login; "start": the agent has no session yet). Null: no line.
export type LimitLine = { head: string; quiet: string; act: "move" | "start" | null; models: string[] };

export function limitLine(o: { agent: AgentLimitFacts; login: AccountInfo | null; others: number; now: number }): LimitLine | null {
  const { agent, login, now } = o;
  const name = login ? loginName(login) : "its login";
  const use = login?.use ?? null;
  const until = (t: number | null) => (t ? ` until ${clockText(t, now)}` : "");
  const none = o.others === 0 ? " No other login is logged in. Add a login in Settings, Claude accounts." : "";
  if (agent.waitsLogin) {
    return {
      head: `No Claude login has room now, so this agent did not start.`,
      quiet: `It starts by itself when a login has room again${agent.waitsLogin.until ? ` (about ${clockText(agent.waitsLogin.until, now)})` : ""}. You can also start it now on the login you pick.`,
      act: "start", models: [],
    };
  }
  const stopped = agent.stop && agent.status !== "running" ? agent.stop : null;
  if (use?.atLimit) {
    return {
      head: `The Claude login of this agent (${name}) is at its limit${until(use.until)}.`,
      quiet: stopped ? `Its last turn was cut. After a move the agent goes on by itself.${none}` : `The agent cannot work on it now.${none}`,
      act: "move", models: [],
    };
  }
  const models = (use?.models ?? []).map((m) => m.name);
  if (models.length) {
    return {
      head: `The Claude login of this agent (${name}) has ${modelsText(use, now).replace(/^No room/, "no room")}.`,
      quiet: stopped ? `Its last turn was cut. After a move the agent goes on by itself.${none}` : `An agent that uses ${models.length === 1 ? "that model" : "one of them"} waits. The other models work.${none}`,
      act: "move", models,
    };
  }
  // The console has no usage that shows it (the read is late, or it failed), but the agent
  // itself was cut: the line of the Claude program says why.
  if (stopped?.why === "login") {
    return {
      head: `This agent stopped: its Claude login (${name}) is signed out.`,
      quiet: `Claude said: “${stopped.text}”. Sign in to that login again in Settings, Claude accounts, or move the agent to another login. After a move the agent goes on by itself.${none}`,
      act: "move", models: [],
    };
  }
  if (stopped) {
    return {
      head: stopped.why === "limit"
        ? `This agent stopped: its Claude login (${name}) has no room.`
        : `This agent stopped: the model of its session does not work for its Claude login (${name}).`,
      quiet: `Claude said: “${stopped.text}”. After a move to another login the agent goes on by itself.${none}`,
      act: "move", models: [],
    };
  }
  if (agent.startedOn) {
    return {
      head: `The default login (${agent.startedOn.from}) had no room${until(agent.startedOn.until && agent.startedOn.until > now ? agent.startedOn.until : null)}, so this agent started on ${name}.`,
      quiet: "The default login stays the default.", act: null, models: [],
    };
  }
  return null;
}

// The name of a login for a person: the e-mail, else "Main login" or its id.
export const loginName = (a: Pick<AccountInfo, "id" | "email" | "isDefault" | "persistent">): string =>
  a.persistent ? `Your assistant's sign-in${a.email ? ` (${a.email})` : ""}` : a.email ?? (a.isDefault ? "Main login" : a.id);

// Persistent agents in plain words (no id), with a capital: "The fleet master and the lead for web".
export function persistentList(ids: string[]): string {
  const names = ids.map((id) => (id === "fleet-master" ? "the fleet master" : id === "coordinator" ? "the helper for tickets" : id.startsWith("lead-") ? `the lead for ${id.slice(5)}` : "an agent"));
  const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return list ? `${list.charAt(0).toUpperCase()}${list.slice(1)}` : "";
}

// The persistent agents that wait for the second sign-in, in plain words (no id).
export function waitersText(ids: string[]): string {
  const list = persistentList(ids);
  return list ? `${list} ${ids.length === 1 ? "waits" : "wait"} for this sign-in.` : "";
}

// What to print for an account in a tight spot (a tag, a dropdown row): the
// email's local part when we have one, else the id. An account still waiting
// on its first login says so, since picking it means logging in first.
export function accountShort(a: Pick<AccountInfo, "id" | "email" | "loggedIn">): string {
  const name = a.email ? a.email.split("@")[0] : a.id;
  return a.loggedIn ? name : `${name} · not logged in`;
}
