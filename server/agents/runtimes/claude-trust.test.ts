import { afterEach, describe, it, expect, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { markOnboarded, ONBOARD_JS, onboardedLaunch, trustClaudeDir } from "./claude-trust.js";

const tmps: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true });
});

// A config dir with a .claude.json (0600) and a lead home dir to trust.
async function fx(cfg?: unknown, raw?: string) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "claude-trust-")));
  tmps.push(base);
  const file = join(base, "cfg", ".claude.json");
  const dir = join(base, "chief", "leads", "app-shop", "agent");
  await mkdir(join(base, "cfg"), { recursive: true });
  await mkdir(dir, { recursive: true });
  if (raw !== undefined || cfg !== undefined) {
    await writeFile(file, raw ?? JSON.stringify(cfg, null, 2));
    await chmod(file, 0o600);
  }
  return { base, file, dir };
}

const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("trustClaudeDir", () => {
  it("sets hasTrustDialogAccepted for a dir with no project entry, as Claude's own dialog does", async () => {
    const { file, dir } = await fx({ numStartups: 3, projects: {} });
    expect(trustClaudeDir(file, dir)).toBe("written");
    const out = await read(file);
    expect(out.projects[dir].hasTrustDialogAccepted).toBe(true);
    // The fields Claude Code itself gives a new entry when the dialog is accepted.
    expect(out.projects[dir]).toEqual({
      allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
    });
  });

  it("sets the key when the file has no projects object yet", async () => {
    const { file, dir } = await fx({ numStartups: 1 });
    expect(trustClaudeDir(file, dir)).toBe("written");
    expect((await read(file)).projects[dir].hasTrustDialogAccepted).toBe(true);
  });

  it("turns a false key true and keeps the entry's other keys", async () => {
    const { file, dir } = await fx({});
    const cfg = { projects: { [dir]: { allowedTools: ["Bash"], hasTrustDialogAccepted: false, lastCost: 1.5 } } };
    await writeFile(file, JSON.stringify(cfg, null, 2));
    expect(trustClaudeDir(file, dir)).toBe("written");
    expect((await read(file)).projects[dir]).toEqual({ allowedTools: ["Bash"], hasTrustDialogAccepted: true, lastCost: 1.5 });
  });

  it("keeps every other key and project entry exactly", async () => {
    const other = {
      oauthAccount: { emailAddress: "a@b.c", accountUuid: "u-1" },
      numStartups: 42, tipsHistory: { x: 3 }, nested: { a: [1, { b: null }], s: "ü\n\"" },
      projects: { "/elsewhere": { hasTrustDialogAccepted: false, allowedTools: ["Read"] }, "/x": { mcpServers: { m: {} } } },
    };
    const { file, dir } = await fx(other);
    expect(trustClaudeDir(file, dir)).toBe("written");
    const out = await read(file);
    const { [dir]: added, ...restProjects } = out.projects;
    expect(added.hasTrustDialogAccepted).toBe(true);
    expect({ ...out, projects: restProjects }).toEqual(other);
  });

  it("does not write when the key is already true", async () => {
    const { file, dir } = await fx({ projects: {} });
    const cfg = { projects: { [dir]: { hasTrustDialogAccepted: true } }, numStartups: 1 };
    const raw = JSON.stringify(cfg); // not the helper's own formatting
    await writeFile(file, raw);
    const before = await stat(file);
    expect(trustClaudeDir(file, dir)).toBe("already");
    const after = await stat(file);
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("leaves a file that is not valid JSON untouched, with one [chief] warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { file, dir } = await fx(undefined, "{ not json");
    expect(trustClaudeDir(file, dir)).toBe("invalid");
    expect(await readFile(file, "utf8")).toBe("{ not json");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[chief\] .*\.claude\.json/);
  });

  it.each([
    ["an array", "[]"],
    ["a string", "\"x\""],
    ["projects that is not an object", "{\"projects\":[1]}"],
    ["an entry that is not an object", "{\"projects\":{\"DIR\":true}}"],
  ])("leaves a config that is %s untouched, with one [chief] warning", async (_what, body) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { file, dir } = await fx(undefined, "{}");
    const raw = body.replace("DIR", dir);
    await writeFile(file, raw);
    expect(trustClaudeDir(file, dir)).toBe("invalid");
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[chief\] /);
  });

  it("does not create a missing file, with one [chief] warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { file, dir } = await fx();
    expect(trustClaudeDir(file, dir)).toBe("missing");
    expect(existsSync(file)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[chief\] /);
  });

  it("writes atomically: keeps the file mode and leaves no temp file", async () => {
    const { base, file, dir } = await fx({ projects: {} });
    await chmod(file, 0o640);
    const before = await stat(file);
    expect(trustClaudeDir(file, dir)).toBe("written");
    const after = await stat(file);
    expect(after.mode & 0o777).toBe(0o640);
    expect(after.ino).not.toBe(before.ino); // a rename, not an in-place rewrite
    expect(await readdir(join(base, "cfg"))).toEqual([".claude.json"]);
  });

  it("keys the entry by the dir's real path, as Claude Code does", async () => {
    const { base, file, dir } = await fx({ projects: {} });
    const link = join(base, "link-to-agent");
    await symlink(dir, link);
    expect(trustClaudeDir(file, link)).toBe("written");
    const out = await read(file);
    expect(Object.keys(out.projects)).toEqual([dir]);
  });

  it("follows a symlinked config file: the link stays, its target gets the key", async () => {
    const { base, file, dir } = await fx({ projects: {} });
    const link = join(base, "linked.claude.json");
    await symlink(file, link);
    expect(trustClaudeDir(link, dir)).toBe("written");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect((await read(file)).projects[dir].hasTrustDialogAccepted).toBe(true);
  });
});

describe("markOnboarded", () => {
  it("sets hasCompletedOnboarding and keeps every other key", async () => {
    const { base, file } = await fx({ numStartups: 2, theme: "dark", projects: { "/x": { hasTrustDialogAccepted: true } } });
    expect(markOnboarded(file, join(base, "cfg"))).toBe("written");
    expect(await read(file)).toEqual({ numStartups: 2, theme: "dark", projects: { "/x": { hasTrustDialogAccepted: true } }, hasCompletedOnboarding: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("makes a missing file (mode 0600) with only the key: a fresh login has none", async () => {
    const { base, file } = await fx();
    expect(markOnboarded(file, join(base, "cfg"))).toBe("written");
    expect(await read(file)).toEqual({ hasCompletedOnboarding: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("makes no file when the login has the old .config.json (Claude reads that one then)", async () => {
    const warn = vi.fn();
    const { base, file } = await fx();
    await writeFile(join(base, "cfg", ".config.json"), "{}");
    expect(markOnboarded(file, join(base, "cfg"), warn)).toBe("missing");
    expect(existsSync(file)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not write when the key is already true; leaves bad JSON untouched with one [chief] warning", async () => {
    const done = await fx({ hasCompletedOnboarding: true });
    const before = (await stat(done.file)).mtimeMs;
    expect(markOnboarded(done.file, join(done.base, "cfg"))).toBe("already");
    expect((await stat(done.file)).mtimeMs).toBe(before);

    const warn = vi.fn();
    const bad = await fx(undefined, "{ not json");
    expect(markOnboarded(bad.file, join(bad.base, "cfg"), warn)).toBe("invalid");
    expect(await readFile(bad.file, "utf8")).toBe("{ not json");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[chief\] /);
  });
});

// The launcher of a spawn through the root helper: real /bin/sh and the real Node, with the env
// the helper gives an agent (env -i: HOME, PATH, CLAUDE_CONFIG_DIR). The "command" is Node,
// which prints its argv and ends with exit code 7, so the test sees that the exec keeps both.
describe("onboardedLaunch (a spawn through the helper)", () => {
  const ARGV_PRINTER = "console.log(JSON.stringify(process.argv.slice(1))); process.exit(7)";
  const ARGS = ["--flag", "a prompt with 'quotes', \"double\", $HOME and `ticks`"];
  const NODE_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  function launch(env: Record<string, string>) {
    const l = onboardedLaunch(process.execPath, ["-e", ARGV_PRINTER, "--", ...ARGS]);
    const r = spawnSync(l.command, l.args, { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
    return { status: r.status, argv: JSON.parse(r.stdout.trim() || "null"), stderr: r.stderr };
  }
  async function dirs() {
    const base = await realpath(await mkdtemp(join(tmpdir(), "claude-onboard-")));
    tmps.push(base);
    const home = join(base, "home"); const cfg = join(base, "cfg");
    await mkdir(home); await mkdir(cfg);
    return { base, home, cfg, file: join(cfg, ".claude.json") };
  }

  it("is a shell that runs Node, then execs the command: argv verbatim, its exit code, no output of its own", async () => {
    const d = await dirs();
    const l = onboardedLaunch("/opt/claude", ["--x"]);
    expect(l.command).toBe("/bin/sh");
    expect(l.args.slice(0, 2)).toEqual(["-c", 'node -e "$0" </dev/null >/dev/null 2>&1; exec "$@"']);
    expect(l.args.slice(-2)).toEqual(["/opt/claude", "--x"]);
    const r = launch({ HOME: d.home, PATH: NODE_PATH, CLAUDE_CONFIG_DIR: d.cfg });
    expect(r).toEqual({ status: 7, argv: ARGS, stderr: "" });
  });

  it("a fresh config dir with no file: the agent makes it, mode 0600, with only the key", async () => {
    const d = await dirs();
    launch({ HOME: d.home, PATH: NODE_PATH, CLAUDE_CONFIG_DIR: d.cfg });
    expect(await read(d.file)).toEqual({ hasCompletedOnboarding: true });
    expect((await stat(d.file)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(d.home, ".claude.json"))).toBe(false);
  });

  it("a file from the helper's repo-clone trust: keeps every key and the mode, leaves no temp file", async () => {
    const d = await dirs();
    const cfg = { projects: { "/srv/clones": { hasTrustDialogAccepted: true, allowedTools: [] } }, numStartups: 1 };
    await writeFile(d.file, JSON.stringify(cfg));
    await chmod(d.file, 0o640);
    expect(launch({ HOME: d.home, PATH: NODE_PATH, CLAUDE_CONFIG_DIR: d.cfg }).status).toBe(7);
    expect(await read(d.file)).toEqual({ ...cfg, hasCompletedOnboarding: true });
    expect((await stat(d.file)).mode & 0o777).toBe(0o640);
    expect(await readdir(d.cfg)).toEqual([".claude.json"]);
  });

  it("no CLAUDE_CONFIG_DIR: $HOME/.claude.json, as Claude reads it", async () => {
    const d = await dirs();
    launch({ HOME: d.home, PATH: NODE_PATH });
    expect(await read(join(d.home, ".claude.json"))).toEqual({ hasCompletedOnboarding: true });
  });

  it("writes nothing when the old .config.json is there, the key is true, or the file is not a JSON object; the command runs", async () => {
    const legacy = await dirs();
    await writeFile(join(legacy.cfg, ".config.json"), "{}");
    expect(launch({ HOME: legacy.home, PATH: NODE_PATH, CLAUDE_CONFIG_DIR: legacy.cfg }).argv).toEqual(ARGS);
    expect(existsSync(legacy.file)).toBe(false);
    const legacyHome = await dirs();
    await mkdir(join(legacyHome.home, ".claude"));
    await writeFile(join(legacyHome.home, ".claude", ".config.json"), "{}");
    launch({ HOME: legacyHome.home, PATH: NODE_PATH });
    expect(existsSync(join(legacyHome.home, ".claude.json"))).toBe(false);

    for (const raw of ["{ not json", "[1,2]", JSON.stringify({ hasCompletedOnboarding: true, a: 1 })]) {
      const d = await dirs();
      await writeFile(d.file, raw);
      const before = await stat(d.file);
      expect(launch({ HOME: d.home, PATH: NODE_PATH, CLAUDE_CONFIG_DIR: d.cfg }).argv).toEqual(ARGS);
      expect(await readFile(d.file, "utf8")).toBe(raw);
      expect((await stat(d.file)).mtimeMs).toBe(before.mtimeMs);
      expect(await readdir(d.cfg)).toEqual([".claude.json"]);
    }
  });

  it("follows a symlinked config file: the link stays, its target gets the key", async () => {
    const d = await dirs();
    const target = join(d.base, "real.json");
    await writeFile(target, JSON.stringify({ a: 1 }));
    await symlink(target, d.file);
    launch({ HOME: d.home, PATH: NODE_PATH, CLAUDE_CONFIG_DIR: d.cfg });
    expect((await lstat(d.file)).isSymbolicLink()).toBe(true);
    expect(await read(target)).toEqual({ a: 1, hasCompletedOnboarding: true });
  });

  // ONBOARD_JS with a hook (node -r) that plays the other writer at the worst time.
  async function withHook(d: { base: string; home: string; cfg: string }, hook: string) {
    const file = join(d.base, "hook.cjs");
    await writeFile(file, hook);
    const env: Record<string, string> = { HOME: d.home, PATH: NODE_PATH, CLAUDE_CONFIG_DIR: d.cfg };
    const r = spawnSync(process.execPath, ["-r", file, "-e", ONBOARD_JS], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
    expect(r.status).toBe(0);
  }
  // The helper's trust of a repo: its copy of the file, read before the mark, with no key.
  const OTHER = (file: string) => `
    const helperCopy = (f) => { const j = JSON.parse(fs.readFileSync(f, "utf8")); delete j.hasCompletedOnboarding;
      j.projects = { "/srv/clones/w1": { hasTrustDialogAccepted: true } };
      fs.writeFileSync(f + ".helper", JSON.stringify(j)); realRename(f + ".helper", f); };
    const file = ${JSON.stringify(file)};`;

  it("the helper's trust write lands just after the mark (no key): the script reads again and marks once more", async () => {
    const d = await dirs();
    await writeFile(d.file, JSON.stringify({ numStartups: 1 }));
    await withHook(d, `const fs = require("fs"); const realRename = fs.renameSync; let n = 0;
      ${OTHER(d.file)}
      fs.renameSync = function (a, b) { realRename(a, b); if (b === file && n++ === 0) helperCopy(file); };`);
    expect(await read(d.file)).toEqual({ numStartups: 1, projects: { "/srv/clones/w1": { hasTrustDialogAccepted: true } }, hasCompletedOnboarding: true });
    expect(await readdir(d.cfg)).toEqual([".claude.json"]);
  });

  it("the same race on a file the script made: it reads again and marks once more", async () => {
    const d = await dirs();
    await withHook(d, `const fs = require("fs"); const realRename = fs.renameSync; const realWrite = fs.writeFileSync; let n = 0;
      ${OTHER(d.file)}
      fs.writeFileSync = function (f) { const r = realWrite.apply(this, arguments); if (f === file && n++ === 0) helperCopy(file); return r; };`);
    expect(await read(d.file)).toEqual({ projects: { "/srv/clones/w1": { hasTrustDialogAccepted: true } }, hasCompletedOnboarding: true });
  });

  it("a temp name that is taken (EEXIST): the script deletes no file it did not make", async () => {
    const d = await dirs();
    await writeFile(d.file, JSON.stringify({ a: 1 }));
    await withHook(d, `const fs = require("fs"); const realWrite = fs.writeFileSync;
      fs.writeFileSync = function (f) {
        if (/[.]onboard-.*[.]tmp$/.test(f)) { realWrite(f, "NOT MINE"); const e = new Error("EEXIST"); e.code = "EEXIST"; throw e; }
        return realWrite.apply(this, arguments); };`);
    const left = (await readdir(d.cfg)).filter((n) => n.endsWith(".tmp"));
    expect(left).toHaveLength(1);
    expect(await readFile(join(d.cfg, left[0]), "utf8")).toBe("NOT MINE");
    expect(await read(d.file)).toEqual({ a: 1 });
  });

  it("no Node on PATH: no mark, and the command still starts as before", async () => {
    const d = await dirs();
    const r = launch({ HOME: d.home, PATH: join(d.base, "no-bin"), CLAUDE_CONFIG_DIR: d.cfg });
    expect(r).toEqual({ status: 7, argv: ARGS, stderr: "" });
    expect(existsSync(d.file)).toBe(false);
  });
});
