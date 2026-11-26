// server/chief/live/codex-env.test.ts — Phase 1a live check (spec §5.2
// "Codex agents"): a shell command that a Codex agent runs sees the identity
// env (CHOIBOT_AGENT_ID, CHOIBOT_AGENT_PASS) that spawn merges into the runtime env.
// It runs the real codex binary with the real login and spends one request,
// so it is opt-in: LIVE_CODEX=1 (not a CHIEF_* name, vitest.setup scrubs
// those). Skipped by default.
import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { codexRuntime } from "../../agents/runtimes/codex.js";
import type { AgentRecord } from "../../agents/store.js";
import { agentIdentityEnv } from "../paths.js";

const PROMPT = "Run the shell command: env | grep ^CHOIBOT_ and print its output verbatim.";

const KILL_GRACE_MS = 5_000;

// stdin is closed: `codex exec` appends piped stdin to the prompt. On the
// timeout: SIGTERM, then SIGKILL when the child is still there after a grace.
function run(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let kill: NodeJS.Timeout | undefined;
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, o.timeoutMs);
    const done = () => { clearTimeout(timer); clearTimeout(kill); };
    child.on("error", (e) => { done(); reject(e); });
    child.on("close", (code) => { done(); resolve({ code, stdout, stderr }); });
  });
}

// The child env is an allowlist: codex's default shell policy inherits all of
// it, and the model sees the command output. So nothing of the caller's env
// (cloud keys, GitHub tokens, database URLs) reaches it.
const PASS_THROUGH = ["PATH", "HOME", "SHELL", "LANG", "TMPDIR"] as const;

function childEnv(runtimeEnv: Record<string, string>, identity: Record<string, string>): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const k of PASS_THROUGH) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...runtimeEnv, ...identity } as NodeJS.ProcessEnv;
}

// Diagnostics on a miss: only stderr lines about auth, with every value-like
// part redacted (key=value, Bearer tokens, quoted JSON values, long runs that
// hold a digit), at most 10 lines of 200 chars.
function authLines(stderr: string): string[] {
  return stderr.split("\n")
    .filter((l) => /auth|login|401|unauthor/i.test(l))
    .map((l) => l
      .replace(/=\S+/g, "=<redacted>")
      .replace(/bearer\s+\S+/gi, "Bearer <redacted>")
      .replace(/:\s*"[^"]*"/g, ': "<redacted>"')
      .replace(/(?=[\w+/.=-]*\d)[\w+/.=-]{16,}/g, "<redacted>")
      .slice(0, 200))
    .slice(-10);
}

describe("Codex env (live, LIVE_CODEX=1)", () => {
  it.skipIf(process.env.LIVE_CODEX !== "1")("a Codex shell command sees CHOIBOT_AGENT_ID and CHOIBOT_AGENT_PASS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chief-codex-env-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const rec: AgentRecord = {
        id: "a1", label: "codex-env", repo: "", worktree: dir, branch: "", baseBranch: "",
        sessionId: null, hookToken: "p1", status: "idle", createdAt: Date.now(), cwd: dir, runtime: "codex",
      };
      // port 1 is dead: the generated hook URLs must never reach :3100.
      const { env } = await codexRuntime.prepare(rec, { port: 1, workspaceDir: dir });
      const home = env?.CODEX_HOME;
      expect(home).toBeTruthy();
      // vitest.setup moved HOME, so prepare linked a missing auth.json: point
      // it at the real login (a link, never a copy).
      const auth = join(home!, "auth.json");
      await rm(auth, { force: true });
      await symlink(join(userInfo().homedir, ".codex", "auth.json"), auth);

      const r = await run(codexRuntime.bin(), ["exec", "--dangerously-bypass-approvals-and-sandbox", PROMPT], {
        cwd: dir, env: childEnv(env!, agentIdentityEnv(rec)), timeoutMs: 200_000,
      });
      // Raw stdout and stderr are never printed, also on a failure: the
      // assertion sees only the identity lines, the log only the exit code and
      // the redacted auth lines of stderr.
      const want = ["CHOIBOT_AGENT_ID=a1", "CHOIBOT_AGENT_PASS=p1"];
      const found = r.stdout.split("\n").map((l) => l.trim()).filter((l) => /^CHOIBOT_AGENT_(ID|PASS)=/.test(l));
      const diag = want.every((w) => found.includes(w)) ? "" : ` auth lines in stderr: ${JSON.stringify(authLines(r.stderr))}`;
      console.info(`[codex-env] exit=${r.code} identity lines in stdout: ${JSON.stringify(found)}${diag}`);
      expect(found).toEqual(expect.arrayContaining(want));
    } finally {
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
