// server/agents/headless/wiring.ts — the headless workers in the product (PR 3 of the plan), behind
// an internal env flag: AGENT_HEADLESS=1. Off by default: with the flag off, nothing here runs (no
// host is registered, headless() is null), and every path of the console is as before.
//
// With the flag on (and never in a hardened deployment):
//   - a new worker (kind absent or "issue", runtime claude, no own clone) starts as `claude -p`
//     with a message stream (host.ts), with the same args, env and hook settings as a terminal
//     worker, plus crossSessionInbound "accept" in its --settings (a message of another agent
//     comes in with no approval hold; spike P6). The record says host "headless".
//   - its hooks post to the console as for a terminal worker (SessionStart, UserPromptSubmit,
//     Stop: spike P3). An interrupted turn has no Stop hook, and -p has no Notification: at a
//     `result` the console posts a Notification hook itself when the record still says running.
//   - at boot, reattach() of EACH worker that the host owns, also when hasSession() is false:
//     the last lines and the exit code of a program that ended while the console was down.
//   - the stream check: after a send to a live worker that is not in a turn, an init and an ack
//     must come within 30 s. Else one log line (with Claude's version), and new workers start in
//     a terminal until the console restarts.
//   - a worker at its usage limit is a row in the limit ticket (its record's stop mark, as for a
//     terminal worker). A headless worker has no own Continue: when its login has room again, the
//     console tells it to go on, one worker each 30 s (startAutoContinue).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addHost, TOO_LARGE_TEXT, type AgentHost, type HostSendResult } from "../host.js";
import { HeadlessHost, SHELL_CODE_ENV, type HeadlessOpts, type RemoveResult } from "./host.js";
import type { StreamEvent } from "./stream.js";
import type { AgentRecord, SessionStore } from "../store.js";
import { writeFileNoFollow } from "../nofollow.js";
import { resolveAppDataDir } from "../../defaults.js";
import { DEFAULT_ACCOUNT } from "../accounts.js";
import { hasRoom } from "../loginuse.js";
import type { LimitAgents } from "../../chief/limit/service.js";

type Env = Record<string, string | undefined>;

// The flag: exactly "1". Anything else (absent, "0", "true") is off.
export function headlessWanted(env: Env = process.env): boolean {
  return env.AGENT_HEADLESS === "1";
}

// The host's folders: AGENT_HEADLESS_DIR, else <the console's data dir>/headless.
export function headlessDirs(env: Env = process.env): { runDir: string; stateDir: string } {
  const root = env.AGENT_HEADLESS_DIR?.trim() || join(resolveAppDataDir(env), "headless");
  return { runDir: join(root, "run"), stateDir: join(root, "state") };
}

// The flags of a message stream (measured with claude 2.1.332; host.ts reads this form).
export const STREAM_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages"];

export function headlessArgs(base: string[]): string[] {
  return [...STREAM_FLAGS, ...base];
}

// A message of another agent (SendMessage) comes in with no approval hold: in the worker's own
// --settings file (the hook settings that prepare() wrote).
export async function acceptInbound(settingsPath: string): Promise<void> {
  const cur = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
  if (typeof cur !== "object" || cur === null || Array.isArray(cur)) throw new Error(`${settingsPath} is not a settings object`);
  if ((cur as Record<string, unknown>).crossSessionInbound === "accept") return;
  await writeFileNoFollow(settingsPath, JSON.stringify({ ...cur, crossSessionInbound: "accept" }));
}

// The env of the program: the names that a shell reads as code go (the host refuses them).
export function streamEnv(env: Record<string, string>): { env: Record<string, string>; dropped: string[] } {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (SHELL_CODE_ENV.test(k)) dropped.push(k);
    else out[k] = v;
  }
  return { env: out, dropped };
}

// The text of a command that was not sent again, in one short line.
function short(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

export type WiringDeps = {
  // The env of an agent program, as for a terminal agent (terminal.ts agentEnvOf).
  agentEnv: (id: string, extra?: Record<string, string>) => Record<string, string>;
  // The exit of a program, as the terminal's onExit (exit.ts agentExitHandler).
  onExit: (id: string, code: number, killed: boolean) => void;
  load: (id: string) => Promise<AgentRecord | null>;
  // A hook of the worker, posted by the console (the same route as Claude's own hooks).
  postHook: (id: string, token: string, body: Record<string, unknown>) => Promise<void>;
  // An error of the worker that the user must see (the notifier: Telegram and the list).
  tellUser: (id: string, text: string) => void;
  log?: (line: string) => void;
  host?: Partial<HeadlessOpts>;    // tests: tick, folders, unit prefix
  settleMs?: number;              // a `result` with no new turn this long → idle (1 s)
  checkMs?: number;               // the stream check's limit (30 s)
  now?: () => number;
};

type State = {
  known: boolean;          // busy is known (a start or a result since this console took it)
  busy: boolean;           // in a turn (init or ack since the last result)
  sessionId: string | null;
  version: string | null;  // Claude's version, from its last init
  lastSend: number;
  settle?: NodeJS.Timeout;
  watch?: { timer: NodeJS.Timeout; init: boolean; ack: boolean };
};

const SETTLE_MS = 1000;
const CHECK_MS = 30_000;
const GO_ON_GUARD_MS = 60_000;     // a go-on of the console in this window: no second one
const AUTO_RETRY_MS = 10 * 60_000; // the auto-continue tries one worker again after this long

export type LaunchOpts = { cwd: string; command: string; args: string[]; env?: Record<string, string>; settingsPath?: string };

export class HeadlessWiring {
  readonly host: HeadlessHost;
  // What hostOf() answers for a headless worker: the host, with a send that the stream check sees.
  readonly seam: AgentHost;
  private states = new Map<string, State>();
  private goOns = new Map<string, number>();
  private tried = new Map<string, number>();
  private failed: { version: string | null; at: number } | null = null;
  private lastVersion: string | null = null;
  private ticking = false;
  private loop: NodeJS.Timeout | null = null;
  private log: (line: string) => void;

  constructor(private d: WiringDeps) {
    this.log = d.log ?? ((l) => console.warn(l));
    const dirs = headlessDirs();
    const runDir = d.host?.runDir ?? dirs.runDir;
    const stateDir = d.host?.stateDir ?? dirs.stateDir;
    for (const dir of [runDir, stateDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.host = new HeadlessHost({
      ...d.host, runDir, stateDir,
      onEvent: (id, e) => this.onEvent(id, e),
      onExit: (id, code, killed) => this.onExit(id, code, killed),
      onNotResent: (id, items) => this.notResent(id, items),
    });
    const h = this.host;
    this.seam = {
      owns: (id) => h.owns(id),
      has: (id) => h.has(id),
      hasSession: (id) => h.hasSession(id),
      reattach: (id) => h.reattach(id),
      inputReady: (id) => h.inputReady(id),
      kill: (id) => h.kill(id),
      send: (id, text) => this.send(id, text),
    };
  }

  private state(id: string): State {
    let s = this.states.get(id);
    if (!s) { s = { known: false, busy: false, sessionId: null, version: null, lastSend: 0 }; this.states.set(id, s); }
    return s;
  }

  private now(): number { return (this.d.now ?? Date.now)(); }

  // A new worker starts headless: not after a failed stream check; Claude only; a worker only
  // (the persistent agents keep their terminal); never an agent with its own clone (its start
  // goes through the helper, which knows no headless host).
  eligible(rec: Pick<AgentRecord, "runtime" | "kind" | "clone">): boolean {
    return !this.failed && (rec.runtime ?? "claude") === "claude" && (rec.kind === undefined || rec.kind === "issue") && !rec.clone;
  }

  streamCheckFailed(): boolean { return this.failed !== null; }

  // Starts (or starts again) the program of a worker. Throws with the host's words when it did
  // not start. The commands that it did not send again go to the user.
  async launch(id: string, o: LaunchOpts): Promise<void> {
    if (o.settingsPath) await acceptInbound(o.settingsPath);
    const { env, dropped } = streamEnv(this.d.agentEnv(id, o.env));
    if (dropped.length) this.log(`[headless] ${id}: not in the worker's env: ${dropped.join(", ")}`);
    const r = await this.host.spawn({ id, cwd: o.cwd, command: o.command, args: headlessArgs(o.args), env });
    if (!r.ok) throw new Error(r.why);
    const s = this.state(id);
    this.endWatch(s);
    s.known = true;
    s.busy = false;
    this.notResent(id, r.notResent);
  }

  // The first message of a start (the positional prompt of a terminal worker). Throws when it was
  // not sent.
  async first(id: string, prompt: string | undefined): Promise<void> {
    if (!prompt?.trim()) return;
    const r = await this.send(id, prompt);
    if (r === "sent") return;
    throw new Error(typeof r === "object" ? TOO_LARGE_TEXT : `the first message was not sent (${r})`);
  }

  private async send(id: string, text: string): Promise<HostSendResult> {
    const s = this.state(id);
    // The stream check: armed before the write, so an init or an ack during it counts.
    const check = s.known && !s.busy && !s.watch && !text.trimStart().startsWith("/") && this.host.has(id);
    if (check) this.armWatch(id, s);
    s.lastSend = this.now();
    const r = await this.host.send(id, text);
    if (r !== "sent" && check) this.endWatch(s);
    return r;
  }

  private armWatch(id: string, s: State): void {
    const w = {
      init: false, ack: false,
      timer: setTimeout(() => {
        if (s.watch !== w) return;
        s.watch = undefined;
        if (!this.host.has(id)) return; // the program ended: its exit says it
        this.fail(id, w);
      }, this.d.checkMs ?? CHECK_MS),
    };
    w.timer.unref?.();
    s.watch = w;
  }

  private endWatch(s: State): void {
    if (s.watch) clearTimeout(s.watch.timer);
    s.watch = undefined;
  }

  private fail(id: string, w: { init: boolean; ack: boolean }): void {
    if (this.failed) return;
    const version = this.states.get(id)?.version ?? this.lastVersion;
    this.failed = { version, at: this.now() };
    const missing = [w.init ? null : "no init", w.ack ? null : "no ack"].filter(Boolean).join(" and ");
    this.log(`[headless] the stream check failed for ${id} (claude ${version ?? "version unknown"}): ${missing} within ${Math.round((this.d.checkMs ?? CHECK_MS) / 1000)} s of a send. New workers start in a terminal.`);
  }

  private onEvent(id: string, e: StreamEvent): void {
    const s = this.state(id);
    if (e.kind === "init") {
      s.busy = true;
      if (e.sessionId) s.sessionId = e.sessionId;
      if (e.version) { s.version = e.version; this.lastVersion = e.version; }
      if (s.watch) s.watch.init = true;
    } else if (e.kind === "ack" && !e.local) {
      s.busy = true;
      if (s.watch) s.watch.ack = true;
    } else if (e.kind === "result") {
      s.busy = false;
      s.known = true;
      if (e.sessionId) s.sessionId = e.sessionId;
      this.settle(id, s, this.now());
      return;
    } else return;
    if (s.settle) { clearTimeout(s.settle); s.settle = undefined; }
    if (s.watch?.init && s.watch.ack) this.endWatch(s);
  }

  // The turn ended. Claude's Stop hook says idle; an interrupted turn has none: when the record
  // still says running a moment later (no new turn, no send since), the console posts the hook.
  private settle(id: string, s: State, at: number): void {
    if (s.settle) clearTimeout(s.settle);
    s.settle = setTimeout(() => {
      s.settle = undefined;
      if (s.busy || s.lastSend > at) return;
      void (async () => {
        const rec = await this.d.load(id);
        if (!rec || rec.status !== "running" || s.busy || s.lastSend > at) return;
        await this.d.postHook(id, rec.hookToken, { hook_event_name: "Notification", ...(s.sessionId ? { session_id: s.sessionId } : {}), message: "the turn ended" });
      })().catch((err: unknown) => this.log(`[headless] ${id}: the idle hook failed: ${err instanceof Error ? err.message : String(err)}`));
    }, this.d.settleMs ?? SETTLE_MS);
    s.settle.unref?.();
  }

  private onExit(id: string, code: number | null, killed: boolean): void {
    const s = this.states.get(id);
    if (s) {
      this.endWatch(s);
      if (s.settle) clearTimeout(s.settle);
      this.states.delete(id);
    }
    // No exit code (the scope was stopped or killed): as a signal for the terminal (-1).
    this.d.onExit(id, code ?? -1, killed);
  }

  private notResent(id: string, items: Array<{ uuid: string; text: string }>): void {
    if (items.length === 0) return;
    const list = items.map((i) => `"${short(i.text)}"`).join(", ");
    this.d.tellUser(id, `Not sent again after a restart: ${list}. Send it again if it is still needed.`);
  }

  // The close of a headless worker: its program and its folders go. "held": another console
  // holds it (nothing changed); "failed": see the log.
  async remove(id: string): Promise<RemoveResult> {
    const r = await this.host.remove(id);
    if (r !== "removed") this.log(`[headless] ${id}: remove ${r}`);
    else {
      const s = this.states.get(id);
      if (s) { this.endWatch(s); if (s.settle) clearTimeout(s.settle); }
      this.states.delete(id);
      this.goOns.delete(id);
      this.tried.delete(id);
    }
    return r;
  }

  // At boot, before the console checks its records: each worker that the host owns is taken back
  // (also one whose program ended: its last lines and exit code come). A folder with no record
  // (deleted while the console was down) goes.
  async boot(store: Pick<SessionStore, "exists">): Promise<void> {
    for (const id of this.host.owned()) {
      // Only a record file that is gone (ENOENT): one that cannot be read now (cut by a crash,
      // EMFILE) keeps its worker.
      if (!(await store.exists(id))) {
        const r = await this.host.remove(id);
        this.log(`[headless] ${id}: no record; its worker folder: ${r}`);
        continue;
      }
      this.state(id).known = false;
      await this.host.reattach(id);
    }
  }

  // ── the go-on after a usage limit ────────────────────────────────────────────────────────

  noteGoOn(id: string): void { this.goOns.set(id, this.now()); }
  wentOnLately(id: string): boolean {
    const at = this.goOns.get(id);
    return at !== undefined && this.now() - at < GO_ON_GUARD_MS;
  }

  // One headless worker whose limit ended gets the go-on (the same read as the limit ticket:
  // its login has room, its session file still says limit, or the read failed). The oldest stop
  // first. Returns its id, or null.
  async continueOne(ops: Pick<LimitAgents, "list" | "stopRead" | "logins" | "goOn">): Promise<string | null> {
    const now = this.now();
    const recs = (await ops.list()).filter((r) => r.host === "headless" && r.closedAt === undefined
      && r.status !== "running" && r.stop?.why === "limit" && this.host.has(r.id));
    if (recs.length === 0) return null;
    const logins = await ops.logins().catch(() => null);
    if (!logins) return null;
    const room = new Set(logins.filter((l) => l.loggedIn && !l.signedOut && l.use !== null && hasRoom(l.use)).map((l) => l.id));
    recs.sort((a, b) => (a.stop!.at - b.stop!.at) || (a.id < b.id ? -1 : 1));
    for (const r of recs) {
      if (!room.has(r.account ?? DEFAULT_ACCOUNT)) continue;
      const tried = this.tried.get(r.id);
      if (tried !== undefined && now - tried < AUTO_RETRY_MS) continue;
      const read = await ops.stopRead(r).catch(() => ({ ok: false as const }));
      if (read.ok && read.stop?.why !== "limit") continue;
      this.tried.set(r.id, now);
      const res = await ops.goOn(r.id);
      this.log(`[headless] ${r.id}: its login has room again; go-on: ${res}`);
      return r.id;
    }
    return null;
  }

  startAutoContinue(ops: Pick<LimitAgents, "list" | "stopRead" | "logins" | "goOn">, everyMs = 30_000): () => void {
    const tick = async () => {
      if (this.ticking) return;
      this.ticking = true;
      try { await this.continueOne(ops); } catch (err) {
        this.log(`[headless] auto-continue: ${err instanceof Error ? err.message : String(err)}`);
      } finally { this.ticking = false; }
    };
    const t = setInterval(() => { void tick(); }, everyMs);
    t.unref?.();
    this.loop = t;
    return () => { clearInterval(t); if (this.loop === t) this.loop = null; };
  }

  shutdown(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    for (const s of this.states.values()) { this.endWatch(s); if (s.settle) clearTimeout(s.settle); }
    this.host.shutdown();
  }
}

// The close or the delete of a headless worker found it held by another console.
export const HEADLESS_HELD = "Another console holds this worker. Try again when that console has stopped.";

// The close and the delete of a headless worker: its program and its folders go. A throw when
// they did not (HEADLESS_HELD: the caller answers 409; anything else: 500).
export async function removeHeadless(w: Pick<HeadlessWiring, "remove">, id: string): Promise<void> {
  const r = await w.remove(id);
  if (r === "held") throw new Error(HEADLESS_HELD);
  if (r === "failed") throw new Error(`the headless worker ${id} was not removed (see the console's log)`);
}

// ── the one wiring of this console ────────────────────────────────────────────────────────────

let current: HeadlessWiring | null = null;
let unhost: (() => void) | null = null;

// The wiring of this console, or null: the flag is off (or the deployment is hardened).
export function headless(): HeadlessWiring | null { return current; }

// Index.ts calls it once, when the flag is on and the deployment is not hardened.
export function initHeadless(d: WiringDeps): HeadlessWiring {
  if (current) throw new Error("the headless wiring is set already");
  const w = new HeadlessWiring(d);
  unhost = addHost(w.seam);
  current = w;
  return w;
}

// Index.ts, once its routes are there: with the flag on, the boot first (each worker is live again
// before the first tick of the auto-continue), then the auto-continue; its stop, or null when the
// boot failed. With the flag off: one log line when headless workers are left, and null.
export async function startHeadless(
  store: Pick<SessionStore, "exists" | "list">,
  ops: Parameters<HeadlessWiring["startAutoContinue"]>[0],
  log: (line: string) => void = (l) => console.warn(l),
  everyMs?: number,
): Promise<(() => void) | null> {
  const w = current;
  if (!w) {
    const left = (await store.list().catch(() => [])).filter((r) => r.host === "headless" && r.closedAt === undefined).length;
    if (left > 0) log(`[headless] ${left} headless worker(s) and AGENT_HEADLESS is off: the console does not resume them (stop, close and delete still end them)`);
    return null;
  }
  try {
    await w.boot(store);
  } catch (e) {
    log(`[headless] boot skipped: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  return w.startAutoContinue(ops, everyMs);
}

// The postHook of index.ts: the console's own hook route (the token of the record). A refusal of the
// route (no record, a bad token) is a throw: the caller logs it.
export function hookPoster(app: { inject: (o: { method: "POST"; url: string; payload: Record<string, unknown> }) => PromiseLike<{ statusCode: number; body: string }> }): WiringDeps["postHook"] {
  return async (id, token, body) => {
    const res = await app.inject({ method: "POST", url: `/api/agents/${encodeURIComponent(id)}/hook?token=${encodeURIComponent(token)}`, payload: body });
    if (res.statusCode >= 300) throw new Error(`the hook route answered ${res.statusCode}: ${res.body.slice(0, 200)}`);
  };
}

// Tests: the wiring goes (its programs live on, as at a console stop).
export function endHeadless(): void {
  current?.shutdown();
  unhost?.();
  current = null;
  unhost = null;
  offHost?.shutdown();
  offHost = null;
  offOpts = {};
}

// ── the flag off ──────────────────────────────────────────────────────────────────────────────
// A worker that a run with the flag on started lives on in its scope after a restart with the flag
// off. The stop, the close and the delete still end it: a host that is not registered (no seam, no
// watch, no onExit; made at the first use) stops its scope, or removes its program and folders.

let offHost: HeadlessHost | null = null;
let offOpts: Partial<HeadlessOpts> = {};

function hostOff(): HeadlessHost {
  return (offHost ??= new HeadlessHost({ ...headlessDirs(), ...offOpts }));
}

// Tests: the folders and the unit prefix of that host.
export function setHeadlessOffHost(o: Partial<HeadlessOpts>): void {
  offHost?.shutdown();
  offHost = null;
  offOpts = o;
}

// The close and the delete of a headless worker (with removeHeadless): the wiring, else that host.
export function headlessRemover(): Pick<HeadlessWiring, "remove"> {
  return current ?? { remove: (id) => hostOff().remove(id) };
}

// The stop of a headless worker with the flag off: its scope stops, and its end is taken here (its
// pid file goes), so that a later run with the flag on does not report it again.
export async function stopHeadlessOff(id: string): Promise<void> {
  const h = hostOff();
  await h.stop(id);
  if (await h.reattach(id)) throw new Error(`the headless worker ${id} did not stop (see the console's log)`);
}
