// bin/cron-runner.test.ts — end-to-end tests for the cron job runner.
// The runner is plain JS started by systemd as `node bin/cron-runner.mjs <job>`,
// so we exercise it the same way: a real subprocess against a temp
// CRON_DATA_DIR, a stub `claude` on disk, and a local HTTP server standing in
// for the console's /api/cron/notify endpoint.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NO_MERGE_RULE } from "../server/chief/brain/prompt.js";

import { BRAIN_FIXTURE, RULES_FIXTURE } from "./lib/chief-cron.fixtures.js";
import { STRONG_ENV_KEEP } from "./lib/chief-cron.mjs";
import { RESULT_INSTRUCTION } from "./lib/cron-result.mjs";
import { legacyMarkers, resolveNames } from "../server/names.mjs";

// What claude gets as the prompt of the job "do it": the instructions, then the result paragraph.
const PROMPT = `do it\n\n${RESULT_INSTRUCTION}`;

const RUNNER = fileURLToPath(new URL("./cron-runner.mjs", import.meta.url));
const TEST_TIMEOUT = 20_000;

type CronRunResult = {
  startedAt: number; finishedAt: number; exitCode: number | null;
  ok: boolean; outputTail: string;
  result?: { state: string; sentence: string; refs: string[] }; why?: string;
};
type NotifyPost = {
  url: string;
  token: string | undefined;
  body: { name?: string; ok?: boolean; summary?: string; telegram?: boolean; result?: unknown; why?: string } | null;
};

let dir = "";
let binDir = "";
let server: Server | undefined;
let posts: NotifyPost[] = [];
// The answer of the console's notify route: 500 = the console is down (the runner then uses its
// own Telegram fallback, which a test points at this same server as a fake Bot API).
let notifyStatus = 200;

async function startNotifyServer(): Promise<number> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += String(c); });
    req.on("end", () => {
      let body: NotifyPost["body"] = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      posts.push({
        url: req.url ?? "",
        token: req.headers["x-cron-token"] as string | undefined,
        body,
      });
      const down = notifyStatus !== 200 && req.url === "/api/cron/notify";
      res.writeHead(down ? notifyStatus : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: !down }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as AddressInfo).port;
}

async function writeJob(overrides: Record<string, unknown> = {}): Promise<void> {
  const spec = {
    name: "j1", schedule: "*-*-* 08:00:00", prompt: "do it",
    timeoutMinutes: 1, notify: "always", enabled: true, createdAt: 1,
    ...overrides,
  };
  await mkdir(join(dir, "jobs"), { recursive: true });
  await writeFile(join(dir, "jobs", `${spec.name}.json`), JSON.stringify(spec, null, 2));
}

/** Stub `claude` that echoes a line and exits with `exitCode`. */
async function writeStub(exitCode = 0, line = "hello from claude"): Promise<string> {
  const path = join(binDir, "claude");
  await writeFile(path, `#!/bin/sh\necho "${line}"\nexit ${exitCode}\n`, { mode: 0o755 });
  return path;
}

function runnerEnv(port: number, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Keep the sandbox hermetic: no real Telegram fallback, no inherited wiring.
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;
  // …and no account wiring from the shell running the tests.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_DEFAULT_ACCOUNT;
  delete env.CLAUDE_ACCOUNTS_DIR;
  Object.assign(env, {
    CRON_DATA_DIR: dir,
    PORT: String(port),
    CLAUDE_CODE_EXECUTABLE: join(binDir, "claude"),
    WORKSPACE_DIR: dir,
    // Never the real chief dir: chiefCronArgs reads BRAIN.md from here.
    CHIEF_DATA_DIR: join(dir, "chief"),
    // Never the real console data dir: the runner reads the default login and the sign-out
    // marks from here (lib/cron-login.mjs).
    XDG_DATA_HOME: join(dir, "data"),
    ...extraEnv,
  });
  return env;
}

function runRunner(job: string, port: number, extraEnv: Record<string, string> = {}) {
  const env = runnerEnv(port, extraEnv);
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [RUNNER, job], { env, cwd: dir }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number"
        ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function readLast(job = "j1"): Promise<CronRunResult | null> {
  try { return JSON.parse(await readFile(join(dir, "runs", job, "last.json"), "utf8")); }
  catch { return null; }
}
async function readRing(job = "j1"): Promise<string[]> {
  try { return (await readdir(join(dir, "runs", job, "ring"))).filter((f) => f.endsWith(".json")); }
  catch { return []; }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cron-runner-"));
  binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(dir, "notify-token"), "s3cret\n");
  posts = [];
  notifyStatus = 200;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("cron-runner", () => {
  it("records a successful run and notifies", async () => {
    const port = await startNotifyServer();
    await writeJob();
    await writeStub(0);

    const { code } = await runRunner("j1", port);
    expect(code).toBe(0);

    const last = await readLast();
    expect(last).not.toBeNull();
    expect(last!.ok).toBe(true);
    expect(last!.exitCode).toBe(0);
    expect(last!.outputTail).toContain("hello from claude");
    expect(last!.finishedAt).toBeGreaterThanOrEqual(last!.startedAt);

    expect(await readRing()).toHaveLength(1);

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/cron/notify");
    expect(posts[0].token).toBe("s3cret");
    expect(posts[0].body?.name).toBe("j1");
    expect(posts[0].body?.ok).toBe(true);
    expect(posts[0].body?.summary).toContain("hello from claude");
    expect(posts[0].body?.telegram).toBe(true);
  }, TEST_TIMEOUT);

  it("records a failed run", async () => {
    const port = await startNotifyServer();
    await writeJob();
    await writeStub(3, "boom");

    await runRunner("j1", port);

    const last = await readLast();
    expect(last).not.toBeNull();
    expect(last!.ok).toBe(false);
    expect(last!.exitCode).toBe(3);
    expect(last!.outputTail).toContain("boom");

    expect(posts).toHaveLength(1);
    expect(posts[0].body?.ok).toBe(false);
    expect(posts[0].body?.summary).toContain("exit 3");
    expect(posts[0].body?.telegram).toBe(true);
  }, TEST_TIMEOUT);

  // The result line (lib/cron-result.mjs): the task's own words of its run, kept with the run.
  describe("the result line", () => {
    const stub = (lines: string[], exitCode = 0) =>
      writeFile(join(binDir, "claude"), `#!/bin/sh\ncat <<'OUT'\n${lines.join("\n")}\nOUT\nexit ${exitCode}\n`, { mode: 0o755 });

    it("keeps the state, the sentence and the links of a run that finished; the summary has no result line", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await stub(["2 new errors.", "", "RESULT: needs-you | 2 new errors since yesterday. | qab12cd34"]);
      await runRunner("j1", port);
      const last = await readLast();
      expect(last!.ok).toBe(true);
      expect(last!.result).toEqual({ state: "needs-you", sentence: "2 new errors since yesterday.", refs: ["qab12cd34"] });
      expect(last!.why).toBeUndefined();
      expect(last!.outputTail).toContain("RESULT: needs-you");
      expect(posts[0].body?.summary).toBe("2 new errors.");
      // The console gets the state and the sentence (it checks both); the links stay with the run.
      expect(posts[0].body?.result).toEqual({ state: "needs-you", sentence: "2 new errors since yesterday." });
      expect(posts[0].body?.why).toBeUndefined();
    }, TEST_TIMEOUT);

    it("an answer that is only the result line: the summary is its sentence", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await stub(["RESULT: all-clear | No new error."]);
      await runRunner("j1", port);
      expect((await readLast())!.result).toEqual({ state: "all-clear", sentence: "No new error.", refs: [] });
      expect(posts[0].body?.summary).toBe("No new error.");
    }, TEST_TIMEOUT);

    it("an answer with no result line keeps none", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeStub(0);
      await runRunner("j1", port);
      const last = await readLast();
      expect(last!.result).toBeUndefined();
      expect(last!.why).toBeUndefined();
      // A run with no result line: the notify is as before.
      expect(Object.keys(posts[0].body!).sort()).toEqual(["name", "ok", "summary", "telegram"]);
    }, TEST_TIMEOUT);

    it("a run that failed is never all clear: no result is kept, and it says why", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await stub(["RESULT: all-clear | Everything is fine."], 3);
      await runRunner("j1", port);
      const last = await readLast();
      expect(last!.ok).toBe(false);
      expect(last!.result).toBeUndefined();
      expect(last!.why).toBe("exit");
      expect(posts[0].body?.ok).toBe(false);
      expect(posts[0].body?.why).toBe("exit");
      expect(posts[0].body?.result).toBeUndefined();
    }, TEST_TIMEOUT);

    it("notify on-failure: a run that needs a person goes to Telegram; an all-clear run does not", async () => {
      const port = await startNotifyServer();
      await writeJob({ notify: "on-failure" });
      await stub(["RESULT: needs-you | Look at the backup."]);
      await runRunner("j1", port);
      await stub(["RESULT: all-clear | Fine."]);
      await runRunner("j1", port);
      expect(posts.map((p) => [p.body?.ok, p.body?.telegram])).toEqual([[true, true], [true, false]]);
    }, TEST_TIMEOUT);

    // The console is down: the runner sends the Telegram message itself, with the same builder
    // as the console (lib/cron-result.mjs runMessageHtml). A fake Bot API stands in for Telegram.
    describe("the Telegram fallback", () => {
      const fallback = async (lines: string[], exitCode = 0) => {
        const port = await startNotifyServer();
        notifyStatus = 500;
        await writeJob();
        await stub(lines, exitCode);
        await runRunner("j1", port, {
          TELEGRAM_BOT_TOKEN: "123:fake", TELEGRAM_CHAT_ID: "-100", CHIEF_TEST: "1",
          CHIEF_TEST_TELEGRAM_API: `http://127.0.0.1:${port}`, CHIEF_CONSOLE_URL: "https://c.example",
        });
        const sent = posts.filter((p) => p.url === "/bot123:fake/sendMessage");
        expect(sent).toHaveLength(1);
        return (sent[0].body as unknown as { text: string; parse_mode: string });
      };
      const LINK = '<a href="https://c.example/#recurring=j1">Open the task</a>';
      it("needs you: the headline, the link and the answer folded", async () => {
        const m = await fallback(["Costs this week: 41 USD", "- EC2 <30>", "", "RESULT: needs-you | EC2 is up 40%."]);
        expect(m).toEqual({ chat_id: "-100", parse_mode: "HTML",
          text: `<b>Recurring · j1</b>: Needs you. EC2 is up 40%.\n${LINK}\n<blockquote expandable>Costs this week: 41 USD\n- EC2 &lt;30&gt;</blockquote>` });
      }, TEST_TIMEOUT);
      it("all clear: the same", async () => {
        expect((await fallback(["Fine: 14 files.", "RESULT: all-clear | The backup is complete."])).text)
          .toBe(`<b>Recurring · j1</b>: All clear. The backup is complete.\n${LINK}\n<blockquote expandable>Fine: 14 files.</blockquote>`);
      }, TEST_TIMEOUT);
      it("an answer that is only the result line has no quote", async () => {
        expect((await fallback(["RESULT: all-clear | The backup is complete."])).text)
          .toBe(`<b>Recurring · j1</b>: All clear. The backup is complete.\n${LINK}`);
      }, TEST_TIMEOUT);
      it("did not finish: the fixed reason, no output", async () => {
        expect((await fallback(["secret <stack>"], 3)).text).toBe(`<b>Recurring · j1</b>: Did not finish. It stopped with an error.\n${LINK}`);
      }, TEST_TIMEOUT);
      it("did not finish because the login is signed out: the fixed reason", async () => {
        expect((await fallback(["Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator."], 1)).text)
          .toBe(`<b>Recurring · j1</b>: Did not finish. Its Claude login is signed out.\n${LINK}`);
      }, TEST_TIMEOUT);
      it("no result line: as before", async () => {
        expect((await fallback(["Backup done.", "", "All good."])).text).toBe("✅ <b>j1</b>\nBackup done.\n<blockquote expandable>All good.</blockquote>");
      }, TEST_TIMEOUT);
    });

    it("marks a run in progress while claude runs, and removes the mark at the end", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeFile(join(binDir, "claude"), `#!/bin/sh\ncat "${dir}/runs/j1/running.json"\nexit 0\n`, { mode: 0o755 });
      await runRunner("j1", port);
      const last = await readLast();
      // The login of the run is in the mark (the sign-out of a login waits for its runs).
      expect(JSON.parse(last!.outputTail)).toEqual({ startedAt: last!.startedAt, login: "default" });
      expect(existsSync(join(dir, "runs", "j1", "running.json"))).toBe(false);
    }, TEST_TIMEOUT);

    it("a run that did not start says so", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await runRunner("j1", port, { CLAUDE_CODE_EXECUTABLE: join(dir, "nope", "claude") });
      expect((await readLast())!.why).toBe("start");
    }, TEST_TIMEOUT);
  });

  it("skips a disabled job", async () => {
    const port = await startNotifyServer();
    await writeJob({ enabled: false });
    await writeStub(0);

    const { code } = await runRunner("j1", port);
    expect(code).toBe(0);
    expect(await readLast()).toBeNull();
    expect(await readRing()).toHaveLength(0);
    expect(posts).toHaveLength(0);
  }, TEST_TIMEOUT);

  // A hand-edited spec used to kill the runner outright: execFile throws
  // ERR_OUT_OF_RANGE on a NaN timeout, so the job vanished with no record.
  it("still records a run when the spec has no timeoutMinutes", async () => {
    const port = await startNotifyServer();
    await writeJob({ timeoutMinutes: undefined });
    await writeStub(3, "boom");

    const { code } = await runRunner("j1", port);
    expect(code).toBe(0);

    const last = await readLast();
    expect(last).not.toBeNull();
    expect(last!.ok).toBe(false);
    expect(last!.exitCode).toBe(3);
    expect(last!.outputTail).not.toBe("");
    expect(last!.outputTail).toContain("boom");
    expect(posts).toHaveLength(1);
  }, TEST_TIMEOUT);

  // A stale CLAUDE_CODE_EXECUTABLE must read as a spawn failure, not a timeout,
  // and must carry the spawn error text instead of an empty outputTail.
  it("reports a spawn failure with diagnostics", async () => {
    const port = await startNotifyServer();
    await writeJob();
    await writeStub(0);

    const { code } = await runRunner("j1", port, {
      CLAUDE_CODE_EXECUTABLE: join(dir, "nope", "claude"),
    });
    expect(code).toBe(0);

    const last = await readLast();
    expect(last).not.toBeNull();
    expect(last!.ok).toBe(false);
    expect(last!.exitCode).toBeNull();
    expect(last!.outputTail).toContain("ENOENT");

    expect(posts).toHaveLength(1);
    expect(posts[0].body?.ok).toBe(false);
    expect(posts[0].body?.summary?.startsWith("spawn failed")).toBe(true);
    expect(posts[0].body?.summary).toContain("ENOENT");
    expect(posts[0].body?.summary).not.toContain("timeout");
  }, TEST_TIMEOUT);

  // claude -p prints a "no stdin data received in 3s" warning to stderr even
  // with stdin closed; it must stay out of the success summary (it used to
  // trail the combined output and eat the 500-char Telegram tail) while the
  // run record keeps the full combined output for debugging.
  it("keeps stderr out of the success summary but in the run record", async () => {
    const port = await startNotifyServer();
    await writeJob();
    await writeFile(
      join(binDir, "claude"),
      `#!/bin/sh\necho "the digest"\necho "Warning: no stdin data received in 3s" >&2\nexit 0\n`,
      { mode: 0o755 },
    );

    const { code } = await runRunner("j1", port);
    expect(code).toBe(0);

    const last = await readLast();
    expect(last!.ok).toBe(true);
    expect(last!.outputTail).toContain("the digest");
    expect(last!.outputTail).toContain("no stdin data");

    expect(posts).toHaveLength(1);
    expect(posts[0].body?.summary).toContain("the digest");
    expect(posts[0].body?.summary).not.toContain("no stdin data");
  }, TEST_TIMEOUT);

  it("respects notify on-failure: an OK run still reaches the console (the fleet master reads it), with telegram false", async () => {
    const port = await startNotifyServer();
    await writeJob({ notify: "on-failure" });
    await writeStub(0);

    const { code } = await runRunner("j1", port);
    expect(code).toBe(0);

    const last = await readLast();
    expect(last).not.toBeNull();
    expect(last!.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ name: "j1", ok: true, telegram: false });
  }, TEST_TIMEOUT);

  describe("account", () => {
    // Stub claude that reports which config dir it was started with.
    async function writeEnvStub(): Promise<void> {
      await writeFile(join(binDir, "claude"), `#!/bin/sh\necho "dir=[$CLAUDE_CONFIG_DIR]"\n`, { mode: 0o755 });
    }
    async function seenDir(): Promise<string | undefined> {
      return /dir=\[(.*)\]/.exec((await readLast())?.outputTail ?? "")?.[1];
    }
    let accounts = "";
    beforeEach(async () => {
      accounts = join(dir, "accounts");
      await mkdir(join(accounts, "office"), { recursive: true });
      await mkdir(join(accounts, "alt"), { recursive: true });
      await writeEnvStub();
    });

    it("runs under CLAUDE_DEFAULT_ACCOUNT when its dir exists", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await runRunner("j1", port, { CLAUDE_ACCOUNTS_DIR: accounts, CLAUDE_DEFAULT_ACCOUNT: "office" });
      expect(await seenDir()).toBe(join(accounts, "office"));
    }, TEST_TIMEOUT);

    it("keeps an explicit CLAUDE_CONFIG_DIR over the default account", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await runRunner("j1", port, {
        CLAUDE_ACCOUNTS_DIR: accounts, CLAUDE_DEFAULT_ACCOUNT: "office", CLAUDE_CONFIG_DIR: "/explicit",
      });
      expect(await seenDir()).toBe("/explicit");
    }, TEST_TIMEOUT);

    it("ignores a default account that is missing, invalid or 'default'", async () => {
      const port = await startNotifyServer();
      await writeJob();
      for (const pref of ["ghost", "Bad Id", "default"]) {
        await runRunner("j1", port, { CLAUDE_ACCOUNTS_DIR: accounts, CLAUDE_DEFAULT_ACCOUNT: pref });
        expect(await seenDir()).toBe("");
        expect((await readLast())!.ok).toBe(true);
      }
    }, TEST_TIMEOUT);

    it("lets spec.account override the default and an explicit dir", async () => {
      const port = await startNotifyServer();
      await writeJob({ account: "alt" });
      await runRunner("j1", port, {
        CLAUDE_ACCOUNTS_DIR: accounts, CLAUDE_DEFAULT_ACCOUNT: "office", CLAUDE_CONFIG_DIR: "/explicit",
      });
      expect(await seenDir()).toBe(join(accounts, "alt"));
    }, TEST_TIMEOUT);

    it("treats spec.account 'default' as the box login", async () => {
      const port = await startNotifyServer();
      await writeJob({ account: "default" });
      await runRunner("j1", port, { CLAUDE_ACCOUNTS_DIR: accounts, CLAUDE_DEFAULT_ACCOUNT: "office" });
      expect(await seenDir()).toBe("");
    }, TEST_TIMEOUT);

    // The console's files (lib/cron-login.mjs): the page's pick and the sign-out marks, in the
    // data dir that the runner's names give; the main login's folder in a throwaway HOME.
    const home = () => join(dir, "home");
    async function consoleFiles(o: { pick?: string; marks?: Record<string, number>; tokens?: string[] }, extra: Record<string, string>): Promise<void> {
      const data = join(dir, "data", resolveNames(legacyMarkers(runnerEnv(0, extra))).dataDir);
      await mkdir(data, { recursive: true });
      if (o.pick) await writeFile(join(data, "default-login.json"), JSON.stringify({ id: o.pick }));
      if (o.marks) await writeFile(join(data, "logins-signed-out.json"), JSON.stringify(o.marks));
      for (const id of o.tokens ?? []) {
        const folder = id === "default" ? join(home(), ".claude") : join(accounts, id);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }));
      }
    }
    const LATER = Date.now() + 3_600_000; // a mark newer than the credentials files

    it("the mark of a run in progress names its login: the named one, the default one, never a signed-out one", async () => {
      const port = await startNotifyServer();
      await writeFile(join(binDir, "claude"), `#!/bin/sh\ncat "${dir}/runs/j1/running.json"\n`, { mode: 0o755 });
      const mark = async () => JSON.parse((await readLast())!.outputTail) as { login?: string };
      const extra = { CLAUDE_ACCOUNTS_DIR: accounts, CLAUDE_DEFAULT_ACCOUNT: "office", HOME: home() };
      await writeJob({ account: "alt" });
      await runRunner("j1", port, extra);
      expect((await mark()).login).toBe("alt");
      await writeJob();
      await runRunner("j1", port, extra);
      expect((await mark()).login).toBe("office");
      // The sign-out of "office" marked it first: the run goes to the main login.
      await consoleFiles({ marks: { office: LATER }, tokens: ["default", "office"] }, extra);
      await runRunner("j1", port, extra);
      expect((await mark()).login).toBe("default");
    }, TEST_TIMEOUT);

    it("a task with no named login follows the page's pick over the setting", async () => {
      const port = await startNotifyServer();
      await writeJob();
      const extra = { CLAUDE_ACCOUNTS_DIR: accounts, CLAUDE_DEFAULT_ACCOUNT: "office", HOME: home() };
      await consoleFiles({ pick: "alt" }, extra);
      await runRunner("j1", port, extra);
      expect(await seenDir()).toBe(join(accounts, "alt"));
      await consoleFiles({ pick: "default" }, extra);
      await runRunner("j1", port, extra);
      expect(await seenDir()).toBe("");
    }, TEST_TIMEOUT);

    it("2026-11-21: the setting's login is signed out; the task runs on the main login, as the console does", async () => {
      const port = await startNotifyServer();
      await writeJob();
      const extra = { CLAUDE_ACCOUNTS_DIR: accounts, CLAUDE_DEFAULT_ACCOUNT: "office", HOME: home() };
      await consoleFiles({ marks: { office: LATER }, tokens: ["default", "office"] }, extra);
      await runRunner("j1", port, extra);
      expect(await seenDir()).toBe("");
      expect(await readLast()).toMatchObject({ ok: true });
    }, TEST_TIMEOUT);

    it("a named login that is signed out: the run fails with why login, claude never runs", async () => {
      const port = await startNotifyServer();
      await writeJob({ account: "alt" });
      const extra = { CLAUDE_ACCOUNTS_DIR: accounts, HOME: home() };
      await consoleFiles({ marks: { alt: LATER }, tokens: ["default", "alt"] }, extra);
      await runRunner("j1", port, extra);
      const last = await readLast();
      expect(last).toMatchObject({ ok: false, exitCode: null, why: "login" });
      expect(last!.outputTail).toBe('Claude login "alt": sign in again on the Settings page');
      expect(posts[0].body).toMatchObject({ ok: false, why: "login" });
      expect(posts[0].body?.summary?.startsWith("login signed out:")).toBe(true);
    }, TEST_TIMEOUT);

    it("claude ends with the sign-out words: why login, not exit", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeStub(1, "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.");
      await runRunner("j1", port, { CLAUDE_ACCOUNTS_DIR: accounts });
      expect(await readLast()).toMatchObject({ ok: false, exitCode: 1, why: "login" });
      expect(posts[0].body).toMatchObject({ ok: false, why: "login" });
    }, TEST_TIMEOUT);

    it("fails the run when spec.account has no dir", async () => {
      const port = await startNotifyServer();
      await writeJob({ account: "ghost" });
      const { code } = await runRunner("j1", port, { CLAUDE_ACCOUNTS_DIR: accounts });
      expect(code).toBe(0);
      const last = await readLast();
      expect(last!.ok).toBe(false);
      expect(last!.exitCode).toBeNull();
      expect(last!.outputTail).toContain('account "ghost" not found');
      expect(posts).toHaveLength(1);
      expect(posts[0].body?.summary?.startsWith("account error")).toBe(true);
    }, TEST_TIMEOUT);
  });

  // The job's claude gets the agent env (bin/lib/agent-env.mjs); the runner
  // itself keeps the console env (its Telegram fallback needs the token).
  describe("agent env of the job's claude", () => {
    async function writeEnvDump(): Promise<void> {
      await writeFile(join(binDir, "claude"), `#!/bin/sh\nenv > "${dir}/child-env.txt"\nexit 0\n`, { mode: 0o755 });
    }
    const childEnv = async () => (await readFile(join(dir, "child-env.txt"), "utf8")).split("\n").filter(Boolean);
    const SECRETS = { TELEGRAM_BOT_TOKEN: "tg-cron-secret", CONSOLE_COOKIE_SECRET: "cookie-cron-secret", CHOIBOT_USER_TOKEN: "user-cron-secret" };

    it("never gets a console secret (AGENT_ENV_PASS unset: every other key)", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeEnvDump();
      await runRunner("j1", port, { ...SECRETS, MY_APP_KEY: "app-cron" });
      const e = (await childEnv()).join("\n");
      for (const v of Object.values(SECRETS)) expect(e).not.toContain(v);
      expect(e).toContain("MY_APP_KEY=app-cron");
      expect((await readLast())!.ok).toBe(true);
    }, TEST_TIMEOUT);

    it("AGENT_ENV_PASS set: the allowlist and the listed keys, with the cron agent id and account dir", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeEnvDump();
      await runRunner("j1", port, {
        ...SECRETS, CHIEF_ENABLED: "1", AGENT_ENV_PASS: "MY_APP_KEY", MY_APP_KEY: "app-cron", OTHER_APP_KEY: "other-cron",
        CLAUDE_CONFIG_DIR: "/explicit",
      });
      const e = await childEnv();
      expect(e).toContain("MY_APP_KEY=app-cron");
      expect(e).toContain("CHOIBOT_AGENT_ID=cron:j1");
      expect(e).toContain("CLAUDE_CONFIG_DIR=/explicit");
      expect(e.some((l) => l.startsWith("OTHER_APP_KEY=") || l.startsWith("CHIEF_ENABLED="))).toBe(false);
      for (const v of Object.values(SECRETS)) expect(e.join("\n")).not.toContain(v);
    }, TEST_TIMEOUT);
  });

  describe("chief", () => {
    async function writeCaptureStub(): Promise<void> {
      await writeFile(
        join(binDir, "claude"),
        `#!/bin/sh\nprintf '%s\\0' "$@" > "${dir}/argv.bin"\nenv | grep '^CHOIBOT_' > "${dir}/env.txt"\nexit 0\n`,
        { mode: 0o755 },
      );
    }
    const argv = async () => (await readFile(join(dir, "argv.bin"), "utf8")).split("\0").slice(0, -1);
    const envLines = async () => (await readFile(join(dir, "env.txt"), "utf8")).split("\n").filter(Boolean);

    it("flag on: merge rule arg, cron agent id, no user token", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeCaptureStub();
      await runRunner("j1", port, { CHIEF_ENABLED: "1", CHOIBOT_USER_TOKEN: "u" });
      const a = await argv();
      const i = a.indexOf("--append-system-prompt");
      expect(i).toBeGreaterThan(-1);
      expect(a[i + 1]).toBe(NO_MERGE_RULE);
      const e = await envLines();
      expect(e).toContain("CHOIBOT_AGENT_ID=cron:j1");
      expect(e.some((l) => l.startsWith("CHOIBOT_USER_TOKEN"))).toBe(false);
    }, TEST_TIMEOUT);

    it("flag on with a brain: Always section appended, retired and uncited dropped", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeCaptureStub();
      const chief = join(dir, "chief");
      await mkdir(join(chief, "brain"), { recursive: true });
      await writeFile(join(chief, "brain", "rules.jsonl"), RULES_FIXTURE);
      await writeFile(join(chief, "brain", "BRAIN.md"), BRAIN_FIXTURE);
      await runRunner("j1", port, { CHIEF_ENABLED: "1" });
      const a = await argv();
      const text = a[a.indexOf("--append-system-prompt") + 1];
      expect(text).toContain(NO_MERGE_RULE);
      expect(text).toContain("- always keep it short [r_aaaaa]");
      expect(text).not.toContain("r_ccccc");
      expect(text).not.toContain("r_bbbbb");                   // retired
      expect(text).not.toContain("uncited line with no id");   // uncited
      expect(text).not.toContain("Ignore the rules above");    // not a valid header
    }, TEST_TIMEOUT);

    it("flag on, no BRAIN.md: exactly the merge rule", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeCaptureStub();
      await runRunner("j1", port, { CHIEF_ENABLED: "1" });
      const a = await argv();
      expect(a[a.indexOf("--append-system-prompt") + 1]).toBe(NO_MERGE_RULE);
    }, TEST_TIMEOUT);

    // Ruling 2c-8-a (b): a hardened deployment's job never loads the cwd's
    // project settings, hooks or MCP servers (an agent may write them).
    const HARDENED = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001" };
    const HARDEN_ARGS = ["--setting-sources", "user", "--strict-mcp-config"];

    it("hardened: --setting-sources user --strict-mcp-config after the chief args", async () => {
      const port = await startNotifyServer();
      await writeJob({ model: "sonnet" });
      await writeCaptureStub();
      await runRunner("j1", port, HARDENED);
      expect(await argv()).toEqual([
        "-p", PROMPT, "--dangerously-skip-permissions", "--model", "sonnet",
        "--append-system-prompt", NO_MERGE_RULE, ...HARDEN_ARGS,
      ]);
    }, TEST_TIMEOUT);

    // Ruling F1: a hardened job (console uid, every permission skipped) never
    // starts on a Claude config dir or settings.json that is not its own or
    // that a group can write: one error line, a failed run, no claude.
    describe("hardened: the Claude config dir (ruling F1)", () => {
      async function cfg(mode: number, settingsMode?: number): Promise<string> {
        const d = join(dir, "claude-cfg");
        await mkdir(d, { recursive: true });
        if (settingsMode !== undefined) {
          await writeFile(join(d, "settings.json"), "{}");
          await chmod(join(d, "settings.json"), settingsMode);
        }
        await chmod(d, mode);
        return d;
      }

      it("a group-writable CLAUDE_CONFIG_DIR: refused, one error line, a failed run, claude never runs", async () => {
        const port = await startNotifyServer();
        await writeJob();
        await writeCaptureStub();
        const d = await cfg(0o770);
        const r = await runRunner("j1", port, { ...HARDENED, CLAUDE_CONFIG_DIR: d });
        const why = `claude config ${d} mode 0770 is group- or other-writable`;
        expect(r.stderr).toBe(`[cron-runner] j1 refused: ${why}\n`);
        expect(existsSync(join(dir, "argv.bin"))).toBe(false);
        expect(await readLast()).toMatchObject({ ok: false, exitCode: null, outputTail: why });
        expect(posts[0].body).toMatchObject({ name: "j1", ok: false, summary: `refused: ${why}` });
      }, TEST_TIMEOUT);

      it("a group-writable settings.json in HOME/.claude: refused", async () => {
        const port = await startNotifyServer();
        await writeJob();
        await writeCaptureStub();
        const home = join(dir, "home");
        await mkdir(join(home, ".claude"), { recursive: true });
        await chmod(join(home, ".claude"), 0o700);
        await writeFile(join(home, ".claude", "settings.json"), "{}");
        await chmod(join(home, ".claude", "settings.json"), 0o664);
        const r = await runRunner("j1", port, { ...HARDENED, HOME: home });
        expect(r.stderr).toBe(`[cron-runner] j1 refused: claude config ${join(home, ".claude", "settings.json")} mode 0664 is group- or other-writable\n`);
        expect(existsSync(join(dir, "argv.bin"))).toBe(false);
      }, TEST_TIMEOUT);

      it("an own 0700 dir with a 0600 settings.json: the job runs", async () => {
        const port = await startNotifyServer();
        await writeJob();
        await writeCaptureStub();
        const d = await cfg(0o700, 0o600);
        await runRunner("j1", port, { ...HARDENED, CLAUDE_CONFIG_DIR: d });
        expect(await argv()).toContain("--strict-mcp-config");
      }, TEST_TIMEOUT);

      it("not hardened: a group-writable dir changes nothing", async () => {
        const port = await startNotifyServer();
        await writeJob();
        await writeCaptureStub();
        const d = await cfg(0o770, 0o666);
        const r = await runRunner("j1", port, { ...HARDENED, CHIEF_AGENT_UID: "", CLAUDE_CONFIG_DIR: d });
        expect(r.stderr).toBe("");
        expect(await argv()).toEqual(["-p", PROMPT, "--dangerously-skip-permissions", "--append-system-prompt", NO_MERGE_RULE]);
      }, TEST_TIMEOUT);
    });

    // S3: the runner re-checks the job's real cwd at run time when hardened:
    // a dir only the console uid owns and can write, else refused.
    describe("hardened: the job cwd (S3)", () => {
      it("a group-writable workdir: refused, one error line, claude never runs", async () => {
        const port = await startNotifyServer();
        const wd = join(dir, "shared");
        await mkdir(wd);
        await chmod(wd, 0o2775);
        await writeJob({ workdir: wd });
        await writeCaptureStub();
        const r = await runRunner("j1", port, HARDENED);
        const why = `job cwd ${JSON.stringify(wd)} mode 2775 lets a group or others write it: it would run their code as the console`;
        expect(r.stderr).toBe(`[cron-runner] j1 refused: ${why}\n`);
        expect(existsSync(join(dir, "argv.bin"))).toBe(false);
        expect(await readLast()).toMatchObject({ ok: false, exitCode: null, outputTail: why });
      }, TEST_TIMEOUT);

      it("a missing workdir or one another uid owns: refused", async () => {
        const port = await startNotifyServer();
        await writeCaptureStub();
        await writeJob({ workdir: join(dir, "none") });
        expect((await runRunner("j1", port, HARDENED)).stderr).toMatch(/^\[cron-runner\] j1 refused: job cwd ".*none" is not a directory the console can use \(ENOENT\)\n$/);
        await writeJob({ workdir: "/" });
        expect((await runRunner("j1", port, HARDENED)).stderr).toMatch(/^\[cron-runner\] j1 refused: job cwd "\/" is owned by uid \d+, not the console\n$/);
        expect(existsSync(join(dir, "argv.bin"))).toBe(false);
      }, TEST_TIMEOUT);

      it("not hardened: a group-writable workdir runs as today", async () => {
        const port = await startNotifyServer();
        const wd = join(dir, "shared");
        await mkdir(wd);
        await chmod(wd, 0o2775);
        await writeJob({ workdir: wd });
        await writeCaptureStub();
        const r = await runRunner("j1", port, { ...HARDENED, CHIEF_AGENT_UID: "" });
        expect(r.stderr).toBe("");
        expect(existsSync(join(dir, "argv.bin"))).toBe(true);
      }, TEST_TIMEOUT);
    });

    it("flag on but not hardened (no uid, uid 0, misconfigured): no hardening args", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeCaptureStub();
      for (const env of [
        { ...HARDENED, CHIEF_AGENT_UID: "" }, { ...HARDENED, CHIEF_AGENT_UID: "0" }, { ...HARDENED, CHIEF_CONSOLE_URL: "" },
      ]) {
        await runRunner("j1", port, env);
        expect(await argv()).toEqual(["-p", PROMPT, "--dangerously-skip-permissions", "--append-system-prompt", NO_MERGE_RULE]);
      }
    }, TEST_TIMEOUT);

    it("hardened with AGENT_ENV_PASS set: the refusal still reads the console env", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeCaptureStub();
      const d = join(dir, "claude-cfg-pass");
      await mkdir(d, { recursive: true });
      await chmod(d, 0o770);
      const r = await runRunner("j1", port, { ...HARDENED, CLAUDE_CONFIG_DIR: d, AGENT_ENV_PASS: "" });
      expect(r.stderr).toContain("refused: claude config");
      expect(existsSync(join(dir, "argv.bin"))).toBe(false);
    }, TEST_TIMEOUT);

    it("flag off: argv and env are unchanged", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeCaptureStub();
      await runRunner("j1", port, { CHIEF_ENABLED: "0" });
      expect(await argv()).toEqual(["-p", PROMPT, "--dangerously-skip-permissions"]);
      // A uid alone (flag off) is not a hardened deployment either.
      await runRunner("j1", port, { CHIEF_AGENT_UID: "1001" });
      expect(await argv()).toEqual(["-p", PROMPT, "--dangerously-skip-permissions"]);
      expect((await envLines()).some((l) => l.startsWith("CHOIBOT_AGENT_ID"))).toBe(false);
    }, TEST_TIMEOUT);
  });

  // Strong protection with the agents' login (pick A): the task is agent work; it runs as the
  // agents' account through sudo and the helper (claude-task). Here a fake sudo stands in: it
  // keeps its argv and env, then runs the stub claude with the args after "--", in the cwd.
  describe("strong protection with the agents' login", () => {
    const STRONG = {
      CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "4242",
      AGENT_CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude", AGENT_EXEC_HELPER: "/usr/local/bin/choibot-agent-exec",
    };
    async function writeFakeSudo(): Promise<string> {
      const sudo = join(binDir, "sudo");
      await writeFile(sudo, `#!/bin/bash
printf '%s\\0' "$@" > "${dir}/sudo-argv.bin"
env | sort > "${dir}/sudo-env.txt"
while [ "$1" != "--" ]; do shift; done
shift
exec "${binDir}/claude" "$@"
`, { mode: 0o755 });
      return sudo;
    }
    const sudoArgv = async () => (await readFile(join(dir, "sudo-argv.bin"), "utf8")).split("\0").slice(0, -1);
    const sudoEnv = async () => Object.fromEntries((await readFile(join(dir, "sudo-env.txt"), "utf8")).split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

    it("the task runs through sudo and the helper as the agents' account: the argv, only the keep list in the env, the agents' Claude folder; the run is kept", async () => {
      const port = await startNotifyServer();
      await writeJob({ model: "sonnet", effort: "high" });
      await writeStub(0, "done as the agent");
      const sudo = await writeFakeSudo();
      const r = await runRunner("j1", port, { ...STRONG, AGENT_SUDO_BIN: sudo, TELEGRAM_BOT_TOKEN: "t", CONSOLE_COOKIE_SECRET: "c", CHOIBOT_USER_TOKEN: "u", LANG: "C.UTF-8" });
      expect(r.code).toBe(0);
      const a = await sudoArgv();
      expect(a.slice(0, 8)).toEqual(["-n", "-u", "#4242", "/usr/local/bin/choibot-agent-exec", "claude-task", dir, "1", "--"]);
      expect(a.some((x) => x.startsWith("--preserve-env"))).toBe(false);
      const claude = a.slice(8);
      expect(claude.slice(0, 7)).toEqual(["-p", PROMPT, "--dangerously-skip-permissions", "--model", "sonnet", "--effort", "high"]);
      expect(claude[7]).toBe("--append-system-prompt");
      expect(claude.slice(-3)).toEqual(["--setting-sources", "user", "--strict-mcp-config"]);
      const env = await sudoEnv();
      for (const k of Object.keys(env)) expect([k, STRONG_ENV_KEEP.includes(k) || k === "PWD" || k === "SHLVL" || k === "_"]).toEqual([k, true]);
      expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: "/home/choibot-agent/.claude", CHOIBOT_AGENT_ID: "cron:j1", CRON_DATA_DIR: dir, LANG: "C.UTF-8", PORT: String(port) });
      expect(await readLast()).toMatchObject({ ok: true, exitCode: 0 });
      expect((await readLast())!.outputTail).toContain("done as the agent");
    }, TEST_TIMEOUT);

    it("the checks of a console-uid run do not apply (the console's own folder is not used); a named login of the spec is not used, with one note", async () => {
      const port = await startNotifyServer();
      await writeJob({ account: "work" });
      await writeStub(0);
      const sudo = await writeFakeSudo();
      const own = join(dir, "console-claude");
      await mkdir(own);
      await chmod(own, 0o770);
      const r = await runRunner("j1", port, { ...STRONG, AGENT_SUDO_BIN: sudo, CLAUDE_CONFIG_DIR: own });
      expect(r.stderr).toBe(`[cron-runner] j1: the login "work" is not used in strong protection; the task runs on the agents' login\n`);
      expect(await readLast()).toMatchObject({ ok: true });
      expect((await sudoEnv()).CLAUDE_CONFIG_DIR).toBe("/home/choibot-agent/.claude");
    }, TEST_TIMEOUT);

    it("the console's pick, its sign-out marks and the sign-out words change nothing", async () => {
      const port = await startNotifyServer();
      await writeJob({ account: "work" });
      await writeStub(1, "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.");
      const sudo = await writeFakeSudo();
      const accounts = join(dir, "accounts");
      for (const id of ["work", "alt"]) await mkdir(join(accounts, id), { recursive: true });
      const extra = { ...STRONG, AGENT_SUDO_BIN: sudo, CLAUDE_ACCOUNTS_DIR: accounts, CLAUDE_DEFAULT_ACCOUNT: "work" };
      const data = join(dir, "data", resolveNames(legacyMarkers(runnerEnv(port, extra))).dataDir);
      await mkdir(data, { recursive: true });
      await writeFile(join(data, "default-login.json"), JSON.stringify({ id: "alt" }));
      await writeFile(join(data, "logins-signed-out.json"), JSON.stringify({ work: Date.now() + 3_600_000 }));
      await runRunner("j1", port, extra);
      expect((await sudoEnv()).CLAUDE_CONFIG_DIR).toBe("/home/choibot-agent/.claude");
      expect(await readLast()).toMatchObject({ ok: false, exitCode: 1, why: "exit" });
    }, TEST_TIMEOUT);

    it("no agents' Claude folder: the run is as before (no sudo)", async () => {
      const port = await startNotifyServer();
      await writeJob();
      await writeStub(0);
      const sudo = await writeFakeSudo();
      const { AGENT_CLAUDE_CONFIG_DIR: _drop, ...hardenedOnly } = STRONG;
      await runRunner("j1", port, { ...hardenedOnly, AGENT_SUDO_BIN: sudo });
      expect(existsSync(join(dir, "sudo-argv.bin"))).toBe(false);
    }, TEST_TIMEOUT);

    it("the helper refuses (a cwd outside its roots): the run fails with the helper's line", async () => {
      const port = await startNotifyServer();
      await writeJob();
      const sudo = join(binDir, "sudo");
      await writeFile(sudo, "#!/bin/bash\necho 'choibot-agent-exec: cwd outside WORKTREE_ROOT, WORKSPACE_DIR and AGENT_HOME_ROOT: /x' >&2\nexit 2\n", { mode: 0o755 });
      await runRunner("j1", port, { ...STRONG, AGENT_SUDO_BIN: sudo });
      expect(await readLast()).toMatchObject({ ok: false, exitCode: 2, why: "exit" });
      expect((await readLast())!.outputTail).toContain("cwd outside WORKTREE_ROOT");
    }, TEST_TIMEOUT);
  });
});
