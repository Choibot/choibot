#!/usr/bin/env node
// server/chief/deploy/runner.mjs — the deploy flow of the console's own checkout (spec §5.7):
// fast-forward main to the commit the console named, install when a package file changed,
// typecheck, build, and restart the console's unit ONLY when every step before it passed.
//
// The build goes into .next-build, never into the .next that the running server reads: a server
// that renders a page while `next build` rewrites its .next mixes the two builds and writes the
// result into the new .next, where the new server serves it (incident 2026-11-19). The restart
// stops the unit, puts .next-build in place as .next (the old build stays as .next-prev) and
// starts the unit. Then the check: GET / on the new server and every /_next/static file the page
// links must answer 200, and the page must be from the new build. A failed check puts .next-prev
// back (two renames, no second build) and starts the unit again.
//
// The restart guard: before each stop, a transient timer (systemd-run --on-active) that starts the
// unit in GUARD_S seconds, cancelled after the start. A runner killed hard (SIGKILL, OOM) between
// the stop and the start leaves the timer, and the timer starts the console: Restart=on-failure
// never starts a unit that was stopped cleanly. Starting a running unit does nothing.
//
// The console starts it in its own transient systemd user unit, so the restart does not kill it.
// Plain JS, node: builtins only, all loaded before the first step: the fast-forward replaces this
// file on disk while it runs.
//
// argv[2] is one JSON object, built by the console from its own config and never from a request:
//   { id, dir, unit, from, target, pnpm: string[], stateFile, logFile, url? }
// url: the console's own loopback address. With it the runner checks the new server and writes
// the result itself (`checks: true` in the state); without it the new server writes the result at
// its boot, as before.
// The runner writes its progress into stateFile ({step, phase, error, tail}); the console shows
// it on the ticket. It never merges a branch, never resets, never stashes, never pushes.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BRANCH = "main";
const REMOTE = "origin";
const REMOTE_REF = `refs/remotes/${REMOTE}/${BRANCH}`;
const PACKAGE_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
const SHA = /^[0-9a-f]{40}$/;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,120}\.service$/;
const TAIL_MAX = 1500;
const MIN = 60_000;
const TIMEOUT = { git: 2 * MIN, install: 15 * MIN, typecheck: 15 * MIN, build: 30 * MIN, restart: 2 * MIN, boot: 2 * MIN, get: 15_000 };
// The dist dirs (next.config.mjs builds into BUILD with CHOIBOT_DEPLOY_BUILD=1).
const LIVE = ".next";
const BUILD = ".next-build";
const PREV = ".next-prev";
const FAILED = ".next-failed";
// Tracked files that `next build` rewrites for its dist dir (next-env.d.ts names .next-build):
// the runner puts their bytes back after the build, so the checkout stays clean.
const BUILD_REWRITES = ["next-env.d.ts", "tsconfig.json"];
// Longer than a stop and a start can take together (TIMEOUT.restart each), so the guard never
// fires while the runner itself keeps the unit stopped.
const GUARD_S = 300;
const URL_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/;
// Console git never runs a hook or a filesystem monitor of the checkout.
const GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];

function parseConfig(raw) {
  let c;
  try { c = JSON.parse(raw ?? ""); } catch { throw new Error("argv[2] must be the runner's JSON config"); }
  const str = (k) => { if (typeof c?.[k] !== "string" || c[k] === "") throw new Error(`config.${k} is missing`); return c[k]; };
  const cfg = { id: str("id"), dir: str("dir"), unit: str("unit"), from: str("from"), target: str("target"), stateFile: str("stateFile"), logFile: str("logFile") };
  if (!SHA.test(cfg.target)) throw new Error("config.target must be a full commit id");
  if (!UNIT.test(cfg.unit)) throw new Error("config.unit must be a systemd service name");
  if (!cfg.dir.startsWith("/")) throw new Error("config.dir must be an absolute path");
  if (!Array.isArray(c.pnpm) || c.pnpm.length === 0 || c.pnpm.some((a) => typeof a !== "string" || a === "")) throw new Error("config.pnpm must be an argv");
  if (c.url !== undefined && (typeof c.url !== "string" || !URL_RE.test(c.url))) throw new Error("config.url must be the console's loopback address");
  return { ...cfg, pnpm: c.pnpm, url: c.url ?? null };
}

let cfg;
let step = "fetch";
let child = null;
// While `next build` runs: the bytes of the files it rewrites (put back on every exit path).
let kept = null;
// Between the stop of the unit and its start: a stopped runner starts the unit before it exits.
let unitStopped = false;
// The restart guard timer is set (see armGuard).
let guarded = false;

function log(line) {
  try { appendFileSync(cfg.logFile, `${line}\n`); } catch { /* the log is best effort */ }
}

// Read-modify-write of the state file (tmp + rename). Another run's state is never touched.
function writeState(patch) {
  let cur;
  try { cur = JSON.parse(readFileSync(cfg.stateFile, "utf8")); } catch { cur = null; }
  if (!cur || cur.id !== cfg.id) { log(`state file is not run ${cfg.id}'s: no write`); return false; }
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  const tmp = `${cfg.stateFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, cfg.stateFile);
  return true;
}

const strip = (s) => s.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r/g, "\n");
function tailOf(out) {
  const t = strip(out).split("\n").map((l) => l.trimEnd()).filter((l) => l !== "").join("\n");
  return t.length > TAIL_MAX ? `…${t.slice(t.length - TAIL_MAX)}` : t;
}

class StepError extends Error {
  constructor(message, tail = "") { super(message); this.tail = tail; }
}

// Runs one command in the checkout. Resolves { code, out } (out: stdout and stderr together).
function run(cmd, args, timeoutMs, env = undefined) {
  log(`$ ${cmd} ${args.join(" ")}`);
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (code, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child = null;
      if (extra) { out += `\n${extra}`; log(extra); }
      resolve({ code, out });
    };
    // Own process group: a timeout or a stop ends the whole command tree.
    const p = spawn(cmd, args, { cwd: cfg.dir, stdio: ["ignore", "pipe", "pipe"], detached: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
    child = p;
    const take = (d) => {
      const s = String(d);
      out += s;
      if (out.length > 200_000) out = out.slice(-100_000);
      try { appendFileSync(cfg.logFile, s); } catch { /* best effort */ }
    };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    const timer = setTimeout(() => {
      try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ }
      finish(-1, `timed out after ${Math.round(timeoutMs / 1000)} s`);
    }, timeoutMs);
    p.on("error", (e) => finish(-1, `cannot run ${cmd}: ${e.message}`));
    p.on("close", (code, signal) => finish(code ?? -1, signal ? `ended by ${signal}` : ""));
  });
}

const git = (args, timeoutMs = TIMEOUT.git) => run("git", [...GIT, "-C", cfg.dir, ...args], timeoutMs);

async function must(what, p) {
  const r = await p;
  if (r.code !== 0) throw new StepError(what, tailOf(r.out));
  return r.out.trim();
}

function enter(name) {
  step = name;
  log(`== ${name}`);
  if (!writeState({ step: name })) throw new StepError("another deploy took over");
}

async function main() {
  cfg = parseConfig(process.argv[2]);
  mkdirSync(dirname(cfg.logFile), { recursive: true, mode: 0o700 });
  log(`deploy ${cfg.id}: ${cfg.dir} ${cfg.from} -> ${cfg.target} (unit ${cfg.unit})`);

  enter("fetch");
  if (cfg.url) writeState({ checks: true });
  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"])).out.trim();
  if (branch !== BRANCH) throw new StepError(`the checkout is on ${branch ? `branch ${branch}` : "no branch"}, not ${BRANCH}`);
  await must(`git fetch ${REMOTE} ${BRANCH} failed`, git(["fetch", "--no-tags", REMOTE, `+refs/heads/${BRANCH}:${REMOTE_REF}`]));
  // Only a commit that is on origin/main is ever deployed.
  if ((await git(["merge-base", "--is-ancestor", cfg.target, REMOTE_REF])).code !== 0) {
    throw new StepError(`commit ${cfg.target.slice(0, 7)} is not on ${REMOTE}/${BRANCH}`);
  }
  const head = await must("cannot read HEAD", git(["rev-parse", "--verify", "HEAD^{commit}"]));
  if ((await git(["merge-base", "--is-ancestor", head, cfg.target])).code !== 0) {
    throw new StepError(`not a fast-forward: local ${BRANCH} has commits that ${REMOTE}/${BRANCH} does not have`);
  }

  enter("fast-forward");
  if (head !== cfg.target) {
    // All or nothing: git refuses, and changes no file, when an uncommitted change is in the way.
    await must("the fast-forward was refused (uncommitted changes are in the way); nothing changed", git(["merge", "--ff-only", "--no-edit", cfg.target]));
  }
  const now = await must("cannot read HEAD", git(["rev-parse", "--verify", "HEAD^{commit}"]));
  if (now !== cfg.target) throw new StepError(`HEAD is ${now.slice(0, 7)} after the fast-forward, not ${cfg.target.slice(0, 7)}`);

  // Install only when a package file changed since the live build (an unknown live commit: install).
  let install = true;
  if (SHA.test(cfg.from)) {
    const diff = await git(["diff", "--name-only", cfg.from, cfg.target, "--", ...PACKAGE_FILES]);
    if (diff.code === 0) install = diff.out.trim() !== "";
  }
  if (!install) writeState({ skipped: ["install"] });
  if (install) {
    enter("install");
    await must("pnpm install failed", run(cfg.pnpm[0], [...cfg.pnpm.slice(1), "install", "--frozen-lockfile", "--prefer-offline"], TIMEOUT.install));
  }

  enter("typecheck");
  // A .next-build that a crashed run left: never reused, and its route types would join the
  // typecheck (tsconfig.json includes .next-build/types). A run killed during its build can also
  // leave next-env.d.ts naming .next-build.
  removeStaleBuild();
  healNextEnv();
  await must("the typecheck failed", run(join(cfg.dir, "node_modules", ".bin", "tsc"), ["--noEmit"], TIMEOUT.typecheck));

  enter("build");
  await build();

  // Every step passed: only now the restart.
  enter("restart");
  const prev = buildIdOf(LIVE);
  await swapIn(prev);
  if (!cfg.url) { log("restarted; the new server writes the result"); return; }

  enter("check");
  const c = await checkSite(cfg.target);
  if (!c.ok) await rollBack(`the new build failed the check: ${c.why}`, c.tail, prev);
  writeState({ phase: "done", checked: c.files, endedAt: Date.now() });
  log(`done: / and ${c.files} files of build ${short(cfg.target)} answer 200`);
}

const short = (sha) => (sha ? sha.slice(0, 7) : "unknown");
const at = (name) => join(cfg.dir, name);
const rmrf = (name) => rmSync(at(name), { recursive: true, force: true });
const move = (from, to) => { renameSync(at(from), at(to)); log(`mv ${from} ${to}`); };

function buildIdOf(dir) {
  try { return readFileSync(at(join(dir, "BUILD_ID")), "utf8").trim(); } catch { return ""; }
}

// `next build` into .next-build. The running server's .next is not touched; Next's build cache
// moves over (a rename) so the build stays incremental, and goes back if the build fails.
// next-env.d.ts as `next build` writes it for .next-build, back to .next (the committed text).
function healNextEnv() {
  const f = at("next-env.d.ts");
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return; }
  const fixed = text.replace(`/// <reference path="./${BUILD}/types/routes.d.ts" />`, `/// <reference path="./${LIVE}/types/routes.d.ts" />`);
  if (fixed !== text) { writeFileSync(f, fixed); log(`put back next-env.d.ts (it named ${BUILD})`); }
}

function putBack() {
  if (!kept) return;
  for (const [f, bytes] of kept) {
    try {
      if (bytes && !readFileSync(at(f)).equals(bytes)) { writeFileSync(at(f), bytes); log(`put back ${f} (the build rewrote it)`); }
    } catch (e) { log(`cannot put back ${f}: ${e instanceof Error ? e.message : e}`); }
  }
  kept = null;
}

// Back to .next: the build cache, after a build that is not put in place.
function cacheBack(from) {
  try {
    if (existsSync(at(join(from, "cache"))) && !existsSync(at(join(LIVE, "cache")))) move(join(from, "cache"), join(LIVE, "cache"));
  } catch (e) { log(`the build cache stays in ${from}: ${e instanceof Error ? e.message : e}`); }
}

function removeStaleBuild() {
  if (!existsSync(at(BUILD))) return;
  // Its build cache is kept when .next has none.
  if (existsSync(at(join(BUILD, "cache"))) && !existsSync(at(join(LIVE, "cache")))) move(join(BUILD, "cache"), join(LIVE, "cache"));
  rmrf(BUILD);
  log(`removed a stale ${BUILD}`);
}

async function build() {
  // A next.config.mjs that does not read CHOIBOT_DEPLOY_BUILD (a revert, say) builds into the .next
  // that the running server reads: the 2026-11-19 incident. Refused before anything is built.
  let config = "";
  try { config = readFileSync(at("next.config.mjs"), "utf8"); } catch { /* checked below */ }
  if (!config.includes("CHOIBOT_DEPLOY_BUILD")) {
    throw new StepError(`next.config.mjs of ${short(cfg.target)} does not build into ${BUILD}: a build now would write the .next of the running console. Nothing was built`);
  }
  removeStaleBuild();
  mkdirSync(at(BUILD), { recursive: true });
  if (existsSync(at(join(LIVE, "cache")))) move(join(LIVE, "cache"), join(BUILD, "cache"));
  kept = BUILD_REWRITES.map((f) => { try { return [f, readFileSync(at(f))]; } catch { return [f, null]; } });
  let r;
  try {
    r = await run(join(cfg.dir, "node_modules", ".bin", "next"), ["build"], TIMEOUT.build, { CHOIBOT_DEPLOY_BUILD: "1" });
  } finally {
    putBack();
  }
  const built = buildIdOf(BUILD);
  const why = r.code !== 0 ? "the build failed"
    : built !== cfg.target ? `the build did not record commit ${short(cfg.target)} (${BUILD}/BUILD_ID is ${built.slice(0, 12) || "missing"})` : "";
  if (!why) return;
  dropBuild();
  throw new StepError(why, r.code !== 0 ? tailOf(r.out) : "");
}

// A build that is not put in place: its cache back to .next, the rest removed.
function dropBuild() {
  cacheBack(BUILD);
  try { rmrf(BUILD); } catch (e) { log(`cannot remove ${BUILD}: ${e instanceof Error ? e.message : e}`); }
}

const systemctl = async (verb) => {
  if (verb === "stop") unitStopped = true;
  const r = await run("systemctl", ["--user", verb, cfg.unit], TIMEOUT.restart);
  if (verb === "start") {
    unitStopped = false;
    // A start that failed keeps the guard: it tries the start again later.
    if (r.code === 0) await disarmGuard();
  }
  return r;
};

const guardUnit = () => `${cfg.unit.replace(/\.service$/, "")}-deploy-guard`;

// systemd-run resolves a bare name itself; an absolute path makes the guard's command plain.
function systemctlPath() {
  for (const d of (process.env.PATH ?? "").split(":")) if (d && existsSync(join(d, "systemctl"))) return join(d, "systemctl");
  return "/usr/bin/systemctl";
}

// The timer that starts the unit if this runner dies before its start. A guard that a killed
// run left is replaced. Throws when it cannot be set: then the unit is not stopped.
async function armGuard() {
  await run("systemctl", ["--user", "stop", `${guardUnit()}.timer`], TIMEOUT.restart);
  const r = await run("systemd-run", [
    "--user", "--collect", "--quiet", `--unit=${guardUnit()}`, `--on-active=${GUARD_S}`,
    `--description=ChoiBot deploy guard ${cfg.id}`, "--", systemctlPath(), "--user", "start", cfg.unit,
  ], TIMEOUT.restart);
  if (r.code !== 0) throw new StepError("the restart guard could not be set (systemd-run failed)", tailOf(r.out));
  guarded = true;
}

// A cancel that fails only leaves one start of a running unit for later: nothing.
async function disarmGuard() {
  if (!guarded) return;
  const r = await run("systemctl", ["--user", "stop", `${guardUnit()}.timer`], TIMEOUT.restart);
  if (r.code === 0) guarded = false;
  else log("the restart guard stays set: it will start a running unit, which does nothing");
}

// A rename that undoes a half swap: best effort, never in the way of the start after it.
function undo(from, to) {
  try { if (!existsSync(at(to)) && existsSync(at(from))) move(from, to); } catch (e) { log(`cannot mv ${from} ${to}: ${e instanceof Error ? e.message : e}`); }
}

// Stop the unit, put .next-build in place as .next (the old one becomes .next-prev), start it.
// The old server is stopped before the swap: it never reads or writes the new build.
async function swapIn(prev) {
  try {
    await armGuard();
  } catch (e) {
    dropBuild();
    throw new StepError(`${e.message}; nothing was restarted`, e.tail);
  }
  const stop = await systemctl("stop");
  if (stop.code !== 0) {
    await systemctl("start");
    dropBuild();
    throw new StepError(`systemctl stop ${cfg.unit} failed; the new build was not put in place`, tailOf(stop.out));
  }
  try {
    rmrf(PREV);
    if (existsSync(at(LIVE))) move(LIVE, PREV);
    move(BUILD, LIVE);
  } catch (e) {
    undo(PREV, LIVE);
    await systemctl("start");
    throw new StepError(`the new build could not be put in place (${e instanceof Error ? e.message : e}); the old build runs`);
  }
  const start = await systemctl("start");
  if (start.code !== 0) await rollBack(`systemctl start ${cfg.unit} failed`, tailOf(start.out), prev);
}

// The new build failed: .next-prev back in place, the failed one kept as .next-failed, the unit
// started again. Only the Next build goes back: HEAD and the server source stay at the target
// (the runner never resets), and the console then shows the older build as live. Always throws.
async function rollBack(why, tail, prev) {
  const back = `Rolled back to the Next build of ${short(prev)} (the server code stays at ${short(cfg.target)})`;
  if (!existsSync(at(PREV))) throw new StepError(`${why}. There is no previous build to roll back to`, tail);
  try {
    await armGuard();
  } catch (e) {
    throw new StepError(`${why}. No roll back: ${e.message}`, e.tail || tail);
  }
  const stop = await systemctl("stop");
  if (stop.code !== 0) {
    await systemctl("start");
    throw new StepError(`${why}. No roll back: systemctl stop ${cfg.unit} failed`, tailOf(stop.out));
  }
  try {
    rmrf(FAILED);
    if (existsSync(at(LIVE))) move(LIVE, FAILED);
    move(PREV, LIVE);
  } catch (e) {
    // A console with no .next does not boot: the failed build goes back in place.
    undo(FAILED, LIVE);
    await systemctl("start");
    throw new StepError(`${why}. The roll back failed (${e instanceof Error ? e.message : e}); the new build runs`, tail);
  }
  // The build cache stays with the checkout, not with the failed build.
  cacheBack(FAILED);
  const start = await systemctl("start");
  if (start.code !== 0) throw new StepError(`${why}. ${back}, but systemctl start ${cfg.unit} failed`, tailOf(start.out));
  if (!cfg.url) throw new StepError(`${why}. ${back}`, tail);
  const c = await checkSite(prev);
  if (!c.ok) throw new StepError(`${why}. ${back}, and it also fails the check: ${c.why}`, c.tail ?? tail);
  throw new StepError(`${why}. ${back}: it passes the check`, tail);
}

async function get(url, text) {
  const res = await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT.get) });
  const body = text ? await res.text() : (await res.arrayBuffer(), "");
  return { status: res.status, body };
}

// GET / on the new server (it boots first: up to TIMEOUT.boot), then every /_next/static file the
// page links. Resolves { ok, files } or { ok: false, why, tail }.
async function checkSite(build) {
  const base = cfg.url;
  const until = Date.now() + TIMEOUT.boot;
  let page = null;
  let last = "the console did not answer";
  while (page === null && Date.now() < until) {
    try {
      const r = await get(`${base}/`, true);
      if (r.status === 200) page = r.body;
      else last = `GET / answered ${r.status}`;
    } catch (e) {
      last = `GET / failed (${e instanceof Error ? e.message : e})`;
    }
    if (page === null) await new Promise((ok) => setTimeout(ok, 1000));
  }
  if (page === null) return { ok: false, why: last };
  if (!build || !page.includes(build)) return { ok: false, why: `the page is not from build ${short(build)}` };
  const files = [...new Set(page.match(/\/_next\/static\/[^"'\s<>\\)]+/g) ?? [])];
  if (files.length === 0) return { ok: false, why: "the page links no /_next/static file" };
  const bad = [];
  for (const f of files) {
    try {
      const r = await get(`${base}${f}`, false);
      if (r.status !== 200) bad.push(`${r.status} ${f}`);
    } catch (e) {
      bad.push(`failed ${f} (${e instanceof Error ? e.message : e})`);
    }
  }
  log(`check of build ${short(build)}: / and ${files.length} files, ${bad.length} not 200`);
  if (bad.length > 0) return { ok: false, why: `${bad.length} of the ${files.length} files the page links do not load`, tail: bad.join("\n") };
  return { ok: true, files: files.length };
}

function fail(e) {
  const message = e instanceof Error ? e.message : String(e);
  log(`FAILED at ${step}: ${message}`);
  try { writeState({ phase: "failed", step, error: message, tail: e instanceof StepError ? e.tail : "", endedAt: Date.now() }); } catch (err) {
    log(`state write failed: ${err instanceof Error ? err.message : err}`);
  }
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    try { if (child?.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    // Never leave the checkout dirty or the console stopped.
    try { putBack(); } catch { /* best effort */ }
    let started = !unitStopped;
    if (unitStopped) {
      try {
        started = spawnSync("systemctl", ["--user", "start", cfg.unit], { timeout: 30_000, stdio: "ignore" }).status === 0;
        log(started ? "started the unit again before the exit" : "the start before the exit failed: the restart guard stays set");
      } catch { /* the guard starts it */ }
    }
    if (guarded && started) {
      try { spawnSync("systemctl", ["--user", "stop", `${guardUnit()}.timer`], { timeout: 30_000, stdio: "ignore" }); } catch { /* it only starts a running unit */ }
    }
    fail(new StepError(`the deploy was stopped (${sig})`));
    process.exit(1);
  });
}

main().then(() => process.exit(0), (e) => {
  if (cfg) fail(e); else console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
