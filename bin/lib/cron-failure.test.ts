// bin/lib/cron-failure.test.ts — the failure words of a Recurring task's run, with made errors,
// and one real execFile whose kill fails with EPERM (the case of a sudo that the signal does
// not reach), to prove the shape of the error that Node gives.
import { execFile, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runFailure } from "./cron-failure.mjs";

const basic = { strong: false, timeoutMinutes: 30 };
const strong = { strong: true, timeoutMinutes: 30 };
const killError = () => Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" });

describe("runFailure", () => {
  it("basic: the runner's timer killed the child (killed + a signal) is a timeout", () => {
    expect(runFailure({ killed: true, signal: "SIGKILL", code: null }, null, basic)).toEqual({ reason: "timeout after 30m", why: "timeout" });
  });
  it("strong: sudo relayed the TERM and the task ended by its own exit code (143, no signal): a timeout", () => {
    expect(runFailure({ killed: true, signal: null, code: 143 }, 143, strong)).toEqual({ reason: "timeout after 30m", why: "timeout" });
  });
  it("strong: the kill itself failed (EPERM, syscall kill): a timeout, not a start failure", () => {
    expect(runFailure(killError(), null, strong)).toEqual({ reason: "timeout after 30m", why: "timeout" });
    // The same error in basic mode is not a timeout of this kind: the child is the task itself.
    expect(runFailure(killError(), null, basic).why).toBe("start");
  });
  it("a real spawn error (ENOENT) stays a start failure, also in strong mode", () => {
    const e = Object.assign(new Error("spawn sudo ENOENT"), { code: "ENOENT", syscall: "spawn sudo" });
    expect(runFailure(e, null, strong)).toEqual({ reason: "spawn failed: ENOENT", why: "start" });
  });
  it("exit 3 stays exit; a killed-by-signal run that the timer did not kill; the account and refused cases", () => {
    expect(runFailure({ code: 3 }, 3, strong)).toEqual({ reason: "exit 3", why: "exit" });
    expect(runFailure({ code: null, signal: "SIGSEGV" }, null, basic)).toEqual({ reason: "killed by SIGSEGV", why: "killed" });
    expect(runFailure({ code: "EACCOUNT" }, null, basic)).toEqual({ reason: "account error", why: "account" });
    expect(runFailure({ code: "EREFUSED" }, null, basic)).toEqual({ reason: "refused", why: "refused" });
  });
});

describe("a login that is signed out", () => {
  // The line of `claude -p` in the run of 2026-11-21 07:30 UTC.
  const REVOKED = "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.";
  it("the runner did not start the task on a named login marked as signed out", () => {
    expect(runFailure({ code: "ESIGNEDOUT" }, null, basic)).toEqual({ reason: "login signed out", why: "login" });
  });
  it("Claude ended the run with its sign-out words: the login, not an error", () => {
    expect(runFailure({ code: 1 }, 1, { ...basic, output: `checking…\n${REVOKED}` })).toEqual({ reason: "login signed out (exit 1)", why: "login" });
    expect(runFailure({ code: 1 }, 1, { ...basic, output: "Not logged in · Please run /login" }).why).toBe("login");
  });
  it("only the last 3 lines with text count: the words in the last line are the login; 10 lines above another error, they are not", () => {
    const own = Array.from({ length: 9 }, (_, i) => `step ${i + 1} done`);
    expect(runFailure({ code: 1 }, 1, { ...basic, output: [...own, REVOKED, "", ""].join("\n") }).why).toBe("login");
    const quoted = ["log line: user saw \"Please log in again\"", ...own, "API Error: 500 internal error"].join("\n");
    expect(runFailure({ code: 1 }, 1, { ...basic, output: quoted })).toEqual({ reason: "exit 1", why: "exit" });
  });
  it("other output, or a timeout, stays as it was", () => {
    expect(runFailure({ code: 1 }, 1, { ...basic, output: "API Error: 500 internal error" })).toEqual({ reason: "exit 1", why: "exit" });
    expect(runFailure({ killed: true, signal: "SIGKILL", code: null }, null, { ...basic, output: REVOKED }).why).toBe("timeout");
  });
  it("strong protection: nothing of this applies (the task runs on the agents' one login)", () => {
    expect(runFailure({ code: 1 }, 1, { ...strong, output: REVOKED })).toEqual({ reason: "exit 1", why: "exit" });
  });
});

describe("the shape of Node's error when the timer's kill cannot reach the child", () => {
  it("execFile calls back at once with code EPERM, syscall kill and no `killed`; runFailure reads it as a timeout in strong mode", async () => {
    let child: ChildProcess | undefined;
    const err = await new Promise<NodeJS.ErrnoException & { killed?: boolean }>((resolve) => {
      child = execFile("sleep", ["5"], { timeout: 100, killSignal: "SIGTERM" }, (e) => resolve(e as never));
      // As for a sudo child of another real uid: libuv's kill gives UV_EPERM (-1).
      const handle = (child as unknown as { _handle: { kill: (s: number) => number } })._handle;
      handle.kill = () => -1;
    });
    try {
      expect([err.code, err.syscall, err.killed]).toEqual(["EPERM", "kill", undefined]);
      expect(runFailure(err, null, strong).why).toBe("timeout");
    } finally {
      if (child?.pid) try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
    }
  });
});
