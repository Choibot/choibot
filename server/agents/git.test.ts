// server/agents/git.test.ts — console git hardening (Task 2c-6; plan Global
// Constraints, Review Focus 4 and 5; overview decisions 36 and 44). Every git
// here runs in a mkdtemp repo with a minimal env, never in the live checkout.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hardenedDeployment } from "../chief/hardened.js";
import { registerFilesApi, type FilesGuard } from "../files/api.js";
import { gh } from "../gh/exec.js";
import { checkRepoProtection, gitArgs, gitEnv, gitHardened, gitOpts, mainRepoOf, resetCredentialHelpers, runGit, type GitExecOpts } from "./git.js";
import { commitPending } from "./reconcile.js";
import { listBranches } from "./repos.js";
import type { AgentRecord } from "./store.js";
import { workspaceChangedFiles, workspaceDiff } from "./workspace.js";
import { createWorktree, worktreeDiff } from "./worktree.js";

const run = promisify(execFile);
type Env = Record<string, string | undefined>;

const ACTIVE: Env = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };
const HARD: Env = { ...ACTIVE, CHIEF_AGENT_UID: "1001" };
// Not hardened: flag off, the chief on without CHIEF_AGENT_UID (rollback), an
// invalid uid, a uid with the flag off.
const NOT_HARD: [string, Env][] = [
  ["flag off", {}],
  ["no CHIEF_AGENT_UID", ACTIVE],
  ["invalid uid", { ...ACTIVE, CHIEF_AGENT_UID: "0" }],
  ["uid, flag off", { CHIEF_AGENT_UID: "1001" }],
];
// next/types makes NODE_ENV required on ProcessEnv; these envs are plain maps.
const pe = (o: Env): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;
const stubHard = () => { for (const [k, v] of Object.entries(HARD)) vi.stubEnv(k, v!); };

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

let base: string;
let repo: string;
// The child env of every git run here: no inherited GIT_*; HOME is <base>,
// so the global config is <base>/.gitconfig (none unless a test writes it).
let childEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "chief-git-")));
  repo = join(base, "r");
  // The console's own global config, as gitEnv reads it: <base>/.gitconfig,
  // never the real ~/.gitconfig. Each test starts with an empty cache.
  vi.stubEnv("HOME", base);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(base, ".gitconfig"));
  resetCredentialHelpers();
  childEnv = pe({
    PATH: process.env.PATH, HOME: base, GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  });
  await plain(["init", "-q", "-b", "main", repo], {}, false);
  await writeFile(join(repo, "f.txt"), "a\n");
  await plain(["add", "f.txt"]);
  await plain(["commit", "-q", "-m", "init"]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  resetCredentialHelpers();
  await rm(base, { recursive: true, force: true });
});

// git in the temp repo without the helpers (the control: what today's code does).
function plain(args: string[], extra: Env = {}, inRepo = true) {
  return run("git", inRepo ? ["-C", repo, ...args] : args, { env: { ...childEnv, ...extra } });
}
// git in the temp repo as a console call, through gitArgs and gitEnv.
function consoleGit(deploy: Env, args: string[], extra: Env = {}) {
  return run("git", gitArgs(repo, ["-C", repo, ...args], deploy), { env: gitEnv(repo, { ...childEnv, ...extra }, deploy) });
}
// A script that touches <base>/<name>.ran when run, then runs body (default:
// print its first arg when that is a file, as a textconv does).
async function marker(name: string, body = '[ -f "$1" ] && cat "$1"'): Promise<{ script: string; ran: () => boolean; reset: () => Promise<void> }> {
  const script = join(base, `${name}.sh`);
  const mark = join(base, `${name}.ran`);
  await writeFile(script, `#!/bin/sh\ntouch '${mark}'\n${body}\nexit 0\n`);
  await chmod(script, 0o755);
  return { script, ran: () => existsSync(mark), reset: () => rm(mark, { force: true }) };
}
async function hook(name: string): Promise<() => boolean> {
  const m = await marker(name);
  await writeFile(join(repo, ".git", "hooks", name), `#!/bin/sh\nexec '${m.script}'\n`);
  await chmod(join(repo, ".git", "hooks", name), 0o755);
  return m.ran;
}

describe("gitHardened (ruling P4)", () => {
  it("is the phase predicate hardenedDeployment", () => {
    expect(gitHardened).toBe(hardenedDeployment);
    expect(gitHardened(HARD)).toBe(true);
    for (const [name, env] of NOT_HARD) expect(gitHardened(env), name).toBe(false);
    expect(gitHardened()).toBe(false); // CHIEF_* scrubbed by vitest.setup.ts
  });
});

describe("gitArgs: no drivers on diff, show and a patch-producing log; no submodule git on status, diff, fetch, pull, push, checkout", () => {
  const F = ["--no-textconv", "--no-ext-diff"];
  const D = [...F, "--ignore-submodules=all"]; // diff
  const NR = "--no-recurse-submodules";
  const table: [string[], string[]][] = [
    [["-C", "/r", "diff", "abc"], ["-C", "/r", "diff", ...D, "abc"]],
    [["-C", "/r", "diff", "--cached", "--name-only"], ["-C", "/r", "diff", ...D, "--cached", "--name-only"]],
    [["-C", "/r", "diff", "--no-color", "-U1000000", "a", "b", "--", "p"], ["-C", "/r", "diff", ...D, "--no-color", "-U1000000", "a", "b", "--", "p"]],
    [["diff"], ["diff", ...D]],
    [["-C", "/r", "show", "abc:path"], ["-C", "/r", "show", ...F, "abc:path"]],
    [["-c", "core.quotepath=off", "--no-pager", "diff", "x"], ["-c", "core.quotepath=off", "--no-pager", "diff", ...D, "x"]],
    // Fix round 2, item 1: a gitlink's nested repo is never asked (a child git there skips the ownership check).
    [["-C", "/r", "status", "--porcelain"], ["-C", "/r", "status", "--ignore-submodules=all", "--porcelain"]],
    [["-C", "/r", "fetch", "--all", "--prune"], ["-C", "/r", "fetch", NR, "--all", "--prune"]],
    [["-C", "/r", "fetch", "--no-tags", "--quiet", "origin", "pull/1/head"], ["-C", "/r", "fetch", NR, "--no-tags", "--quiet", "origin", "pull/1/head"]],
    [["-C", "/r", "pull", "--ff-only"], ["-C", "/r", "pull", NR, "--ff-only"]],
    [["-C", "/r", "push", "-u", "origin", "b"], ["-C", "/r", "push", NR, "-u", "origin", "b"]],
    [["-C", "/r", "checkout", "main"], ["-C", "/r", "checkout", "-q", "main"]],
    [["-C", "/r", "checkout", "main", "--", "diff"], ["-C", "/r", "checkout", "-q", "main", "--", "diff"]],
    [["--git-dir=/r/.git", "--work-tree", "/r", "show"], ["--git-dir=/r/.git", "--work-tree", "/r", "show", ...F]],
    ...["-p", "-u", "--patch", "-U3", "--unified=5", "--stat", "--numstat", "--shortstat", "--patch-with-stat", "--word-diff", "--color-words", "--cc", "-c", "--remerge-diff", "-Sneedle", "-Gre", "-L1,2:f", "--check"]
      .map((flag): [string[], string[]] => [["-C", "/r", "log", "a..b", flag], ["-C", "/r", "log", ...F, "a..b", flag]]),
    // Not a patch: log without a patch flag, a "-p" path after --, other subcommands.
    [["-C", "/r", "log", "a..b", "--reverse", "--format=%B"], ["-C", "/r", "log", "a..b", "--reverse", "--format=%B"]],
    [["-C", "/r", "log", "--format=%H", "--", "-p"], ["-C", "/r", "log", "--format=%H", "--", "-p"]],
    [["-c", "core.quotepath=off", "ls-files", "--cached"], ["-c", "core.quotepath=off", "ls-files", "--cached"]],
    [["grep", "-n", "-e", "diff"], ["grep", "-n", "-e", "diff"]],
    [["-C", "/r", "stash", "list", "--format=%gd%x09%gs"], ["-C", "/r", "stash", "list", "--format=%gd%x09%gs"]],
    [["-C", "/r", "merge-base", "--is-ancestor", "a", "b"], ["-C", "/r", "merge-base", "--is-ancestor", "a", "b"]],
    [["-C", "/r", "add", "-A"], ["-C", "/r", "add", "-A"]],
    [["clone", "--", "https://h/x.git", "/w/x"], ["clone", "--", "https://h/x.git", "/w/x"]],
    [["init", "/a/show"], ["init", "/a/show"]],
  ];

  it("hardened: the insertion table", () => {
    for (const [args, want] of table) expect(gitArgs("/r", args, HARD), args.join(" ")).toEqual(want);
  });

  it("hardened: the caller's array is not changed", () => {
    const args = ["-C", "/r", "diff", "abc"];
    gitArgs("/r", args, HARD);
    expect(args).toEqual(["-C", "/r", "diff", "abc"]);
  });

  it("not hardened (Review Focus 4): the same array, for every row", () => {
    for (const [name, env] of NOT_HARD) {
      for (const [args] of table) expect(gitArgs("/r", args, env), name).toBe(args);
    }
    const args = ["-C", "/r", "diff", "abc"];
    expect(gitArgs("/r", args)).toBe(args); // process.env: CHIEF_* scrubbed
  });
});

describe("gitEnv", () => {
  it("hardened: the Global Constraints keys but safe.directory (ruling 2c-6-a), GIT_CONFIG_NOSYSTEM=1", () => {
    const env = pe({ PATH: "/usr/bin", HOME: "/h", KEEP: "x" });
    const out = gitEnv("/w/repo", env, HARD);
    expect(out).toEqual({
      PATH: "/usr/bin", HOME: "/h", KEEP: "x",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "13",
      GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "core.sshCommand", GIT_CONFIG_VALUE_2: "ssh",
      GIT_CONFIG_KEY_3: "credential.helper", GIT_CONFIG_VALUE_3: "",
      GIT_CONFIG_KEY_4: "diff.external", GIT_CONFIG_VALUE_4: "",
      GIT_CONFIG_KEY_5: "commit.gpgSign", GIT_CONFIG_VALUE_5: "false",
      GIT_CONFIG_KEY_6: "tag.gpgSign", GIT_CONFIG_VALUE_6: "false",
      // Fix round 2, item 1: the second layer, for the git gh runs (no gitArgs there).
      GIT_CONFIG_KEY_7: "diff.ignoreSubmodules", GIT_CONFIG_VALUE_7: "all",
      GIT_CONFIG_KEY_8: "fetch.recurseSubmodules", GIT_CONFIG_VALUE_8: "false",
      GIT_CONFIG_KEY_9: "submodule.recurse", GIT_CONFIG_VALUE_9: "false",
      GIT_CONFIG_KEY_10: "push.recurseSubmodules", GIT_CONFIG_VALUE_10: "no",
      // Ruling H1-a: no console auto-gc (it writes objects/info/commit-graph by path).
      GIT_CONFIG_KEY_11: "gc.auto", GIT_CONFIG_VALUE_11: "0",
      GIT_CONFIG_KEY_12: "maintenance.auto", GIT_CONFIG_VALUE_12: "false",
      // Checklist hold item 1: no agent-chosen ref name in a console reflog line.
      GIT_REFLOG_ACTION: "choibot",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", KEEP: "x" }); // a copy
  });

  it("hardened: inherited GIT_CONFIG_COUNT/KEY_n/VALUE_n and GIT_REFLOG_ACTION are replaced, not added to", () => {
    const env = pe({
      PATH: "/usr/bin", GIT_CONFIG_COUNT: "14", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/evil",
      GIT_CONFIG_KEY_13: "core.fsmonitor", GIT_CONFIG_VALUE_13: "/evil", GIT_CONFIG_NOSYSTEM: "0",
      GIT_REFLOG_ACTION: "merge x$(touch${IFS}pwned)",
    });
    const out = gitEnv("/w/repo", env, HARD);
    expect(out.GIT_REFLOG_ACTION).toBe("choibot");
    expect(out.GIT_CONFIG_COUNT).toBe("13");
    expect(out.GIT_CONFIG_VALUE_0).toBe("/dev/null");
    expect(out.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(Object.keys(out).filter((k) => k.startsWith("GIT_CONFIG_KEY_")).sort()).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => `GIT_CONFIG_KEY_${i}`).sort());
    expect(out).not.toHaveProperty("GIT_CONFIG_VALUE_13");
  });

  it("hardened: the deployment, not the child env, decides (an allowlisted child env)", () => {
    stubHard();
    const allow = pe({ PATH: "/usr/bin" });
    expect(gitEnv("/w/repo", allow)).toMatchObject({ PATH: "/usr/bin", GIT_CONFIG_COUNT: "13", GIT_CONFIG_VALUE_0: "/dev/null" });
  });

  it("hardened, with the main repo (ruling 2c-6-d): GIT_COMMON_DIR = <realpath(main)>/.git; without it, none", async () => {
    const link = join(base, "link");
    await symlink(repo, link);
    expect(gitEnv(join(link, "sub"), childEnv, HARD, link).GIT_COMMON_DIR).toBe(join(repo, ".git"));
    expect(gitEnv(repo, childEnv, HARD)).not.toHaveProperty("GIT_COMMON_DIR");
    expect(gitEnv(repo, childEnv, HARD, "")).not.toHaveProperty("GIT_COMMON_DIR");
    for (const [name, deploy] of NOT_HARD) expect(gitEnv(repo, childEnv, deploy, repo), name).toBe(childEnv);
    expect(gitOpts(repo, { timeout: 1 } as GitExecOpts, HARD, repo).env!.GIT_COMMON_DIR).toBe(join(repo, ".git"));
  });

  it("not hardened (Review Focus 4): the same object", () => {
    const env = pe({ PATH: "/usr/bin", GIT_CONFIG_COUNT: "1" });
    for (const [name, deploy] of NOT_HARD) expect(gitEnv("/w/repo", env, deploy), name).toBe(env);
    expect(gitEnv("/w/repo")).toBe(process.env);
    // No reflog action of its own: absent stays absent, an inherited one is kept.
    const own = pe({ PATH: "/usr/bin", GIT_REFLOG_ACTION: "mine" });
    for (const [name, deploy] of NOT_HARD) {
      expect(gitEnv("/w/repo", env, deploy), name).not.toHaveProperty("GIT_REFLOG_ACTION");
      expect(gitEnv("/w/repo", own, deploy).GIT_REFLOG_ACTION, name).toBe("mine");
    }
  });
});

describe("gitOpts", () => {
  it("not hardened: the same options object", () => {
    const o = { cwd: "/w/repo", maxBuffer: 1 };
    for (const [name, deploy] of NOT_HARD) expect(gitOpts("/w/repo", o, deploy), name).toBe(o);
    expect(gitOpts("/w/repo", o)).toBe(o);
  });

  it("hardened: a copy with env = gitEnv over the given env, else process.env", () => {
    const o = { cwd: "/w/repo", maxBuffer: 1 };
    expect(gitOpts("/w/repo", o, HARD)).toEqual({ ...o, env: gitEnv("/w/repo", process.env, HARD) });
    const own = { timeout: 5, env: pe({ PATH: "/bin" }) };
    expect(gitOpts("/w/repo", own, HARD)).toEqual({ timeout: 5, env: gitEnv("/w/repo", own.env, HARD) });
    expect(o).toEqual({ cwd: "/w/repo", maxBuffer: 1 });
  });
});

describe("Review Focus 5: hardened, repo config and hooks run no code as the console uid", () => {
  it("core.fsmonitor: git status leaves no marker", async () => {
    const m = await marker("fsmonitor");
    await plain(["config", "core.fsmonitor", m.script]);
    await plain(["status", "--porcelain"]);
    expect(m.ran()).toBe(true); // the control: today's git runs it
    await m.reset();
    await writeFile(join(repo, "f.txt"), "a\nb\n");
    const { stdout } = await consoleGit(HARD, ["status", "--porcelain"]);
    expect(stdout).toBe(" M f.txt\n");
    expect(m.ran()).toBe(false);
  });

  it("a post-checkout hook does not run on a checkout", async () => {
    const ran = await hook("post-checkout");
    await consoleGit(HARD, ["checkout", "-q", "-b", "side"]);
    expect(ran()).toBe(false);
    expect((await consoleGit(HARD, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("side");
    await plain(["checkout", "-q", "main"]);
    expect(ran()).toBe(true); // the control
  });

  it("a diff.<x>.textconv set via .gitattributes + repo config does not run on diff", async () => {
    const m = await marker("textconv");
    await plain(["config", "diff.x.textconv", m.script]);
    await writeFile(join(repo, ".gitattributes"), "f.txt diff=x\n");
    await writeFile(join(repo, "f.txt"), "a\nb\n");
    await plain(["diff"]);
    expect(m.ran()).toBe(true); // the control
    await m.reset();
    const { stdout } = await consoleGit(HARD, ["diff"]);
    expect(stdout).toContain("+b");
    expect(m.ran()).toBe(false);
    await consoleGit(HARD, ["log", "-p", "-1"]);
    await consoleGit(HARD, ["show", "HEAD"]);
    expect(m.ran()).toBe(false);
  });

  it("an external diff (diff.external, a diff.<x>.command driver) does not run on diff", async () => {
    const ext = await marker("external");
    const drv = await marker("driver");
    await plain(["config", "diff.external", ext.script]);
    await plain(["config", "diff.y.command", drv.script]);
    await writeFile(join(repo, ".gitattributes"), "g.txt diff=y\n");
    await writeFile(join(repo, "g.txt"), "g\n");
    await plain(["add", "g.txt"]);
    await plain(["commit", "-q", "-m", "g"]);
    await writeFile(join(repo, "f.txt"), "a\nb\n");
    await writeFile(join(repo, "g.txt"), "g\nh\n");
    const { stdout } = await consoleGit(HARD, ["diff"]);
    expect(stdout).toContain("+b");
    expect(stdout).toContain("+h");
    expect(ext.ran()).toBe(false);
    expect(drv.ran()).toBe(false);
    await plain(["diff"]);
    expect(ext.ran() || drv.ran()).toBe(true); // the control
  });

  it("credential.helper from the repo config is reset", async () => {
    const m = await marker("credential", "echo username=u; echo password=p");
    await plain(["config", "credential.helper", m.script]);
    const fill = (env: NodeJS.ProcessEnv) => new Promise<number>((ok) => {
      const c = execFile("git", ["-C", repo, "credential", "fill"], { env }, (e) => ok(e ? Number((e as { code?: number }).code) : 0));
      c.stdin!.end("protocol=https\nhost=example.com\n\n");
    });
    expect(await fill(gitEnv(repo, childEnv, HARD))).not.toBe(0); // no helper, no prompt
    expect(m.ran()).toBe(false);
    expect(await fill(childEnv)).toBe(0); // the control: the repo's helper answers
    expect(m.ran()).toBe(true);
  });

  it("the console user's global credential helpers come back after the reset (ruling 2c-6-b); the repo's never run", async () => {
    const global = await marker("global-cred", "echo username=g; echo password=gp");
    const local = await marker("repo-cred", "echo username=r; echo password=rp");
    await writeFile(join(base, ".gitconfig"), `[credential "https://example.com"]\n\thelper =\n\thelper = ${global.script}\n`);
    await plain(["config", "credential.helper", local.script]);
    const env = gitEnv(repo, childEnv, HARD);
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "15",
      GIT_CONFIG_KEY_3: "credential.helper", GIT_CONFIG_VALUE_3: "",
      GIT_CONFIG_KEY_13: "credential.https://example.com.helper", GIT_CONFIG_VALUE_13: "",
      GIT_CONFIG_KEY_14: "credential.https://example.com.helper", GIT_CONFIG_VALUE_14: global.script,
    });
    // The command scope: the reset, then the global entries in order.
    const { stdout } = await run("git", ["-C", repo, "config", "--show-scope", "--get-regexp", "^credential\\..*helper$"], { env });
    expect(stdout.split("\n").filter((l) => l.startsWith("command"))).toEqual([
      "command\tcredential.helper ",
      "command\tcredential.https://example.com.helper ",
      `command\tcredential.https://example.com.helper ${global.script}`,
    ]);
    const fill = (host: string, e: NodeJS.ProcessEnv) => new Promise<{ code: number; out: string }>((ok) => {
      const c = execFile("git", ["-C", repo, "credential", "fill"], { env: e }, (err, out) =>
        ok({ code: err ? Number((err as { code?: number }).code) : 0, out: String(out) }));
      c.stdin!.end(`protocol=https\nhost=${host}\n\n`);
    });
    expect(await fill("example.com", env)).toMatchObject({ code: 0, out: expect.stringContaining("username=g") });
    expect(global.ran()).toBe(true);
    expect((await fill("other.org", env)).code).not.toBe(0); // no global helper for it; the repo's stays dropped
    expect(local.ran()).toBe(false);
    expect((await fill("other.org", childEnv)).out).toContain("username=r"); // the control
    expect(local.ran()).toBe(true);
  });

  it("the global helpers: read once, on the first hardened gitEnv; never when not hardened", async () => {
    const cfg = (helper: string) => writeFile(join(base, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`);
    await cfg("first");
    for (const [, deploy] of NOT_HARD) gitEnv(repo, childEnv, deploy);
    gitOpts(repo, {});
    await runGit(repo, ["-C", repo, "status"]);
    await cfg("second");
    expect(gitEnv(repo, childEnv, HARD)).toMatchObject({ GIT_CONFIG_COUNT: "14", GIT_CONFIG_KEY_13: "credential.helper", GIT_CONFIG_VALUE_13: "second" });
    await cfg("third");
    expect(gitEnv(repo, childEnv, HARD).GIT_CONFIG_VALUE_13).toBe("second"); // cached for the process
  });

  it("the global helpers: include.path is followed (--includes); a failed read is cached too", async () => {
    await writeFile(join(base, "inc"), "[credential]\n\thelper = included\n");
    await writeFile(join(base, ".gitconfig"), `[include]\n\tpath = ${join(base, "inc")}\n`);
    expect(gitEnv(repo, childEnv, HARD)).toMatchObject({ GIT_CONFIG_COUNT: "14", GIT_CONFIG_VALUE_13: "included" });
    resetCredentialHelpers();
    vi.stubEnv("GIT_CONFIG_GLOBAL", base); // a directory: git config fails (not "no entry")
    expect(gitEnv(repo, childEnv, HARD).GIT_CONFIG_COUNT).toBe("13");
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(base, ".gitconfig"));
    expect(gitEnv(repo, childEnv, HARD).GIT_CONFIG_COUNT).toBe("13"); // no second read
  });

  it("no safe.directory (ruling 2c-6-a): a repo git takes as not the console's (GIT_TEST_ASSUME_DIFFERENT_OWNER=1) is refused", async () => {
    const env = gitEnv(repo, childEnv, HARD);
    expect(Object.entries(env).filter(([k, v]) => k.startsWith("GIT_CONFIG_KEY_") && v === "safe.directory")).toEqual([]);
    await expect(consoleGit(HARD, ["status", "--porcelain"], { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" })).rejects.toThrow(/dubious ownership/);
    await expect(plain(["status", "--porcelain"], { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" })).rejects.toThrow(/dubious ownership/);
    await expect(consoleGit(HARD, ["status", "--porcelain"])).resolves.toMatchObject({ stdout: "" }); // the console's own repo
  });

  it("an agent-owned repo or gitdir: its filter.<x>.clean does not run (git refuses first)", async () => {
    const m = await marker("clean", "cat");
    await plain(["config", "filter.x.clean", m.script]);
    await writeFile(join(repo, ".gitattributes"), "* filter=x\n");
    await writeFile(join(repo, "f.txt"), "a\nb\n");
    await plain(["diff", "--name-only", "HEAD"]);
    expect(m.ran()).toBe(true); // the control: git hashes the changed file through the filter
    await m.reset();
    const other = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
    // diff sets the repo up "gently": it says "Not a git repository" for one it refuses.
    for (const args of [["diff", "--name-only", "HEAD"], ["status", "--porcelain"], ["add", "-A"]]) {
      await expect(consoleGit(HARD, args, other), args.join(" ")).rejects.toThrow(/dubious ownership|Not a git repository/);
    }
    expect(m.ran()).toBe(false);
  });
});

// Fix round 2, item 1: git asks a gitlink's nested repo with a child git run
// under an explicit GIT_DIR, which skips the ownership check, so an
// agent-made nested repo's own config would run as the console uid.
describe("hardened: no git runs in a gitlink's nested repo (fix round 2, item 1)", () => {
  const g = (args: string[], cwd = repo) => run("git", ["-C", cwd, ...args], { env: childEnv });
  // Same size, a new mtime: git must hash the file (through any clean filter) to compare.
  const statDirty = async (f: string, content: string) => {
    await writeFile(f, content);
    const t = new Date(Date.now() + 5000);
    await utimes(f, t, t);
  };
  // A tracked gitlink `sub` in `dir`: an agent-made nested repo whose own
  // config has a clean filter (the marker), made stat-dirty. ignoreNone: a
  // .gitmodules that says ignore=none, which beats a diff.ignoreSubmodules key.
  async function gitlink(dir: string, script: string, ignoreNone = true): Promise<void> {
    const sub = join(dir, "sub");
    await g(["init", "-q", "-b", "main", sub], dir);
    await writeFile(join(sub, "s.txt"), "s\n");
    await g(["add", "s.txt"], sub);
    await g(["commit", "-q", "-m", "s"], sub);
    if (ignoreNone) await writeFile(join(dir, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n');
    await g(["add", "-A"], dir);
    await g(["commit", "-q", "-m", "gitlink"], dir);
    await g(["config", "filter.x.clean", script], sub);
    await writeFile(join(sub, ".gitattributes"), "* filter=x\n");
    await statDirty(join(sub, "s.txt"), "t\n");
  }
  const indexBytes = async () => readFile(join(repo, ".git", "index"));

  it("status, diff and checkout through gitArgs/gitEnv leave the nested repo alone (control: today's git runs its filter)", async () => {
    const m = await marker("subfilter", "cat");
    await gitlink(repo, m.script);
    await g(["branch", "side"]);
    await plain(["status", "--porcelain"]);
    expect(m.ran()).toBe(true); // the control
    await m.reset();
    for (const args of [["status", "--porcelain"], ["status", "--porcelain", "--untracked-files=all"], ["diff", "--name-only", "HEAD"],
      ["diff", "--name-status", "HEAD~1"], ["diff", "HEAD~1"], ["diff", "--cached", "--name-only"], ["checkout", "side"], ["checkout", "main"]]) {
      await consoleGit(HARD, args);
      expect(m.ran(), args.join(" ")).toBe(false);
    }
    await plain(["checkout", "side"]);
    expect(m.ran()).toBe(true); // the control: checkout reports local changes through the nested repo
  });

  it("the env alone (the git gh runs): diff.ignoreSubmodules=all keeps status out of the nested repo", async () => {
    const m = await marker("subfilter", "cat");
    await gitlink(repo, m.script, false);
    await run("git", ["-C", repo, "status", "--porcelain"], { env: gitEnv(repo, childEnv, HARD, repo) });
    expect(m.ran()).toBe(false);
    await plain(["status", "--porcelain"]);
    expect(m.ran()).toBe(true); // the control
  });

  it("commitPending: add -A leaves every gitlink out, on a private index; the edits are committed and the index synced", async () => {
    const m = await marker("subfilter", "cat");
    await gitlink(repo, m.script);
    await writeFile(join(repo, "f.txt"), "a\nb\n");
    await writeFile(join(repo, "new.txt"), "n\n");
    stubHard();
    const rec = { worktree: repo, repo, branch: "main", baseBranch: "main" } as AgentRecord;
    expect(await commitPending(rec)).toEqual({ ok: true });
    expect(m.ran()).toBe(false);
    expect((await plain(["show", "--name-only", "--format=", "HEAD"])).stdout.split("\n").filter(Boolean).sort()).toEqual(["f.txt", "new.txt"]);
    expect((await plain(["diff", "--cached", "--name-only", "--ignore-submodules=all"])).stdout).toBe(""); // the real index is HEAD
    vi.unstubAllEnvs();
    await statDirty(join(repo, "sub", "s.txt"), "u\n");
    await writeFile(join(repo, "f.txt"), "a\nb\nc\n");
    expect(await commitPending(rec)).toEqual({ ok: true }); // not hardened: today's add -A
    expect(m.ran()).toBe(true); // the control
  });

  it("worktreeDiff and workspaceDiff stage on a private index: no nested repo git, the worktree's index untouched", async () => {
    const m = await marker("subfilter", "cat");
    await gitlink(repo, m.script);
    await writeFile(join(repo, "f.txt"), "a\nb\n");
    await writeFile(join(repo, "new.txt"), "n\n");
    const before = await indexBytes();
    stubHard();
    const d = await worktreeDiff(repo, "main", repo);
    expect(d).toContain("+b");
    expect(d).toContain("new.txt");
    const w = await workspaceDiff(base);
    expect(w).toContain("b/r/new.txt");
    expect(m.ran()).toBe(false);
    expect((await indexBytes()).equals(before)).toBe(true);
    vi.unstubAllEnvs();
    await worktreeDiff(repo, "main");
    expect(m.ran()).toBe(true); // the control: today's add -N / diff
  });

  it("fetch (repos.ts) does not recurse into a submodule whose own config runs ext:: (control: today's fetch does)", async () => {
    const m = await marker("ext");
    const s = join(base, "s");
    const o = join(base, "o");
    const l = join(base, "l");
    const file = ["-c", "protocol.file.allow=always"];
    await g(["init", "-q", "-b", "main", s], base);
    await writeFile(join(s, "f"), "1\n");
    await g(["add", "f"], s);
    await g(["commit", "-q", "-m", "1"], s);
    await g(["init", "-q", "-b", "main", o], base);
    await writeFile(join(o, "a"), "a\n");
    await g(["add", "a"], o);
    await g(["commit", "-q", "-m", "a"], o);
    await run("git", ["-C", o, ...file, "submodule", "add", "-q", s, "sub"], { env: childEnv });
    await g(["commit", "-q", "-m", "sub"], o);
    await g(["clone", "-q", o, l], base);
    await run("git", ["-C", l, ...file, "submodule", "update", "-q", "--init"], { env: childEnv });
    const bump = async (n: string) => {
      await writeFile(join(s, "f"), `${n}\n`);
      await g(["commit", "-q", "-am", n], s);
      await run("git", ["-C", join(o, "sub"), ...file, "pull", "-q"], { env: childEnv });
      await g(["add", "sub"], o);
      await g(["commit", "-q", "-m", `bump ${n}`], o);
    };
    const subGitDir = (await g(["rev-parse", "--absolute-git-dir"], join(l, "sub"))).stdout.trim();
    await run("git", ["--git-dir", subGitDir, "config", "protocol.ext.allow", "always"], { env: childEnv });
    await run("git", ["--git-dir", subGitDir, "config", "remote.origin.url", `ext::sh -c touch% ${join(base, "ext.ran")}`], { env: childEnv });
    await bump("2");
    stubHard();
    await listBranches(l);
    expect(m.ran()).toBe(false);
    vi.unstubAllEnvs();
    await bump("3");
    await run("git", ["-C", l, "fetch", "--all", "--prune"], { env: childEnv }).catch(() => {});
    expect(m.ran()).toBe(true); // the control
  });
});

// Fix round 2, item 2 (ruling 2c-6-d): a new <gitdir>/commondir moves the
// config git reads past the ownership check; a pinned GIT_COMMON_DIR makes
// git ignore that file.
describe("hardened: the common dir is pinned (ruling 2c-6-d)", () => {
  // A copy of the repo's .git with a clean filter, named by a planted .git/commondir.
  async function plant(script: string): Promise<void> {
    const evil = join(base, "evilcommon");
    await cp(join(repo, ".git"), evil, { recursive: true });
    await run("git", ["--git-dir", evil, "config", "filter.x.clean", script], { env: childEnv });
    await writeFile(join(repo, ".gitattributes"), "* filter=x\n");
    await writeFile(join(repo, "f.txt"), "b\n");
    const t = new Date(Date.now() + 5000);
    await utimes(join(repo, "f.txt"), t, t);
    await writeFile(join(repo, ".git", "commondir"), `${evil}\n`);
  }

  it("a planted .git/commondir: hardened status with the main repo pinned runs no filter (control: unpinned it does)", async () => {
    const m = await marker("common", "cat");
    await plant(m.script);
    await run("git", ["-C", repo, "status", "--porcelain"], { env: gitEnv(repo, childEnv, HARD) });
    expect(m.ran()).toBe(true); // the control: the hardened env without the pin
    await m.reset();
    const { stdout } = await run("git", ["-C", repo, "status", "--porcelain"], { env: gitEnv(repo, childEnv, HARD, repo) });
    expect(stdout).toContain(" M f.txt");
    expect(m.ran()).toBe(false);
  });

  it("the call sites pin it: workspace changes, the files changes route (a repo root and a dir below it)", async () => {
    const m = await marker("common", "cat");
    await plant(m.script);
    stubHard();
    expect((await workspaceChangedFiles(base)).map((f) => f.rel)).toContain("r/f.txt");
    const app = Fastify();
    registerFilesApi(app, { workspaceDir: base });
    await app.ready();
    try {
      const res = await app.inject({ method: "GET", url: `/api/files/changes?root=${encodeURIComponent(repo)}` });
      expect(res.json()).toMatchObject({ git: true, changes: expect.arrayContaining([expect.objectContaining({ rel: "f.txt" })]) });
      const sub = join(repo, "d");
      await mkdir(sub);
      const res2 = await app.inject({ method: "GET", url: `/api/files/changes?root=${encodeURIComponent(sub)}` });
      expect(res2.json().git).toBe(true); // a subdir: its repo, found above it
    } finally {
      await app.close();
    }
    expect(m.ran()).toBe(false);
  });

  it("mainRepoOf: a .git dir; a dir below it; a console-made worktree's gitfile; nothing else", async () => {
    const SELF = process.getuid!();
    expect(mainRepoOf(repo, base, SELF)).toBe(repo);
    await mkdir(join(repo, "d", "e"), { recursive: true });
    expect(mainRepoOf(join(repo, "d", "e"), base, SELF)).toBe(repo);
    const wt = join(base, "wt1");
    await plain(["worktree", "add", "-q", wt, "-b", "agent/w"]);
    expect(mainRepoOf(wt, base, SELF)).toBe(repo);
    expect(mainRepoOf(wt, base, SELF + 1)).toBeNull(); // a gitfile the console does not own
    await writeFile(join(wt, ".git"), `gitdir: ${join(base, "elsewhere", "gitdir")}\n`);
    expect(mainRepoOf(wt, base, SELF)).toBeNull(); // not <main>/.git/worktrees/<id>
    const plainDir = join(base, "plain");
    await mkdir(plainDir);
    expect(mainRepoOf(plainDir, base, SELF)).toBeNull();
    expect(mainRepoOf(join(repo, "d"), join(repo, "d"), SELF)).toBeNull(); // not above stop
  });

  it("files changes: hardened, a root with no main repo the console can name runs no git", async () => {
    const wt = join(base, "wt2");
    await plain(["worktree", "add", "-q", wt, "-b", "agent/w2"]);
    stubHard();
    const app = Fastify();
    registerFilesApi(app, { workspaceDir: base });
    await app.ready();
    try {
      expect((await app.inject({ method: "GET", url: `/api/files/changes?root=${encodeURIComponent(wt)}` })).json().git).toBe(true);
      await writeFile(join(wt, ".git"), `gitdir: ${join(base, "nowhere")}\n`);
      expect((await app.inject({ method: "GET", url: `/api/files/changes?root=${encodeURIComponent(wt)}` })).json()).toEqual({ changes: [], git: false });
    } finally {
      await app.close();
    }
  });
});

// Checklist hold item 1: an agent with write on .git/logs/ swaps logs/HEAD
// or logs/refs/heads/<base> for a symlink (here to <base>/rc-*, say the
// console user's shell rc). The Merge route (reconcile.ts: checkout <base>,
// merge --no-edit <branch>) then appends its reflog lines there. Hardened,
// they hold the fixed action, no part of the agent-chosen branch name.
describe("hardened: a fixed reflog action on the Merge route (checklist hold item 1)", () => {
  const BRANCH = "x$(touch${IFS}pwned)";
  const messages = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => l.slice(l.indexOf("\t") + 1));

  for (const kind of ["fast-forward", "true merge"] as const) {
    it(`${kind}: no part of the branch name reaches logs/HEAD or logs/refs/heads/main (control: today's merge writes it)`, async () => {
      await plain(["checkout", "-q", "-b", BRANCH]);
      await writeFile(join(repo, "g.txt"), "agent\n");
      await plain(["add", "g.txt"]);
      await plain(["commit", "-q", "-m", "agent work"]);
      await plain(["checkout", "-q", "main"]);
      if (kind === "true merge") {
        await writeFile(join(repo, "h.txt"), "base\n");
        await plain(["add", "h.txt"]);
        await plain(["commit", "-q", "-m", "base work"]);
      }
      const start = (await plain(["rev-parse", "HEAD"])).stdout.trim();
      const rc = { HEAD: join(base, "rc-head"), main: join(base, "rc-main") };
      const plant = async () => {
        for (const [log, target] of [["HEAD", rc.HEAD], [join("refs", "heads", "main"), rc.main]] as const) {
          await writeFile(target, "");
          await rm(join(repo, ".git", "logs", log), { force: true });
          await symlink(target, join(repo, ".git", "logs", log));
        }
      };
      const mergeAs = async (deploy: Env) => {
        await consoleGit(deploy, ["checkout", "main"]);
        await consoleGit(deploy, ["merge", "--no-edit", BRANCH]);
      };

      await plant();
      await mergeAs({}); // control: flag off, as today
      for (const f of [rc.HEAD, rc.main]) expect(readFileSync(f, "utf8"), f).toContain(`merge ${BRANCH}`);

      await plain(["reset", "-q", "--hard", start]);
      await plant();
      await mergeAs(HARD);
      for (const f of [rc.HEAD, rc.main]) {
        expect(readFileSync(f, "utf8"), f).not.toMatch(/touch|pwned|\$\(/);
        expect(messages(f).length, f).toBeGreaterThan(0); // the symlink was followed: the test means something
        for (const m of messages(f)) expect(m, f).toMatch(/^choibot(: (Fast-forward|Merge made by the '\w+' strategy\.))?$/);
      }
      expect(messages(rc.HEAD)[0]).toBe("choibot"); // the checkout of the base
      await expect(plain(["merge-base", "--is-ancestor", BRANCH, "HEAD"])).resolves.toBeDefined(); // merged
    });
  }

  // The agent's worktree admin dir .git/worktrees/<x>/ is group-writable by
  // design (C1), so its logs/HEAD can be a symlink; so can the agent branch's
  // own reflog. commitPending (commit, then reset -q) appends to both.
  it("a linked worktree: commitPending writes only fixed text into .git/worktrees/<x>/logs/HEAD and the branch reflog (control: flag off, no fixed action)", async () => {
    const wt = join(base, "wt");
    await plain(["worktree", "add", "-q", "-b", BRANCH, wt]);
    const rc = { HEAD: join(base, "rc-wt-head"), branch: join(base, "rc-wt-branch") };
    const plant = async () => {
      for (const [log, target] of [[join("worktrees", "wt", "logs", "HEAD"), rc.HEAD], [join("logs", "refs", "heads", BRANCH), rc.branch]] as const) {
        await writeFile(target, "");
        await rm(join(repo, ".git", log), { force: true });
        await symlink(target, join(repo, ".git", log));
      }
    };
    const rec = { worktree: wt, repo, branch: BRANCH, baseBranch: "main" } as AgentRecord;

    await plant();
    await writeFile(join(wt, "f.txt"), "control\n");
    expect(await commitPending(rec)).toEqual({ ok: true }); // flag off, as today
    for (const f of [rc.HEAD, rc.branch]) expect(messages(f), f).toEqual(["commit: console: commit pending edits"]);

    await plant();
    await writeFile(join(wt, "f.txt"), "hardened\n");
    stubHard();
    expect(await commitPending(rec)).toEqual({ ok: true });
    for (const f of [rc.HEAD, rc.branch]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/touch|pwned|\$\(/);
      expect(messages(f).length, f).toBeGreaterThan(0); // the symlink was followed
      for (const m of messages(f)) expect(m, f).toMatch(/^choibot: (console: commit pending edits|updating HEAD)$/);
    }
    expect(messages(rc.HEAD)).toContain("choibot: console: commit pending edits");
  });
});

// Ruling H1-a: C1 leaves .git/objects/ group-writable, so an agent can plant
// .git/objects/info/commit-graph as a symlink and add loose objects until
// `gc --auto` fires. The console's commit, merge or fetch would then run
// auto-gc, whose commit-graph write follows the symlink (its lock resolves
// it) and replaces the target with a binary file. Hardened: no auto-gc.
describe("hardened: no console auto-gc (ruling H1-a)", () => {
  // n real loose blobs under objects/17/: gc --auto counts that one dir
  // (more than ceil(6700 / 256) = 27 there means "too many").
  async function looseObjects17(n: number): Promise<void> {
    const dir = join(repo, ".git", "objects", "17");
    await mkdir(dir, { recursive: true });
    for (let i = 0, made = 0; made < n; i++) {
      const body = Buffer.from(`filler ${i}\n`);
      const obj = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
      const sha = createHash("sha1").update(obj).digest("hex");
      if (!sha.startsWith("17")) continue;
      await writeFile(join(dir, sha.slice(2)), deflateSync(obj));
      made++;
    }
  }

  it("a console commit writes no commit-graph through a planted objects/info symlink (control: today's auto-gc replaces the target)", async () => {
    await plain(["config", "gc.autoDetach", "false"]); // the control's gc runs before commit returns
    await looseObjects17(40);
    const victim = join(base, "victim");
    await writeFile(victim, "secret\n");
    await mkdir(join(repo, ".git", "objects", "info"), { recursive: true });
    await symlink(victim, join(repo, ".git", "objects", "info", "commit-graph"));
    const commit = async (deploy: Env, msg: string) => {
      await writeFile(join(repo, "f.txt"), `${msg}\n`);
      await plain(["add", "f.txt"]);
      await consoleGit(deploy, ["commit", "-q", "-m", msg]);
    };
    await commit(HARD, "hardened");
    expect(readFileSync(victim, "utf8")).toBe("secret\n");
    await commit({}, "control"); // flag off, as today: same repo, same loose objects
    expect(readFileSync(victim).subarray(0, 4).toString()).toBe("CGPH");
  });
});

describe("Review Focus 4: not hardened, the user's own hooks still run", () => {
  for (const [name, deploy] of NOT_HARD) {
    it(`${name}: post-checkout runs on a console checkout`, async () => {
      const ran = await hook("post-checkout");
      await consoleGit(deploy, ["checkout", "-q", "-b", "side"]);
      expect(ran()).toBe(true);
    });
  }
});

describe("runGit and the call sites", () => {
  it("not hardened: runGit runs the hook and returns stdout as execFile does", async () => {
    const ran = await hook("post-checkout");
    await runGit(repo, ["-C", repo, "checkout", "-q", "-b", "side"]);
    expect(ran()).toBe(true);
    expect((await runGit(repo, ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).stdout).toBe("side\n");
  });

  it("hardened: runGit runs no hook and no textconv, and keeps the caller's options", async () => {
    stubHard();
    const ran = await hook("post-checkout");
    const tc = await marker("textconv");
    await plain(["config", "diff.x.textconv", tc.script]);
    await writeFile(join(repo, ".gitattributes"), "f.txt diff=x\n");
    await writeFile(join(repo, "f.txt"), "a\nb\n");
    await runGit(repo, ["-C", repo, "checkout", "-q", "-b", "side"], { timeout: 15000 });
    expect((await runGit(repo, ["-C", repo, "diff"])).stdout).toContain("+b");
    expect(ran()).toBe(false);
    expect(tc.ran()).toBe(false);
    await expect(runGit(repo, ["-C", repo, "status"], { maxBuffer: 1 })).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });

  it("hardened: createWorktree runs no post-checkout hook and worktreeDiff no textconv", async () => {
    stubHard();
    const ran = await hook("post-checkout");
    const tc = await marker("textconv");
    await plain(["config", "diff.x.textconv", tc.script]);
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/x", root: join(base, "wts") });
    expect(ran()).toBe(false);
    await writeFile(join(wt.path, ".gitattributes"), "f.txt diff=x\n");
    await writeFile(join(wt.path, "f.txt"), "a\nb\n");
    expect(await worktreeDiff(wt.path, "main")).toContain("+b");
    expect(tc.ran()).toBe(false);
  });

  it("not hardened: createWorktree runs the user's post-checkout hook, as today", async () => {
    const ran = await hook("post-checkout");
    await createWorktree({ repo, baseBranch: "main", branch: "agent/x", root: join(base, "wts") });
    expect(ran()).toBe(true);
  });

  it("files routes: hardened, git runs in a console-owned root (also from the guard's /proc/self/fd/3) and refuses another owner's", async () => {
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repo, "ignored.txt"), "x\n");
    // A non-USER caller the guard passes: /api/files/all runs git through runInDir.
    const guard: FilesGuard = { user: async () => false, refused: async () => false, hidden: () => false, refuse: (r) => r.code(403).send({}) };
    const app = Fastify();
    registerFilesApi(app, { workspaceDir: base, guard });
    await app.ready();
    const q = encodeURIComponent(repo);
    const all = async () => (await app.inject({ method: "GET", url: `/api/files/all?root=${q}` })).json().files;
    const changes = async () => (await app.inject({ method: "GET", url: `/api/files/changes?root=${q}` })).json();
    try {
      stubHard();
      expect(await all()).toEqual([".gitignore", "f.txt"]); // git ls-files
      expect((await changes()).git).toBe(true);
      // Another owner's repo: git refuses, the routes fall back (find, no changes).
      vi.stubEnv("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");
      expect(await all()).toEqual([".gitignore", "f.txt", "ignored.txt"]); // find
      expect(await changes()).toEqual({ changes: [], git: false });
    } finally {
      await app.close();
    }
  });

  it("gh gets the hardened env (the git it runs inherits it); not hardened, the env as today", async () => {
    const bin = join(base, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "gh"), "#!/bin/sh\nprintf '%s|%s|%s|%s|%s' \"$GIT_CONFIG_COUNT\" \"$GIT_CONFIG_VALUE_0\" \"$(pwd -P)\" \"$GIT_COMMON_DIR\" \"$GIT_REFLOG_ACTION\"\n");
    await chmod(join(bin, "gh"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const today = `${process.env.GIT_CONFIG_COUNT ?? ""}|${process.env.GIT_CONFIG_VALUE_0 ?? ""}|${repo}|${process.env.GIT_COMMON_DIR ?? ""}|${process.env.GIT_REFLOG_ACTION ?? ""}`;
    expect(await gh(["pr", "view"], { cwd: repo })).toBe(today);
    stubHard();
    expect(await gh(["pr", "view"], { cwd: repo })).toBe(`13|/dev/null|${repo}|${repo}/.git|choibot`); // the cwd is the main repo
  });
});

describe("checkRepoProtection (checklist C1)", () => {
  const SELF = process.getuid!();
  const OTHER = SELF + 1;
  const top = () => repo;
  const gitDir = () => join(repo, ".git");
  const hooks = () => join(repo, ".git", "hooks");
  const logs = (...p: string[]) => join(repo, ".git", "logs", ...p);
  // The repo as C1 leaves it: a top dir no agent can write (or a sticky one),
  // config console-owned 0644, .git/ sticky, .git/hooks/ sticky and not
  // group- or world-writable, .git/logs/ not group-writable, logs/refs/ and
  // logs/refs/heads/ group-writable and sticky (hold item 1). Modes are set:
  // the test umask may be 002.
  async function fixed(): Promise<void> {
    await chmod(top(), 0o755);
    await chmod(join(repo, ".git", "config"), 0o644);
    await chmod(gitDir(), 0o1755);
    await chmod(hooks(), 0o1755);
    await chmod(join(repo, ".git", "info"), 0o755);
    await chmod(logs(), 0o755);
    await chmod(logs("HEAD"), 0o644);
    await chmod(logs("refs"), 0o1775);
    await chmod(logs("refs", "heads"), 0o1775);
    await chmod(join(repo, ".git", "objects", "info"), 0o755);
  }

  it("a fixed repo: no problem; a group-writable top dir with the sticky bit is fixed too", async () => {
    await fixed();
    expect(checkRepoProtection(repo, SELF)).toEqual([]);
    await chmod(top(), 0o1775);
    expect(checkRepoProtection(repo, SELF)).toEqual([]);
  });

  // Ruling F4: .git/ itself is not group-writable (console git follows a
  // planted MERGE_MSG, SQUASH_MSG or gc.log symlink there), and .git/info/
  // neither (info/exclude, info/attributes).
  it("a group- or world-writable .git/ (sticky or not) or .git/info/ is a problem; no .git/info/ is fine", async () => {
    await fixed();
    await chmod(gitDir(), 0o1775);
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/ is group- or world-writable (mode 1775)"]);
    await chmod(gitDir(), 0o1757);
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/ is group- or world-writable (mode 1757)"]);
    await fixed();
    await chmod(join(repo, ".git", "info"), 0o775);
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/info/ is group- or world-writable (mode 0775)"]);
    await rm(join(repo, ".git", "info"), { recursive: true });
    expect(checkRepoProtection(repo, SELF)).toEqual([]);
    await symlink(base, join(repo, ".git", "info"));
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/info/ is not a directory"]);
  });

  it("reports each problem", async () => {
    await fixed();
    const one = async (p: string, mode: number, want: string) => {
      await chmod(p, mode);
      expect(checkRepoProtection(repo, SELF), want).toEqual([want]);
      await fixed();
    };
    await one(join(repo, ".git", "config"), 0o664, ".git/config mode 0664, want 0644");
    await one(gitDir(), 0o755, ".git/ has no sticky bit");
    await one(hooks(), 0o755, ".git/hooks/ has no sticky bit");
    // Ruling 2c-6-c: an agent with write on .git/hooks/ adds a hook the
    // user's own git runs; with write on the top dir it renames .git itself.
    await one(hooks(), 0o1775, ".git/hooks/ is group- or world-writable (mode 1775)");
    await one(hooks(), 0o1757, ".git/hooks/ is group- or world-writable (mode 1757)");
    await one(top(), 0o775, "top dir is group- or world-writable (mode 0775) and has no sticky bit");
    await one(top(), 0o757, "top dir is group- or world-writable (mode 0757) and has no sticky bit");
    // Not the console's: config, .git/, .git/hooks/ and the logs (the owner may write or chmod them).
    expect(checkRepoProtection(repo, OTHER)).toEqual([
      `.git/config owner uid ${SELF}, want ${OTHER}`,
      `.git/ owner uid ${SELF}, want ${OTHER}`,
      `.git/hooks/ owner uid ${SELF}, want ${OTHER}`,
      `.git/logs/ owner uid ${SELF}, want ${OTHER}`,
      `.git/logs/HEAD owner uid ${SELF}, want ${OTHER}`,
      `.git/logs/refs/ owner uid ${SELF}, want ${OTHER}`,
      `.git/logs/refs/heads/ owner uid ${SELF}, want ${OTHER}`,
      `.git/objects/info/ owner uid ${SELF}, want ${OTHER}`,
    ]);
  });

  it("all at once, in a fixed order", async () => {
    await chmod(top(), 0o775);
    await chmod(join(repo, ".git", "config"), 0o666);
    await chmod(gitDir(), 0o775);
    await chmod(hooks(), 0o775);
    await chmod(join(repo, ".git", "info"), 0o775);
    await chmod(logs(), 0o775);
    await chmod(logs("refs"), 0o775);
    await chmod(logs("refs", "heads"), 0o775);
    await chmod(join(repo, ".git", "objects", "info"), 0o775);
    expect(checkRepoProtection(repo, OTHER)).toEqual([
      "top dir is group- or world-writable (mode 0775) and has no sticky bit",
      `.git/config owner uid ${SELF}, want ${OTHER}`,
      ".git/config mode 0666, want 0644",
      `.git/ owner uid ${SELF}, want ${OTHER}`,
      ".git/ is group- or world-writable (mode 0775)",
      ".git/ has no sticky bit",
      `.git/hooks/ owner uid ${SELF}, want ${OTHER}`,
      ".git/hooks/ is group- or world-writable (mode 0775)",
      ".git/hooks/ has no sticky bit",
      ".git/info/ is group- or world-writable (mode 0775)",
      `.git/logs/ owner uid ${SELF}, want ${OTHER}`,
      ".git/logs/ is group- or world-writable (mode 0775)",
      `.git/logs/HEAD owner uid ${SELF}, want ${OTHER}`,
      `.git/logs/refs/ owner uid ${SELF}, want ${OTHER}`,
      ".git/logs/refs/ has no sticky bit",
      `.git/logs/refs/heads/ owner uid ${SELF}, want ${OTHER}`,
      ".git/logs/refs/heads/ has no sticky bit",
      `.git/objects/info/ owner uid ${SELF}, want ${OTHER}`,
      ".git/objects/info/ is group- or world-writable (mode 0775)",
    ]);
  });

  it("a config symlink, a missing hooks dir, a missing config", async () => {
    await fixed();
    const cfg = join(repo, ".git", "config");
    const real = join(base, "config-elsewhere");
    await writeFile(real, await readFile(cfg));
    await chmod(real, 0o644);
    await rm(cfg);
    await symlink(real, cfg);
    await rm(hooks(), { recursive: true });
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/config is not a regular file", ".git/hooks/ unreadable (ENOENT)"]);
    await rm(cfg);
    expect(checkRepoProtection(repo, SELF)[0]).toBe(".git/config unreadable (ENOENT)");
  });

  it("ruling 2c-6-d: a .git/commondir in a main repo; .git/worktrees/ and each .git/worktrees/<x>/ console-owned, .git/worktrees/ sticky", async () => {
    await fixed();
    await writeFile(join(repo, ".git", "commondir"), "/elsewhere\n");
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/commondir exists (a main repo has none)"]);
    await rm(join(repo, ".git", "commondir"));
    await plain(["worktree", "add", "-q", join(base, "wt1"), "-b", "agent/w"]);
    await chmod(join(repo, ".git", "worktrees"), 0o755);
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/worktrees/ has no sticky bit"]);
    await chmod(join(repo, ".git", "worktrees"), 0o1775);
    expect(checkRepoProtection(repo, SELF)).toEqual([]); // .git/worktrees/wt1/ stays writable for the agent's own HEAD and index
    await chmod(hooks(), 0o1755);
    expect(checkRepoProtection(repo, OTHER).slice(3, 5)).toEqual([
      `.git/worktrees/ owner uid ${SELF}, want ${OTHER}`,
      `.git/worktrees/wt1/ owner uid ${SELF}, want ${OTHER}`,
    ]);
    await rm(join(repo, ".git", "worktrees", "wt1"), { recursive: true });
    await writeFile(join(repo, ".git", "worktrees", "stray"), "x");
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/worktrees/stray/ is not a directory"]);
  });

  // Hold item 1 (reflog symlinks): with write on .git/logs/ an agent swaps
  // logs/HEAD for a symlink the console's reflog line follows. logs/refs/
  // and logs/refs/heads/ stay group-writable (the agent's git logs its own
  // branches there), sticky so the console's files there stay in place.
  it("hold item 1: .git/logs/ not group- or world-writable, logs/HEAD a console-owned file, logs/refs/ and logs/refs/heads/ sticky", async () => {
    await fixed();
    expect(checkRepoProtection(repo, SELF)).toEqual([]);
    const one = async (p: string, mode: number, want: string) => {
      await chmod(p, mode);
      expect(checkRepoProtection(repo, SELF), want).toEqual([want]);
      await fixed();
    };
    await one(logs(), 0o775, ".git/logs/ is group- or world-writable (mode 0775)");
    await one(logs(), 0o1775, ".git/logs/ is group- or world-writable (mode 1775)");
    await one(logs(), 0o757, ".git/logs/ is group- or world-writable (mode 0757)");
    await one(logs("refs"), 0o775, ".git/logs/refs/ has no sticky bit");
    await one(logs("refs", "heads"), 0o775, ".git/logs/refs/heads/ has no sticky bit");
    // A group-writable logs/HEAD is fine: the console's git makes it 0664 in
    // a shared repo, and no agent can replace a file in .git/logs/.
    await chmod(logs("HEAD"), 0o664);
    expect(checkRepoProtection(repo, SELF)).toEqual([]);
  });

  it("hold item 1: a symlink or a dir in place of a logs entry; no logs entry is fine", async () => {
    await fixed();
    const elsewhere = join(base, "elsewhere");
    await mkdir(join(elsewhere, "refs", "heads"), { recursive: true });
    await writeFile(join(elsewhere, "HEAD"), "");
    await rm(logs("HEAD"));
    await symlink(join(elsewhere, "HEAD"), logs("HEAD"));
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/logs/HEAD is not a regular file"]);
    await rm(logs("HEAD"));
    expect(checkRepoProtection(repo, SELF)).toEqual([]); // no logs/HEAD yet
    await mkdir(logs("HEAD"));
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/logs/HEAD is not a regular file"]);
    await rm(logs("HEAD"), { recursive: true });
    await rm(logs("refs", "heads"), { recursive: true });
    await symlink(join(elsewhere, "refs", "heads"), logs("refs", "heads"));
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/logs/refs/heads/ is not a directory"]);
    await rm(logs("refs", "heads"));
    expect(checkRepoProtection(repo, SELF)).toEqual([]);
    await rm(logs("refs"), { recursive: true });
    await symlink(join(elsewhere, "refs"), logs("refs"));
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/logs/refs/ is not a directory"]); // and nothing through it
    await rm(logs(), { recursive: true });
    expect(checkRepoProtection(repo, SELF)).toEqual([]);
    await symlink(elsewhere, logs());
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/logs/ is not a directory"]); // and nothing through it
  });

  // Ruling H1-a: the commit-graph lives in .git/objects/info/, which C1
  // keeps out of the group write it gives .git/objects/.
  it("ruling H1-a: .git/objects/info/ console-owned, not group- or world-writable; none is fine; a later check still runs without .git/logs/", async () => {
    await fixed();
    const info = join(repo, ".git", "objects", "info");
    await chmod(info, 0o775);
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/objects/info/ is group- or world-writable (mode 0775)"]);
    await chmod(info, 0o757);
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/objects/info/ is group- or world-writable (mode 0757)"]);
    await rm(info, { recursive: true });
    expect(checkRepoProtection(repo, SELF)).toEqual([]);
    await symlink(base, info);
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/objects/info/ is not a directory"]);
    // Review minor 1: the logs block does not end the checks.
    await rm(logs(), { recursive: true });
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/objects/info/ is not a directory"]);
    await symlink(base, logs());
    expect(checkRepoProtection(repo, SELF)).toEqual([".git/logs/ is not a directory", ".git/objects/info/ is not a directory"]);
  });

  it("no repo at the path", () => {
    expect(checkRepoProtection(join(base, "none"), SELF)).toEqual([
      "top dir unreadable (ENOENT)", ".git/config unreadable (ENOENT)", ".git/ unreadable (ENOENT)", ".git/hooks/ unreadable (ENOENT)",
    ]);
  });
});

// Every console git and gh spawn goes through the helpers. The listed files
// are the call sites that exist (server/chief/leads/lead.ts joins in Task 3-7).
describe("source scan: no console git or gh spawn skips gitArgs/gitEnv", () => {
  const LISTED = [
    "server/agents/api.ts", "server/agents/reconcile.ts", "server/agents/repos.ts", "server/agents/upload.ts",
    "server/agents/workspace.ts", "server/agents/worktree.ts", "server/master/master.ts",
    "server/files/api.ts", "server/gh/exec.ts", "server/gh/pr.ts", "server/gh/repos.ts", "server/pr/api.ts",
    "server/chief/boot.ts",
  ];
  // A string literal (any quote) naming git or gh: the bare name or a path to
  // it ("/usr/bin/git"), or a shell string starting with it ("git status").
  const LITERAL = /(["'`])((?:[^"'`\s]*\/)?(git|gh))( [^"'`]*)?\1/g;
  // Calls that start a process with their arguments.
  const SPAWNER = /^(exec|execSync|execFile|execFileSync|execFileP|execP|spawn|spawnSync|fork|run|runInDir)$/;
  // The source without comments (a // or /* after whitespace or at a line
  // start; "https://" in a string stays), newlines kept for line numbers.
  const code = (src: string) =>
    src.replace(/(^|\s)(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (_m, pre: string, c: string) => pre + c.replace(/[^\n]/g, " "));

  // The call around index i: its callee name and its text, from the
  // unmatched "(" before i to its match.
  function enclosingCall(src: string, i: number): { callee: string; text: string } | null {
    let depth = 0;
    let open = -1;
    for (let j = i - 1; j >= 0 && open < 0; j--) {
      if (src[j] === ")") depth++;
      else if (src[j] === "(") { if (depth === 0) open = j; else depth--; }
    }
    if (open < 0) return null;
    const callee = /([A-Za-z_$][\w$]*)\s*$/.exec(src.slice(Math.max(0, open - 80), open))?.[1] ?? "";
    depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) return { callee, text: src.slice(open, j + 1) };
    }
    return null;
  }

  // Each git or gh spawn that skips the helpers, as "<line>: <why>". A bare
  // "git"/"gh" must sit in a call that passes gitArgs (git) and
  // gitEnv/gitOpts. A path to it counts only as a spawner's argument (a route
  // like "/api/agents/:id/git" is no spawn), and a shell string never goes to
  // a spawner (it cannot pass gitArgs); elsewhere (a log label, a message)
  // neither is a spawn.
  function violations(raw: string): string[] {
    const src = code(raw);
    const out: string[] = [];
    for (const m of src.matchAll(LITERAL)) {
      const line = src.slice(0, m.index).split("\n").length;
      const call = enclosingCall(src, m.index!);
      const spawner = call !== null && SPAWNER.test(call.callee);
      if (m[4] !== undefined) {
        if (spawner) out.push(`${line}: a shell string "${m[2]}${m[4]}" given to ${call!.callee}`);
        continue;
      }
      if (m[2] !== m[3] && !spawner) continue; // a path, not a spawner's argument
      if (!call) out.push(`${line}: a "${m[2]}" literal outside a call`);
      else if (m[3] === "git" && !/\bgitArgs\(/.test(call.text)) out.push(`${line}: git argv without gitArgs`);
      else if (!/\bgit(Env|Opts)\(/.test(call.text)) out.push(`${line}: ${m[3]} env without gitEnv/gitOpts`);
    }
    return out;
  }

  function serverSources(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...serverSources(p));
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }

  it("the scanner (fix round 2, item 5): absolute paths and shell strings are caught; labels and messages are not", () => {
    expect(violations('await execFileP("/usr/bin/git", ["status"]);')).toEqual(["1: git argv without gitArgs"]);
    expect(violations('spawn("./gh", ["pr", "view"]);')).toEqual(["1: gh env without gitEnv/gitOpts"]);
    expect(violations('exec("git status --porcelain");')).toEqual(['1: a shell string "git status --porcelain" given to exec']);
    expect(violations("execSync(`gh pr view ${n}`);")).toEqual(["1: a shell string \"gh pr view ${n}\" given to execSync"]);
    expect(violations('const GIT = "git";')).toEqual(['1: a "git" literal outside a call']);
    expect(violations([
      'runInDir(dir, "git", gitArgs(r, a), 1, gitEnv(r));',
      'run("gh", args, gitOpts(c, { cwd: c }));',
      'deadline(p, ms, "git merge-base");',
      'app.get("/api/agents/:id/git", handler);',
      'const route = "/x/gh";',
      "return { error: `git failed: ${detail}` };",
      '// exec("git status") in a comment',
    ].join("\n"))).toEqual([]);
  });

  it("each listed file runs git through runGit, or passes gitArgs and gitEnv/gitOpts at the spawn", () => {
    for (const f of LISTED) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(/\brunGit\(|\bgit(Args|Env|Opts)\(/.test(code(src)), `${f} uses the helpers`).toBe(true);
      expect(violations(src), f).toEqual([]);
    }
  });

  it("no other server file spawns git or gh", () => {
    const found = serverSources(join(ROOT, "server"))
      .map((p) => relative(ROOT, p))
      .filter((f) => f !== "server/agents/git.ts" && !LISTED.includes(f))
      .filter((f) => violations(readFileSync(join(ROOT, f), "utf8")).length > 0);
    expect(found).toEqual([]);
  });
});
