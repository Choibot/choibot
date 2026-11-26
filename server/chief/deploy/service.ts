// server/chief/deploy/service.ts — the console's own deploy ticket and the Deploy action
// (spec §5.7; the exception to the user's decision 1A, for choibot only).
//
// The check (every CHECK_MS): when origin/main has commits the running build does not have, the
// console keeps ONE open queue item of kind `deploy` ("Console: N commits merged, not live", the
// merged PRs). It updates the item when more commits merge and closes it when the running build
// has all of main. Only this file creates a `deploy` item: POST /api/queue refuses the kind.
//
// Deploy (start): the caller is already proven to be the user (the route's user token, or the
// user's own Telegram account). start takes NO input but who pressed: the checkout, the branch,
// the unit and the commit all come from the console's own facts. It writes the run to the state
// file and starts runner.mjs in its own transient systemd unit, which survives the restart.
// The runner builds into .next-build, swaps it in while the unit is stopped, and checks the new
// server (GET / and the files it links, on the console's loopback URL): it writes the result
// itself (`checks: true`), and the console closes the ticket when it reads `done`. A runner with
// no URL (or an older runner) leaves the result to the new server, at its boot (afterBoot). A run
// whose runner is gone is set to failed, at boot and while the console runs.
import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { gitEnv } from "../../agents/git.js";
import { atomicWrite, readJson } from "../files.js";
import type { QueueStore } from "../queue/store.js";
import type { QueueItem } from "../queue/types.js";
import { runnerUnitOf, type Armed } from "./config.js";
import { mergedPrs, type DeployGit } from "./git.js";
import {
  CONSOLE_AGENT_ID, DEPLOY_BRANCH, DEPLOY_CLOSED, DEPLOY_REMOTE, DEPLOY_REPO, DEPLOY_STEPS, PR_LIST_MAX, deployBody, deployTitle, short,
  type DeployInfo, type DeployRun,
} from "./ticket.js";

const execFileP = promisify(execFile);

export const CHECK_MS = 60_000;
export const MIRROR_MS = 1_000;
// The runner writes its first step at once; before this a run with no live runner is not dead.
const START_GRACE_MS = 20_000;
// The restart step: systemctl has 2 min in the runner. Past this the restart did not happen.
const RESTART_MAX_MS = 180_000;
const LOG_KEEP = 5;
const COMMIT_SCAN_MAX = 200;

export type RunnerConfig = {
  id: string; dir: string; unit: string; from: string; target: string; pnpm: string[]; stateFile: string; logFile: string;
  // The console's own loopback address: the runner checks the new server there.
  url?: string;
};

// The state file: the run, as the runner and the console write it, and the ticket it shows on.
const stateShape = z.object({
  id: z.string(), ticketId: z.string(), via: z.enum(["tab", "telegram"]),
  phase: z.enum(["running", "done", "failed"]), step: z.enum(DEPLOY_STEPS),
  startedAt: z.number(), updatedAt: z.number(), endedAt: z.number().optional(),
  from: z.string(), to: z.string(), error: z.string().optional(), tail: z.string().optional(),
  skipped: z.array(z.enum(DEPLOY_STEPS)).optional(),
  alive: z.number().optional(), resumed: z.number().optional(), failed: z.number().optional(),
  // The runner checks the new server and writes `done` itself; `checked`: the files it loaded.
  checks: z.boolean().optional(), checked: z.number().optional(),
}).passthrough();
type State = z.infer<typeof stateShape>;

export type Reconciled = { resumed: string[]; cold: string[]; alive: string[]; failed: string[] };

export type DeployDeps = {
  store: QueueStore;
  // The console's own checkout and unit (config.ts), and whether this process is that unit.
  dir: string; unit: string; armed: Armed;
  // The commits read once at boot: HEAD when the server started, and the build's recorded commit.
  boot: { head: string | null; build: string | null; at: number };
  git: DeployGit;
  stateFile: string; logDir: string; pnpm: string[];
  // The console's loopback URL for the runner's check; null: no check (the old flow).
  checkUrl?: string | null;
  // Starts runner.mjs in its transient unit; rejects when it could not start (a run is going).
  launch: (cfg: RunnerConfig) => Promise<void>;
  runnerAlive: () => Promise<boolean>;
  now?: () => number; log?: (s: string) => void; newId?: () => string;
};

export type StartResult =
  | { code: 200; item: QueueItem }
  | { code: 409 | 502 | 503; error: string; item?: QueueItem };

export type DeployStatus = {
  armed: boolean; why?: string; unit: string; branch: string; remote: string;
  live: string | null; target: string | null; count: number; ticketId: string | null;
  run: Pick<State, "id" | "phase" | "step"> | null;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isLive = (i: QueueItem): boolean => i.status === "open" || i.status === "snoozed";
const isTicket = (i: QueueItem): boolean => i.kind === "deploy";

function runOf(s: State): DeployRun {
  return {
    id: s.id, via: s.via, startedAt: s.startedAt, phase: s.phase, step: s.step, from: s.from, to: s.to,
    ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
    ...(s.skipped?.length ? { skipped: s.skipped } : {}),
    ...(s.checked !== undefined ? { checked: s.checked } : {}),
    ...(s.error !== undefined ? { error: s.error } : {}), ...(s.tail ? { tail: s.tail } : {}),
    ...(s.alive !== undefined ? { alive: s.alive } : {}), ...(s.resumed !== undefined ? { resumed: s.resumed } : {}),
    ...(s.failed !== undefined ? { failed: s.failed } : {}),
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class DeployService {
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  // undefined until init() read it; null: unknown (the build recorded no commit).
  private live: string | null | undefined;
  private info: DeployInfo | null = null;
  private target: string | null = null;
  private checking: Promise<void> | null = null;
  // Checks run one after the other (the timer's and start's): never two upserts at once.
  private queue: Promise<unknown> = Promise.resolve();
  private starting = false;
  private mirrorTimer?: NodeJS.Timeout;
  private mirroring = false;
  private readonly logged = new Map<string, string>();
  // This server's reconcile result, kept for the run that a checking runner ends after the boot.
  private reconciled: Reconciled | undefined;

  constructor(private readonly d: DeployDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
  }

  // The commit that is fully live: the build's and the booted code's when they are equal, else
  // the older of the two. Null when the build recorded no commit or the two are not in one line.
  async liveCommit(): Promise<string | null> {
    if (this.live !== undefined) return this.live;
    const { head, build } = this.d.boot;
    let live: string | null = null;
    try {
      if (head && build) {
        if (head === build) live = head;
        else if (await this.d.git.isAncestor(build, head)) live = build;
        else if (await this.d.git.isAncestor(head, build)) live = head;
      }
    } catch (e) {
      this.warn("live", `[deploy] the live commit could not be read: ${errText(e)}`);
    }
    if (live === null) this.warn("live", `[deploy] off: the running build recorded no commit (build ${build ?? "none"}, boot ${head ?? "none"})`);
    this.live = live;
    return live;
  }

  status(state: State | null = null): DeployStatus {
    const a = this.d.armed;
    return {
      armed: a.ok, ...(a.ok ? {} : { why: a.why }), unit: this.d.unit, branch: DEPLOY_BRANCH, remote: DEPLOY_REMOTE,
      live: this.live ?? null, target: this.target, count: this.info?.count ?? 0, ticketId: null,
      run: state ? { id: state.id, phase: state.phase, step: state.step } : null,
    };
  }

  async statusNow(): Promise<DeployStatus> {
    const state = await this.readState();
    const ticket = (await this.tickets())[0];
    return { ...this.status(state), ticketId: ticket?.id ?? null };
  }

  // One check at a time; a call while one runs gets that one.
  check(): Promise<void> {
    return this.checking ??= this.enqueue(() => this.runCheck()).finally(() => { this.checking = null; });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  // A check that throws when origin cannot be read (start needs a fresh origin/main).
  private async runCheck(strict = false): Promise<void> {
    if (!this.d.armed.ok) return;
    const live = await this.liveCommit();
    if (live === null) return;
    const { git } = this.d;
    let target: string;
    try {
      const remote = await git.remoteHead();
      if ((await git.trackedHead()) !== remote) await git.fetch();
      target = (await git.trackedHead()) ?? remote;
      this.logged.delete("origin");
    } catch (e) {
      if (strict) throw e;
      this.warn("origin", `[deploy] origin/${DEPLOY_BRANCH} could not be read: ${errText(e)}`);
      return;
    }
    this.target = target;
    const count = target === live ? 0 : await git.count(live, target);
    if (count === 0) {
      this.info = null;
      // A run still going owns its ticket: afterBoot or the mirror ends it.
      const s = await this.readState();
      if (s?.phase === "running") return;
      if (s) await this.settle(s);
      await this.closeAll(DEPLOY_CLOSED.live);
      return;
    }
    const all = mergedPrs(await git.commits(live, target, COMMIT_SCAN_MAX));
    const note = await this.blockNote(target);
    this.info = {
      live, target, count, prs: all.slice(0, PR_LIST_MAX), more: Math.max(0, all.length - PR_LIST_MAX),
      ...(note ? { note } : {}),
    };
    await this.upsert(this.info);
  }

  // Why the runner would refuse now. A failed read gives no note: the runner decides.
  private async blockNote(target: string): Promise<string | undefined> {
    const { git } = this.d;
    try {
      const branch = await git.branch();
      if (branch !== DEPLOY_BRANCH) return `The checkout is on ${branch ? `branch ${branch}` : "no branch"}, not ${DEPLOY_BRANCH}. Deploy will be refused.`;
      const head = await git.head();
      if (head !== target && !(await git.isAncestor(head, target))) {
        return `Local ${DEPLOY_BRANCH} has commits that ${DEPLOY_REMOTE}/${DEPLOY_BRANCH} does not have: not a fast-forward. Deploy will be refused.`;
      }
      const files = head === target ? [] : await git.blockedFiles(head, target);
      if (files.length > 0) {
        const names = files.slice(0, 3).join(", ") + (files.length > 3 ? ` and ${files.length - 3} more` : "");
        return `Uncommitted changes in ${names} are in the way of the fast-forward. Deploy will be refused until they are committed or removed.`;
      }
    } catch (e) {
      this.warn("note", `[deploy] the pre-check failed: ${errText(e)}`);
    }
    return undefined;
  }

  private async tickets(): Promise<QueueItem[]> {
    return (await this.d.store.list()).filter((i) => isTicket(i) && isLive(i));
  }

  // The one open ticket shows `info`. A second open one (a hand-made file) is closed.
  private async upsert(info: DeployInfo): Promise<void> {
    const { store } = this.d;
    const all = await store.list();
    const open = all.filter((i) => isTicket(i) && isLive(i));
    for (const extra of open.slice(1)) await this.closeOne(extra.id, "duplicate");
    const title = deployTitle(info.count);
    const body = deployBody(info);
    const cur = open[0];
    if (!cur) {
      // The user withdrew the ticket for this same commit: no new one until main moves.
      const last = all.filter(isTicket).at(-1);
      if (last && last.status === "withdrawn" && last.lastError === undefined && last.deploy?.target === info.target) return;
      await store.add({
        kind: "deploy", agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" },
        repo: DEPLOY_REPO, area: DEPLOY_REPO, title, body, blocking: false, deploy: info,
      });
      return;
    }
    await store.withItem(cur.id, async () => {
      const item = await store.get(cur.id);
      if (!item || !isLive(item)) return;
      const run = item.deploy?.run;
      const next: DeployInfo = { ...info, ...(run ? { run } : {}) };
      // The console's own facts replace whatever the file held (owner, repo and flags too).
      const fixed: QueueItem = {
        ...item, agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" },
        repo: DEPLOY_REPO, area: DEPLOY_REPO, blocking: false, title, body, deploy: next,
      };
      if (!same(fixed, item)) await store.write(fixed);
    });
  }

  private async closeOne(id: string, why: string, run?: DeployRun): Promise<void> {
    const { store } = this.d;
    await store.withItem(id, async () => {
      const item = await store.get(id);
      if (!item || !isLive(item) || !isTicket(item)) return;
      const { snoozedUntil: _ended, ...rest } = item;
      const deploy = item.deploy && run ? { ...item.deploy, run } : item.deploy;
      await store.write({ ...rest, status: "withdrawn", lastError: why, closedAt: this.now(), ...(deploy ? { deploy } : {}) });
    });
  }

  private async closeAll(why: string): Promise<void> {
    for (const t of await this.tickets()) await this.closeOne(t.id, why);
  }

  // ---- the run ----

  async readState(): Promise<State | null> {
    try {
      const r = stateShape.safeParse(await readJson<unknown>(this.d.stateFile));
      return r.success ? r.data : null;
    } catch (e) {
      this.warn("state", `[deploy] the state file could not be read: ${errText(e)}`);
      return null;
    }
  }

  private writeState(s: State): Promise<void> {
    return atomicWrite(this.d.stateFile, JSON.stringify({ ...s, updatedAt: this.now() }, null, 2));
  }

  // The run on its ticket, when it changed. An open ticket only: a closed one keeps its result.
  private async show(s: State): Promise<QueueItem | null> {
    const { store } = this.d;
    return store.withItem(s.ticketId, async () => {
      const item = await store.get(s.ticketId);
      if (!item || !isTicket(item) || !item.deploy) return null;
      const run = runOf(s);
      if (!isLive(item) || same(item.deploy.run, run)) return item;
      const next: QueueItem = { ...item, deploy: { ...item.deploy, run } };
      await store.write(next);
      return next;
    });
  }

  // A run on its ticket; a run that a checking runner ended `done` also closes the ticket as
  // deployed, with this server's reconcile result (written once, after the runner exited).
  private async settle(s: State): Promise<void> {
    if (s.phase !== "done" || s.checks !== true) { await this.show(s); return; }
    const ticket = await this.d.store.get(s.ticketId);
    if (!ticket || !isTicket(ticket) || !isLive(ticket)) return;
    const r = this.reconciled;
    const done: State = s.alive === undefined && r
      ? { ...s, alive: r.alive.length, resumed: r.resumed.length + r.cold.length, failed: r.failed.length }
      : s;
    if (done !== s) await this.writeState(done);
    await this.closeOne(s.ticketId, DEPLOY_CLOSED.deployed, runOf(done));
    this.log(`[deploy] ${s.id} done: live ${short(s.to)}, checked ${s.checked ?? 0} files, rollback ${short(s.from)}`);
  }

  // The user pressed Deploy. `via` is the only input.
  async start(via: "tab" | "telegram"): Promise<StartResult> {
    const a = this.d.armed;
    if (!a.ok) return { code: 503, error: `deploy is off: ${a.why}` };
    if (this.starting) return { code: 409, error: "a deploy already runs" };
    this.starting = true;
    try {
      const prev = await this.readState();
      if (prev?.phase === "running" && !(await this.endIfDead(prev))) {
        return { code: 409, error: "a deploy already runs", ...(await this.itemOf(prev.ticketId)) };
      }
      // A fresh look at origin/main: the user deploys what is merged now.
      try {
        await this.enqueue(() => this.runCheck(true));
      } catch (e) {
        return { code: 502, error: `origin/${DEPLOY_BRANCH} could not be read: ${errText(e)}` };
      }
      const info = this.info;
      const ticket = (await this.tickets())[0];
      if (!info || !ticket) return { code: 409, error: "nothing to deploy: the running build has all of main" };
      const id = (this.d.newId ?? (() => `d${this.now().toString(36)}`))();
      const state: State = {
        id, ticketId: ticket.id, via, phase: "running", step: "fetch", startedAt: this.now(), updatedAt: this.now(),
        from: info.live, to: info.target,
      };
      await this.writeState(state);
      await this.wake(ticket.id);
      await this.show(state);
      const logFile = join(this.d.logDir, `run-${id}.log`);
      await this.pruneLogs();
      try {
        await this.d.launch({
          id, dir: this.d.dir, unit: this.d.unit, from: info.live, target: info.target, pnpm: this.d.pnpm,
          stateFile: this.d.stateFile, logFile, ...(this.d.checkUrl ? { url: this.d.checkUrl } : {}),
        });
      } catch (e) {
        const failed = await this.fail(state, `the deploy runner did not start: ${errText(e)}`);
        return { code: 502, error: failed.error ?? "the deploy runner did not start", ...(await this.itemOf(ticket.id)) };
      }
      this.startMirror();
      const item = await this.d.store.get(ticket.id);
      return item ? { code: 200, item } : { code: 409, error: "the ticket is gone" };
    } finally {
      this.starting = false;
    }
  }

  // Deploy from the Telegram card: only the card of the console's own open ticket starts a run.
  async startFromCard(itemId: string): Promise<StartResult> {
    const ticket = (await this.tickets())[0];
    if (!ticket || ticket.id !== itemId) return { code: 409, error: "this is not the open deploy ticket" };
    return this.start("telegram");
  }

  private async itemOf(id: string): Promise<{ item?: QueueItem }> {
    const item = await this.d.store.get(id);
    return item ? { item } : {};
  }

  // A snoozed ticket whose Deploy was pressed is open again.
  private async wake(id: string): Promise<void> {
    const { store } = this.d;
    await store.withItem(id, async () => {
      const item = await store.get(id);
      if (!item || item.status !== "snoozed") return;
      const { snoozedUntil: _woken, ...rest } = item;
      await store.write({ ...rest, status: "open" });
    });
  }

  private async fail(s: State, error: string): Promise<State> {
    const next: State = { ...s, phase: "failed", error, endedAt: this.now() };
    await this.writeState(next);
    await this.show(next);
    return next;
  }

  // True when the run was ended here because nothing can still move it.
  private async endIfDead(s: State): Promise<boolean> {
    if (s.phase !== "running") return true;
    const t = this.now();
    // A checking runner stops and starts the unit itself: after its restart (this server is the
    // new one) it is dead only when its unit is gone, as at any other step.
    const restarted = s.checks === true && this.d.boot.at > s.startedAt;
    if (s.step === "restart" && !restarted) {
      // This server is older than the run, so the restart it waits for did not come.
      if (this.d.boot.at > s.startedAt || t - s.updatedAt < RESTART_MAX_MS || (await this.d.runnerAlive())) return false;
      await this.fail(s, "the restart did not happen");
      return true;
    }
    if (t - s.startedAt < START_GRACE_MS || (await this.d.runnerAlive())) return false;
    // The runner may have written its last state while we looked.
    const again = await this.readState();
    if (!again || again.id !== s.id) return true;
    if (again.phase !== "running") { await this.settle(again); return true; }
    if (again.step === "restart" && !restarted) return false;
    await this.fail(again, `the deploy stopped at ${again.step}: its runner is gone`);
    return true;
  }

  // The state file onto the ticket, once a second while a run goes.
  startMirror(): void {
    if (this.mirrorTimer) return;
    this.mirrorTimer = setInterval(() => { void this.mirror(); }, MIRROR_MS);
    this.mirrorTimer.unref?.();
  }

  private stopMirror(): void {
    if (this.mirrorTimer) clearInterval(this.mirrorTimer);
    this.mirrorTimer = undefined;
  }

  async mirror(): Promise<void> {
    if (this.mirroring) return;
    this.mirroring = true;
    try {
      const s = await this.readState();
      if (!s) return this.stopMirror();
      await this.settle(s);
      if (s.phase !== "running" || (await this.endIfDead(s))) this.stopMirror();
    } catch (e) {
      this.warn("mirror", `[deploy] the run could not be shown: ${errText(e)}`);
    } finally {
      this.mirroring = false;
    }
  }

  // At boot, after reconcile: the result of a run that restarted this console, or the end of a
  // run that died. Then the first check. Never rejects.
  async afterBoot(r: Reconciled | undefined): Promise<void> {
    try {
      if (!this.d.armed.ok) return;
      const live = await this.liveCommit();
      const s = await this.readState();
      this.reconciled = r;
      if (s?.phase === "running" && s.checks === true && this.d.boot.at > s.startedAt && (s.step === "restart" || s.step === "check")) {
        // The runner checks this server now and writes the result; the mirror shows it.
        await this.show(s);
        this.startMirror();
      } else if (s?.phase === "running") {
        if (s.step === "restart" && this.d.boot.at > s.startedAt) {
          if (live === s.to) {
            const done: State = {
              ...s, phase: "done", endedAt: this.now(),
              ...(r ? { alive: r.alive.length, resumed: r.resumed.length + r.cold.length, failed: r.failed.length } : {}),
            };
            await this.writeState(done);
            await this.closeOne(s.ticketId, DEPLOY_CLOSED.deployed, runOf(done));
            this.log(`[deploy] ${s.id} done: live ${short(s.to)}, rollback ${short(s.from)}`);
          } else {
            await this.fail(s, `the console restarted, but the running build is ${short(live)}, not ${short(s.to)}`);
          }
        } else if (!(await this.endIfDead(s))) {
          // The runner still works (the console was restarted by something else): show it on.
          await this.show(s);
          this.startMirror();
        }
      } else if (s) {
        // A checking runner wrote its result while this server booted.
        await this.settle(s);
      }
      await this.check();
    } catch (e) {
      this.log(`[deploy] boot step failed: ${errText(e)}`);
    }
  }

  // The check timer. Returns stop.
  startWatch(): () => void {
    const timer = setInterval(() => {
      void this.check().catch((e) => this.warn("check", `[deploy] check failed: ${errText(e)}`));
    }, CHECK_MS);
    timer.unref?.();
    return () => { clearInterval(timer); this.stopMirror(); };
  }

  private async pruneLogs(): Promise<void> {
    try {
      const names = (await readdir(this.d.logDir)).filter((n) => /^run-[0-9a-z]+\.log$/.test(n)).sort();
      for (const n of names.slice(0, Math.max(0, names.length - (LOG_KEEP - 1)))) await rm(join(this.d.logDir, n), { force: true });
    } catch { /* no log dir yet */ }
  }

  // The same message is logged once until it changes.
  private warn(key: string, msg: string): void {
    if (this.logged.get(key) === msg) return;
    this.logged.set(key, msg);
    this.log(msg);
  }
}

// ---- the real runner launch (index.ts) ----

// runner.mjs in its own transient user unit. `--collect` removes the unit when it ends, also
// after a failure, so the fixed name is free for the next run; while a run goes, systemd refuses
// a second unit of that name.
export function systemdLaunch(o: { unit: string; runner: string; node?: string; env?: NodeJS.ProcessEnv }): DeployDeps["launch"] {
  const env = o.env ?? process.env;
  return async (cfg) => {
    // A hardened deployment: the runner's git gets the console's git overrides too (GIT_CONFIG_*).
    const hardened = Object.entries(gitEnv(cfg.dir, {} as NodeJS.ProcessEnv)).filter(([k, v]) => k.startsWith("GIT_") && typeof v === "string");
    await execFileP("systemd-run", [
      "--user", "--collect", "--quiet", `--unit=${runnerUnitOf(o.unit)}`, `--description=ChoiBot deploy ${cfg.id}`,
      `--working-directory=${cfg.dir}`, `--setenv=PATH=${env.PATH ?? "/usr/bin:/bin"}`,
      ...hardened.map(([k, v]) => `--setenv=${k}=${v}`),
      "--", o.node ?? process.execPath, o.runner, JSON.stringify(cfg),
    ], { timeout: 30_000 });
  };
}

export function systemdRunnerAlive(unit: string): DeployDeps["runnerAlive"] {
  return async () => {
    try {
      const { stdout } = await execFileP("systemctl", ["--user", "show", runnerUnitOf(unit), "-p", "ActiveState", "--value"], { timeout: 10_000 });
      return ["active", "activating", "deactivating", "reloading"].includes(stdout.trim());
    } catch {
      // Unknown counts as alive: a run is never called dead on a failed look.
      return true;
    }
  };
}
