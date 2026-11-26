// bin/lib/cron-failure.mjs — why a Recurring task's run failed, from the error of execFile: the
// words of the summary (reason) and the fixed word kept with the run (why: RUN_WHYS in
// cron-result.mjs). Plain JS: the cron runner starts with a bare node.
//
// "exit 3", "timeout after 30m" and "spawn failed: ENOENT" are three different pages to be woken
// up for: they are never one.
//
// A timeout: the runner's timer killed the child (`killed`). Two more cases in strong protection,
// where the child is sudo and the task runs as the agents' account (chief-cron.mjs strongTask):
//   - sudo relays the TERM and the task ends by its own exit code (143), with no signal;
//   - the TERM does not reach sudo at all (kill() fails, e.g. EPERM): Node then gives an error of
//     the kill itself (syscall "kill") and no `killed`. The runner does not wait for the task in
//     that case: the helper ends it at its own limit, 60 s after the task's time
//     (deploy/choibot-agent-exec claude-task).
//
// A login that is signed out: the runner did not start the task on a named login that the console
// marked as signed out (ESIGNEDOUT), or Claude ended the run with its sign-out words (LOGIN_RE,
// one list with the console). Only the last lines with text are read: Claude's error is the last
// thing that `claude -p` prints, and a task can quote the same words in its own text. Not in
// strong protection: there the task runs on the agents' one login, and this change does not apply.
import { LOGIN_RE } from "../../server/agents/loginwords.mjs";

const LAST_LINES = 3;
const lastLines = (output) => String(output ?? "").split("\n").filter((l) => l.trim()).slice(-LAST_LINES).join("\n");

/**
 * @param {{ killed?: boolean, signal?: string | null, code?: unknown, syscall?: string } | null | undefined} err
 * @param {number | null} exitCode
 * @param {{ strong: boolean, timeoutMinutes: number, output?: string }} o
 * @returns {{ reason: string, why: "timeout" | "account" | "login" | "refused" | "start" | "exit" | "killed" }}
 */
export function runFailure(err, exitCode, o) {
  const timedOut = (!!err?.killed && (!!err.signal || o.strong)) || (o.strong && err?.syscall === "kill");
  if (timedOut) return { reason: `timeout after ${o.timeoutMinutes}m`, why: "timeout" };
  if (err?.code === "EACCOUNT") return { reason: "account error", why: "account" };
  if (err?.code === "ESIGNEDOUT") return { reason: "login signed out", why: "login" };
  if (err?.code === "EREFUSED") return { reason: "refused", why: "refused" };
  if (typeof err?.code === "string") return { reason: `spawn failed: ${err.code}`, why: "start" };
  if (typeof exitCode === "number") {
    if (!o.strong && LOGIN_RE.test(lastLines(o.output))) return { reason: `login signed out (exit ${exitCode})`, why: "login" };
    return { reason: `exit ${exitCode}`, why: "exit" };
  }
  if (err?.signal) return { reason: `killed by ${err.signal}`, why: "killed" };
  return { reason: "failed", why: "killed" };
}
