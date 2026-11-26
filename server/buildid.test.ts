// server/buildid.test.ts — the commit that a build records (server/buildid.mjs): the release
// builder's setting, the commit that `git archive` wrote, git HEAD, or none. A git checkout gets
// the id it got before.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_COMMIT_ENV, STAMP_FILE, buildCommit } from "./buildid.mjs";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const none = () => "";

describe("buildCommit", () => {
  it("takes the release builder's setting first", () => {
    expect(buildCommit({ env: { [BUILD_COMMIT_ENV]: A }, stamp: () => B, gitHead: () => C })).toBe(A);
    expect(buildCommit({ env: { [BUILD_COMMIT_ENV]: ` ${A}\n` }, stamp: none, gitHead: none })).toBe(A);
  });

  it("stops the build on a setting that is not a full commit id", () => {
    for (const bad of ["abc1234", A.toUpperCase(), `${A}0`, "main"]) {
      expect(() => buildCommit({ env: { [BUILD_COMMIT_ENV]: bad }, stamp: () => B, gitHead: () => C })).toThrow(/not a full commit id/);
    }
  });

  it("then the commit that git archive wrote, before git HEAD", () => {
    expect(buildCommit({ env: {}, stamp: () => B, gitHead: () => C })).toBe(B);
  });

  it("takes git HEAD in a checkout: the placeholder is not a commit (as before)", () => {
    expect(buildCommit({ env: {}, stamp: () => "$Format:%H$", gitHead: () => C })).toBe(C);
    expect(buildCommit({ env: { [BUILD_COMMIT_ENV]: "" }, stamp: none, gitHead: () => C })).toBe(C);
  });

  it("gives null with none of them (Next then makes its own id)", () => {
    expect(buildCommit({ env: {}, stamp: none, gitHead: none })).toBeNull();
    expect(buildCommit({ env: {}, stamp: () => "not a commit", gitHead: () => "fatal: not a git repository" })).toBeNull();
  });
});

// The real files: this repo's .gitattributes and placeholder, in a new repo, through `git archive`.
describe("git archive writes the commit into the stamp file", () => {
  let dir: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "buildid-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("holds the archived commit, and the checkout keeps the placeholder", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "server"), { recursive: true });
    copyFileSync(join(process.cwd(), ".gitattributes"), join(repo, ".gitattributes"));
    copyFileSync(join(process.cwd(), STAMP_FILE), join(repo, STAMP_FILE));
    writeFileSync(join(repo, "package.json"), "{}\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "one");
    const commit = git(repo, "rev-parse", "HEAD");

    const out = join(dir, "out");
    mkdirSync(out);
    execFileSync("sh", ["-c", 'git -C "$1" archive --format=tar HEAD | tar -x -C "$2"', "sh", repo, out]);
    expect(readFileSync(join(out, STAMP_FILE), "utf8").trim()).toBe(commit);
    // The archive's folder has no git: the stamp decides.
    expect(buildCommit({ env: {}, dir: out })).toBe(commit);
    // The checkout itself: the placeholder, so git HEAD decides (the same id as before).
    expect(readFileSync(join(repo, STAMP_FILE), "utf8").trim()).toBe("$Format:%H$");
    expect(buildCommit({ env: {}, dir: repo })).toBe(commit);
  });
});
