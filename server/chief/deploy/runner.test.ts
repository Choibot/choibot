// server/chief/deploy/runner.test.ts — the real runner.mjs on a scratch git checkout with a
// scratch origin (spec §5.7). tsc, next, pnpm and systemctl are stub scripts that log their
// calls: the test reads which ran (`calls`: without the restart guard's own calls; `all`: with
// them). systemd-run is a stub too. Nothing here touches a real unit or a real build. For the
// check, a small HTTP server stands in for the console: it serves the checkout's .next as it is
// at each request (page.html at /, static/* at /_next/static/*).
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "runner.mjs");
const UNIT = "choibot-scratch-test.service";
const GUARD = "choibot-scratch-test-deploy-guard";
const isGuard = (c: string): boolean => c.includes(GUARD);

let root: string;
let origin: string;
let work: string;   // a second clone: where "merged PRs" are made and pushed from
let live: string;   // the checkout the runner deploys
let bin: string;
let calls: string;
let stateFile: string;
let env: NodeJS.ProcessEnv;
let site: ChildProcess | null = null;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env }).trim();

function script(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

// A commit on origin/main, as a merged PR leaves it. Returns its id.
function merge(file: string, text: string, msg = `change ${file}`): string {
  git(work, "pull", "-q", "origin", "main");
  mkdirSync(dirname(join(work, file)), { recursive: true });
  writeFileSync(join(work, file), text);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", msg);
  git(work, "push", "-q", "origin", "main");
  return git(work, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-deploy-runner-"));
  origin = join(root, "origin.git"); work = join(root, "work"); live = join(root, "live"); bin = join(root, "bin");
  calls = join(root, "calls.log"); stateFile = join(root, "state", "state.json");
  // No user or system git config, no hooks from this host.
  env = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", CALLS: calls } as unknown as NodeJS.ProcessEnv;
  mkdirSync(bin, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
  execFileSync("git", ["clone", "-q", origin, work], { env, stdio: "ignore" });
  writeFileSync(join(work, "package.json"), '{"name":"scratch"}\n');
  writeFileSync(join(work, "app.ts"), "export const v = 1;\n");
  writeFileSync(join(work, ".gitignore"), "node_modules\n.next\n.next-build\n.next-prev\n.next-failed\n");
  writeFileSync(join(work, "next-env.d.ts"), '/// <reference path="./.next/types/routes.d.ts" />\n');
  writeFileSync(join(work, "next.config.mjs"), 'export default { distDir: process.env.CHOIBOT_DEPLOY_BUILD === "1" ? ".next-build" : ".next" };\n');
  git(work, "add", "-A"); git(work, "commit", "-q", "-m", "first"); git(work, "branch", "-M", "main"); git(work, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, live], { env, stdio: "ignore" });
  // The stubs. Each logs its call; a marker file in the checkout makes it fail.
  script(join(live, "node_modules", ".bin", "tsc"), 'echo "tsc $*" >> "$CALLS"\nif [ -f .fail-tsc ]; then echo "app.ts(1,1): error TS2322: wrong type"; exit 2; fi');
  // Like next.config.mjs: CHOIBOT_DEPLOY_BUILD=1 builds into .next-build, and Next rewrites
  // next-env.d.ts for that dir. The "build": BUILD_ID, a page that names it, and two static files
  // (.stale-page: the page links a file the build does not have, as on 2026-11-19; .other-page:
  // the page of a deploy build names another build).
  script(join(live, "node_modules", ".bin", "next"), [
    'echo "next $* CHOIBOT_DEPLOY_BUILD=${CHOIBOT_DEPLOY_BUILD:-}" >> "$CALLS"',
    'if [ -f .fail-next ]; then echo "Failed to compile." >&2; exit 1; fi',
    'd=.next; [ "${CHOIBOT_DEPLOY_BUILD:-}" = 1 ] && d=.next-build',
    'echo "/// <reference path=\"./$d/types/routes.d.ts\" />" > next-env.d.ts',
    'if [ -f .slow-next ]; then sleep 30; fi',
    'mkdir -p "$d/static/chunks" "$d/static/css" && echo a > "$d/static/chunks/app-a.js" && echo b > "$d/static/css/b.css"',
    'gone=""; [ -f .stale-page ] && gone=\'<script src="/_next/static/chunks/app-gone.js"></script>\'',
    'id="$(git rev-parse HEAD)"; [ -f .other-page ] && [ "$d" = .next-build ] && id=0000000000000000000000000000000000000000',
    'echo "<link href=\"/_next/static/css/b.css\"><script src=\"/_next/static/chunks/app-a.js\"></script>$gone<script>{\"b\":\"$id\"}</script>" > "$d/page.html"',
    'if [ ! -f .no-build-id ]; then git rev-parse HEAD > "$d/BUILD_ID"; fi',
  ].join("\n"));
  script(join(bin, "pnpm"), 'echo "pnpm $*" >> "$CALLS"\nif [ -f .fail-pnpm ]; then echo "ERR_PNPM_OUTDATED_LOCKFILE"; exit 1; fi');
  script(join(bin, "systemd-run"), 'echo "systemd-run $*" >> "$CALLS"\nif [ -f "$(dirname "$CALLS")/fail-guard" ]; then echo "Failed to start transient timer unit: Access denied"; exit 1; fi');
  script(join(bin, "systemctl"), [
    'echo "systemctl $*" >> "$CALLS"', 'm="$(dirname "$CALLS")"',
    'unit=no; case "$3" in *.service) unit=yes;; esac',
    'if [ "$2" = stop ] && [ $unit = yes ] && [ -f "$m/fail-stop" ]; then echo "Failed to stop: Access denied."; exit 1; fi',
    'if [ "$2" = stop ] && [ $unit = yes ] && [ -f "$m/slow-stop" ]; then sleep 30; fi',
    'if [ "$2" = start ] && [ -f "$m/fail-start-once" ]; then rm "$m/fail-start-once"; echo "Failed to start: Unit failed."; exit 1; fi',
  ].join("\n"));
  // The live build: what the console runs before the deploy (the stub, run once by hand).
  execFileSync(join(live, "node_modules", ".bin", "next"), ["build"], { cwd: live, env });
  mkdirSync(join(live, ".next", "cache"), { recursive: true });
  writeFileSync(join(live, ".next", "cache", "webpack.pack"), "build cache\n");
  writeFileSync(join(live, "next-env.d.ts"), '/// <reference path="./.next/types/routes.d.ts" />\n');
  rmSync(calls, { force: true });
});
afterEach(() => {
  site?.kill();
  site = null;
  rmSync(root, { recursive: true, force: true });
});

// The stand-in console on a free loopback port. Returns its URL.
function startSite(): string {
  const portFile = join(root, "site.port");
  const code = [
    'const http = require("node:http"), fs = require("node:fs"), path = require("node:path");',
    "const [dir, portFile] = process.argv.slice(1);",
    "const srv = http.createServer((req, res) => {",
    '  const b = path.join(dir, ".next");',
    '  if (req.url === "/") { try { res.end(fs.readFileSync(path.join(b, "page.html"))); } catch { res.statusCode = 500; res.end(); } return; }',
    "  const m = /^\\/_next\\/static\\/([a-z0-9/._-]+)$/.exec(req.url);",
    '  if (m && fs.existsSync(path.join(b, "static", m[1]))) { res.end("x"); return; }',
    "  res.statusCode = 404; res.end();",
    "});",
    'srv.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(srv.address().port)));',
  ].join("\n");
  site = spawn(process.execPath, ["-e", code, live, portFile], { stdio: "ignore" });
  const until = Date.now() + 10_000;
  while (!existsSync(portFile) && Date.now() < until) spawnSync("sleep", ["0.05"]);
  return `http://127.0.0.1:${readFileSync(portFile, "utf8").trim()}`;
}

type Cfg = { id: string; dir: string; unit: string; from: string; target: string; pnpm: string[]; stateFile: string; logFile: string; url?: string };

function run(target: string, o: Partial<Cfg> = {}, seed: Record<string, unknown> | null = {}): { code: number | null; state: Record<string, unknown>; calls: string[]; all: string[]; log: string } {
  const cfg: Cfg = {
    id: "d1", dir: live, unit: UNIT, from: git(live, "rev-parse", "HEAD"), target, pnpm: [join(bin, "pnpm")],
    stateFile, logFile: join(root, "state", "run-d1.log"), ...o,
  };
  mkdirSync(dirname(stateFile), { recursive: true });
  if (seed) writeFileSync(stateFile, JSON.stringify({ id: "d1", ticketId: "q12345678", via: "tab", phase: "running", step: "fetch", startedAt: 1, updatedAt: 1, from: cfg.from, to: target, ...seed }));
  const r = spawnSync(process.execPath, [RUNNER, JSON.stringify(cfg)], { env, encoding: "utf8", timeout: 60_000 });
  return {
    code: r.status,
    state: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown> : {},
    calls: callLines().filter((c) => !isGuard(c)),
    all: callLines(),
    log: existsSync(cfg.logFile) ? readFileSync(cfg.logFile, "utf8") : "",
  };
}

const head = (): string => git(live, "rev-parse", "HEAD");
const callLines = (): string[] => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
// The guard's calls as the runner makes them: replace a stale one and set it (arm), cancel it.
const ARM = [`systemctl --user stop ${GUARD}.timer`, `systemd-run --user --collect --quiet --unit=${GUARD} --on-active=300 --description=ChoiBot deploy guard d1 -- ${join("BIN", "systemctl")} --user start ${UNIT}`];
const CANCEL = `systemctl --user stop ${GUARD}.timer`;
const arm = (): string[] => ARM.map((c) => c.replace("BIN", bin));

describe("runner.mjs", () => {
  it("fast-forwards, typechecks, builds, and only then restarts the unit", () => {
    const before = head();
    const target = merge("app.ts", "export const v = 2;\n");
    const r = run(target);
    expect(r.code).toBe(0);
    expect(head()).toBe(target);
    expect(r.calls).toEqual(["tsc --noEmit", "next build CHOIBOT_DEPLOY_BUILD=1", `systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`]);
    // No check URL: the runner leaves the run at `restart`, and the new server writes the result.
    expect(r.state).toMatchObject({ id: "d1", phase: "running", step: "restart", from: before, to: target, skipped: ["install"] });
    expect(r.state.checks).toBeUndefined();
    // The build went into .next-build and was put in place while the unit was stopped.
    expect(readFileSync(join(live, ".next", "BUILD_ID"), "utf8").trim()).toBe(target);
    expect(readFileSync(join(live, ".next-prev", "BUILD_ID"), "utf8").trim()).toBe(before);
    expect(existsSync(join(live, ".next-build"))).toBe(false);
    expect(r.log.indexOf("mv .next .next-prev")).toBeGreaterThan(r.log.indexOf(`$ systemctl --user stop ${UNIT}`));
    expect(r.log.indexOf(`$ systemctl --user start ${UNIT}`)).toBeGreaterThan(r.log.indexOf("mv .next-build .next"));
    // The build cache moved with the build; next-env.d.ts, rewritten by the build, is put back.
    expect(readFileSync(join(live, ".next", "cache", "webpack.pack"), "utf8")).toBe("build cache\n");
    expect(readFileSync(join(live, "next-env.d.ts"), "utf8")).toBe('/// <reference path="./.next/types/routes.d.ts" />\n');
    expect(git(live, "status", "--porcelain")).toBe("");
  });

  it("installs with the frozen lockfile only when a package file changed", () => {
    const target = merge("package.json", '{"name":"scratch","version":"2"}\n');
    const r = run(target);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(["pnpm install --frozen-lockfile --prefer-offline", "tsc --noEmit", "next build CHOIBOT_DEPLOY_BUILD=1", `systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`]);
    expect(r.state.skipped).toBeUndefined();
  });

  it("the checkout is already at the commit (ahead of the build): no fast-forward, a build, a restart", () => {
    const from = head();
    const target = merge("app.ts", "export const v = 3;\n");
    git(live, "pull", "-q", "origin", "main");
    const r = run(target, { from });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(["tsc --noEmit", "next build CHOIBOT_DEPLOY_BUILD=1", `systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`]);
  });

  it("a failed typecheck restarts nothing and keeps the error tail", () => {
    const target = merge("app.ts", "export const v: string = 2;\n");
    writeFileSync(join(live, ".fail-tsc"), "");
    const r = run(target);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual(["tsc --noEmit"]);
    expect(r.state).toMatchObject({ phase: "failed", step: "typecheck", error: "the typecheck failed", tail: "app.ts(1,1): error TS2322: wrong type" });
    expect(typeof r.state.endedAt).toBe("number");
  });

  it("a failed build restarts nothing", () => {
    const target = merge("app.ts", "export const v = 4;\n");
    writeFileSync(join(live, ".fail-next"), "");
    const r = run(target);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual(["tsc --noEmit", "next build CHOIBOT_DEPLOY_BUILD=1"]);
    expect(r.state).toMatchObject({ phase: "failed", step: "build", error: "the build failed", tail: "Failed to compile." });
  });

  it("a failed install restarts nothing and builds nothing", () => {
    const target = merge("pnpm-lock.yaml", "lockfileVersion: 9\n");
    writeFileSync(join(live, ".fail-pnpm"), "");
    const r = run(target);
    expect(r.calls).toEqual(["pnpm install --frozen-lockfile --prefer-offline"]);
    expect(r.state).toMatchObject({ phase: "failed", step: "install", error: "pnpm install failed", tail: "ERR_PNPM_OUTDATED_LOCKFILE" });
  });

  it("a build that recorded another commit restarts nothing", () => {
    const target = merge("app.ts", "export const v = 5;\n");
    writeFileSync(join(live, ".no-build-id"), "");
    const r = run(target);
    expect(r.calls).toEqual(["tsc --noEmit", "next build CHOIBOT_DEPLOY_BUILD=1"]);
    expect(r.state).toMatchObject({ phase: "failed", step: "build" });
    expect(String(r.state.error)).toContain("the build did not record commit");
  });

  it("not a fast-forward: fails and changes nothing", () => {
    writeFileSync(join(live, "local.txt"), "a local commit\n");
    git(live, "add", "-A"); git(live, "commit", "-q", "-m", "local only");
    const before = head();
    const target = merge("app.ts", "export const v = 6;\n");
    const r = run(target);
    expect(r.code).toBe(1);
    expect(head()).toBe(before);
    expect(r.calls).toEqual([]);
    expect(r.state).toMatchObject({ phase: "failed", step: "fetch", error: "not a fast-forward: local main has commits that origin/main does not have" });
  });

  it("an uncommitted change in the way: fails, changes nothing, and never stashes or resets it", () => {
    const before = head();
    const target = merge("package.json", '{"name":"scratch","version":"3"}\n');
    writeFileSync(join(live, "package.json"), '{"name":"scratch","local":true}\n');
    const r = run(target);
    expect(r.code).toBe(1);
    expect(head()).toBe(before);
    expect(readFileSync(join(live, "package.json"), "utf8")).toBe('{"name":"scratch","local":true}\n');
    expect(git(live, "stash", "list")).toBe("");
    expect(r.calls).toEqual([]);
    expect(r.state).toMatchObject({ phase: "failed", step: "fast-forward", error: "the fast-forward was refused (uncommitted changes are in the way); nothing changed" });
    expect(String(r.state.tail)).toContain("package.json");
  });

  it("an uncommitted change that is not in the way stays as it is, and the deploy goes on", () => {
    writeFileSync(join(live, "package.json"), '{"name":"scratch","local":true}\n');
    const target = merge("app.ts", "export const v = 7;\n");
    const r = run(target);
    expect(r.code).toBe(0);
    expect(head()).toBe(target);
    expect(readFileSync(join(live, "package.json"), "utf8")).toBe('{"name":"scratch","local":true}\n');
    expect(r.calls.at(-1)).toBe(`systemctl --user start ${UNIT}`);
  });

  it("deploys only a commit that is on origin/main, and only from branch main", () => {
    const target = merge("app.ts", "export const v = 8;\n");
    // A commit that exists only in the checkout (an agent's work): refused.
    git(live, "checkout", "-q", "-b", "agent/x");
    writeFileSync(join(live, "evil.ts"), "x\n");
    git(live, "add", "-A"); git(live, "commit", "-q", "-m", "not merged");
    const local = head();
    git(live, "checkout", "-q", "main");
    const before = head();
    let r = run(local);
    expect(r.state).toMatchObject({ phase: "failed", step: "fetch", error: `commit ${local.slice(0, 7)} is not on origin/main` });
    expect(head()).toBe(before);
    git(live, "checkout", "-q", "agent/x");
    r = run(target);
    expect(r.state).toMatchObject({ phase: "failed", step: "fetch", error: "the checkout is on branch agent/x, not main" });
    expect(r.calls).toEqual([]);
  });

  it("a stop that systemd refuses: the new build is not put in place, the unit is started", () => {
    const before = head();
    const target = merge("app.ts", "export const v = 9;\n");
    writeFileSync(join(root, "fail-stop"), "");
    const r = run(target);
    expect(r.code).toBe(1);
    expect(r.calls.slice(-2)).toEqual([`systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`]);
    expect(r.state).toMatchObject({ phase: "failed", step: "restart", error: `systemctl stop ${UNIT} failed; the new build was not put in place`, tail: "Failed to stop: Access denied." });
    expect(readFileSync(join(live, ".next", "BUILD_ID"), "utf8").trim()).toBe(before);
  });

  it("a start that systemd refuses: the previous build goes back in place and starts", () => {
    const before = head();
    const target = merge("app.ts", "export const v = 13;\n");
    writeFileSync(join(root, "fail-start-once"), "");
    const r = run(target);
    expect(r.code).toBe(1);
    expect(r.calls.slice(-4)).toEqual([`systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`, `systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`]);
    expect(r.state).toMatchObject({ phase: "failed", step: "restart", error: `systemctl start ${UNIT} failed. Rolled back to the Next build of ${before.slice(0, 7)} (the server code stays at ${target.slice(0, 7)})`, tail: "Failed to start: Unit failed." });
    expect(readFileSync(join(live, ".next", "BUILD_ID"), "utf8").trim()).toBe(before);
    expect(readFileSync(join(live, ".next-failed", "BUILD_ID"), "utf8").trim()).toBe(target);
  });

  it("a failed build leaves the live .next as it was and keeps its build cache", () => {
    const before = head();
    const target = merge("app.ts", "export const v = 14;\n");
    writeFileSync(join(live, ".fail-next"), "");
    const r = run(target);
    expect(r.code).toBe(1);
    expect(readFileSync(join(live, ".next", "BUILD_ID"), "utf8").trim()).toBe(before);
    expect(readFileSync(join(live, ".next", "cache", "webpack.pack"), "utf8")).toBe("build cache\n");
    expect(existsSync(join(live, ".next-build"))).toBe(false);
    expect(readFileSync(join(live, "next-env.d.ts"), "utf8")).toBe('/// <reference path="./.next/types/routes.d.ts" />\n');
  });

  it("removes a .next-build that a crashed run left, and never uses it", () => {
    mkdirSync(join(live, ".next-build"), { recursive: true });
    writeFileSync(join(live, ".next-build", "stale.txt"), "from a crashed run\n");
    const target = merge("app.ts", "export const v = 15;\n");
    const r = run(target);
    expect(r.code).toBe(0);
    expect(r.log).toContain("removed a stale .next-build");
    // Before the typecheck: its route types never join it.
    expect(r.log.indexOf("removed a stale .next-build")).toBeLessThan(r.log.indexOf("$ "+join(live, "node_modules", ".bin", "tsc")));
    expect(existsSync(join(live, ".next", "stale.txt"))).toBe(false);
    expect(readFileSync(join(live, ".next", "BUILD_ID"), "utf8").trim()).toBe(target);
  });

  it("refuses to build a commit whose next.config.mjs does not build into .next-build", () => {
    const before = head();
    const target = merge("next.config.mjs", "export default {};\n");
    const r = run(target);
    expect(r.code).toBe(1);
    expect(r.state).toMatchObject({ phase: "failed", step: "build" });
    expect(String(r.state.error)).toContain("does not build into .next-build");
    expect(r.calls).toEqual(["tsc --noEmit"]);
    expect(readFileSync(join(live, ".next", "BUILD_ID"), "utf8").trim()).toBe(before);
  });

  it("puts back a next-env.d.ts that a killed build left naming .next-build", () => {
    writeFileSync(join(live, "next-env.d.ts"), '/// <reference path="./.next-build/types/routes.d.ts" />\n');
    const target = merge("app.ts", "export const v = 21;\n");
    const r = run(target);
    expect(r.code).toBe(0);
    expect(r.log).toContain("put back next-env.d.ts (it named .next-build)");
    expect(r.log.indexOf("put back next-env.d.ts (it named")).toBeLessThan(r.log.indexOf("$ " + join(live, "node_modules", ".bin", "tsc")));
    expect(git(live, "status", "--porcelain")).toBe("");
  });

  describe("a runner that is stopped (SIGTERM)", () => {
    // The runner in the background; the test waits for `marker` in the calls, then stops it.
    function stopWhen(target: string, marker: string): { state: Record<string, unknown>; calls: string[] } {
      const cfg: Cfg = {
        id: "d1", dir: live, unit: UNIT, from: head(), target, pnpm: [join(bin, "pnpm")], stateFile, logFile: join(root, "state", "run-d1.log"),
      };
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ id: "d1", ticketId: "q12345678", via: "tab", phase: "running", step: "fetch", startedAt: 1, updatedAt: 1, from: cfg.from, to: target }));
      const p = spawn(process.execPath, [RUNNER, JSON.stringify(cfg)], { env, stdio: "ignore" });
      const seen = (): boolean => existsSync(calls) && readFileSync(calls, "utf8").includes(marker);
      let until = Date.now() + 20_000;
      while (!seen() && Date.now() < until) spawnSync("sleep", ["0.05"]);
      spawnSync("sleep", ["0.2"]);
      p.kill("SIGTERM");
      until = Date.now() + 20_000;
      const ended = (): boolean => (JSON.parse(readFileSync(stateFile, "utf8")) as { phase: string }).phase !== "running";
      while (!ended() && Date.now() < until) spawnSync("sleep", ["0.05"]);
      return { state: JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>, calls: callLines().filter((c) => !isGuard(c)) };
    }

    it("during the build: next-env.d.ts is put back, nothing is swapped", () => {
      const before = head();
      writeFileSync(join(live, ".slow-next"), "");
      const target = merge("app.ts", "export const v = 22;\n");
      const r = stopWhen(target, "next build");
      expect(r.state).toMatchObject({ phase: "failed", step: "build", error: "the deploy was stopped (SIGTERM)" });
      expect(readFileSync(join(live, "next-env.d.ts"), "utf8")).toBe('/// <reference path="./.next/types/routes.d.ts" />\n');
      expect(readFileSync(join(live, ".next", "BUILD_ID"), "utf8").trim()).toBe(before);
      expect(r.calls.some((c) => c.startsWith("systemctl"))).toBe(false);
    });

    it("between the stop and the start: the unit is started before the runner exits", () => {
      writeFileSync(join(root, "slow-stop"), "");
      const target = merge("app.ts", "export const v = 23;\n");
      const r = stopWhen(target, `systemctl --user stop ${UNIT}`);
      expect(r.state).toMatchObject({ phase: "failed", step: "restart", error: "the deploy was stopped (SIGTERM)" });
      expect(r.calls.at(-1)).toBe(`systemctl --user start ${UNIT}`);
    });
  });

  describe("the restart guard (a timer that starts the unit if the runner dies after the stop)", () => {
    it("is set before the stop and cancelled after the start", () => {
      const target = merge("app.ts", "export const v = 24;\n");
      const r = run(target);
      expect(r.code).toBe(0);
      expect(r.all.slice(-5)).toEqual([...arm(), `systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`, CANCEL]);
    });

    it("is set again before the stop of a roll back; a start that failed leaves it set", () => {
      const target = merge("app.ts", "export const v = 25;\n");
      writeFileSync(join(root, "fail-start-once"), "");
      const r = run(target);
      expect(r.code).toBe(1);
      // stop, start (fails: the guard stays), then the roll back: a new guard, stop, start, cancel.
      expect(r.all.slice(-8)).toEqual([...arm(), `systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`, ...arm(), `systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`, CANCEL].slice(-8));
      expect(r.all.filter((c) => c.startsWith("systemd-run"))).toHaveLength(2);
    });

    it("a guard that cannot be set: the unit is not stopped, the new build is dropped", () => {
      const before = head();
      const target = merge("app.ts", "export const v = 26;\n");
      writeFileSync(join(root, "fail-guard"), "");
      const r = run(target);
      expect(r.code).toBe(1);
      expect(r.state).toMatchObject({ phase: "failed", step: "restart", error: "the restart guard could not be set (systemd-run failed); nothing was restarted", tail: "Failed to start transient timer unit: Access denied" });
      expect(r.all.some((c) => c.startsWith(`systemctl --user stop ${UNIT}`))).toBe(false);
      expect(readFileSync(join(live, ".next", "BUILD_ID"), "utf8").trim()).toBe(before);
      expect(existsSync(join(live, ".next-build"))).toBe(false);
    });

    it("a runner killed hard after the stop leaves the guard set (nobody cancels it)", () => {
      writeFileSync(join(root, "slow-stop"), "");
      const target = merge("app.ts", "export const v = 27;\n");
      const cfg: Cfg = { id: "d1", dir: live, unit: UNIT, from: head(), target, pnpm: [join(bin, "pnpm")], stateFile, logFile: join(root, "state", "run-d1.log") };
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ id: "d1", ticketId: "q12345678", via: "tab", phase: "running", step: "fetch", startedAt: 1, updatedAt: 1, from: cfg.from, to: target }));
      const p = spawn(process.execPath, [RUNNER, JSON.stringify(cfg)], { env, stdio: "ignore" });
      const until = Date.now() + 20_000;
      while (!callLines().includes(`systemctl --user stop ${UNIT}`) && Date.now() < until) spawnSync("sleep", ["0.05"]);
      spawnSync("sleep", ["0.2"]);
      p.kill("SIGKILL");
      spawnSync("sleep", ["0.5"]);
      const all = callLines();
      expect(all.slice(-3)).toEqual([...arm(), `systemctl --user stop ${UNIT}`]);
      expect(all.filter((c) => c === CANCEL)).toHaveLength(1); // only the "replace a stale one" before the set
    });

    it("a SIGTERM after the stop: the runner starts the unit and cancels the guard", () => {
      writeFileSync(join(root, "slow-stop"), "");
      const target = merge("app.ts", "export const v = 28;\n");
      const cfg: Cfg = { id: "d1", dir: live, unit: UNIT, from: head(), target, pnpm: [join(bin, "pnpm")], stateFile, logFile: join(root, "state", "run-d1.log") };
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ id: "d1", ticketId: "q12345678", via: "tab", phase: "running", step: "fetch", startedAt: 1, updatedAt: 1, from: cfg.from, to: target }));
      const p = spawn(process.execPath, [RUNNER, JSON.stringify(cfg)], { env, stdio: "ignore" });
      let until = Date.now() + 20_000;
      while (!callLines().includes(`systemctl --user stop ${UNIT}`) && Date.now() < until) spawnSync("sleep", ["0.05"]);
      spawnSync("sleep", ["0.2"]);
      p.kill("SIGTERM");
      until = Date.now() + 20_000;
      while (callLines().at(-1) !== CANCEL && Date.now() < until) spawnSync("sleep", ["0.05"]);
      expect(callLines().slice(-2)).toEqual([`systemctl --user start ${UNIT}`, CANCEL]);
    });
  });

  describe("the check after the restart (url)", () => {
    it("the page of the new build and every file it links answer 200: done, by the runner", () => {
      const before = head();
      const url = startSite();
      const target = merge("app.ts", "export const v = 16;\n");
      const r = run(target, { url });
      expect(r.code).toBe(0);
      expect(r.state).toMatchObject({ phase: "done", step: "check", checks: true, checked: 2, from: before, to: target });
      expect(typeof r.state.endedAt).toBe("number");
      expect(readFileSync(join(live, ".next", "BUILD_ID"), "utf8").trim()).toBe(target);
      expect(r.log).toContain(`check of build ${target.slice(0, 7)}: / and 2 files, 0 not 200`);
    });

    it("a page that links a file the build does not have: rolled back to the previous build, which passes", () => {
      const before = head();
      const url = startSite();
      const target = merge("app.ts", "export const v = 17;\n");
      writeFileSync(join(live, ".stale-page"), "");
      const r = run(target, { url });
      expect(r.code).toBe(1);
      expect(r.state).toMatchObject({
        phase: "failed", step: "check",
        error: `the new build failed the check: 1 of the 3 files the page links do not load. Rolled back to the Next build of ${before.slice(0, 7)} (the server code stays at ${target.slice(0, 7)}): it passes the check`,
        tail: "404 /_next/static/chunks/app-gone.js",
      });
      expect(r.calls.slice(-4)).toEqual([`systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`, `systemctl --user stop ${UNIT}`, `systemctl --user start ${UNIT}`]);
      // The previous build runs again; the failed one is kept; no second build ran.
      expect(readFileSync(join(live, ".next", "BUILD_ID"), "utf8").trim()).toBe(before);
      expect(readFileSync(join(live, ".next-failed", "BUILD_ID"), "utf8").trim()).toBe(target);
      expect(readFileSync(join(live, ".next", "cache", "webpack.pack"), "utf8")).toBe("build cache\n");
      expect(r.calls.filter((c) => c.startsWith("next build"))).toHaveLength(1);
      // HEAD stays at the target: the runner never resets.
      expect(head()).toBe(target);
    });

    it("a page that is not from the new build fails the check", () => {
      const before = head();
      const url = startSite();
      const target = merge("app.ts", "export const v = 18;\n");
      writeFileSync(join(live, ".other-page"), "");
      const r = run(target, { url });
      expect(r.state).toMatchObject({
        phase: "failed", step: "check",
        error: `the new build failed the check: the page is not from build ${target.slice(0, 7)}. Rolled back to the Next build of ${before.slice(0, 7)} (the server code stays at ${target.slice(0, 7)}): it passes the check`,
      });
    });

    it("refuses a url that is not loopback", () => {
      const target = merge("app.ts", "export const v = 20;\n");
      expect(run(target, { url: "http://example.com:3100" }).code).toBe(1);
      expect(run(target, { url: "http://127.0.0.1:3100/x" }).code).toBe(1);
      expect(existsSync(calls)).toBe(false);
    });
  });

  it("refuses a config that is not the console's: no unit name, no full commit id", () => {
    const target = merge("app.ts", "export const v = 10;\n");
    expect(run(target, { unit: "choibot.service; rm -rf /" }).code).toBe(1);
    expect(run("main").code).toBe(1);
    expect(run(target, { dir: "relative/path" }).code).toBe(1);
    expect(existsSync(calls)).toBe(false);
    expect(head()).not.toBe(target);
  });

  it("never writes into another run's state", () => {
    const target = merge("app.ts", "export const v = 11;\n");
    const r = run(target, {}, { id: "d2", step: "build" });
    expect(r.code).toBe(1);
    expect(r.state).toMatchObject({ id: "d2", phase: "running", step: "build" });
    expect(r.calls).toEqual([]);
  });

  it("runs no hook of the checkout", () => {
    script(join(live, ".git", "hooks", "post-merge"), 'echo "hook ran" >> "$CALLS"');
    const target = merge("app.ts", "export const v = 12;\n");
    const r = run(target);
    expect(r.code).toBe(0);
    expect(r.calls).not.toContain("hook ran");
  });
});
