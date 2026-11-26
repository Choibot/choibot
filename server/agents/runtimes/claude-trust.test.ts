import { afterEach, describe, it, expect, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustClaudeDir } from "./claude-trust.js";

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
