// bin/lib/cron-login.mjs — the Claude login of a Recurring task that names none: the console's
// default login now (server/agents/accounts.ts preferredAccount). Plain JS: the cron runner starts
// with a bare node and cannot import the server's TS.
//
// The console keeps two small files in its data dir (server/index.ts):
//   - default-login.json {"id": …}: the pick of the Settings page ("Make default");
//   - logins-signed-out.json {id: ms}: the logins that Claude said are signed out, and when. A mark
//     ends when the login's credentials file is newer than it (the user signed in again).
// The runner only reads them. A missing or broken file is no pick, or no mark: then the setting
// CLAUDE_DEFAULT_ACCOUNT decides, as before. cron-login.test.ts proves parity with the server.
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { names } from "../../server/names.mjs";

/** The id of the main login (the real Claude folder). */
export const MAIN_LOGIN = "default";

/** isAccountId() of accounts.ts. */
export const isLoginId = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(v);

/** The console's data dir (server/defaults.ts resolveAppDataDir). */
export function appDataDir(env) {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), names().dataDir);
}

/** Where the logins are (accounts.ts accountPaths). */
export function loginPaths(env) {
  return {
    root: env.CLAUDE_ACCOUNTS_DIR || join(homedir(), ".claude-accounts"),
    defaultDir: env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  };
}

const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const credentials = (id, p) => join(id === MAIN_LOGIN ? p.defaultDir : join(p.root, id), ".credentials.json");
const mtimeOf = (path) => { try { return statSync(path).mtimeMs; } catch { return null; } };
const isDir = (path) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
// accessTokenFor() of accounts.ts: a credentials file with an access token. Nothing of it is kept.
const hasToken = (path) => {
  const t = readJson(path)?.claudeAiOauth?.accessToken;
  return typeof t === "string" && t !== "";
};

/**
 * What the console knows of its logins, read from its files: the page's pick, the logins marked
 * as signed out now, and, when one is, the logins that work (main first, then the others by id).
 * @param {Record<string, string | undefined>} env
 * @returns {{ picked: string | undefined, signedOut: Set<string>, working: string[] }}
 */
export function readLogins(env) {
  const data = appDataDir(env);
  const p = loginPaths(env);
  const id = readJson(join(data, "default-login.json"))?.id;
  const signedOut = new Set();
  const marks = readJson(join(data, "logins-signed-out.json"));
  if (marks && typeof marks === "object" && !Array.isArray(marks)) {
    for (const [login, at] of Object.entries(marks)) {
      if (!isLoginId(login) || typeof at !== "number" || !Number.isFinite(at)) continue;
      const renewed = mtimeOf(credentials(login, p));
      if (renewed === null || renewed <= at) signedOut.add(login);
    }
  }
  // As loadSignedOut(): the logins that work are looked up only when a mark holds.
  const working = [];
  if (signedOut.size) {
    const ids = [MAIN_LOGIN];
    try {
      for (const name of readdirSync(p.root).sort()) if (isLoginId(name) && name !== MAIN_LOGIN && isDir(join(p.root, name))) ids.push(name);
    } catch { /* no accounts folder: the main login only */ }
    working.push(...ids.filter((login) => !signedOut.has(login) && hasToken(credentials(login, p))));
  }
  return { picked: isLoginId(id) ? id : undefined, signedOut, working };
}

/**
 * Port of preferredAccount(): the page's pick, else the setting, else the main login; while that
 * login is signed out, the first login that works (the main login first). The id, "default" for
 * the main login.
 * @param {{ picked: string | undefined, setting: string | undefined, signedOut: Set<string>, working: string[] }} s
 */
export function pickLogin({ picked, setting, signedOut, working }) {
  const v = picked ?? setting?.trim();
  const want = v && isLoginId(v) ? v : MAIN_LOGIN;
  return signedOut.has(want) ? working.find((w) => !signedOut.has(w)) ?? want : want;
}

/** The console's default login now, for a task that names none. */
export function consoleDefaultLogin(env) {
  return pickLogin({ ...readLogins(env), setting: env.CLAUDE_DEFAULT_ACCOUNT });
}
