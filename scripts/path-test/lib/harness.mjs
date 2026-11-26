// scripts/path-test/lib/harness.mjs — what the path test needs around its steps: the test roots
// (made and run by scripts/install-test/run.sh), the list of steps with its result table, the
// proof that the real user's system is as it was, and the browser.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const IT = join(REPO, "scripts/install-test/run.sh");
const FAKES = join(REPO, "scripts/path-test/fakes");
// The private address that the fake Tailscale of the install test gives (its `serve status`).
export const PRIVATE_NAME = "server.example.ts.net";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\r/g;

// The commands that run now, so a stop of the test can end them first.
const running = new Set();
export const stopCommands = () => { for (const c of running) c.kill("SIGKILL"); };

// One command, its two outputs as one text. Never throws for an exit code.
export function run(cmd, args, o = {}) {
  return new Promise((done) => {
    const child = execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: o.timeoutMs ?? 600_000, env: o.env ?? process.env, cwd: o.cwd }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout}${stderr}`.replace(ANSI, "") });
    });
    running.add(child);
    child.on("exit", () => running.delete(child));
    if (o.input !== undefined) child.stdin.end(o.input); else child.stdin.end();
  });
}

// ------------------------------------------------------------------ the roots

const ROOT_RE = /^\/tmp\/choibot-it-[A-Za-z0-9]+$/;

// A free port on 127.0.0.1, asked from the system.
export function freePort() {
  return new Promise((done, fail) => {
    const s = net.createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); });
  });
}

// The commands of the installed CLI that the test may run in a person's shell: the ones that
// read and write files on the server. A command that calls the console goes through `asUser`
// below, behind the guard (fakes/preload.mjs).
const FILE_COMMANDS = new Set(["doctor", "pair", "access", "names", "login"]);

export class Root {
  constructor(dir, port) {
    if (!ROOT_RE.test(dir)) throw new Error(`not a test root: ${dir}`);
    this.dir = dir;
    this.port = port;
    this.home = join(dir, "home");
    this.state = join(dir, "state");
    this.base = `http://localhost:${port}`;
  }

  // A new root with the code of this checkout (tracked and new files), and an archive of it.
  async make(warm) {
    const r = await run(IT, ["new", this.dir, ...(warm ? ["--warm", warm.dir] : [])]);
    if (r.code !== 0) throw new Error(`the test root was not made:\n${r.out}`);
    const tar = await run("tar", ["-czf", join(this.dir, "choibot.tar.gz"), "-C", join(this.dir, "src"), "--exclude=.git", "."]);
    if (tar.code !== 0) throw new Error(`the archive of the code was not made:\n${tar.out}`);
    mkdirSync(join(this.dir, "gh"), { recursive: true });
    // The console of the test: its fake Telegram, its fake service fact and the network guard.
    copyFileSync(join(FAKES, "preload.mjs"), join(this.dir, "fakes/preload.mjs"));
    copyFileSync(join(FAKES, "systemd-run"), join(this.dir, "fakebin/systemd-run"));
    copyFileSync(join(FAKES, "agent"), join(this.state, "agent"));
    for (const f of ["fakebin/systemd-run", "state/agent"]) chmodSync(join(this.dir, f), 0o755);
    // Every git command of the test's home reads https://github.com/ from <root>/github.com.
    writeFileSync(join(this.home, ".gitconfig"), `[url "${this.dir}/github.com/"]\n\tinsteadOf = https://github.com/\n`);
  }

  // The env of the console (the fake systemctl adds it to the unit's own).
  serviceEnv(o) {
    const guard = [`PATH_TEST_PORTS=${[this.port, ...(o.ports ?? [])].join(",")}`, `PATH_TEST_NET_LOG=${join(this.state, "net.log")}`, `NODE_OPTIONS=--import=${join(this.dir, "fakes/preload.mjs")}`];
    writeFileSync(join(this.state, "service-env"), [`CHIEF_TEST=1`, `CHIEF_TEST_TELEGRAM_API=${o.telegramApi}`, `PATH_TEST_UNIT=choibot.service`, ...guard].join("\n") + "\n");
    this.guard = guard;
  }

  set(name, value) {
    const file = join(this.state, name);
    if (value === undefined) rmSync(file, { force: true }); else writeFileSync(file, `${value}\n`);
  }

  read(file) { try { return readFileSync(join(this.dir, file), "utf8"); } catch { return ""; } }
  has(file) { return existsSync(join(this.dir, file)); }

  // The install line, in a terminal of its own. The guard is off for it: it downloads.
  async install(args = []) {
    this.set("shell-env");
    const r = await run(IT, ["install", this.dir, `CHOIBOT_SOURCE=${join(this.dir, "choibot.tar.gz")}`, `CHOIBOT_PORT=${this.port}`, ...args]);
    writeFileSync(join(this.state, "shell-env"), this.guard.join("\n") + "\n");
    return r;
  }

  // A command of the installed CLI, as the person at the server types it.
  cli(...args) {
    if (!FILE_COMMANDS.has(args[0])) throw new Error(`the test runs \`${args[0]}\` only through asUser()`);
    return run(IT, ["cli", this.dir, ...args]);
  }

  // A command of the CLI that calls the console, in a person's shell. The guard holds it to
  // the ports of the test; what it tried is in the net log.
  callConsole(...args) { return run(IT, ["cli", this.dir, ...args]); }

  sh(text, input) { return run(IT, ["sh", this.dir, text], { input }); }

  tool(name, mode) { return run(IT, ["set", this.dir, name, ...(mode === undefined ? [] : [mode])]); }

  // After the install: the fake gh comes before the gh that the install script got.
  fakeGithub(repos) {
    copyFileSync(join(FAKES, "gh"), join(this.dir, "fakebin/gh"));
    chmodSync(join(this.dir, "fakebin/gh"), 0o755);
    writeFileSync(join(this.dir, "gh/repos.json"), JSON.stringify(repos));
  }

  // A repo "on GitHub" with one commit: a small project with a README.
  async makeRemote(slug) {
    const seed = join(this.dir, "tmp", `seed-${slug.replace("/", "-")}`);
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, "README.md"), "# hello\n\nA small web server.\n");
    writeFileSync(join(seed, "package.json"), '{"name":"hello","scripts":{"start":"node server.js"}}\n');
    writeFileSync(join(seed, "server.js"), 'console.log("hello");\n');
    const bare = join(this.dir, "github.com", `${slug}.git`);
    mkdirSync(dirname(bare), { recursive: true });
    const r = await this.sh(`cd ${seed} && git init -q -b main && git add -A && git -c user.name=Ada -c user.email=ada@example.invalid commit -q -m "first commit" && git clone -q --bare . ${bare}`);
    if (r.code !== 0) throw new Error(`the repo on the fake GitHub was not made:\n${r.out}`);
  }

  remoteGit(slug, ...args) { return this.sh(`git -C ${join(this.dir, "github.com", `${slug}.git`)} ${args.join(" ")}`); }

  // The pids of this root: the processes that carry its HOME in their environment.
  pids() {
    const out = [];
    for (const p of readdirSync("/proc")) {
      if (!/^\d+$/.test(p)) continue;
      try { if (readFileSync(`/proc/${p}/environ`, "utf8").split("\0").includes(`HOME=${this.home}`)) out.push(Number(p)); } catch { /* another user's, or gone */ }
    }
    return out;
  }

  // The names of the env keys of every process of the root. Names only, never a value.
  envKeys() {
    const keys = new Set();
    for (const p of this.pids()) {
      try { for (const kv of readFileSync(`/proc/${p}/environ`, "utf8").split("\0")) if (kv) keys.add(kv.split("=")[0]); } catch { /* gone */ }
    }
    return [...keys];
  }

  // The pid of the console's own service process (the fake systemctl keeps it).
  servicePid() { return Number(this.read("state/choibot.pid").trim()) || 0; }

  logTail(n = 40) { return this.read("state/choibot.log").split("\n").slice(-n).join("\n"); }

  // Wait until the console answers on its port.
  async up(ms = 60_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if ((await fetch(`http://127.0.0.1:${this.port}/api/chief/pair/first`, { signal: AbortSignal.timeout(3000) })).ok) return true; } catch { /* not up yet */ }
      await sleep(500);
    }
    return false;
  }

  async down() { if (existsSync(this.state)) await run(IT, ["down", this.dir]); }

  remove() { if (ROOT_RE.test(this.dir)) rmSync(this.dir, { recursive: true, force: true }); }
}

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// ------------------------------------------------------- the real user's system

// The listening sockets of this machine: "address:port" and, for a process of this user, its pid.
async function listeners() {
  const r = await run("ss", ["-ltnpH"]);
  return r.out.split("\n").filter(Boolean).map((line) => {
    const cols = line.trim().split(/\s+/);
    return { at: cols[3], pid: Number(/pid=(\d+)/.exec(line)?.[1] ?? 0) };
  });
}

// The sockets of the given pids, and the ones that do not listen on the server itself only.
export async function listenersOf(pids) {
  const mine = (await listeners()).filter((l) => pids.includes(l.pid));
  return { all: mine.map((l) => l.at), open: mine.filter((l) => !/^(127\.0\.0\.1|\[::1\]):/.test(l.at)).map((l) => l.at) };
}

// Read only: what the test must leave as it was. The same lists as `install-test/run.sh
// snapshot`, plus the listening ports.
export async function snapshot() {
  const home = homedir();
  const units = [];
  const walk = (dir, rel) => {
    let names = [];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      const p = join(dir, n), st = statSync(p, { throwIfNoEntry: false });
      if (!st) { units.push(`? ${join(rel, n)}`); continue; }
      units.push(`${st.isDirectory() ? "d" : "f"} ${(st.mode & 0o7777).toString(8)} ${st.size} ${Math.floor(st.mtimeMs)} ${join(rel, n)}`);
      if (st.isDirectory()) walk(p, join(rel, n));
    }
  };
  walk(join(home, ".config/systemd/user"), "");
  // A transient unit is a run of other work on this machine (an agent's scope, a scratch unit).
  const unitFiles = (await run("systemctl", ["--user", "list-unit-files", "--no-pager", "--no-legend"])).out
    .split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => l && l.split(" ")[1] !== "transient").sort();
  const share = join(home, ".local/share");
  const data = readdirSync(share).sort().map((n) => { const st = statSync(join(share, n), { throwIfNoEntry: false }); return `${st?.isDirectory() ? "d" : "f"} ${((st?.mode ?? 0) & 0o7777).toString(8)} ${n}`; });
  const cron = await run("crontab", ["-l"]);
  return { units, unitFiles, data, crontab: [`exit ${cron.code}`, ...cron.out.split("\n")], ports: await listeners() };
}

// What differs between two snapshots, as lines for a person. `ours`: pids the test started.
export function snapshotDiff(before, after) {
  const out = [];
  const lists = [["units", "~/.config/systemd/user"], ["unitFiles", "systemctl --user list-unit-files"], ["data", "~/.local/share"], ["crontab", "crontab -l"]];
  for (const [key, name] of lists) {
    const a = new Set(before[key]), b = new Set(after[key]);
    for (const l of before[key]) if (!b.has(l)) out.push(`${name}: gone or changed: ${l}`);
    for (const l of after[key]) if (!a.has(l)) out.push(`${name}: new or changed: ${l}`);
  }
  return out;
}

// The listening ports that are not the same, with the process behind each one where this user
// can see it. Other work on this machine opens and closes ports too: the caller decides.
export function portDiff(before, after) {
  const name = (pid) => { try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return "a process that ended"; } };
  const a = new Set(before.ports.map((p) => p.at)), b = new Set(after.ports.map((p) => p.at));
  return [
    ...after.ports.filter((p) => !a.has(p.at)).map((p) => ({ what: "new", at: p.at, pid: p.pid, by: p.pid ? name(p.pid) : "another user" })),
    ...before.ports.filter((p) => !b.has(p.at)).map((p) => ({ what: "gone", at: p.at, pid: p.pid, by: p.pid ? name(p.pid) : "another user" })),
  ];
}

// ------------------------------------------------------------------ the steps

export class Fail extends Error {}
export const must = (ok, text) => { if (!ok) throw new Fail(text); };
export const mustHave = (text, part, what) => must(typeof part === "string" ? text.includes(part) : part.test(text), `${what}: the text has no ${typeof part === "string" ? `“${part}”` : part}.\n--- the text was:\n${text.slice(-1500)}`);

// Words that a new user must not read: a command that does not exist on such an install, our
// own words for the server, a settings key, a path.
const NOT_PLAIN = [
  [/\bpnpm\b/, "the word “pnpm” (an install by the install line has no such command)"],
  [/\bthe box\b|\bon the box\b/i, "“the box” (the user reads “your server”)"],
  [/\blog mode\b/i, "“log mode”"],
  [/\b[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)+\b/, "a settings key"],
  [/(^|[\s"'(])~?\/(home|tmp|usr|etc|var|root)\/[\w./-]+/, "a file path"],
  [/\.env\b/, "the name of the settings file"],
];
export function notPlain(text) {
  const hits = [];
  for (const [re, what] of NOT_PLAIN) { const m = re.exec(text); if (m) hits.push(`${what}: “…${text.slice(Math.max(0, m.index - 50), m.index + 60).replace(/\s+/g, " ")}…”`); }
  return hits;
}
export const mustBePlain = (text, where) => { const hits = notPlain(text); must(hits.length === 0, `${where} has words that are not for a new user:\n  ${hits.join("\n  ")}`); };

const fmtMs = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export class Steps {
  constructor(outDir, o = {}) {
    this.outDir = outDir;
    this.rows = [];
    this.pages = new Map();   // name → page: for the picture of a failed step
    this.logs = new Map();    // name → () => text: the last lines for a failed step
    this.until = o.until;
    this.stopped = false;
    this.started = Date.now();
    mkdirSync(outDir, { recursive: true });
  }

  ok(id) { return this.rows.find((r) => r.id === id)?.result === "pass"; }

  // One step. `needs`: steps that must have passed, else this one is skipped with that reason.
  async step(id, title, fn, o = {}) {
    const row = { id, title, result: "skipped", reason: "", ms: 0 };
    this.rows.push(row);
    const missing = (o.needs ?? []).find((n) => !this.ok(n));
    if (this.stopped) { row.reason = this.stopReason ?? `the run stopped after step ${this.until}`; return false; }
    if (missing) { row.reason = `needs step ${missing}`; this.print(row); return false; }
    const t0 = Date.now();
    try {
      const skip = await fn();
      if (typeof skip === "string") { row.reason = skip; } else row.result = "pass";
    } catch (e) {
      row.result = "fail";
      row.reason = e instanceof Fail ? e.message : `${e?.message ?? e}`;
      await this.keep(row, e);
    }
    row.ms = Date.now() - t0;
    this.print(row);
    if (this.until === id) this.stopped = true;
    return row.result === "pass";
  }

  print(row) {
    const mark = row.result === "pass" ? "pass" : row.result === "fail" ? "FAIL" : "skip";
    process.stdout.write(`  ${mark}  ${row.id.padEnd(4)} ${row.title}${row.result === "pass" ? `  (${fmtMs(row.ms)})` : ""}\n`);
    if (row.result !== "pass") process.stdout.write(`        ${row.reason.split("\n")[0]}\n`);
  }

  // The picture of each open page and the last lines of the logs, for a failed step.
  async keep(row, e) {
    const text = [`Step ${row.id}: ${row.title}`, "", e instanceof Fail ? e.message : (e?.stack ?? String(e)), ""];
    for (const [name, page] of this.pages) {
      try {
        if (page.isClosed()) continue;
        await page.screenshot({ path: join(this.outDir, `${row.id}-${name}.png`), timeout: 10_000 });
        text.push(`--- ${name}: ${page.url()}`, (await page.locator("body").innerText({ timeout: 5000 })).replace(/\n{2,}/g, "\n").slice(0, 6000), "");
      } catch (err) { text.push(`--- ${name}: no picture (${err?.message?.split("\n")[0]})`, ""); }
    }
    for (const [name, tail] of this.logs) { try { text.push(`--- ${name} (last lines)`, tail(), ""); } catch { /* the log is gone */ } }
    writeFileSync(join(this.outDir, `${row.id}.log`), text.join("\n"));
  }

  table() {
    const total = Date.now() - this.started;
    const w = Math.max(...this.rows.map((r) => r.title.length), 4);
    const lines = [`${"step".padEnd(5)} ${"what".padEnd(w)}  result   time`, `${"-".repeat(5)} ${"-".repeat(w)}  -------  ------`];
    for (const r of this.rows) {
      lines.push(`${r.id.padEnd(5)} ${r.title.padEnd(w)}  ${r.result.padEnd(7)}  ${r.result === "skipped" ? "" : fmtMs(r.ms)}`);
      // One line in the table. The whole reason and the text of the pages are in <step>.log.
      if (r.result !== "pass") lines.push(`${" ".repeat(6)}${r.result === "fail" ? "why: " : "skipped: "}${r.reason.split("\n")[0]}`.slice(0, 400));
    }
    const n = (k) => this.rows.filter((r) => r.result === k).length;
    lines.push("", `${n("pass")} pass, ${n("fail")} fail, ${n("skipped")} skipped. Run time: ${fmtMs(total)}.`);
    return lines.join("\n");
  }

  failed() { return this.rows.some((r) => r.result === "fail"); }
  note(text) { appendFileSync(join(this.outDir, "notes.txt"), `${text}\n`); }
}

// ------------------------------------------------------------------ the browser

// playwright-core is not a dependency of this repo. The test takes it from the place that the
// person gives, else from this checkout when somebody installed it there.
export async function findPlaywright() {
  const given = process.env.CHOIBOT_TEST_PLAYWRIGHT;
  const places = [given, given && join(given, "index.mjs"), join(REPO, "node_modules/playwright-core/index.mjs"), join(REPO, "node_modules/playwright/index.mjs")]
    .filter((p) => p && existsSync(p) && statSync(p).isFile());
  if (places.length === 0) return null;
  const mod = await import(pathToFileURL(places[0]).href);
  return mod.chromium ?? mod.default?.chromium ?? null;
}

export const haveOpenssl = () => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } };
