// server/widgets/runner.ts — run a widget's `refresh` or `actions/<name>`
// script (spec "Script contract"). spawn with no shell and `detached: true`,
// so the script leads its own process group: a timeout or an output overrun
// kills the whole group, and a `curl` or background job the script started
// stops too. The run ends on `exit`; the pipes then get at most drainMs, so a
// stray process that keeps stdout open cannot hold the request. Direct runs:
// when the run settles, the group is killed in all cases, so no background
// job outlives it.
//
// Hardened deployment (Phase 2c, spec §3 code-route gate): with `agentExec`
// the script runs as the agent uid through `sudo … choibot-agent-exec run <file>
// <cwd>`. The script's group then belongs to the agent uid: the console
// cannot signal it, only sudo. The helper kills that group itself when the
// script ends (deploy/choibot-agent-exec cmd_run), so no background job
// outlives a run here either. sudo relays SIGTERM to the helper, which passes
// it to `timeout` and so to the script's group, but sudo cannot relay
// SIGKILL. So a stop sends SIGTERM first and SIGKILL to sudo's group after
// killGraceMs; the helper's own RUN_TIMEOUT (SIGKILL as the agent uid) is the
// backstop.
import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { helperArgv, type AgentExec } from "../agents/terminal.js";
import { LIMITS } from "./paths.js";
import { envKey } from "../names.mjs";

export type RunResult = { ok: true; value: unknown } | { ok: false; error: string };
export type RunOpts = {
  file: string; cwd: string; args: unknown; env: Record<string, string>;
  maxOut: number; timeoutMs?: number; drainMs?: number;
  // Set only in a hardened deployment after the helper probe passed.
  agentExec?: AgentExec; killGraceMs?: number;
};

export const SCRIPT_TIMEOUT_MS = 30_000;
export const DRAIN_MS = 500;
export const KILL_GRACE_MS = 2_000;
const PASS_ENV = ["PATH", "HOME", "USER", "LANG", "TZ"] as const;
// What sudo itself gets on a run through the helper: no HOME or USER (the
// helper sets the agent user's) and never a console secret.
const SUDO_RUN_ENV: readonly string[] = ["PATH", "LANG", "TZ", envKey("WIDGET_DIR"), envKey("AGENT_ID")];

// The real path of `rel` when it is a regular file with an execute bit inside
// the widget folder (no symlink out of it); else null → 400 "not runnable".
export async function resolveRunnable(dir: string, rel: string): Promise<string | null> {
  try {
    const root = await realpath(dir);
    const real = await realpath(join(dir, rel));
    if (!real.startsWith(root + sep)) return null;
    const st = await stat(real);
    if (!st.isFile() || (st.mode & 0o111) === 0) return null;
    return real;
  } catch {
    return null;
  }
}

// Hygiene, not a security boundary (agents already get the console's full
// env): it keeps console tokens out of script output by accident.
export function scriptEnv(
  widgetDir: string, agentId: string, base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) {
    const v = base[k];
    if (v !== undefined) env[k] = v;
  }
  env[envKey("WIDGET_DIR")] = widgetDir;
  env[envKey("AGENT_ID")] = agentId;
  return env;
}

// argv and env of a run through the helper (sudo is argv[0]). The helper
// enters the cwd as the agent uid, so sudo gets none; the values reach the
// script through sudo's env_keep, never on argv.
function helperRun(x: AgentExec, o: RunOpts): { argv: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const k of SUDO_RUN_ENV) {
    const v = o.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { argv: helperArgv(x, "run", [o.file, resolve(o.cwd)]), env };
}

export function runScript(o: RunOpts): Promise<RunResult> {
  const timeoutMs = o.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  const drainMs = o.drainMs ?? DRAIN_MS;
  const x = o.agentExec;
  return new Promise<RunResult>((resolveRun) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolveRun(r);
    };
    let child: ChildProcess;
    try {
      // Cast on purpose: next/types adds a required NODE_ENV to ProcessEnv; the
      // minimal env from scriptEnv() must stay minimal, so do not widen it.
      if (x) {
        const h = helperRun(x, o);
        child = spawn(h.argv[0], h.argv.slice(1), { env: h.env as NodeJS.ProcessEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      } else {
        child = spawn(o.file, [], { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      }
    } catch (e) {
      finish({ ok: false, error: `spawn failed: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const chunks: Buffer[] = [];
    let outBytes = 0;
    let errTail = "";
    let failure: string | null = null;
    const timedOut = `timed out after ${timeoutMs / 1000} s`;
    const killGroup = (signal: NodeJS.Signals = "SIGKILL") => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { /* already gone */ }
    };
    // Through the helper: SIGTERM (sudo relays it), SIGKILL after the grace.
    const stop = () => {
      if (!x) return killGroup();
      killGroup("SIGTERM");
      grace ??= setTimeout(() => killGroup(), o.killGraceMs ?? KILL_GRACE_MS);
    };
    timer = setTimeout(() => { failure ??= timedOut; stop(); }, timeoutMs);
    child.stdout!.on("data", (b: Buffer) => {
      if (failure) return;
      outBytes += b.length;
      if (outBytes > o.maxOut) { failure = "output too large"; stop(); return; }
      chunks.push(b);
    });
    child.stderr!.on("data", (b: Buffer) => {
      errTail = (errTail + b.toString("utf8")).slice(-LIMITS.stderrTail);
    });
    // A script that never reads stdin closes it early: EPIPE is not an error here.
    child.stdin!.on("error", () => { /* ignored */ });
    child.stdin!.end(JSON.stringify(o.args ?? {}));

    const withTail = (msg: string) => {
      const t = errTail.trim();
      return t ? `${msg}: ${t}` : msg;
    };
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      // The leader has exited, but its pgid stays reserved while any member
      // lives: kill what the script left in the background, then drop pipes.
      // Once only (drain and close can both fire): a freed pgid may be reused.
      if (settled) return;
      killGroup();
      child.stdin!.destroy();
      child.stdout!.destroy();
      child.stderr!.destroy();
      // The helper's own RUN_TIMEOUT: `timeout -s KILL` ends the run by
      // SIGKILL, never exit 124 (that is the script's own code).
      if (x && !failure && signal === "SIGKILL") failure = timedOut;
      if (failure) return finish({ ok: false, error: failure === "output too large" ? failure : withTail(failure) });
      if (code !== 0) return finish({ ok: false, error: withTail(`exit ${code ?? signal}`) });
      const text = Buffer.concat(chunks).toString("utf8").trim();
      try {
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({ ok: false, error: withTail("stdout is not valid JSON") });
      }
    };
    child.on("error", (e) => finish({ ok: false, error: `spawn failed: ${e.message}` }));
    child.on("exit", (code, signal) => {
      // From here settle() kills the group once: no stop or grace kill after exit.
      clearTimeout(timer);
      clearTimeout(grace);
      const drain = setTimeout(() => settle(code, signal), drainMs);
      child.once("close", () => { clearTimeout(drain); settle(code, signal); });
    });
  });
}
