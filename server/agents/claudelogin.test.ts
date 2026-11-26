// server/agents/claudelogin.test.ts — the Claude login from the page, with a fake `claude` (a
// small script in a temp folder: no test here reaches Claude or a login of this server).
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountPaths } from "./accounts.js";
import { ClaudeLogin, isLoginCode, loginFailure, parseLink, type ClaudeLoginState } from "./claudelogin.js";

let dir: string;
let made: ClaudeLogin[];
const GOOD = "good-code_123#state-456";
const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";

// The fake prints what Claude Code prints with no terminal, then reads one line. The file
// "mode" changes what it does. Each call is one line of calls.log, with the config dir it got.
// With the file "save", a right code also saves the login as Claude Code 2.x does: under a lock
// that is a mkdir of `.storage-write.lock` (proper-lockfile). That mkdir fails on a link that
// points at nothing, and then nothing is saved.
function fakeClaude(): string {
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env bash
D="${dir}"
echo "$* [\${CLAUDE_CONFIG_DIR:-default}]" >> "$D/calls.log"
if [ "$1 $2" = "auth status" ]; then
  if [ -f "$D/logged-in" ]; then echo '{"loggedIn":true,"email":"ada@example.invalid","subscriptionType":"max"}'; exit 0; fi
  echo '{"loggedIn":false}'; exit 1
fi
case "$(cat "$D/mode" 2>/dev/null)" in
  silent) sleep 5; exit 1 ;;
  offline) echo "Couldn't log in: fetch failed"; exit 1 ;;
esac
trap 'echo killed >> "$D/calls.log"; exit 143' TERM
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: ${LINK}"
printf 'Paste code here if prompted > '
IFS= read -r code || exit 1
echo "$code" > "$D/got-code"
if [ "$code" = "${GOOD}" ]; then
  if [ -f "$D/save" ]; then
    C="\${CLAUDE_CONFIG_DIR:-$D/main}"; mkdir -p "$C"
    if mkdir "$C/.storage-write.lock" 2>/dev/null; then echo '{}' > "$C/.credentials.json"; rmdir "$C/.storage-write.lock"; fi
  fi
  [ "$(cat "$D/mode" 2>/dev/null)" = lie ] || touch "$D/logged-in"
  echo "Login successful."; exit 0
fi
echo "Couldn't log in: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code."
exit 1
`);
  chmodSync(bin, 0o755);
  return bin;
}
const calls = (): string[] => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : []);
const paths = (): AccountPaths => ({ root: join(dir, "accounts"), defaultDir: join(dir, "main"), defaultClaudeJson: join(dir, "main.json") });

function login(o: { linkMs?: number; firstMs?: number; checkMs?: number; onDone?: (a: string) => void } = {}): ClaudeLogin {
  const l = new ClaudeLogin({ paths: paths(), bin: fakeClaude(), env: { PATH: process.env.PATH }, log: () => {}, ...o });
  made.push(l);
  return l;
}

async function until(l: ClaudeLogin, want: ClaudeLoginState["state"]): Promise<ClaudeLoginState> {
  for (let i = 0; i < 200; i++) {
    if (l.state().state === want) return l.state();
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`the login did not reach "${want}": it is "${l.state().state}"`);
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claude-login-")); made = []; });
// A fake that was stopped writes one last line: the folder goes when it is quiet.
afterEach(() => { for (const l of made) l.stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

describe("parseLink", () => {
  it("takes the sign-in link of Claude from the output of the command", () => {
    expect(parseLink(`Opening browser…\nIf the browser didn't open, visit: ${LINK}\nPaste code here if prompted > `)).toBe(LINK);
    expect(parseLink(`\u001b[1mIf the browser didn't open, visit: https://claude.ai/oauth/authorize?x=1\u001b[0m`)).toBe("https://claude.ai/oauth/authorize?x=1");
  });

  it("gives no link for an address that is not of Claude, or not HTTPS", () => {
    for (const bad of ["https://claude.com.evil.test/login", "http://claude.com/login", "https://user:pw@claude.com/x", "https://evil.test/?claude.com", "javascript:alert(1)"]) {
      expect(parseLink(`visit: ${bad}`), bad).toBeNull();
    }
    expect(parseLink("no link here")).toBeNull();
  });
});

describe("isLoginCode", () => {
  it("is one word: no space and no line break goes to the command", () => {
    expect(isLoginCode(GOOD)).toBe(true);
    for (const bad of ["", "short", "two words here", "line\nbreak-123456", "semi;colon-12345", "$(rm)-1234567", 12345678, null]) expect(isLoginCode(bad), String(bad)).toBe(false);
  });
});

describe("loginFailure", () => {
  it("names the reason from what the command says", () => {
    expect(loginFailure("Couldn't log in: That code wasn't accepted. It may be incomplete, expired, already used")).toBe("wrong-code");
    expect(loginFailure("Couldn't log in: fetch failed")).toBe("no-answer");
    expect(loginFailure("something else")).toBe("failed");
  });
});

describe("ClaudeLogin", () => {
  it("shows the link, takes the code, and ends with the account that Claude names", async () => {
    const done: string[] = [];
    const l = login({ onDone: (a) => done.push(a) });
    const st = await l.start("default");
    expect(st).toMatchObject({ state: "waiting", account: "default", url: LINK });
    expect(l.busyWith()).toBe("default");
    expect(l.submit(GOOD)).toEqual({ state: "checking", account: "default" });
    expect(await until(l, "done")).toEqual({ state: "done", account: "default", email: "ada@example.invalid", plan: "Max" });
    expect(readFileSync(join(dir, "got-code"), "utf8").trim()).toBe(GOOD);
    expect(done).toEqual(["default"]);
    expect(l.busyWith()).toBeNull();
    // The main login runs with the config dir of the console itself.
    expect(calls()[0]).toBe("auth login [default]");
  });

  it("runs the command with the config dir of the account", async () => {
    const l = login();
    await l.start("work");
    expect(calls()[0]).toBe(`auth login [${join(dir, "accounts", "work")}]`);
    l.submit(GOOD);
    await until(l, "done");
    expect(calls().at(-1)).toBe(`auth status [${join(dir, "accounts", "work")}]`);
  });

  it("a wrong code ends the login with that reason: a new link is needed", async () => {
    const l = login();
    await l.start("default");
    l.submit("this-is-a-wrong-code");
    expect(await until(l, "failed")).toEqual({ state: "failed", account: "default", reason: "wrong-code" });
    expect(l.submit(GOOD)).toEqual({ state: "refused", why: "no-login" });
    expect((await l.start("default", { fresh: true })).state).toBe("waiting");
  });

  it("refuses a text that is not a code, and keeps the link open", async () => {
    const l = login();
    await l.start("default");
    expect(l.submit("two words")).toEqual({ state: "refused", why: "bad-code" });
    expect(l.state().state).toBe("waiting");
    expect(existsSync(join(dir, "got-code"))).toBe(false);
  });

  it("a second start of the same account gives the same link and starts no second command", async () => {
    const l = login();
    await l.start("default");
    await l.start("default");
    expect(calls().filter((c) => c.startsWith("auth login"))).toHaveLength(1);
    await l.start("default", { fresh: true });
    expect(calls().filter((c) => c.startsWith("auth login"))).toHaveLength(2);
  });

  it("a start for another account ends the one that waits", async () => {
    const l = login();
    await l.start("default");
    const st = await l.start("work");
    expect(st).toMatchObject({ state: "waiting", account: "work" });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls()).toContain("killed");
  });

  it("the link runs out", async () => {
    const l = login({ linkMs: 80 });
    await l.start("default");
    expect(await until(l, "failed")).toEqual({ state: "failed", account: "default", reason: "expired" });
    expect(l.busyWith()).toBeNull();
  });

  it("a command that gives no link fails as “no answer”", async () => {
    writeFileSync(join(dir, "mode"), "silent");
    const l = login({ firstMs: 80 });
    expect(await l.start("default")).toEqual({ state: "failed", account: "default", reason: "no-answer" });
    writeFileSync(join(dir, "mode"), "offline");
    expect(await l.start("default", { fresh: true })).toEqual({ state: "failed", account: "default", reason: "no-answer" });
  });

  it("no Claude program on the server", async () => {
    const l = new ClaudeLogin({ paths: paths(), bin: join(dir, "not-there"), env: {}, log: () => {} });
    made.push(l);
    expect(await l.start("default")).toEqual({ state: "failed", account: "default", reason: "no-claude" });
  });

  it("exit 0 with no login on record is not a login", async () => {
    writeFileSync(join(dir, "mode"), "lie");
    const done: string[] = [];
    const l = login({ onDone: (a) => done.push(a) });
    await l.start("default");
    l.submit(GOOD);
    expect(await until(l, "failed")).toMatchObject({ reason: "failed" });
    expect(done).toEqual([]);
  });

  it("stop ends the command; clear forgets a result that was shown", async () => {
    const l = login();
    await l.start("default");
    l.stop();
    expect(l.state()).toEqual({ state: "idle" });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls()).toContain("killed");
    await l.start("default");
    l.submit("this-is-a-wrong-code");
    await until(l, "failed");
    l.clear();
    expect(l.state()).toEqual({ state: "idle" });
  });

  it("the code is in no state and no log line", async () => {
    const lines: string[] = [];
    const l = new ClaudeLogin({ paths: paths(), bin: fakeClaude(), env: { PATH: process.env.PATH }, log: (s) => lines.push(s) });
    made.push(l);
    await l.start("default");
    l.submit(GOOD);
    const end = await until(l, "done");
    expect(JSON.stringify([end, lines])).not.toContain(GOOD);
  });
});

// 2026-11-21: a sign-in of the login `office` said "done" two times, and the login stayed signed
// out. Links to short-life files of the main folder were in its folder: Claude could not take its
// write lock and did not save the sign-in; `claude auth status` still read the old file.
describe("a sign-in that Claude did not save", () => {
  const work = () => join(dir, "accounts", "work");
  const creds = () => join(work(), ".credentials.json");
  const lockLink = () => join(work(), ".storage-write.lock");
  // The login's folder with a credentials file of yesterday.
  function oldLogin(): void {
    mkdirSync(work(), { recursive: true });
    writeFileSync(creds(), "{}");
    const day = (Date.now() - 86_400_000) / 1000;
    utimesSync(creds(), day, day);
  }
  const linkedLock = () => symlinkSync(join(dir, "main", ".storage-write.lock"), lockLink());

  it("D: an old credentials file after a yes is not a login: failed, not-saved, with a log line", async () => {
    oldLogin();
    const done: string[] = [];
    const lines: string[] = [];
    const l = new ClaudeLogin({ paths: paths(), bin: fakeClaude(), env: { PATH: process.env.PATH }, onDone: (a) => done.push(a), log: (s) => lines.push(s) });
    made.push(l);
    await l.start("work");
    l.submit(GOOD);
    expect(await until(l, "failed")).toEqual({ state: "failed", account: "work", reason: "not-saved" });
    expect(done).toEqual([]);
    expect(lines).toContain("[accounts] Claude login ended: not-saved (the credentials file is older than this sign-in)");
  });

  it("D: a credentials file that Claude wrote in this sign-in, or no file at all (the keychain of macOS): done", async () => {
    oldLogin();
    writeFileSync(join(dir, "save"), "");
    const l = login();
    await l.start("work");
    l.submit(GOOD);
    expect(await until(l, "done")).toMatchObject({ state: "done", account: "work" });
    expect(statSync(creds()).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    rmSync(join(dir, "save"));
    rmSync(creds());
    await l.start("work", { fresh: true });
    l.submit(GOOD);
    expect(await until(l, "done")).toMatchObject({ state: "done", account: "work" });
  });

  it("D: no check on macOS: Claude saves the login in the keychain there, and an old file can stay", async () => {
    oldLogin();
    const l = new ClaudeLogin({ paths: paths(), bin: fakeClaude(), env: { PATH: process.env.PATH }, log: () => {}, platform: "darwin" });
    made.push(l);
    await l.start("work");
    l.submit(GOOD);
    expect(await until(l, "done")).toMatchObject({ state: "done", account: "work" });
  });

  it("C: before a sign-in, a stale link to the lock goes: Claude takes its lock and saves the login", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    oldLogin();
    linkedLock();
    writeFileSync(join(dir, "save"), "");
    const l = login();
    await l.start("work");
    expect(() => lstatSync(lockLink())).toThrow(/ENOENT/);
    l.submit(GOOD);
    expect(await until(l, "done")).toMatchObject({ state: "done", account: "work" });
    expect(statSync(creds()).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    expect(warn).toHaveBeenCalledWith("[accounts] login work: removed 1 stale link to short-life files (.storage-write.lock)");
    warn.mockRestore();
  });

  it("strong protection (a `command`): no heal and no check; the login is the agents' own", async () => {
    oldLogin();
    linkedLock();
    writeFileSync(join(dir, "save"), "");
    const bin = fakeClaude();
    const l = new ClaudeLogin({
      paths: paths(), log: () => {},
      command: (sub, account) => ({ bin, args: ["auth", sub], env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, "accounts", account) } }),
    });
    made.push(l);
    await l.start("work");
    l.submit(GOOD);
    expect(await until(l, "done")).toMatchObject({ state: "done", account: "work" });
    // The link stayed, so the fake could not take its lock: the old file is still there.
    expect(lstatSync(lockLink()).isSymbolicLink()).toBe(true);
    expect(statSync(creds()).mtimeMs).toBeLessThan(Date.now() - 3_600_000);
  });
});
