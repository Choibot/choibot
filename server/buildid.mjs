// server/buildid.mjs — the commit that a build records as its build id (.next/BUILD_ID; chief
// spec §5.7). next.config.mjs calls it at `next build`. Plain JS, node: builtins only: Next loads
// next.config.mjs before any TypeScript loader runs.
//
// The order:
//   1. CHOIBOT_BUILD_COMMIT: the release builder (scripts/release/build.sh) sets it. A value that
//      is not a full commit id stops the build: a release must never record a wrong id.
//   2. server/release-commit.txt: `git archive` writes the commit into it (export-subst in
//      .gitattributes). In a git checkout the file holds the placeholder, which is not a commit.
//   3. git HEAD of the folder (a git checkout: as before).
//   4. none: Next makes its own random id, and the console then knows no commit.
// A git checkout with no CHOIBOT_BUILD_COMMIT gets the same id as before: 2 never gives a commit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BUILD_COMMIT_ENV = "CHOIBOT_BUILD_COMMIT";
export const STAMP_FILE = join("server", "release-commit.txt");
const SHA = /^[0-9a-f]{40}$/;

function stampOf(dir) {
  try {
    return readFileSync(join(dir, STAMP_FILE), "utf8").trim();
  } catch {
    return "";
  }
}

function gitHeadOf(dir) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// The commit, or null. `o` is for the tests: env, dir, and the two reads.
export function buildCommit(o = {}) {
  const env = o.env ?? process.env;
  const dir = o.dir ?? process.cwd();
  const given = (env[BUILD_COMMIT_ENV] ?? "").trim();
  if (given) {
    if (!SHA.test(given)) throw new Error(`${BUILD_COMMIT_ENV} is not a full commit id (40 lower-case hex characters)`);
    return given;
  }
  const stamp = (o.stamp ?? stampOf)(dir);
  if (SHA.test(stamp)) return stamp;
  const head = (o.gitHead ?? gitHeadOf)(dir);
  return SHA.test(head) ? head : null;
}
