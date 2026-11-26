// server/services/manager.ts
import type { TerminalManager } from "../agents/terminal.js";
import type { EventHub } from "../events.js";
import type { ServiceStore, ServiceRecord } from "./store.js";

// PTY id namespace for services — distinct from agent ids (uuids) and shell ids
// ("shell-…") so the shared onExit dispatch in server/index.ts can route exits.
export function svcTermId(id: string): string { return "svc:" + id; }

export type ServiceStatus = "stopped" | "running" | "crashed";
export type ServiceRuntime = {
  status: ServiceStatus;
  restartCount: number;
  lastExitCode: number | null;
  autoRestartDisabled: boolean;
};

export type ServiceManagerOpts = {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  backoffMs?: (attempt: number) => number;
  breaker?: { maxRestarts: number; windowMs: number };
  notify?: (text: string) => void;
};

export type ServiceManager = {
  start(id: string, confirm: boolean): Promise<{ ok: boolean; error?: string; needsConfirm?: boolean }>;
  stop(id: string): boolean;
  handleExit(termId: string, code?: number, killed?: boolean): boolean;
  reconcile(): Promise<void>;
  snapshot(id: string): ServiceRuntime;
  // Captured tail of the service's most recent run, retained after the PTY
  // exits so a crash's error is visible even though the terminal is gone.
  lastOutput(id: string): string;
};

// In-memory runtime state per started/reconciled service. The persisted record
// (status is NOT stored on it) is cached here so handleExit can respawn without
// an async store read (onExit fires synchronously).
type RT = {
  rec: ServiceRecord;
  intendedRunning: boolean;   // false once the user stops it
  status: ServiceStatus;
  restartCount: number;
  restartTimes: number[];     // timestamps of recent auto-restarts (breaker window)
  lastExitCode: number | null;
  autoRestartDisabled: boolean;
  timer: { clear(): void } | null;
  tail: string;               // capped tail of the current/last run's output
};

const TAIL_CAP = 8192;        // bytes of output retained per service for post-mortem

const DEFAULT_BACKOFF = (attempt: number) => Math.min(60_000, 2_000 * 2 ** (attempt - 1));

export function createServiceManager(
  terminals: TerminalManager,
  store: ServiceStore,
  hub: EventHub,
  opts: ServiceManagerOpts = {},
): ServiceManager {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); return { clear: () => clearTimeout(h) }; });
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF;
  const breaker = opts.breaker ?? { maxRestarts: 5, windowMs: 120_000 };
  const notify = opts.notify;

  const runtime = new Map<string, RT>();

  function emit(id: string, rt: RT): void {
    hub.emitEvent({
      type: "service-status", serviceId: id, status: rt.status,
      restartCount: rt.restartCount, lastExitCode: rt.lastExitCode,
      autoRestartDisabled: rt.autoRestartDisabled,
    });
  }

  function spawn(id: string, rt: RT): void {
    terminals.spawn({
      id: svcTermId(id), persist: true,
      command: rt.rec.command, args: rt.rec.args, cwd: rt.rec.cwd, env: rt.rec.env,
    });
    rt.status = "running";
    // Capture this run's output so a fast crash's error survives the PTY's
    // deletion on exit — otherwise the log pane could only show "not running"
    // with no reason. Reset per (re)start so the tail reflects the latest run.
    rt.tail = "";
    terminals.attach(svcTermId(id))?.subscribe((chunk) => {
      rt.tail = (rt.tail + chunk).slice(-TAIL_CAP);
    });
    emit(id, rt);
  }

  async function start(id: string, confirm: boolean) {
    const rec = await store.load(id);
    if (!rec) return { ok: false, error: "no such service" };
    if (rec.requiresConfirm && !confirm) return { ok: false, needsConfirm: true, error: "confirmation required" };

    const existing = runtime.get(id);
    if ((existing && existing.status === "running") || terminals.has(svcTermId(id))) {
      return { ok: false, error: "already running" };
    }
    const rt: RT = existing ?? {
      rec, intendedRunning: true, status: "stopped", restartCount: 0,
      restartTimes: [], lastExitCode: null, autoRestartDisabled: false, timer: null, tail: "",
    };
    rt.rec = rec;                 // pick up edits
    rt.intendedRunning = true;
    rt.autoRestartDisabled = false;
    rt.restartTimes = [];
    rt.timer?.clear(); rt.timer = null;
    runtime.set(id, rt);
    spawn(id, rt);
    return { ok: true };
  }

  function stop(id: string): boolean {
    const rt = runtime.get(id);
    if (rt) { rt.intendedRunning = false; rt.timer?.clear(); rt.timer = null; }
    terminals.kill(svcTermId(id));
    if (rt) {
      rt.status = "stopped"; rt.restartCount = 0; rt.restartTimes = [];
      rt.autoRestartDisabled = false; emit(id, rt);
    }
    return true;
  }

  function handleExit(termId: string, code?: number, killed?: boolean): boolean {
    if (!termId.startsWith("svc:")) return false;
    const id = termId.slice("svc:".length);
    const rt = runtime.get(id);
    if (!rt) return true; // claim the exit (svc-prefixed) even if the def was deleted
    rt.lastExitCode = code ?? null;

    // Breaker already tripped → stay crashed, never relaunch.
    if (rt.autoRestartDisabled) { rt.status = "crashed"; emit(id, rt); return true; }

    // Intentional stop / clean exit → settle as stopped, no restart.
    if (!rt.intendedRunning || killed) { rt.status = "stopped"; emit(id, rt); return true; }

    // Unexpected crash.
    if (!rt.rec.autoRestart) { rt.status = "crashed"; emit(id, rt); return true; }

    const t = now();
    rt.restartTimes = rt.restartTimes.filter((x) => t - x < breaker.windowMs);
    rt.restartTimes.push(t);
    if (rt.restartTimes.length >= breaker.maxRestarts) {
      rt.status = "crashed"; rt.intendedRunning = false; rt.autoRestartDisabled = true;
      emit(id, rt);
      notify?.(`Service "${rt.rec.name}" crashed ${breaker.maxRestarts}× within ${Math.round(breaker.windowMs / 1000)}s — auto-restart disabled.`);
      return true;
    }
    rt.restartCount += 1;
    rt.timer = setTimer(() => { if (rt.intendedRunning) spawn(id, rt); }, backoffMs(rt.restartCount));
    return true;
  }

  async function reconcile(): Promise<void> {
    for (const rec of await store.list()) {
      // Eagerly reattach a surviving session so its onExit watcher is armed at
      // boot — otherwise a crash after a server restart would fire no
      // auto-restart/breaker/notify and the badge would stay falsely "running"
      // until someone opened the logs. reattach returns null if the session
      // ended in the race, which we treat as not-alive.
      let alive = await terminals.hasSession(svcTermId(rec.id));
      let att = null;
      if (alive) {
        att = await terminals.reattach(svcTermId(rec.id));
        alive = att !== null;
      }
      const rt: RT = {
        rec, intendedRunning: alive, status: alive ? "running" : "stopped",
        restartCount: 0, restartTimes: [], lastExitCode: null,
        autoRestartDisabled: false, timer: null, tail: "",
      };
      runtime.set(rec.id, rt);
      // Capture a reattached survivor's output too, so a post-restart crash is
      // diagnosable in the log pane.
      att?.subscribe((chunk) => { rt.tail = (rt.tail + chunk).slice(-TAIL_CAP); });
    }
  }

  function snapshot(id: string): ServiceRuntime {
    const rt = runtime.get(id);
    if (!rt) return { status: "stopped", restartCount: 0, lastExitCode: null, autoRestartDisabled: false };
    return { status: rt.status, restartCount: rt.restartCount, lastExitCode: rt.lastExitCode, autoRestartDisabled: rt.autoRestartDisabled };
  }

  function lastOutput(id: string): string { return runtime.get(id)?.tail ?? ""; }

  return { start, stop, handleExit, reconcile, snapshot, lastOutput };
}
