// server/agents/headless/host.ts — the headless host: a worker's `claude -p` with a message
// stream and no terminal. A library: nothing in the product registers it yet (addHost only in
// its tests), so no terminal agent runs this code.
//
// Each worker runs in its own systemd user scope (<unitPrefix><id>.scope), in a new session
// (holder.sh), so a restart of the console does not end it. Two folders per worker (mode 0700):
//   <runDir>/<id>/    the worker's: in.fifo, out.jsonl (out.1.jsonl: the last program's), gen,
//                     err.log, pid, exit, passed, env (holder.sh), writer.lock
//   <stateDir>/<id>/  the console's own: read.json (its place in out.jsonl), sendlog.json
// One writer: a console holds writer.lock of a worker while it writes to its FIFO or reads its
// out.jsonl (the boot id, its pid, start time and a token; a lock of a console that ended, also
// before a reboot, is taken over). Another console, or a second host in this process, gets
// "not live" or a refusal.
// The env file holds the program's environment (its secrets too): it lives from the write to the
// holder's read only. A new host removes each env file that no live console holds first.
// Each step that starts or stops a program of a worker (spawn, reattach, kill, stop, remove, the
// end of a program) runs after the step before it of the same worker (a queue per id).
// Send: the console logs the message (sendlog.ts), then writes its frame into the FIFO. The writes
// of one worker go one after the other, so two long lines never mix. The FIFO fd is non-blocking:
// a worker that stopped reading never holds a thread of the console. A frame that the relay did
// not pass goes again after resendMs.
// Read: whole lines of out.jsonl from the saved place, one chunk per tick; a cut last line waits
// for its end. onEvent gets each line of the 5 kinds (stream.ts) at least once: a console that
// stops between a read and the save of its place reads the line again. The host's own steps are
// idempotent (the send log acks by uuid: a replay, or the end of a command_lifecycle).
// out.jsonl is the program's stdout (an O_APPEND fd that the program holds: a rename does not move
// it). So the host does not rotate it during a run: each outTrimBytes that it read, it frees the
// disk blocks of the part that it read (a punch-hole: the size and every offset stay, that part
// reads as NULs). At each start it moves the file to out.1.jsonl (a new generation).
// No call of the AgentHost seam throws or rejects: it gives false, "not-live", or for send() of a
// message above HEADLESS_MAX_BYTES as JSON, a TooLarge result.
//
// Known limit of step 1: another process of the same Linux user (another agent) can write frames
// into the FIFO, edit sendlog.json or read.json, or put a link in place of in.fifo. The folders
// are 0700, so other users cannot.
import { execFile, execFileSync, spawn as spawnChild } from "node:child_process";
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentHost, HostSendResult } from "../host.js";
import { SendLog, type SendEntry } from "./sendlog.js";
import { HEADLESS_MAX_BYTES, frame, interruptLine, parseEvent, userLine, wellFormed, type StreamEvent } from "./stream.js";

export { HEADLESS_MAX_BYTES };

const run = promisify(execFile);
export const HOLDER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "holder.sh");
export const DEFAULT_UNIT_PREFIX = "agent-headless-";
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CHUNK = 4 << 20;     // a read of out.jsonl takes this much, unless one line is longer
const MAX_LINE = 16 << 20; // a longer output line is skipped (no line of the 4 kinds is that long)
// A program that ended: its holder writes the exit code at once. With no exit file after this
// long, the scope was killed (no code).
const EXIT_FILE_WAIT_MS = 1000;
// fallocate --punch-hole is fast; one that hangs (a stuck filesystem) is killed after this long.
const TRIM_TIMEOUT_MS = 2000;
// Names that a shell runs or reads as code: the program's environment never holds them.
export const SHELL_CODE_ENV = /^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|BASH_FUNC_.*)$/;

export type HeadlessOpts = {
  runDir: string;
  stateDir: string;
  unitPrefix?: string;
  tickMs?: number;          // how often the host reads out.jsonl and checks its programs (500)
  startTimeoutMs?: number;  // spawn() waits this long for the program's pid (10 s)
  sendWaitMs?: number;      // send() and interrupt() wait this long for their write (5 s), then the write goes on
  writeStallMs?: number;    // a write that makes no progress this long stops (60 s): the resend gives it again
  resendMs?: number;        // an open message that the relay did not pass goes again after this long (30 s)
  outTrimBytes?: number;    // the read part of out.jsonl is freed each time it grows by this much (64 MiB)
  onEvent?: (id: string, e: StreamEvent) => void;
  // code null: no exit code (the scope was stopped or killed). killed: kill() or stop() ended it.
  // When it comes, no process of the program is left (the scope is stopped).
  onExit?: (id: string, code: number | null, killed: boolean) => void;
  // A reattach closed these commands: as SpawnResult.notResent (a console stopped during a start,
  // after the commands were marked passed and before they were closed). The caller tells the user.
  onNotResent?: (id: string, items: Array<{ uuid: string; text: string }>) => void;
};

// env: the program's whole environment (nothing of the console's own goes to it).
export type SpawnOpts = { id: string; cwd: string; command: string; args: string[]; env: Record<string, string | undefined> };
// notResent: the commands ("/…") that the relay gave to the last program, that Claude did not
// report as done, and that this start does not send again (the caller tells the user).
export type SpawnResult = { ok: true; notResent: Array<{ uuid: string; text: string }> } | { ok: false; why: string };
// held: another console holds the worker; nothing was removed.
export type RemoveResult = "removed" | "held" | "failed";

type Live = { pid: number; start: string; killed: boolean; deadAt?: number; ending?: boolean };
// The pid file of the holder: the program's pid, its start time and the boot id.
type Saved = { pid: number; start: string; boot: string };
// Where the console read out.jsonl: the file's generation (a new one at each start), its inode
// and the offset; skip: in a line above MAX_LINE.
type ReadState = { gen: string; ino: number; off: number; skip: boolean };

export class HeadlessHost implements AgentHost {
  readonly unitPrefix: string;
  private runDir: string;
  private stateDir: string;
  private token = randomUUID();
  private live = new Map<string, Live>();
  private fds = new Map<string, number>();
  private locks = new Map<string, string>();
  private logs = new Map<string, SendLog>();
  private reads = new Map<string, ReadState>();
  private gens = new Map<string, string>();
  private chains = new Map<string, Promise<void>>();
  private serials = new Map<string, Promise<void>>();
  private wrote = new Map<string, Map<string, number>>(); // id → entry uuid → the time of its last write
  private trimmed = new Map<string, number>();              // id → the end of the freed part of out.jsonl
  private noTrim = new Set<string>();                       // ids whose trim failed in this out.jsonl
  private timer: NodeJS.Timeout | null = null;
  private closed = false;                                   // shutdown() ran

  constructor(private opts: HeadlessOpts) {
    this.unitPrefix = opts.unitPrefix ?? DEFAULT_UNIT_PREFIX;
    if (!/^[A-Za-z0-9_-]*$/.test(this.unitPrefix)) throw new Error(`bad unit prefix ${JSON.stringify(this.unitPrefix)}`);
    this.runDir = resolve(opts.runDir);
    this.stateDir = resolve(opts.stateDir);
    this.sweepEnvFiles();
  }

  // Before anything else: an env file that a console left (it stopped during a start) goes, under
  // the worker's lock. One that a live console holds is in its start now: it stays.
  private sweepEnvFiles(): void {
    let ids: string[] = [];
    try { ids = readdirSync(this.runDir); } catch { return; }
    for (const id of ids) {
      if (!SAFE_ID.test(id)) continue;
      const p = this.paths(id);
      try {
        if (!existsSync(p.env) || !this.claim(id)) continue;
        try { rmSync(p.env, { force: true }); } finally { this.release(id); }
      } catch (err) { warn(id, "the sweep of a left env file", err); }
    }
  }

  private paths(id: string) {
    if (!SAFE_ID.test(id)) throw new Error(`bad agent id ${JSON.stringify(id)}`);
    const run = join(this.runDir, id);
    const state = join(this.stateDir, id);
    return {
      run, state, fifo: join(run, "in.fifo"), out: join(run, "out.jsonl"), old: join(run, "out.1.jsonl"),
      gen: join(run, "gen"), err: join(run, "err.log"), env: join(run, "env"), pid: join(run, "pid"),
      exit: join(run, "exit"), passed: join(run, "passed"), lock: join(run, "writer.lock"),
      read: join(state, "read.json"), log: join(state, "sendlog.json"),
    };
  }

  unit(id: string): string { return `${this.unitPrefix}${id}.scope`; }

  // ── AgentHost ────────────────────────────────────────────────────────────────────────────────

  // The worker was started here once (its folder is there), live or not.
  owns(id: string): boolean { return SAFE_ID.test(id) && existsSync(join(this.runDir, id)); }

  // Each worker that was started here once (its folder is there), live or not.
  owned(): string[] {
    try {
      return readdirSync(this.runDir, { withFileTypes: true }).filter((d) => d.isDirectory() && SAFE_ID.test(d.name)).map((d) => d.name);
    } catch { return []; }
  }

  has(id: string): boolean {
    const l = this.live.get(id);
    return !!l && !l.ending && alive(l.pid, l.start);
  }

  async hasSession(id: string): Promise<boolean> {
    try {
      if (this.has(id)) return true;
      if (!this.owns(id)) return false;
      const p = this.savedPid(id);
      return !!p && running(p);
    } catch { return false; }
  }

  // After a console restart: the program lives on in its scope. The host reads out.jsonl to its
  // end first (the replays that came while the console was down), then sends the open entries
  // that the relay did not pass. A program that ended while the console was down: its last lines
  // and its exit code go to onEvent and onExit, its scope is stopped, and the result is false.
  // Commands that the relay gave to an older program and that are still open (the last console
  // stopped in a start) are closed and go to onNotResent.
  async reattach(id: string): Promise<boolean> {
    if (!SAFE_ID.test(id)) return false;
    const ended: { code?: number | null; killed?: boolean } = {};
    let notResent: Array<{ uuid: string; text: string }> = [];
    let ok = false;
    try {
      ok = await this.serial(id, async () => {
        this.checkOpen();
        if (this.has(id)) return true;
        // A program that kill() stopped and whose end the poll has not taken yet: its end says
        // killed (a move to another login: kill, then a reattach in the resume).
        const killed = this.live.get(id)?.killed ?? false;
        if (!this.owns(id)) return false;
        const p = this.savedPid(id);
        if (!p || !this.claim(id)) return false;
        if (running(p)) {
          this.openFifo(id);
          this.live.set(id, { pid: p.pid, start: p.start, killed: false });
          await this.drainOut(id);
          this.checkOpen();
          try { notResent = this.log(id).closePassedCommands(); } catch (err) { warn(id, "the send log", err); }
          this.tick();
          void this.resend(id, this.passedIds(id));
          return true;
        }
        // Another boot: the program ended with the machine, and no holder writes its exit file.
        const deadline = p.boot === BOOT_ID ? Date.now() + EXIT_FILE_WAIT_MS : 0;
        while (exitCodeOf(this.paths(id).exit) === null && Date.now() < deadline) {
          await sleep(50);
          this.checkOpen();
        }
        await this.drainOut(id);
        this.checkOpen();
        ended.killed = killed;
        ended.code = this.closeDead(id);
        await this.stopUnit(id); // the end is taken (its pid file is gone): it is reported also after a shutdown
        return false;
      });
    } catch (err) {
      if (!this.closed) warn(id, "reattach", err);
      this.live.delete(id);
      this.release(id);
      return false;
    }
    if (notResent.length) try { this.opts.onNotResent?.(id, notResent); } catch (err) { warn(id, "onNotResent", err); }
    if ("code" in ended) this.reportExit(id, ended.code ?? null, ended.killed ?? false);
    return ok;
  }

  // A stream takes input at any time: Claude queues a message that comes during a turn.
  inputReady(id: string): boolean { return this.has(id); }

  // Stops the scope (after a spawn of this id that runs now); onExit then says killed.
  kill(id: string): void {
    if (!SAFE_ID.test(id)) return;
    void this.serial(id, () => this.stopNow(id)).catch((err: unknown) => warn(id, "kill", err));
  }

  // "sent": logged, and written or being written (a write that takes longer than sendWaitMs goes
  // on; a frame that the relay does not pass goes again). A program that ends first gets it at its
  // next start (a command "/…" that the relay passed: not again, see SpawnResult). TooLarge: a
  // message above HEADLESS_MAX_BYTES as JSON; nothing logged or written. Never rejects.
  async send(id: string, text: string): Promise<HostSendResult> {
    if (!SAFE_ID.test(id) || !this.has(id)) return "not-live";
    const t = wellFormed(text);
    const uuid = randomUUID();
    const json = userLine(uuid, t);
    if (json.length > HEADLESS_MAX_BYTES) return { refused: "too-large", bytes: json.length, limit: HEADLESS_MAX_BYTES }; // ASCII: chars = bytes
    try { this.log(id).add(t, { uuid }); } catch (err) { warn(id, "the send log", err); return "not-live"; }
    await within(this.writeEntry(id, uuid, json), this.opts.sendWaitMs ?? 5000, undefined);
    return "sent";
  }

  // ── more than the seam ───────────────────────────────────────────────────────────────────────

  // Starts the program in a new scope. A program of this id that still runs is stopped first,
  // with no onExit. The open entries of the send log go to the new program. Never rejects.
  async spawn(o: SpawnOpts): Promise<SpawnResult> {
    if (!SAFE_ID.test(o.id)) return { ok: false, why: `bad agent id ${JSON.stringify(o.id)}` };
    const bad = refusalOf(o);
    if (bad) return { ok: false, why: bad };
    try {
      return await this.serial(o.id, () => this.start(o));
    } catch (err) {
      this.live.delete(o.id);
      this.release(o.id);
      return { ok: false, why: `the worker ${o.id} did not start: ${messageOf(err)}` };
    }
  }

  // Ends the turn now (an Interrupt). Not in the send log: a program that ended needs none.
  // false: not written in sendWaitMs (a write before it stalls); it is then never written, so it
  // cannot end a later turn.
  async interrupt(id: string): Promise<boolean> {
    if (!SAFE_ID.test(id) || !this.has(id)) return false;
    const rid = `int-${randomUUID()}`;
    let late = false;
    const w = this.write(id, frame(rid, interruptLine(rid)), () => late).then(() => true, () => false);
    return within(w, this.opts.sendWaitMs ?? 5000, false, () => { late = true; });
  }

  // As kill(), and waits until the scope is gone.
  async stop(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return;
    await this.serial(id, () => this.stopNow(id)).catch((err: unknown) => warn(id, "stop", err));
  }

  // The close of the worker: the program and both folders go, with no onExit. (Its session file
  // stays, as for a terminal worker.) "held": another console holds it; nothing changed.
  async remove(id: string): Promise<RemoveResult> {
    if (!SAFE_ID.test(id)) return "failed";
    const l = this.live.get(id);
    if (l) l.ending = true; // a program that ends during the stop gives no onExit
    return this.serial(id, async (): Promise<RemoveResult> => {
      const p = this.paths(id);
      if (existsSync(p.run) && !this.claim(id)) {
        if (l && this.live.get(id) === l) l.ending = false;
        return "held";
      }
      this.live.delete(id);
      await this.stopUnit(id);
      this.release(id);
      for (const m of [this.logs, this.reads, this.gens, this.wrote, this.trimmed, this.noTrim]) m.delete(id);
      rmSync(p.run, { recursive: true, force: true });
      rmSync(p.state, { recursive: true, force: true });
      return "removed";
    }).catch((err: unknown) => { warn(id, "remove", err); return "failed" as const; });
  }

  // The messages that Claude did not take yet, oldest first.
  pending(id: string): SendEntry[] {
    try { return SAFE_ID.test(id) ? this.log(id).open() : []; } catch { return []; }
  }

  // The console stops: the programs live on. A start or a reattach in progress stops at its next
  // step (the next console reattaches the program, if it started).
  shutdown(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of new Set([...this.fds.keys(), ...this.locks.keys()])) this.release(id);
    this.live.clear();
  }

  // ── inside ───────────────────────────────────────────────────────────────────────────────────

  // One step of a worker at a time: each starts when the one before it ended.
  private serial<T>(id: string, f: () => Promise<T>): Promise<T> {
    const prev = this.serials.get(id) ?? Promise.resolve();
    const p = prev.then(f);
    const tail = p.then(() => {}, () => {});
    this.serials.set(id, tail);
    void tail.then(() => { if (this.serials.get(id) === tail) this.serials.delete(id); });
    return p;
  }

  // After each wait of a start or a reattach: a host that was shut down does nothing more (it
  // holds no lock now).
  private checkOpen(): void {
    if (this.closed) throw new Error("the console stops");
  }

  private async start(o: SpawnOpts): Promise<SpawnResult> {
    const id = o.id;
    const p = this.paths(id);
    this.checkOpen();
    ownDir(p.run);
    ownDir(p.state);
    if (!this.claim(id)) return { ok: false, why: `another console holds the worker ${id}` };
    this.live.delete(id);
    await this.stopUnit(id);
    this.checkOpen();
    await makeFifo(p.fifo);
    this.checkOpen();
    this.openFifo(id);
    await this.drainOut(id); // the lines of a program that ended while the console was down
    this.checkOpen();
    // The entries that the relay gave to the last program (a command of them is not sent again).
    try { this.log(id).markPassed(this.passedIds(id)); } catch (err) { warn(id, "the send log", err); }
    this.rotate(id);
    for (const f of [p.pid, p.exit, p.passed, p.env]) rmSync(f, { force: true });
    this.drainFifo(id);      // frames that the last program did not read: the resend gives them again
    this.wrote.delete(id);
    writeFileSync(p.env, envFile(o.env), { mode: 0o600, flag: "wx" });
    try {
      let ended = false;
      let spawnError = "";
      const errFd = openSync(p.err, "a", 0o600);
      try {
        const child = spawnChild(sysBin("systemd-run"), [
          "--user", "--scope", "--quiet", "--collect", `--unit=${this.unit(id)}`, "-p", "TimeoutStopSec=10", "--",
          sysBin("setsid"), sysBin("bash"), "-p", HOLDER_SCRIPT, p.run, o.command, ...o.args,
        ], { cwd: o.cwd, env: systemEnv(), stdio: ["ignore", "ignore", errFd] });
        child.on("exit", () => { ended = true; });
        child.on("error", (err) => { ended = true; spawnError = err.message; });
        child.unref();
      } finally { closeSync(errFd); }

      const deadline = Date.now() + (this.opts.startTimeoutMs ?? 10_000);
      for (;;) {
        const saved = this.savedPid(id);
        if (saved) { this.live.set(id, { pid: saved.pid, start: saved.start, killed: false }); break; }
        if (ended || Date.now() > deadline) {
          await this.stopUnit(id);
          this.release(id);
          return { ok: false, why: `the worker ${id} did not start: ${spawnError || tailOf(p.err)}` };
        }
        await sleep(20);
        // A shutdown now: the env file goes (finally). A holder that read it writes its pid file and
        // the next console reattaches the program; one that did not read it ends.
        this.checkOpen();
      }
    } finally {
      rmSync(p.env, { force: true }); // the holder read it before it wrote the pid file; on a fault: not read
    }
    let notResent: Array<{ uuid: string; text: string }> = [];
    try { notResent = this.log(id).closePassedCommands(); } catch (err) { warn(id, "the send log", err); }
    this.tick();
    void this.resend(id, new Set());
    return { ok: true, notResent };
  }

  private async stopNow(id: string): Promise<void> {
    const l = this.live.get(id);
    if (l) l.killed = true;
    await this.stopUnit(id);
  }

  // The program ended (poll saw it): its last lines, then the stop of its scope (a process of it
  // in another session lives on until then), then onExit.
  private async finish(id: string, l: Live): Promise<void> {
    if (l.ending || this.live.get(id) !== l) return;
    if (exitCodeOf(this.paths(id).exit) === null) {
      l.deadAt ??= Date.now();
      if (Date.now() - l.deadAt < EXIT_FILE_WAIT_MS) return;
    }
    l.ending = true;
    const ended: { code?: number | null } = {};
    await this.serial(id, async () => {
      if (this.live.get(id) !== l) return; // removed, or started again
      await this.drainOut(id);
      if (this.live.get(id) !== l) return;
      ended.code = this.closeDead(id);
      await this.stopUnit(id);
    }).catch((err: unknown) => warn(id, "the end of the program", err));
    if ("code" in ended) this.reportExit(id, ended.code ?? null, l.killed);
  }

  // Nothing of a program that ended stays live here; its pid file goes (its end is reported once).
  private closeDead(id: string): number | null {
    const p = this.paths(id);
    const code = exitCodeOf(p.exit);
    this.live.delete(id);
    this.release(id);
    rmSync(p.pid, { force: true });
    return code;
  }

  private reportExit(id: string, code: number | null, killed: boolean): void {
    try { this.opts.onExit?.(id, code, killed); } catch (err) { warn(id, "onExit", err); }
  }

  private log(id: string): SendLog {
    let l = this.logs.get(id);
    if (!l) { // its folder: start() makes it (a read of a worker that never started makes none)
      l = new SendLog(this.paths(id).log);
      this.logs.set(id, l);
    }
    return l;
  }

  // The open entries, oldest first; skip: the ones that the relay passed already. A command that
  // the relay gave to an older program is never written (its close failed or did not run yet).
  private async resend(id: string, skip: ReadonlySet<string>): Promise<void> {
    try {
      for (const e of this.log(id).open()) {
        if (!this.has(id)) return;
        if (skip.has(e.uuid) || passedCommand(e)) { this.noteWrite(id, e.uuid); continue; }
        await this.writeEntry(id, e.uuid, userLine(e.uuid, e.text));
      }
    } catch (err) { warn(id, "resend", err); }
  }

  // A frame that the relay did not pass (a cut or dropped write): again, after resendMs.
  private resendDue(id: string): void {
    if (this.chains.has(id)) return; // a write runs
    const open = this.log(id).open();
    if (open.length === 0) return;
    const every = this.opts.resendMs ?? 30_000;
    const now = Date.now();
    const wrote = this.wrote.get(id);
    const due = open.filter((e) => now - (wrote?.get(e.uuid) ?? 0) >= every);
    if (due.length === 0) return;
    const passed = this.passedIds(id);
    for (const e of due) {
      if (passed.has(e.uuid) || passedCommand(e)) this.noteWrite(id, e.uuid); // in Claude's queue, or never again
      else void this.writeEntry(id, e.uuid, userLine(e.uuid, e.text));
    }
  }

  private noteWrite(id: string, uuid: string): void {
    let m = this.wrote.get(id);
    if (!m) { m = new Map(); this.wrote.set(id, m); }
    m.set(uuid, Date.now());
  }

  // Never rejects: a write that stops is given again by the resend.
  private writeEntry(id: string, uuid: string, json: string): Promise<void> {
    this.noteWrite(id, uuid);
    let buf: Buffer;
    try { buf = frame(uuid, json); } catch (err) { warn(id, "a logged message", err); return Promise.resolve(); }
    return this.write(id, buf).catch((err: unknown) => warn(id, "the write stopped; it goes again", err));
  }

  // cancelled: true when its wait ended (the write then stops before its next byte).
  private write(id: string, buf: Buffer, cancelled?: () => boolean): Promise<void> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const p = prev.then(() => this.writeAll(id, buf, cancelled));
    const tail = p.catch(() => {});
    this.chains.set(id, tail);
    void tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
    return p;
  }

  private async writeAll(id: string, buf: Buffer, cancelled?: () => boolean): Promise<void> {
    const stall = this.opts.writeStallMs ?? 60_000;
    let done = 0;
    let last = Date.now();
    while (done < buf.length) {
      if (cancelled?.()) throw new Error("its wait ended"); // a cut frame: the relay drops it
      const fd = this.fds.get(id);
      if (fd === undefined) throw new Error("the FIFO is closed");
      try {
        const n = writeSync(fd, buf, done, buf.length - done);
        done += n;
        if (n > 0) last = Date.now();
      } catch (err) {
        if (codeOf(err) !== "EAGAIN") throw err;
        if (!this.has(id)) throw new Error("the program ended");
        if (Date.now() - last > stall) throw new Error(`the worker read no input for ${stall} ms`);
        await sleep(5); // the FIFO is full: the relay reads it
      }
    }
  }

  // The one writer of a worker: writer.lock holds "<boot id> <pid> <start time> <token>" of its
  // console. A lock of a process that ended (also one of another boot: its pid and start time can
  // be ours now) is moved aside and taken; a lock that another console made in the meantime is
  // put back.
  private claim(id: string): boolean {
    if (this.locks.has(id)) return true;
    const file = this.paths(id).lock;
    const mine = `${BOOT_ID} ${process.pid} ${SELF_START} ${this.token}\n`;
    for (let i = 0; i < 3; i++) {
      try {
        writeFileSync(file, mine, { flag: "wx", mode: 0o600 });
        this.locks.set(id, mine);
        return true;
      } catch (err) { if (codeOf(err) !== "EEXIST") return false; }
      let seen: string;
      try { seen = readFileSync(file, "utf8"); } catch { continue; }
      if (lockLive(seen)) return false; // another console, or another host here
      const aside = `${file}.${this.token}`;
      try { renameSync(file, aside); } catch { continue; }
      let moved = "";
      try { moved = readFileSync(aside, "utf8"); } catch { /* gone */ }
      if (moved !== seen) { try { linkSync(aside, file); } catch { /* a third console holds it now */ } }
      rmSync(aside, { force: true });
    }
    return false;
  }

  private release(id: string): void {
    const fd = this.fds.get(id);
    this.fds.delete(id);
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
    const mine = this.locks.get(id);
    this.locks.delete(id);
    if (!mine) return;
    try {
      const file = this.paths(id).lock;
      if (readFileSync(file, "utf8") === mine) rmSync(file, { force: true });
    } catch { /* gone */ }
  }

  // The console's own read-write fd on the FIFO: the open never waits, and the FIFO keeps its
  // bytes while the console holds it (it drops them when its last fd closes).
  private openFifo(id: string): void {
    if (this.fds.has(id)) return;
    const fd = openSync(this.paths(id).fifo, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFIFO()) throw new Error("in.fifo is not a FIFO");
    } catch (err) { closeSync(fd); throw err; }
    this.fds.set(id, fd);
  }

  private drainFifo(id: string): void {
    const fd = this.fds.get(id);
    if (fd === undefined) return;
    const buf = Buffer.alloc(65536);
    for (;;) {
      try { if (readSync(fd, buf, 0, buf.length, null) <= 0) return; } catch { return; }
    }
  }

  private tick(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.poll(), this.opts.tickMs ?? 500);
    this.timer.unref?.();
  }

  private poll(): void {
    for (const [id, l] of [...this.live]) {
      if (this.closed) return;
      if (l.ending) continue;
      try {
        this.readChunk(id);
        if (!alive(l.pid, l.start)) void this.finish(id, l);
        else this.resendDue(id);
      } catch (err) {
        warn(id, "poll", err);
      }
    }
  }

  // A new out.jsonl and a new generation for the next program. The last program's lines stay in
  // out.1.jsonl (for a person who looks).
  private rotate(id: string): void {
    const p = this.paths(id);
    try { renameSync(p.out, p.old); } catch (err) { if (codeOf(err) !== "ENOENT") throw err; }
    const gen = randomUUID();
    const r: ReadState = { gen, ino: -1, off: 0, skip: false };
    this.reads.set(id, r);
    this.trimmed.delete(id);
    this.noTrim.delete(id); // a new out.jsonl: the trim is tried again
    this.saveRead(id, r);
    atomicWrite(p.gen, `${gen}\n`);
    this.gens.set(id, gen);
  }

  private genOf(id: string): string {
    let g = this.gens.get(id);
    if (g === undefined) {
      try { g = readFileSync(this.paths(id).gen, "utf8").trim(); } catch { g = ""; }
      this.gens.set(id, g);
    }
    return g;
  }

  private readState(id: string): ReadState {
    let r = this.reads.get(id);
    if (!r) {
      r = { gen: "", ino: -1, off: 0, skip: false };
      try {
        const v = JSON.parse(readFileSync(this.paths(id).read, "utf8")) as Partial<ReadState>;
        if (typeof v.gen === "string" && typeof v.ino === "number" && typeof v.off === "number" && v.off >= 0) {
          r = { gen: v.gen, ino: v.ino, off: v.off, skip: v.skip === true };
        }
      } catch { /* none yet */ }
      this.reads.set(id, r);
    }
    return r;
  }

  private saveRead(id: string, r: ReadState): void { atomicWrite(this.paths(id).read, JSON.stringify(r)); }

  // All of out.jsonl, one chunk at a time, with a turn of the event loop between chunks.
  private async drainOut(id: string): Promise<void> {
    for (let i = 0; i < 100_000 && !this.closed && this.readChunk(id); i++) await new Promise<void>((r) => setImmediate(r));
  }

  // One chunk of whole lines from the saved place; true: it moved on. Another generation, another
  // file or a shorter file than the offset: from 0.
  private readChunk(id: string): boolean {
    const p = this.paths(id);
    let st: { size: number; ino: number };
    try { st = statSync(p.out); } catch { return false; }
    const gen = this.genOf(id);
    let r = this.readState(id);
    if (r.gen !== gen || r.ino !== st.ino || st.size < r.off) {
      r = { gen, ino: st.ino, off: 0, skip: false };
      this.reads.set(id, r);
      this.trimmed.delete(id);
      this.noTrim.delete(id);
    }
    const avail = st.size - r.off;
    if (avail <= 0) return false;
    let want = Math.min(avail, CHUNK);
    let buf = readAt(p.out, r.off, want);
    if (buf.length === 0) return false;
    if (r.skip) { // the rest of a line above MAX_LINE
      const nl = buf.indexOf(0x0a);
      r.off += nl < 0 ? buf.length : nl + 1;
      if (nl >= 0) r.skip = false;
      this.saveRead(id, r);
      return true;
    }
    if (buf[0] === 0) { // the freed part (trimOut) reads as NULs: no output line, no warning
      const k = buf.findIndex((b) => b !== 0);
      r.off += k < 0 ? buf.length : k;
      this.saveRead(id, r);
      return true;
    }
    let cut = buf.lastIndexOf(0x0a);
    while (cut < 0 && want < avail && want < MAX_LINE) {
      want = Math.min(avail, want * 2, MAX_LINE);
      buf = readAt(p.out, r.off, want);
      cut = buf.lastIndexOf(0x0a);
    }
    if (cut < 0) {
      if (buf.length < MAX_LINE) return false; // a cut last line: it waits for its end
      warn(id, `an output line above ${MAX_LINE} bytes: skipped`);
      r.off += buf.length;
      r.skip = true;
      this.saveRead(id, r);
      return true;
    }
    for (const raw of buf.subarray(0, cut).toString("utf8").split("\n")) {
      const e = raw ? parseEvent(raw) : null;
      if (e) this.onLine(id, e);
    }
    r.off += cut + 1;
    this.saveRead(id, r);
    this.trimOut(id, r.off, st.ino);
    return true;
  }

  // Frees the disk blocks of out.jsonl before the read place, each outTrimBytes (the header says
  // why not a rotation). The last "\n" before the place stays: a read from 0 (its place lost)
  // skips the NULs of the freed part (readChunk) and goes on at that "\n". A failed trim is not
  // tried again in this out.jsonl (a new one comes at the next start).
  private trimOut(id: string, off: number, ino: number): void {
    const every = this.opts.outTrimBytes ?? 64 << 20;
    const end = off - 1;
    if (this.noTrim.has(id) || end - (this.trimmed.get(id) ?? 0) < every) return;
    const file = this.paths(id).out;
    try {
      if (statSync(file).ino !== ino) return;
      execFileSync(sysBin("fallocate"), ["--punch-hole", "--offset", "0", "--length", String(end), file], {
        env: systemEnv(), stdio: "ignore", timeout: TRIM_TIMEOUT_MS, killSignal: "SIGKILL",
      });
      this.trimmed.set(id, end);
    } catch (err) {
      this.noTrim.add(id);
      warn(id, "the trim of out.jsonl (fallocate --punch-hole) failed; this out.jsonl grows until the next start", err);
    }
  }

  private onLine(id: string, e: StreamEvent): void {
    if (e.kind === "ack" && !e.local) {
      try { this.log(id).ackReplay(e.uuid, e.text); } catch (err) { warn(id, "ack", err); }
    }
    // An input that gets no replay: Claude ends its command_lifecycle (also for a replayed one).
    if (e.kind === "lifecycle" && e.commandUuid && (e.state === "completed" || e.state === "cancelled")) {
      try { this.log(id).ackCommand(e.commandUuid); } catch (err) { warn(id, "ack", err); }
    }
    try { this.opts.onEvent?.(id, e); } catch (err) { warn(id, "onEvent", err); }
  }

  private passedIds(id: string): Set<string> {
    try { return new Set(readFileSync(this.paths(id).passed, "utf8").split("\n").filter(Boolean)); } catch { return new Set(); }
  }

  private savedPid(id: string): Saved | null {
    try {
      const [pid, start, boot] = readFileSync(this.paths(id).pid, "utf8").trim().split(" ");
      const n = Number(pid);
      return Number.isInteger(n) && n > 0 && start ? { pid: n, start, boot: boot ?? "" } : null;
    } catch { return null; }
  }

  private async stopUnit(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return;
    try {
      await run(sysBin("systemctl"), ["--user", "stop", this.unit(id)], { env: systemEnv() });
    } catch { /* not loaded */ }
  }
}

// The start time of this process (field 22 of /proc/self/stat): with the pid, it names this
// console in writer.lock.
const SELF_START = (() => {
  try {
    const s = readFileSync("/proc/self/stat", "utf8");
    return s.slice(s.lastIndexOf(") ") + 2).split(" ")[19] ?? "0";
  } catch { return "0"; }
})();

// The boot of this machine: a pid and a start time name one process only within one boot.
const BOOT_ID = (() => {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || "-"; } catch { return "-"; }
})();

// The program of a pid file runs (in this boot).
const running = (p: Saved) => p.boot === BOOT_ID && alive(p.pid, p.start);

// writer.lock names a console that lives (in this boot).
function lockLive(text: string): boolean {
  const [boot, pid, start] = text.trim().split(" ");
  return boot === BOOT_ID && alive(Number(pid), start ?? "");
}

// A command ("/…") that the relay gave to an older program (marked at a start): never sent again.
const passedCommand = (e: SendEntry) => e.slash && e.passed === true;

// The process is there, not a zombie, and the same one (its start time in /proc/<pid>/stat):
// a pid that the system gave to another process later is not the worker.
function alive(pid: number, start: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = s.slice(s.lastIndexOf(") ") + 2).split(" ");
    return f[0] !== "Z" && f[19] === start;
  } catch { return false; }
}

// The command and environment of a program: no shell code, no NUL, no option in place of the
// command (env -i reads a "NAME=VALUE" there as one more variable).
function refusalOf(o: SpawnOpts): string | null {
  if (!o.command || o.command.startsWith("-") || o.command.includes("=")) return `bad command ${JSON.stringify(o.command)}`;
  if ([o.command, o.cwd, ...o.args].some((s) => s.includes("\0"))) return "a NUL byte in the command";
  for (const [k, v] of Object.entries(o.env)) {
    if (v === undefined) continue;
    if (!/^[^=\0]+$/.test(k)) return `bad environment name ${JSON.stringify(k)}`;
    if (SHELL_CODE_ENV.test(k)) return `the environment holds ${k}: a shell runs it`;
    if (v.includes("\0")) return `a NUL byte in the value of ${k}`;
  }
  return null;
}

function envFile(env: Record<string, string | undefined>): string {
  return Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}\0`).join("");
}

// A folder of a worker: 0700, a real folder (not a link).
function ownDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
  chmodSync(dir, 0o700);
}

async function makeFifo(file: string): Promise<void> {
  try {
    if (lstatSync(file).isFIFO()) return;
    rmSync(file, { force: true }); // a file or a link in its place
  } catch (err) { if (codeOf(err) !== "ENOENT") throw err; }
  await run(sysBin("mkfifo"), ["-m", "600", file], { env: systemEnv() });
}

// A system program by its absolute path: never one that the PATH of the console finds first.
function sysBin(name: string): string {
  for (const d of ["/usr/bin", "/bin"]) if (existsSync(`${d}/${name}`)) return `${d}/${name}`;
  throw new Error(`no ${name} in /usr/bin or /bin`);
}

// The environment of systemd-run, systemctl and mkfifo: fixed. systemd-run --user finds the user
// manager by XDG_RUNTIME_DIR.
function systemEnv(): NodeJS.ProcessEnv {
  const e: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
  };
  if (process.env.DBUS_SESSION_BUS_ADDRESS) e.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  return e as NodeJS.ProcessEnv;
}

function exitCodeOf(file: string): number | null {
  try {
    const t = readFileSync(file, "utf8").trim();
    const n = Number(t);
    return t !== "" && Number.isInteger(n) ? n : null;
  } catch { return null; }
}

function readAt(file: string, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const fd = openSync(file, constants.O_RDONLY);
  try {
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, pos + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally { closeSync(fd); }
}

function atomicWrite(file: string, data: string): void {
  writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function tailOf(file: string): string {
  try { return readFileSync(file, "utf8").slice(-300).trim() || "(no error output)"; } catch { return "(no error output)"; }
}

// p, or `fallback` after ms (p goes on; onLate runs first).
function within<T>(p: Promise<T>, ms: number, fallback: T, onLate?: () => void): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const late = new Promise<T>((r) => { t = setTimeout(() => { onLate?.(); r(fallback); }, ms); t.unref?.(); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const warn = (id: string, what: string, err?: unknown) =>
  console.warn(`[headless] ${id}: ${what}${err === undefined ? "" : `: ${messageOf(err)}`}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
