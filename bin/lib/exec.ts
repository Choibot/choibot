// bin/lib/exec.ts — the ONLY place bin/ touches child processes, so tests can
// vi.mock this module instead of the OS.
import { spawn } from "node:child_process";

export type RunResult = { code: number; stdout: string; stderr: string };

export function run(
  cmd: string,
  args: string[],
  // timeoutMs: the child is killed after it (a probe must not hang on a tool that waits).
  opts: { env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe"; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      stdio: opts.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e.message) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// NOTE: `bin` is interpolated into `sh -c`; only ever call with hardcoded
// tool names, never user input.
export async function which(bin: string): Promise<string | null> {
  const r = await run("sh", ["-c", `command -v ${bin}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}
