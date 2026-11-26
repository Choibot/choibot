// server/agents/claudelogin.ts — the Claude login of an account, started from the page. No
// terminal: the console runs `claude auth login` for the account's own config dir, shows the
// sign-in link that the command prints, and hands it the code that the user pastes into a form.
// Claude Code itself does the login and writes its own files; the console never reads or
// stores a token or the code.
//
// How the command works (Claude Code 2.x, checked with a pipe and no terminal): it prints
//   "If the browser didn't open, visit: https://claude.com/…"   and   "Paste code here if prompted >"
// then reads one line. A code that is right ends it with exit 0. Any other code ends it with
// exit 1 and one line that says why. So one run takes one code: a wrong code needs a new link.
//
// One login at a time, as the GitHub login of the Set-up page (setup/ghlogin.ts).
import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { parseStatus } from "../../bin/lib/login.js";
import { resolveClaudeBin } from "../defaults.js";
import { claudeAccountEnv, credentialsPath, healAccountDir, type AccountPaths } from "./accounts.js";

// How long the link of one run is offered. The page shows the time that is left.
export const LINK_MS = 15 * 60_000;
// No link after this time: the command does not answer.
const FIRST_MS = 20_000;
// How long the command may take to check a code. (Strong protection: the helper ends a login and
// a status read by itself a little after these times; deploy/choibot-agent-exec claude-auth.)
export const CHECK_MS = 60_000;
export const STATUS_MS = 20_000;
const KEEP_BYTES = 8_192;
// The time of a file comes from a coarse clock of the kernel: it can be a little behind Date.now.
const MTIME_SLACK_MS = 1_000;

export type ClaudeLoginReason =
  | "wrong-code"   // Claude did not accept the code
  | "expired"      // nobody gave a code in time
  | "no-claude"    // the Claude program is not on the server
  | "no-answer"    // the command gave no link, or the sign-in service did not answer
  | "not-saved"    // Claude said yes, but the credentials file is older than this sign-in
  | "failed";

export type ClaudeLoginState =
  | { state: "idle" }
  | { state: "starting"; account: string }
  | { state: "waiting"; account: string; url: string; expiresAt: number }
  | { state: "checking"; account: string }
  | { state: "done"; account: string; email: string | null; plan: string | null }
  | { state: "failed"; account: string; reason: ClaudeLoginReason };

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// The link is shown to the user as a link: only an HTTPS address of Claude itself passes.
const URL_RE = /visit:\s*(https:\/\/[^\s]+)/;
const LINK_HOSTS = /^(claude\.com|claude\.ai|[a-z0-9-]+\.claude\.com|[a-z0-9-]+\.claude\.ai|[a-z0-9-]+\.anthropic\.com)$/;

export function parseLink(text: string): string | null {
  const raw = URL_RE.exec(text.replace(ANSI, ""))?.[1];
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && LINK_HOSTS.test(u.hostname) && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

// What the page of Claude shows to paste: one word of letters, digits and a few marks.
// Nothing else goes to the command (no space, no line break).
const CODE_RE = /^[A-Za-z0-9_#.~+/=:-]{8,2048}$/;
export const isLoginCode = (v: unknown): v is string => typeof v === "string" && CODE_RE.test(v);

export function loginFailure(text: string): ClaudeLoginReason {
  const t = text.replace(ANSI, "");
  if (/wasn'?t accepted|invalid code|incomplete, expired, already used/i.test(t)) return "wrong-code";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|fetch failed|could not reach|timed out/i.test(t)) return "no-answer";
  return "failed";
}

export type ClaudeLoginDeps = {
  paths: AccountPaths;
  // The Claude program. Default: the one the agents use.
  bin?: string;
  env?: Record<string, string | undefined>;
  linkMs?: number;
  firstMs?: number;
  checkMs?: number;
  now?: () => number;
  // A login ended well: the facts that depend on it are read again.
  onDone?: (account: string) => void;
  // The command of `claude auth login|status` for an account. Default: the Claude program with the
  // account's config dir. Strong protection: the agents' login through the helper (agentlogin.ts).
  command?: (sub: "login" | "status", account: string) => { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  log?: (s: string) => void;
  // The system of the server. Default: process.platform.
  platform?: NodeJS.Platform;
};

type Child = ReturnType<typeof spawn>;

export class ClaudeLogin {
  private st: ClaudeLoginState = { state: "idle" };
  private child: Child | null = null;
  private timer: NodeJS.Timeout | null = null;
  private waiters: (() => void)[] = [];

  constructor(private d: ClaudeLoginDeps) {}

  state(): ClaudeLoginState { return this.st; }

  // The account whose login runs now, or null.
  busyWith(): string | null {
    return this.child && this.st.state !== "idle" && this.st.state !== "done" && this.st.state !== "failed" ? this.st.account : null;
  }

  private bin(): string { return this.d.bin ?? resolveClaudeBin(this.env()); }
  private env(): NodeJS.ProcessEnv { return (this.d.env ?? process.env) as NodeJS.ProcessEnv; }
  // The env of the command: the config dir of the account. No colour, no pager.
  private childEnv(account: string): NodeJS.ProcessEnv {
    return { ...this.env(), ...claudeAccountEnv(account, this.d.paths), NO_COLOR: "1", TERM: "dumb" };
  }
  private command(sub: "login" | "status", account: string): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
    return this.d.command?.(sub, account) ?? { bin: this.bin(), args: ["auth", sub], env: this.childEnv(account) };
  }

  // Start the login of `account` and give its state when the link is there (or the start
  // failed). A login of the same account that waits is kept, so a second press or a second
  // device gets the same link. `fresh`: a new link.
  async start(account: string, o: { fresh?: boolean } = {}): Promise<ClaudeLoginState> {
    if (this.child && !o.fresh && this.busyWith() === account) return this.settled();
    this.stop();
    // Basic protection: links to short-life files in the login's folder stop Claude from saving
    // the sign-in (accounts.ts isShortLife). Strong protection (a `command`): the login is the
    // agents' own, through the helper; the console does not touch it.
    if (!this.d.command) healAccountDir(account, this.d.paths);
    // Real time (not `now`): it is compared with the time of the credentials file.
    const startedAt = Date.now();
    let child: Child;
    try {
      const c = this.command("login", account);
      child = spawn(c.bin, c.args, { env: c.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      this.set({ state: "failed", account, reason: "no-claude" });
      return this.st;
    }
    this.child = child;
    this.set({ state: "starting", account });
    this.log(`started for ${account}`);
    let seen = "";
    const mine = () => this.child === child;
    const onData = (chunk: Buffer) => {
      if (!mine()) return;
      seen = (seen + chunk.toString("utf8")).slice(-KEEP_BYTES);
      if (this.st.state !== "starting") return;
      const url = parseLink(seen);
      if (!url) return;
      const ms = this.d.linkMs ?? LINK_MS;
      this.clearTimer();
      this.set({ state: "waiting", account, url, expiresAt: (this.d.now ?? Date.now)() + ms });
      this.log("the sign-in link is on the page");
      this.arm(child, ms, "expired");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // A broken pipe on the way in (the command ended) is not an error of the console.
    child.stdin?.on("error", () => {});
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (mine()) this.end(child, { state: "failed", account, reason: e.code === "ENOENT" || e.code === "EACCES" ? "no-claude" : "failed" });
    });
    child.on("close", (code) => {
      if (!mine()) return;
      this.child = null;
      this.clearTimer();
      if (code !== 0) {
        // 127: the command was not found (through the helper: `claude` is not on the agents' PATH).
        const reason = this.st.state === "starting" ? (code === 127 ? "no-claude" : "no-answer") : loginFailure(seen);
        this.set({ state: "failed", account, reason });
        this.log(`ended: ${reason}`);
        return;
      }
      void this.who(account).then(async (who) => {
        if (this.child !== null) return; // a newer login started meanwhile
        // Exit 0 with no login on record is not a login.
        if (!who.loggedIn) { this.set({ state: "failed", account, reason: "failed" }); this.log("ended: the command said yes, but no login is on record"); return; }
        const unsaved = await this.notSaved(account, startedAt);
        if (this.child !== null) return;
        if (unsaved) {
          this.set({ state: "failed", account, reason: "not-saved" });
          this.log("ended: not-saved (the credentials file is older than this sign-in)");
          return;
        }
        this.set({ state: "done", account, email: who.email, plan: who.plan });
        this.log(`done for ${account}`);
        this.d.onDone?.(account);
      });
    });
    this.arm(child, this.d.firstMs ?? FIRST_MS, "no-answer");
    return this.settled();
  }

  // The code that the page of Claude showed. One code for one link.
  submit(code: string): ClaudeLoginState | { state: "refused"; why: "no-login" | "bad-code" } {
    const child = this.child;
    if (!child || this.st.state !== "waiting") return { state: "refused", why: "no-login" };
    if (!isLoginCode(code)) return { state: "refused", why: "bad-code" };
    const account = this.st.account;
    this.clearTimer();
    this.set({ state: "checking", account });
    child.stdin?.write(`${code}\n`);
    this.arm(child, this.d.checkMs ?? CHECK_MS, "no-answer");
    return this.st;
  }

  // End a login that runs (the user closed the form, or the console stops).
  stop(): void {
    const child = this.child;
    this.child = null;
    this.clearTimer();
    if (child) this.kill(child);
    if (this.st.state === "starting" || this.st.state === "waiting" || this.st.state === "checking") this.set({ state: "idle" });
  }

  // After a "done" or a "failed" that the page has shown.
  clear(): void {
    if (this.st.state === "done" || this.st.state === "failed") this.set({ state: "idle" });
  }

  private arm(child: Child, ms: number, reason: ClaudeLoginReason): void {
    this.timer = setTimeout(() => {
      if (this.child !== child) return;
      const account = "account" in this.st ? this.st.account : "";
      this.end(child, { state: "failed", account, reason });
    }, ms);
    this.timer.unref?.();
  }

  // Close the command's stdin and send it SIGTERM. Claude Code does not end on a closed stdin,
  // so the signal is the stop. Through sudo (strong protection) sudo relays it; if a signal does
  // not arrive, the helper's own time limit ends the command (deploy/choibot-agent-exec).
  private kill(child: Child): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    if (!child.kill("SIGTERM")) this.log("stop: the signal did not reach the command; it ends at its time limit");
  }

  private end(child: Child, next: ClaudeLoginState): void {
    this.child = null;
    this.clearTimer();
    this.kill(child);
    this.set(next);
    if (next.state === "failed") this.log(`ended: ${next.reason}`);
  }

  // "Done" must be true. Claude Code ends with 0 and says "logged in" from an old credentials file
  // when it could not write the new one (it could not take its write lock). A file older than the
  // start of this sign-in was not written by it. No file: no check. macOS: no check (Claude saves
  // the login in the keychain there, and an old file can stay on disk). Strong protection (a
  // `command`): the file is the agents' own, which the console does not read; no check.
  private async notSaved(account: string, startedAt: number): Promise<boolean> {
    if (this.d.command || (this.d.platform ?? process.platform) === "darwin") return false;
    const at = await stat(credentialsPath(account, this.d.paths)).then((s) => s.mtimeMs, () => null);
    return at !== null && at < startedAt - MTIME_SLACK_MS;
  }

  // Who is logged in for the account, as Claude Code says it.
  private who(account: string): Promise<ReturnType<typeof parseStatus>> {
    return new Promise((done) => {
      const c = this.command("status", account);
      execFile(c.bin, c.args, { env: c.env, timeout: STATUS_MS }, (_err, stdout) => done(parseStatus(String(stdout ?? ""))));
    });
  }

  private settled(): Promise<ClaudeLoginState> {
    if (this.st.state !== "starting") return Promise.resolve(this.st);
    return new Promise((resolve) => {
      const done = () => { this.waiters = this.waiters.filter((w) => w !== done); resolve(this.st); };
      this.waiters.push(done);
    });
  }

  private set(next: ClaudeLoginState): void {
    this.st = next;
    if (next.state !== "starting") for (const w of [...this.waiters]) w();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private log(what: string): void {
    (this.d.log ?? ((s: string) => console.warn(s)))(`[accounts] Claude login ${what}`);
  }
}
