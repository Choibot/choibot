// src/lib/settings.ts — the Settings page's pure parts: the status line of each section (a dot
// and a few words), the checks a form runs before it sends, and the one way an action's refusal
// becomes a sentence. The page reads what the server already has (GET /api/leads, /api/accounts,
// /api/repos); every action goes to a USER route (server/chief/gate.ts gateUser).
import { chiefFetch, refusalSentence } from "./chief";
import type { LeadRow } from "./leads";
import type { AccountInfo } from "./accounts";
import type { RepoInfo } from "./agents";
// Types only from the server modules (no node import reaches the browser).
import type { BotInfo, Target, TargetId } from "../../server/settings/telegram";
import type { GitHubStatus } from "../../server/settings/github";
import type { AppReposView, AppTokenView } from "../../server/gh/appapi";
import type { UsedSource } from "../../server/gh/appused";
import type { LinkKind, LinkView, Restart } from "../../server/settings/link";

// The dot of a status line: ok (set up and working), off (not set up), warn (set up, but
// something needs the user), err (broken or cannot be read), load (not known yet).
export type Tone = "ok" | "off" | "warn" | "err" | "load";
export type SectionStatus = { tone: Tone; text: string };

export const LOADING: SectionStatus = { tone: "load", text: "Checking…" };

// The section shown when the page opens (desktop) and none was picked before.
export const FIRST_SECTION = "leads";

// What a section's read gave: the rows, "off" (the route does not exist: chief off), or the
// error text. null = not read yet.
export type Read<T> = { rows: T[] } | { off: true } | { error: string } | null;

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// Leads: they need the chief (GET /api/leads is 404 without it).
export function leadsStatus(r: Read<LeadRow>): SectionStatus {
  if (r === null) return LOADING;
  if ("off" in r) return { tone: "off", text: "Not set up: leads are off on this console" };
  if ("error" in r) return { tone: "err", text: `Cannot read the leads: ${r.error}` };
  const rows = r.rows;
  if (rows.length === 0) return { tone: "off", text: "No leads yet" };
  const broken = rows.filter((l) => l.status === "error").map((l) => l.area);
  if (broken.length) return { tone: "warn", text: `${broken.length === 1 ? "Lead" : "Leads"} ${broken.join(", ")} stopped with an error` };
  const noRepos = rows.filter((l) => l.repos.length === 0).map((l) => l.area);
  const live = rows.filter((l) => l.status === "running" || l.status === "idle").length;
  const base = `${plural(rows.length, "lead")} · ${live} live`;
  if (noRepos.length) return { tone: "warn", text: `${base} · ${noRepos.join(", ")} has no repos` };
  return { tone: "ok", text: base };
}

// The word for a lead's own state (its record's status; null = no record yet).
export function leadWord(status: string | null | undefined, waits = false): string {
  // It waits for the second sign-in: not stopped, not an error.
  if (waits) return "Waits for its sign-in";
  switch (status) {
    case "running": return "Working";
    case "idle": return "Waiting";
    case "done": return "Stopped";
    case "error": return "Error";
    default: return "Not started";
  }
}

export function accountsStatus(r: Read<AccountInfo>, preferred: string): SectionStatus {
  if (r === null) return LOADING;
  if ("off" in r) return { tone: "off", text: "Not set up" };
  if ("error" in r) return { tone: "err", text: `Cannot read the logins: ${r.error}` };
  const def = r.rows.find((a) => a.id === preferred);
  if (!def) return { tone: "warn", text: `The default login "${preferred}" does not exist` };
  // The second sign-in (the fleet master's, the leads' and the helper's) asks for nothing until one
  // of them waits for it: before that, it is not a missing login.
  const counted = r.rows.filter((a) => !a.persistent || (a.waits?.length ?? 0) > 0);
  const waiting = counted.filter((a) => !a.loggedIn).length;
  // No login at all: agents cannot work. The page has the login (no terminal).
  if (waiting > 0 && waiting === counted.length) return { tone: "warn", text: "Not logged in to Claude. Press Log in." };
  const base = `Connected · ${plural(r.rows.length, "login")}`;
  // A login that Claude signed out is not a new one: it says so.
  const out = counted.filter((a) => !a.loggedIn && a.signedOut).length;
  const text = [base, out ? `${out} signed out` : "", waiting - out ? `${waiting - out} not logged in yet` : ""].filter(Boolean).join(" · ");
  return waiting ? { tone: "warn", text } : { tone: "ok", text: base };
}

export function reposStatus(r: Read<RepoInfo>): SectionStatus {
  if (r === null) return LOADING;
  if ("off" in r) return { tone: "off", text: "Not set up" };
  if ("error" in r) return { tone: "err", text: `Cannot read the workspace: ${r.error}` };
  return r.rows.length ? { tone: "ok", text: `${plural(r.rows.length, "repo")} in the workspace` } : { tone: "off", text: "No repos in the workspace yet" };
}

// = server/chief/leads/areas.ts AREA_RE (a node module).
export const AREA_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Why a new area name cannot be used, or null.
export function areaNameError(name: string, existing: string[]): string | null {
  if (!name) return "Type a name for the area";
  if (!AREA_RE.test(name)) return "Use lowercase letters, digits and -, max 32, starting with a letter or digit";
  if (existing.includes(name)) return "That area exists: edit its repos below";
  return null;
}

// The name of an area made from the name of a repo: lowercase letters, digits and "-" (the
// rule of AREA_RE), and not a name that is taken ("shop", then "shop-2"). Empty: the repo name
// gives no valid name.
export function areaNameFrom(repo: string, existing: string[]): string {
  const base = repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  if (!base) return "";
  for (let n = 1; ; n++) {
    const tail = n === 1 ? "" : `-${n}`;
    const name = `${base.slice(0, 32 - tail.length).replace(/-+$/, "")}${tail}`;
    if (!existing.includes(name)) return name;
  }
}

// What the "New lead" form starts with, so the user can press "Start lead" at once: the first
// repo that no lead has yet, and the name made from it. No free repo: an empty form.
export function newLeadStart(allRepos: string[], leads: { area: string; repos: string[] }[]): { name: string; repos: string[] } {
  const taken = new Set(leads.flatMap((l) => l.repos));
  const repo = allRepos.find((r) => !taken.has(r));
  return repo ? { name: areaNameFrom(repo, leads.map((l) => l.area)), repos: [repo] } : { name: "", repos: [] };
}

// The repos picked, in the order of the workspace list (a repo the area lists but the workspace
// does not have stays, at the end: removing it is the user's choice).
export function toggleRepo(picked: string[], name: string, all: string[]): string[] {
  const next = picked.includes(name) ? picked.filter((r) => r !== name) : [...picked, name];
  const known = all.filter((r) => next.includes(r));
  return [...known, ...next.filter((r) => !all.includes(r))];
}

export const sameRepos = (a: string[], b: string[]): boolean => a.length === b.length && a.every((r) => b.includes(r));

export type ActionResult = { ok: true } | { ok: false; error: string };

// A refused or failed action as one sentence: pairing and misconfigured first (lib/chief), then
// the server's own error text, then the status.
export async function actionError(res: Response, action: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string; userAuth?: string } | null;
  return refusalSentence(res.status, body, action) ?? (typeof body?.error === "string" && body.error ? body.error : `failed (${res.status})`);
}

// Start an area's lead, or set the repos of an area that has one (POST /api/leads: USER only; it
// writes the repos, then starts the lead if it is not running, else leaves it as it is).
export async function saveLead(area: string, repos: string[]): Promise<ActionResult> {
  try {
    const res = await chiefFetch("/api/leads", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ area, repos }),
    });
    return res.ok ? { ok: true } : { ok: false, error: await actionError(res, "Starting a lead") };
  } catch {
    return { ok: false, error: "The console did not answer" };
  }
}

// The user's avatar pick for an area's lead (POST /api/leads/:area/avatar: USER only). 0 is the
// creature of the area name itself.
export async function saveLeadAvatar(area: string, variant: number): Promise<ActionResult> {
  try {
    const res = await chiefFetch(`/api/leads/${encodeURIComponent(area)}/avatar`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variant }),
    });
    return res.ok ? { ok: true } : { ok: false, error: await actionError(res, "Changing an avatar") };
  } catch {
    return { ok: false, error: "The console did not answer" };
  }
}

// ---- the add-ons (PR B): read only, from GET /api/settings/* ----
export type { Target, TargetId, GitHubStatus, AppReposView, AppTokenView };

export type TelegramView = {
  token: boolean; userId: string | null; targets: Target[]; bot: BotInfo | null;
  chief: "on" | "off" | "misconfigured"; chiefProblem: string | null; userAuth: "telegram" | "log" | null; devices: number | null; canTest: boolean;
  // The set-up form (null: this console has no form). Never the token: only whether it is set.
  setup?: SetupView | null; bootAt?: number | null;
  // The connection made with a one-time code (null: this console has none). Never a code or an id.
  link?: LinkView | null;
};
export type { LinkKind, LinkView };
// A one-time code, as the answer of its request gives it (one time, to this device only).
export type LinkCode = { kind: LinkKind; code: string; expiresAt: number; bot: string; url?: string; send: string };
export type LinkStart = { ok: true; code: LinkCode } | { ok: false; error: string; exists: boolean };

// Asks for a one-time code (POST /api/settings/telegram/link: USER only). `replace`: the user
// confirmed that the new account or chat replaces the one that is connected.
export async function startTelegramLink(kind: LinkKind, replace = false): Promise<LinkStart> {
  try {
    const res = await chiefFetch("/api/settings/telegram/link", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, ...(replace ? { replace: true } : {}) }),
    });
    if (res.ok) return { ok: true, code: (await res.json()) as LinkCode };
    const body = (await res.clone().json().catch(() => null)) as { exists?: boolean } | null;
    return { ok: false, error: await actionError(res, "A code"), exists: body?.exists === true };
  } catch {
    return { ok: false, error: "The console did not answer", exists: false };
  }
}

// Removes the connected account or the fleet master chat (POST /api/settings/telegram/disconnect: USER only).
export async function disconnectTelegram(what: LinkKind): Promise<{ ok: true; changed: boolean; restart: Restart | null } | { ok: false; error: string }> {
  try {
    const res = await chiefFetch("/api/settings/telegram/disconnect", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ what }),
    });
    if (res.ok) return { ok: true, ...((await res.json()) as { changed: boolean; restart: Restart | null }) };
    return { ok: false, error: await actionError(res, "Disconnecting") };
  } catch {
    return { ok: false, error: "The console did not answer" };
  }
}

// How long a code still works, for the line under it.
export function codeTimeLeft(expiresAt: number, now: number): string {
  const m = Math.ceil((expiresAt - now) / 60_000);
  return m <= 1 ? "1 minute" : `${m} minutes`;
}
export type SetupField = "token" | "account" | "masterGroup" | "masterTopic" | "cronGroup" | "cronTopic";
export type SetupView = {
  values: Record<Exclude<SetupField, "token">, string>;
  tokenSet: boolean; canSave: boolean; why: string | null;
  restart: { ok: true } | { ok: false; why: string }; restarting: boolean;
};
export type SetupResult =
  | { ok: true; saved: boolean; text?: string; restart?: { ok: true } | { ok: false; why: string } }
  | { ok: false; field: SetupField | null; error: string };

// Saves the Telegram form (POST /api/settings/telegram/setup: USER only). The token goes to the
// server once; the answer never holds it.
export async function saveTelegramSetup(input: Partial<Record<SetupField, string>>): Promise<SetupResult> {
  try {
    const res = await chiefFetch("/api/settings/telegram/setup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    if (res.ok) return { ok: true, ...(await res.json()) };
    const body = (await res.clone().json().catch(() => null)) as { field?: SetupField | null; error?: string } | null;
    const refused = refusalSentence(res.status, body as never, "Saving the set-up");
    return { ok: false, field: refused ? null : body?.field ?? null, error: refused ?? body?.error ?? `failed (${res.status})` };
  } catch {
    return { ok: false, field: null, error: "The console did not answer" };
  }
}

const labelOf = (v: TelegramView, id: TargetId): string => v.targets.find((t) => t.id === id)?.label ?? id;

export function telegramStatus(r: Read<TelegramView>): SectionStatus {
  if (r === null) return LOADING;
  if ("off" in r) return { tone: "off", text: "Not set up" };
  if ("error" in r) return { tone: "err", text: `Cannot read the Telegram set-up: ${r.error}` };
  const v = r.rows[0];
  if (!v.token) return { tone: "off", text: "Not connected: the console has no bot yet" };
  if (v.bot && !v.bot.ok) return { tone: "err", text: `The bot token does not work: ${v.bot.error}` };
  const who = v.bot?.ok && v.bot.username ? `Connected as @${v.bot.username}` : "Connected";
  const gaps = v.targets.filter((t) => (t.missing.length || t.problem) && !t.off).map((t) => t.id);
  if (gaps.length) return { tone: "warn", text: `${who} · ${gaps.map((id) => labelOf(v, id)).join(", ")} not set up` };
  return { tone: "ok", text: who };
}

// A target's state in plain words (no key name: those are in the "How to set this up" fold).
export function targetState(t: Target): { word: "Ready" | "Not set up" | "Off"; tone: Tone; needs: string | null } {
  if (t.off) return { word: "Off", tone: "off", needs: t.off };
  const m = new Set(t.missing);
  if (!m.size && !t.problem) return { word: "Ready", tone: "ok", needs: null };
  const no = (needs: string) => ({ word: "Not set up" as const, tone: "warn" as Tone, needs });
  if (m.has("TELEGRAM_BOT_TOKEN")) return no("Needs the bot first.");
  if (t.id === "queue") {
    if (t.problem) return no("The chief of staff has a set-up problem: see How to set this up.");
    if ([...m].some((k) => k !== "CHIEF_ENABLED")) return no("Needs your connected chat, or the fleet master chat.");
    return no("Needs the chief of staff to be on.");
  }
  if (t.id === "master") {
    const parts = [m.has("TELEGRAM_ISSUES_USER_ID") && "your Telegram account", m.has("TELEGRAM_MASTER_CHAT_ID") && "a group", m.has("TELEGRAM_MASTER_THREAD_ID") && "a topic"].filter(Boolean) as string[];
    return no(`Needs ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "a group and a topic"}.`);
  }
  if (t.id === "cron") return no("Needs a group and topic of its own, or the agent notifications chat.");
  return no("Needs a chat to post in.");
}

// The target it shares, in words ("In the fleet master chat"); "" for a chat of its own.
export function targetWhere(v: TelegramView, t: Target): string {
  if (t.id === "queue" && !t.sameAs && !t.missing.length) return "In your chat with the bot";
  return t.sameAs ? `In the ${labelOf(v, t.sameAs).toLowerCase()}` : "";
}

// For the "How to set this up" fold only: the ids the console reads ("chat -100… · topic 2").
export function targetIds(t: Target): string {
  if (!t.chatId) return "";
  return t.threadId ? `chat ${t.chatId} · topic ${t.threadId}` : `chat ${t.chatId}`;
}

export function githubStatusLine(r: Read<GitHubStatus>): SectionStatus {
  if (r === null) return LOADING;
  if ("off" in r) return { tone: "off", text: "Not set up" };
  if ("error" in r) return { tone: "err", text: `Cannot check GitHub: ${r.error}` };
  const s = r.rows[0];
  // The ChoiBot GitHub app: its key, never another login of gh.
  const key = s.app?.key;
  if (key && key.state !== "ok") {
    if (key.state === "none") return { tone: "off", text: "Not connected: ChoiBot is not connected" };
    return { tone: "err", text: key.why === "refused" ? "GitHub no longer takes the key of your server. Connect again." : "The GitHub key of your server ran out. Connect again." };
  }
  if (key?.unsaved && s.login) return { tone: "warn", text: `Connected as ${s.login} · the new key is not saved: after a restart, connect again` };
  if (!s.login) {
    return s.error === "gh is not logged in"
      ? { tone: "off", text: "Not connected: GitHub is not logged in on your server" }
      : { tone: "err", text: s.error ?? "gh did not answer" };
  }
  const blocked = s.repos.filter((x) => !x.read).length;
  if (blocked) return { tone: "warn", text: `Connected as ${s.login} · cannot read ${plural(blocked, "repo")}` };
  if (s.rate && s.rate.limit > 0 && s.rate.remaining / s.rate.limit < 0.1) return { tone: "warn", text: `Connected as ${s.login} · ${s.rate.remaining} API calls left` };
  return { tone: "ok", text: `Connected as ${s.login}` };
}

// The rate limit line: "4,900 of 5,000 left · resets 14:05".
export function rateLine(rate: GitHubStatus["rate"], locale?: string): string {
  if (!rate) return "Unknown";
  const n = (x: number) => x.toLocaleString(locale ?? "en-US");
  const at = rate.reset ? new Date(rate.reset * 1000).toLocaleTimeString(locale ?? "en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  return `${n(rate.remaining)} of ${n(rate.limit)} left${at ? ` · resets ${at}` : ""}`;
}

async function readJson<T>(url: string): Promise<T> {
  const res = await chiefFetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
}
export const fetchTelegram = (fresh = false) => readJson<TelegramView>(`/api/settings/telegram${fresh ? "?fresh=1" : ""}`);
export const fetchGitHub = (fresh = false) => readJson<GitHubStatus>(`/api/settings/github${fresh ? "?fresh=1" : ""}`);
// The ChoiBot app's two lists (GET /api/github/app/repos: USER only).
export const fetchAppRepos = (fresh = false) => readJson<AppReposView>(`/api/github/app/repos${fresh ? "?fresh=1" : ""}`);

// Disconnect the ChoiBot app on this server (POST /api/github/app/disconnect: USER only). `github`:
// where the person ends it on GitHub too.
export async function disconnectApp(): Promise<{ ok: true; github: string } | { ok: false; error: string }> {
  try {
    const res = await chiefFetch("/api/github/app/disconnect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!res.ok) return { ok: false, error: await actionError(res, "Disconnect") };
    const j = (await res.json().catch(() => null)) as { github?: unknown } | null;
    return { ok: true, github: typeof j?.github === "string" ? j.github : "" };
  } catch {
    return { ok: false, error: "The console did not answer" };
  }
}

// "agents · tickets": where a used repo was seen.
const SOURCE_WORD: Record<UsedSource, string> = { agents: "agents", recurring: "a Recurring task", tickets: "tickets" };
export const usedFrom = (from: UsedSource[]): string => from.map((f) => SOURCE_WORD[f]).join(" · ");
// "today", "yesterday", "3 days ago".
export function daysAgo(ms: number): string {
  const d = Math.floor(ms / 86_400_000);
  return d < 1 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

// A test message to a target (POST /api/settings/telegram/test: USER only).
export async function sendTelegramTest(target: TargetId | "account"): Promise<ActionResult> {
  try {
    const res = await chiefFetch("/api/settings/telegram/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }),
    });
    return res.ok ? { ok: true } : { ok: false, error: await actionError(res, "A test message") };
  } catch {
    return { ok: false, error: "The console did not answer" };
  }
}
