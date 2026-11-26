// server/agents/accounts.ts — multiple Claude Code logins on one box.
//
// `claude` keeps its login (and everything else: settings, plugins, skills,
// transcripts, memory) under one config dir — ~/.claude by default, or
// $CLAUDE_CONFIG_DIR. That is the only per-account knob it has, and it is read
// once at process start. So an "account" here is a config dir the console owns,
// and an agent is pinned to one by spawning it with CLAUDE_CONFIG_DIR set.
//
// A bare second dir would lose the user's whole setup (superpowers, hooks,
// CLAUDE.md, memory, the transcripts `--resume` needs). So an account dir is a
// SHADOW of the default one: every entry is symlinked back to the real dir,
// except the handful that are the login itself (see PRIVATE). Transcripts and
// the harness task files therefore stay in one place whichever account an agent
// runs under — which is what lets an agent switch account mid-session: relaunch
// with a different CLAUDE_CONFIG_DIR and `--resume` still finds the session.
//
// The default account is the real dir; records with no `account` use it, so
// nothing changes for a console that never creates a second login.
import { mkdir, readdir, readFile, writeFile, symlink, lstat, rm, rename, stat } from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hardenedDeployment } from "../chief/hardened.js";

export const DEFAULT_ACCOUNT = "default";

export type AccountPaths = {
  root: string;             // where non-default account dirs live
  defaultDir: string;       // the real config dir (~/.claude or $CLAUDE_CONFIG_DIR)
  defaultClaudeJson: string; // the real ~/.claude.json (inside defaultDir when CLAUDE_CONFIG_DIR is set)
};

export type AccountInfo = {
  id: string;
  label: string;          // email when known, else the id
  email: string | null;
  loggedIn: boolean;      // a credentials file with an access token exists, and Claude did not say that the login is signed out
  isDefault: boolean;
  // Claude said that this login is signed out (its token was revoked or is gone) and the user
  // did not sign in again since. Then `loggedIn` is false: no agent starts on it or moves to it.
  signedOut?: true;
};

// Resolved from the environment at call time, so the console and its children
// agree: the default account IS whatever `claude` itself would use here.
export function accountPaths(env: Record<string, string | undefined> = process.env): AccountPaths {
  const home = homedir();
  const defaultDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return {
    root: env.CLAUDE_ACCOUNTS_DIR || join(home, ".claude-accounts"),
    defaultDir,
    defaultClaudeJson: env.CLAUDE_CONFIG_DIR ? join(defaultDir, ".claude.json") : join(home, ".claude.json"),
  };
}

// Short, lowercase, path-safe: it becomes a directory name and a record field.
// `default` is a valid id (it names the real dir), but never a directory.
export function isAccountId(v: unknown): v is string {
  return typeof v === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(v);
}

// The default login that the user picked on the page ("Make default" in Settings): kept in a
// small file of the console's data dir and in memory. Undefined: no pick, the setting decides.
let pickedDefault: string | undefined;

// Read the pick when the console starts. No file, or a file that is not valid: no pick.
export async function loadDefaultLogin(file: string): Promise<void> {
  try {
    const id = (JSON.parse(await readFile(file, "utf8")) as { id?: unknown }).id;
    pickedDefault = isAccountId(id) ? id : undefined;
  } catch {
    pickedDefault = undefined;
  }
}

// Keep the pick (`id` can be "default": the main login). The file first: a pick that was not
// written is not a pick after a restart.
export async function setDefaultLogin(id: string, file: string): Promise<void> {
  if (!isAccountId(id)) throw new Error("invalid account id");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify({ id }), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  pickedDefault = id;
}

// For tests: forget the pick.
export function forgetDefaultLogin(): void { pickedDefault = undefined; }

// ---- logins that are signed out ----
// A credentials file can hold a token that no longer works: the user signed out elsewhere, or
// the token was revoked. Only Claude can tell: an agent on that login stops with "OAuth token
// revoked · Please run /login" (stopwhy.ts, why "login"). The console keeps the mark (the id
// and the time) in memory and in a small file. The mark ends when the credentials file is
// newer than it: the user signed in again (from the page or in a terminal).
let signedOut = new Map<string, number>();
let signedOutFile: string | undefined;
// The ids of the logins that work, default first, as of the last listAccounts.
let working: string[] = [];

const saveSignedOut = async (): Promise<void> => {
  if (!signedOutFile) return;
  await mkdir(dirname(signedOutFile), { recursive: true });
  await writeFile(`${signedOutFile}.tmp`, JSON.stringify(Object.fromEntries(signedOut)), { mode: 0o600 });
  await rename(`${signedOutFile}.tmp`, signedOutFile);
};

// Read the marks when the console starts. No file, or a file that is not valid: no mark.
export async function loadSignedOut(file: string, p: AccountPaths = accountPaths()): Promise<void> {
  signedOutFile = file;
  signedOut = new Map();
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    for (const [id, at] of Object.entries(raw)) if (isAccountId(id) && typeof at === "number" && Number.isFinite(at)) signedOut.set(id, at);
  } catch { /* no marks */ }
  // The logins that work, for the default (preferredAccount cannot wait for a file).
  if (signedOut.size) await listAccounts(p).catch(() => []);
}

const credentialsAt = (id: string, p: AccountPaths): Promise<number | null> =>
  stat(credentialsPath(id, p)).then((s) => s.mtimeMs, () => null);

// Claude said at `at` that the login `id` is signed out. A line that is older than the
// credentials file is of a login the user renewed since: no mark. True when the mark is set.
export async function markSignedOut(id: string | undefined, at: number, p: AccountPaths = accountPaths()): Promise<boolean> {
  const key = id && !isDefaultAccount(id) ? id : DEFAULT_ACCOUNT;
  const renewed = await credentialsAt(key, p);
  if (renewed !== null && renewed > at) return false;
  if (signedOut.has(key)) return true;
  signedOut.set(key, at);
  await saveSignedOut().catch(() => {});
  await listAccounts(p).catch(() => []); // the logins that work, for the default
  return true;
}

// "Sign out" of a login (agents/api.ts) sets the mark before Claude removes the login, so that a
// Recurring run that starts meanwhile goes to another login. A sign-out that did not happen
// removes the mark again.
export async function clearSignedOut(id: string | undefined): Promise<void> {
  const key = id && !isDefaultAccount(id) ? id : DEFAULT_ACCOUNT;
  if (!signedOut.delete(key)) return;
  await saveSignedOut().catch(() => {});
}

// Whether the mark of `id` holds now. A credentials file newer than the mark ends it.
async function signedOutNow(id: string, p: AccountPaths): Promise<boolean> {
  const at = signedOut.get(id);
  if (at === undefined) return false;
  const renewed = await credentialsAt(id, p);
  if (renewed !== null && renewed > at) {
    signedOut.delete(id);
    await saveSignedOut().catch(() => {});
    return false;
  }
  return true;
}

// In memory only (the last look): for the code that cannot wait for a file.
export function isSignedOut(id: string | undefined): boolean {
  return signedOut.has(id && !isDefaultAccount(id) ? id : DEFAULT_ACCOUNT);
}

// The login a console-made agent (the Coordinator, a lead, the fleet master) starts on when
// its own login is signed out: the default when it works, else the first login that works.
// Null: its login works, or no other login works (it then keeps its login).
export async function loginInPlaceOf(current: string | undefined, p: AccountPaths = accountPaths()): Promise<{ account: string | undefined } | null> {
  const cur = current && !isDefaultAccount(current) ? current : DEFAULT_ACCOUNT;
  if (!signedOut.has(cur)) return null;
  const list = await listAccounts(p);
  if (list.find((a) => a.id === cur)?.loggedIn) return null; // signed in again
  const pref = preferredAccount() ?? DEFAULT_ACCOUNT;
  const next = list.find((a) => a.id === pref && a.loggedIn) ?? list.find((a) => a.loggedIn);
  return next ? { account: next.isDefault ? undefined : next.id } : null;
}

// For tests: forget the marks.
export function forgetSignedOut(): void { signedOut = new Map(); signedOutFile = undefined; working = []; }

// The account new agents get when a request names none: the pick of the page, else the
// setting CLAUDE_DEFAULT_ACCOUNT. Undefined means the box's default login. An explicit
// "default" in a request still means the real dir — this only fills a gap.
// While that login is signed out, the default moves on to a login that works (the main login
// first); when the user signs in again, it is the default again.
export function preferredAccount(env: Record<string, string | undefined> = process.env): string | undefined {
  const v = pickedDefault ?? env.CLAUDE_DEFAULT_ACCOUNT?.trim();
  const want = v && isAccountId(v) ? v : DEFAULT_ACCOUNT;
  const id = signedOut.has(want) ? working.find((w) => !signedOut.has(w)) ?? want : want;
  return id !== DEFAULT_ACCOUNT ? id : undefined;
}

// Record fragment for a new console-owned agent (masters): the preferred
// account when it is configured and its dir exists, else nothing.
export async function preferredAccountIfExists(p?: AccountPaths): Promise<{ account?: string }> {
  const pref = preferredAccount();
  return pref && (await accountExists(pref, p)) ? { account: pref } : {};
}

export function isDefaultAccount(id: string | undefined | null): boolean {
  return !id || id === DEFAULT_ACCOUNT;
}

export function accountDir(id: string | undefined, p: AccountPaths = accountPaths()): string {
  return isDefaultAccount(id) ? p.defaultDir : join(p.root, id!);
}

// The env an agent needs to run under an account. Empty for the default, so a
// default-account agent inherits exactly what the console has (including a
// CLAUDE_CONFIG_DIR the console itself was started with).
export function claudeAccountEnv(id: string | undefined, p: AccountPaths = accountPaths()): Record<string, string> {
  return isDefaultAccount(id) ? {} : { CLAUDE_CONFIG_DIR: accountDir(id, p) };
}

// The entries that ARE the login, and so must not be shared between accounts.
// `.claude.json` holds oauthAccount + onboarding state; `.credentials.json` the
// tokens; statsig caches feature gates keyed to the account.
const PRIVATE = new Set([".credentials.json", "statsig"]);
function isPrivate(name: string): boolean {
  return PRIVATE.has(name) || name.startsWith(".claude.json");
}

// Short-life entries: the locks and the temp files of a write, which Claude makes for a moment
// and then removes. A link to one stays after its target goes, and points at nothing. Claude Code
// saves a login under a lock (proper-lockfile: a mkdir of `.storage-write.lock`): on a link that
// points at nothing that mkdir fails, the stale check finds no file, so Claude never gets the
// lock and never writes `.credentials.json` (a sign-in "done" that was not saved, 2026-11-21).
// So they are never linked, and links to them that an older sync made are removed.
export function isShortLife(name: string): boolean {
  // Not short-life: a real file since 2026-07-05, shared with the linked `daemon` folder and `daemon.status.json`.
  if (name === "daemon.lock") return false;
  return name.endsWith(".lock") || name.startsWith(".storage-write") || name.startsWith(".credentials.json")
    || name.includes(".tmp.") || name.endsWith(".tmp");
}

// Keys of .claude.json that describe the login or cache account-scoped answers;
// a new account must not inherit them (claude refetches what it needs).
function stripAccountState(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "oauthAccount") continue;
    if (/^cached/i.test(k) || /Cache(At|Slots)?$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function accountExists(id: string, p: AccountPaths = accountPaths()): Promise<boolean> {
  if (isDefaultAccount(id)) return true;
  if (!isAccountId(id)) return false;
  try { return (await lstat(accountDir(id, p))).isDirectory(); } catch { return false; }
}

// Hardened (ruling F1): why the console must not make files by path in `dir`
// (an accounts root or account dir), or null. It must be a real dir (not a
// symlink) the console owns and no group or other can write: an agent's Claude
// dir is never one. A missing dir is fine: the console makes it.
function sharedDirProblem(dir: string): string | null {
  let st;
  try { st = lstatSync(dir); } catch (e) {
    const code = (e as { code?: unknown }).code;
    return code === "ENOENT" ? null : `${dir} unreadable (${String(code ?? e)})`;
  }
  if (!st.isDirectory()) return `${dir} is not a directory`;
  const self = process.getuid?.() ?? -1;
  if (st.uid !== self) return `${dir} owner uid ${st.uid}, want ${self}`;
  const mode = st.mode & 0o7777;
  if ((mode & 0o022) !== 0) return `${dir} mode ${mode.toString(8).padStart(4, "0")} is group- or other-writable`;
  return null;
}

// The dir of a login that the console may change, or null: the default login (the real dir is
// never changed), or hardened (one log line) unless the root and the account dir are the
// console's own.
function ownAccountDir(id: string, p: AccountPaths, what: string): string | null {
  if (isDefaultAccount(id)) return null;
  if (!isAccountId(id)) throw new Error(`invalid account id: ${id}`);
  const dir = accountDir(id, p);
  if (hardenedDeployment()) {
    const why = sharedDirProblem(p.root) ?? sharedDirProblem(dir);
    if (why) {
      console.warn(`[chief] accounts dir ${why}; not ${what} in a hardened deployment`);
      return null;
    }
  }
  return dir;
}

// Remove the links to short-life entries (isShortLife) that an older sync made in `dir`. An entry
// goes only when all three hold: it is a symbolic link, its text is exactly the path of the same
// name in the default dir, and its name is short-life. A real file or folder, or a link to
// another place, stays. (unlink never removes a folder, and never what a link points at.)
// A private name never goes: a `.credentials.json` link that an owner made by hand is the login.
function removeShortLifeLinks(id: string, dir: string, p: AccountPaths): void {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; } // no dir yet: nothing to heal
  const gone: string[] = [];
  for (const name of names) {
    if (!isShortLife(name) || isPrivate(name)) continue;
    const at = join(dir, name);
    try {
      if (!lstatSync(at).isSymbolicLink() || readlinkSync(at) !== join(p.defaultDir, name)) continue;
      unlinkSync(at);
      gone.push(name);
    } catch { /* gone meanwhile: nothing to do */ }
  }
  if (gone.length) console.warn(`[accounts] login ${id}: removed ${gone.length} stale link${gone.length > 1 ? "s" : ""} to short-life files (${gone.join(", ")})`);
}

// The `tasks` of a login (Claude Code's task files: the Plan rail) is a link to the default login's
// tasks folder, made by a sync while that folder was there. Claude's own clean-up can remove that
// folder; then the link points at nothing, and Claude Code cannot save a task in this login: it
// makes the folder with `mkdir -p`, which fails through such a link (ENOENT; ENOTDIR async), and it
// ignores only EEXIST. So the target is made again: the default login's tasks folder, 0700, as the
// console's account. Only when the link's text is exactly that path and nothing at all is there
// (not a file, not a link): a plain mkdir, never through a link.
function remakeTasksTarget(id: string, dir: string, p: AccountPaths): void {
  const target = join(p.defaultDir, "tasks");
  try {
    const at = join(dir, "tasks");
    if (!lstatSync(at).isSymbolicLink() || readlinkSync(at) !== target) return;
  } catch { return; } // no link: nothing to do
  try { lstatSync(target); return; } catch (e) {
    if ((e as { code?: unknown }).code !== "ENOENT") return;
  }
  try { mkdirSync(target, { mode: 0o700 }); } catch { return; } // raced, or no default dir: Claude's own write says
  console.warn(`[accounts] login ${id}: its tasks link pointed at nothing; made ${target} (0700)`);
}

// Heal the dir of a login: remove the links to short-life entries, and make the target of a dead
// `tasks` link (remakeTasksTarget). Before a sign-in from the page
// (claudelogin.ts), so that Claude can take its write lock and save the login. Synchronous: no
// second start of a sign-in can come in between.
export function healAccountDir(id: string, p: AccountPaths = accountPaths()): void {
  const dir = ownAccountDir(id, p, "healed");
  if (!dir) return;
  removeShortLifeLinks(id, dir, p);
  remakeTasksTarget(id, dir, p);
}

// Make (or refresh) the shadow dir: every entry of the default dir that is not
// private or short-life gets a symlink, unless the account dir already has something by that
// name (its own file, or a link from a previous sync). Idempotent and cheap, so
// the runtime runs it before every spawn: an entry the default dir grows later
// (a new plugins cache, say) is picked up on the next launch. It heals the dir first
// (removeShortLifeLinks) and makes the target of a `tasks` link that points at nothing
// (remakeTasksTarget). Hardened: skipped (one log line) unless the root and the account dir
// are the console's own.
export async function syncAccountDir(id: string, p: AccountPaths = accountPaths()): Promise<void> {
  const dir = ownAccountDir(id, p, "synced");
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  removeShortLifeLinks(id, dir, p);
  remakeTasksTarget(id, dir, p);
  let names: string[] = [];
  try { names = await readdir(p.defaultDir); } catch { /* no default dir yet: nothing to shadow */ }
  for (const name of names) {
    if (isPrivate(name) || isShortLife(name)) continue;
    const dst = join(dir, name);
    try { await lstat(dst); continue; } catch { /* absent: link it */ }
    try { await symlink(join(p.defaultDir, name), dst); } catch { /* raced or unsupported: skip */ }
  }
}

// Create a new account dir. Seeds .claude.json from the real one with the login
// stripped, so onboarding/trust/MCP state carries over and `claude` goes
// straight to "please log in" on the account's first launch. Hardened: refused
// (one log line) unless the accounts root is the console's own (ruling F1).
export async function createAccount(id: string, p: AccountPaths = accountPaths()): Promise<AccountInfo> {
  if (!isAccountId(id)) throw new Error("invalid account id");
  if (isDefaultAccount(id)) throw new Error("that is the default account");
  const dir = accountDir(id, p);
  if (existsSync(dir)) throw new Error("account already exists");
  const hardened = hardenedDeployment();
  const why = hardened ? sharedDirProblem(p.root) : null;
  if (why) {
    const msg = `[chief] accounts dir ${why}; no account is made there in a hardened deployment`;
    console.warn(msg);
    throw new Error(msg);
  }
  // Hardened: 0700 whatever the umask, so the sync below accepts the dir.
  await mkdir(dir, hardened ? { recursive: true, mode: 0o700 } : { recursive: true });
  let seed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readFile(p.defaultClaudeJson, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) seed = stripAccountState(raw);
  } catch { /* no default config: start blank */ }
  await writeFile(join(dir, ".claude.json"), JSON.stringify(seed, null, 2), { mode: 0o600 });
  await syncAccountDir(id, p);
  return describe(id, p);
}

export async function deleteAccount(id: string, p: AccountPaths = accountPaths()): Promise<void> {
  if (isDefaultAccount(id)) throw new Error("cannot delete the default account");
  if (!isAccountId(id)) throw new Error("invalid account id");
  // The dir is mostly symlinks; rm on a symlink removes the link, never what it
  // points at, so the real config dir is untouched.
  await rm(accountDir(id, p), { recursive: true, force: true });
}

// Where an account's login lives: its credentials file, and the .claude.json
// claude writes oauthAccount into (the default account keeps it in $HOME).
export function credentialsPath(id: string | undefined, p: AccountPaths = accountPaths()): string {
  return join(accountDir(id, p), ".credentials.json");
}
export function claudeJsonPath(id: string | undefined, p: AccountPaths): string {
  return isDefaultAccount(id) ? p.defaultClaudeJson : join(accountDir(id, p), ".claude.json");
}

export async function accessTokenFor(id: string | undefined, p: AccountPaths = accountPaths()): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(credentialsPath(id, p), "utf8"));
    const t = raw?.claudeAiOauth?.accessToken;
    return typeof t === "string" && t ? t : null;
  } catch {
    return null;
  }
}

async function emailFor(id: string, p: AccountPaths): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(claudeJsonPath(id, p), "utf8"));
    const e = raw?.oauthAccount?.emailAddress;
    return typeof e === "string" && e ? e : null;
  } catch {
    return null;
  }
}

async function describe(id: string, p: AccountPaths): Promise<AccountInfo> {
  const [email, token, out] = await Promise.all([emailFor(id, p), accessTokenFor(id, p), signedOutNow(id, p)]);
  return { id, label: email ?? id, email, loggedIn: token !== null && !out, isDefault: isDefaultAccount(id), ...(out ? { signedOut: true as const } : {}) };
}

// Default first, then the others by id. The registry IS the filesystem: a dir
// under root is an account, so nothing can drift out of sync with it.
export async function listAccounts(p: AccountPaths = accountPaths()): Promise<AccountInfo[]> {
  const ids: string[] = [];
  try {
    for (const name of (await readdir(p.root)).sort()) {
      if (!isAccountId(name) || isDefaultAccount(name)) continue;
      try { if ((await lstat(join(p.root, name))).isDirectory()) ids.push(name); } catch { /* gone */ }
    }
  } catch { /* no root yet: only the default */ }
  const list = await Promise.all([DEFAULT_ACCOUNT, ...ids].map((id) => describe(id, p)));
  working = list.filter((a) => a.loggedIn).map((a) => a.id);
  return list;
}
