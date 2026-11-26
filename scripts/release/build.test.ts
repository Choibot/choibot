// scripts/release/build.test.ts — the version that build.sh gives a commit (--print-version: no
// build, no download): the first-parent count, or a public tree's release-source.json, and the
// refusals of the format (release-format.md section 2). A small git repo of its own for each case.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BUILD = join(process.cwd(), "scripts", "release", "build.sh");
const SRC_A = "a".repeat(40), SRC_B = "b".repeat(40), SRC_C = "c".repeat(40);
const source = (version: number, commit: string) => `${JSON.stringify({ v: 1, version, commit })}\n`;

// This tree holds release-source.json (the export writes it): its releases keep the number of
// their source commit.
describe("this tree", () => {
  it("holds release-source.json of the format, and build.sh --print-version gives its number", () => {
    const text = readFileSync(join(process.cwd(), "release-source.json"), "utf8");
    expect(text).toMatch(/^\{"v":1,"version":[1-9][0-9]*,"commit":"[0-9a-f]{40}"\}\n$/);
    const { version } = JSON.parse(text) as { version: number };
    // A clone of this checkout, with its HEAD as its origin/main (a new repo has no remote).
    const dir = mkdtempSync(join(tmpdir(), "release-tree-"));
    try {
      const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmpdir(), LANG: "C.UTF-8" };
      const clone = join(dir, "r");
      execFileSync("git", ["clone", "-q", "--no-hardlinks", process.cwd(), clone], { env });
      const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8", env }).trim();
      execFileSync("git", ["-C", clone, "update-ref", "refs/remotes/origin/main", head], { env });
      expect(execFileSync("git", ["-C", clone, "show", `${head}:release-source.json`], { encoding: "utf8", env })).toBe(text);
      const r = spawnSync("bash", [BUILD, "--repo", clone, "--ref", head, "--print-version"], { encoding: "utf8", env });
      expect([r.status, r.stdout]).toEqual([0, `${version} ${head}\n`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// /etc/os-release sets NAME and VERSION: sourced in the builder's own shell, it replaced the
// release's number and the tar's name (release 845 stopped on it). It is read in a subshell only.
describe("build.sh and /etc/os-release", () => {
  it("never sources /etc/os-release into its own shell", () => {
    const lines = readFileSync(BUILD, "utf8").split("\n").filter((l) => /(^|[;&|]\s*)(\.|source)\s+\/etc\/os-release/.test(l) && !/\$\(\s*\.\s+\/etc\/os-release/.test(l));
    expect(lines, "build.sh sources /etc/os-release in its own shell: read it in a subshell, $( . /etc/os-release && … )").toEqual([]);
  });
});

describe("build.sh --print-version", () => {
  let repo: string;
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmpdir(), LANG: "C.UTF-8" };
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env }).trim();
  // One commit with these files; returns its id.
  const commit = (files: Record<string, string>, msg = "c") => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(repo, p, ".."), { recursive: true });
      writeFileSync(join(repo, p), text);
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const main = () => git("update-ref", "refs/remotes/origin/main", "HEAD");
  const print = (ref: string, ...more: string[]) => spawnSync("bash", [BUILD, "--repo", repo, "--ref", ref, "--print-version", ...more], { encoding: "utf8", env });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "release-version-"));
    git("init", "-q");
    commit({ "server/buildid.mjs": "// stand-in\n", "package.json": "{}\n" }, "one");
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it("gives the first-parent count with no release-source.json (the private repo)", () => {
    commit({ "a.txt": "1" });
    const head = commit({ "a.txt": "2" });
    main();
    const r = print("HEAD");
    expect([r.status, r.stdout]).toEqual([0, `3 ${head}\n`]);
  });

  it("gives a public tree's version from its file, export after export", () => {
    const first = commit({ "release-source.json": source(840, SRC_A) }, "export 840");
    const second = commit({ "release-source.json": source(842, SRC_B), "a.txt": "new" }, "export 842");
    main();
    expect(print(first).stdout).toBe(`840 ${first}\n`);
    expect(print(second).stdout).toBe(`842 ${second}\n`);
  });

  it("refuses a public commit that is not an export: the same file as its first parent", () => {
    commit({ "release-source.json": source(842, SRC_B) }, "export 842");
    const readme = commit({ "README.md": "a fix in the public repo" }, "readme");
    main();
    const r = print(readme);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the first parent holds the same release-source.json: this commit is not an export (no new source)");
    expect(r.stdout).toBe("");
  });

  it("refuses a number that does not go up, and a file of another form", () => {
    commit({ "release-source.json": source(842, SRC_B) }, "export 842");
    const lower = commit({ "release-source.json": source(841, SRC_C) }, "export 841");
    main();
    expect(print(lower).stderr).toContain("version 841 is not greater than 842 of the first parent");
    for (const bad of [
      `${JSON.stringify({ v: 1, version: 843, commit: SRC_C, extra: 1 })}\n`,
      `${JSON.stringify({ v: 1, version: "843", commit: SRC_C })}\n`,
      `${JSON.stringify({ v: 2, version: 843, commit: SRC_C })}\n`,
      `${JSON.stringify({ v: 1, version: 843, commit: "abc1234" })}\n`,
      JSON.stringify({ v: 1, version: 843, commit: SRC_C }),
      `${JSON.stringify({ v: 1, version: 843, commit: SRC_C })}\n\n`,
    ]) {
      const c = commit({ "release-source.json": bad }, "bad");
      main();
      const r = print(c);
      expect([bad, r.status]).toEqual([bad, 1]);
      expect(r.stderr).toContain("release-source.json of");
    }
  });

  it("still refuses a commit off origin/main's first-parent line, and names a proof", () => {
    main();
    const off = commit({ "release-source.json": source(850, SRC_A) }, "not merged");
    expect(print(off).stderr).toContain("is not on the first-parent line of origin/main");
    const r = print(off, "--unmerged");
    expect([r.status, r.stdout]).toEqual([0, `850 ${off}\n`]);
  });
});
