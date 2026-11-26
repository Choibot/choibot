// bin/lib/cron-login.test.ts — the runner's default login (cron-login.mjs) is the console's
// (server/agents/accounts.ts preferredAccount): the same files on disk give the same login. Each
// case is a throwaway folder with the console's data dir, a main Claude folder and an accounts
// folder; the runner reads first, then the server loads the same files.
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountPaths, forgetDefaultLogin, forgetSignedOut, loadDefaultLogin, loadSignedOut, preferredAccount } from "../../server/agents/accounts.js";
import { resolveAppDataDir } from "../../server/defaults.js";
import { appDataDir, consoleDefaultLogin, pickLogin, readLogins } from "./cron-login.mjs";

let root = "";
let env: Record<string, string | undefined> = {};
const NOW = Date.UTC(2026, 10, 21, 7, 0);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cron-login-"));
  env = { XDG_DATA_HOME: join(root, "data"), CLAUDE_CONFIG_DIR: join(root, "main"), CLAUDE_ACCOUNTS_DIR: join(root, "accounts") };
  forgetDefaultLogin();
  forgetSignedOut();
});
afterEach(async () => {
  forgetDefaultLogin();
  forgetSignedOut();
  await rm(root, { recursive: true, force: true });
});

type Case = {
  logins?: string[];                    // account folders (the main login always exists)
  tokens?: Record<string, number>;      // a credentials file with a token, and its time
  pick?: string;                        // the content of default-login.json, as written
  marks?: string;                       // the content of logins-signed-out.json, as written
  setting?: string;                     // CLAUDE_DEFAULT_ACCOUNT
};

async function lay(c: Case): Promise<void> {
  const data = appDataDir(env);
  await mkdir(data, { recursive: true });
  await mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true });
  for (const id of c.logins ?? []) await mkdir(join(env.CLAUDE_ACCOUNTS_DIR!, id), { recursive: true });
  for (const [id, at] of Object.entries(c.tokens ?? {})) {
    const file = join(id === "default" ? env.CLAUDE_CONFIG_DIR! : join(env.CLAUDE_ACCOUNTS_DIR!, id), ".credentials.json");
    await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }));
    await utimes(file, at / 1000, at / 1000);
  }
  if (c.pick !== undefined) await writeFile(join(data, "default-login.json"), c.pick);
  if (c.marks !== undefined) await writeFile(join(data, "logins-signed-out.json"), c.marks);
  env.CLAUDE_DEFAULT_ACCOUNT = c.setting;
}

// The runner's answer first (the server may drop a renewed mark from the file), then the server's.
async function both(c: Case): Promise<[string, string]> {
  await lay(c);
  const runner = consoleDefaultLogin(env);
  const data = resolveAppDataDir(env);
  await loadDefaultLogin(join(data, "default-login.json"));
  await loadSignedOut(join(data, "logins-signed-out.json"), accountPaths(env));
  return [runner, preferredAccount(env) ?? "default"];
}

const mark = (m: Record<string, number>) => JSON.stringify(m);
const CASES: [string, Case, string][] = [
  ["no file and no setting: the main login", {}, "default"],
  ["the setting alone", { logins: ["work"], setting: "work" }, "work"],
  ["the page's pick before the setting", { logins: ["work", "alt"], pick: '{"id":"alt"}', setting: "work" }, "alt"],
  ["the page picked the main login", { logins: ["work"], pick: '{"id":"default"}', setting: "work" }, "default"],
  ["2026-11-21: the setting's login is signed out, the main login works", {
    logins: ["work"], tokens: { default: NOW - 1e6, work: NOW - 1e6 }, marks: mark({ work: NOW }), setting: "work" }, "default"],
  ["the pick is signed out and the main login too: the first login that works", {
    logins: ["alt", "work"], tokens: { default: NOW - 1e6, alt: NOW - 1e6, work: NOW - 1e6 }, marks: mark({ work: NOW, default: NOW }), pick: '{"id":"work"}' }, "alt"],
  ["the main login is signed out and nothing is set: another login that works", {
    logins: ["work"], tokens: { default: NOW - 1e6, work: NOW - 1e6 }, marks: mark({ default: NOW }) }, "work"],
  ["no login works: it keeps the login", { logins: ["work"], marks: mark({ work: NOW }), setting: "work" }, "work"],
  ["a login with no token does not work", { logins: ["alt", "work"], tokens: { work: NOW - 1e6 }, marks: mark({ work: NOW, default: NOW }), setting: "work" }, "work"],
  ["signed in again since the mark: the login is the default again", {
    logins: ["work"], tokens: { default: NOW - 1e6, work: NOW + 1e6 }, marks: mark({ work: NOW }), setting: "work" }, "work"],
  ["broken files: the setting", { logins: ["work"], pick: "{not json", marks: "[1,", setting: "work" }, "work"],
  ["a pick that is not an id, marks that are not valid: the setting", {
    logins: ["work"], tokens: { default: NOW - 1e6 }, pick: '{"id":"Bad Id"}', marks: '{"work":"soon","Bad Id":1}', setting: " work " }, "work"],
  ["a mark of a login with no folder", { tokens: { default: NOW - 1e6 }, marks: mark({ ghost: NOW }), setting: "ghost" }, "default"],
];

describe("the runner's default login is the console's", () => {
  for (const [what, c, want] of CASES) {
    it(what, async () => {
      expect(await both(c)).toEqual([want, want]);
    });
  }
  it("the data dir is the console's", () => {
    expect(appDataDir(env)).toBe(resolveAppDataDir(env));
    const { XDG_DATA_HOME: _x, ...noXdg } = env;
    expect(appDataDir(noXdg)).toBe(resolveAppDataDir(noXdg));
  });
});

describe("readLogins", () => {
  it("reads no credentials file when no mark holds", async () => {
    await lay({ logins: ["work"], tokens: { default: NOW, work: NOW }, setting: "work" });
    expect(readLogins(env)).toEqual({ picked: undefined, signedOut: new Set(), working: [] });
  });
  it("the marks that hold now, and the logins that work, main first", async () => {
    await lay({ logins: ["b", "a", "c"], tokens: { default: NOW - 1e6, a: NOW - 1e6, b: NOW + 1e6, c: NOW - 1e6 }, marks: mark({ a: NOW, b: NOW }), pick: '{"id":"c"}' });
    expect(readLogins(env)).toEqual({ picked: "c", signedOut: new Set(["a"]), working: ["default", "b", "c"] });
  });
});

describe("pickLogin", () => {
  it("the pick, the setting, the main login; never a signed-out login while another works", () => {
    const none = { signedOut: new Set<string>(), working: [] };
    expect(pickLogin({ ...none, picked: undefined, setting: undefined })).toBe("default");
    expect(pickLogin({ ...none, picked: undefined, setting: "  " })).toBe("default");
    expect(pickLogin({ ...none, picked: "a", setting: "b" })).toBe("a");
    expect(pickLogin({ picked: undefined, setting: "b", signedOut: new Set(["b"]), working: ["default", "a"] })).toBe("default");
    expect(pickLogin({ picked: undefined, setting: "b", signedOut: new Set(["b"]), working: [] })).toBe("b");
  });
});
