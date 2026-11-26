// server/chief/live/codex-resume.test.ts — Phase 1b live check (spec §6.4
// "Injection", Task 1b-20 row 7): does a resumed Codex session read the
// generated AGENTS.md again, or keep the instructions it started with? The
// spec assumes the second ("a Codex agent gets a new brain only on a fresh
// spawn"); only a quote of the new text counts a resume as a prompt refresh.
//
// It starts a session with the brain MARKER-0ld0 in AGENTS.md, rebuilds the
// Codex home with MARKER-c0d3 (prepare rewrites AGENTS.md, as on every
// launch), resumes the session and asks for the MARKER- sentences. The verdict
// is logged; either answer is a result. A codex auth or login error is "not
// run (auth)" (the test skips), never a result. It runs the real codex binary
// with the real login and spends two requests, so it is opt-in: LIVE_CODEX=1.
import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { readdir, readFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { codexRuntime } from "../../agents/runtimes/codex.js";
import type { AgentRecord } from "../../agents/store.js";
import { brainPrompt } from "../brain/prompt.js";

const OLD = "MARKER-0ld0";
const NEW = "MARKER-c0d3";
const brainWith = (marker: string) =>
  brainPrompt(`# Brain (2026-11-09)\n\n## Workers only\n- ${marker}: the brain sentence for this check. [r_${marker.slice(7)}]`);
const START = "Reply with the single word OK. Do not run any command and do not read any file.";
const ASK = "Do not run any command and do not read any file. From your instructions alone, quote every sentence "
  + "that starts with MARKER- verbatim, one per line. If there is none, write NONE. Then, on its own line, write "
  + "PREVIOUS: followed by the exact word you replied with in the previous turn of this conversation (NONE if there was none).";
// The resume kept the conversation (else a fresh session would also read the
// new AGENTS.md, and the verdict would mean nothing).
const KEPT = /PREVIOUS:\W*OK\b/i;

const KILL_GRACE_MS = 5_000;

// As in codex-env.test.ts: stdin closed, SIGTERM on the timeout, then SIGKILL.
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

// The child env is an allowlist (hard rule 6): nothing of the caller's env
// reaches codex, whose shell commands inherit it and whose model sees them.
const PASS_THROUGH = ["PATH", "HOME", "SHELL", "LANG", "TMPDIR"] as const;

function childEnv(runtimeEnv: Record<string, string>): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const k of PASS_THROUGH) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...runtimeEnv } as NodeJS.ProcessEnv;
}

// Value-like parts redacted (key=value, Bearer tokens, quoted JSON values,
// long runs that hold a digit), at most 200 chars.
const redact = (l: string) => l
  .replace(/=\S+/g, "=<redacted>")
  .replace(/bearer\s+\S+/gi, "Bearer <redacted>")
  .replace(/:\s*"[^"]*"/g, ': "<redacted>"')
  .replace(/(?=[\w+/.=-]*\d)[\w+/.=-]{16,}/g, "<redacted>")
  .slice(0, 200);

type Events = { threadId: string | null; messages: string[]; commands: number; errors: string[] };

// The `--json` JSONL events: thread.started {thread_id}, item.* {item: {type:
// agent_message | command_execution | …}}, error / turn.failed. Lines that do
// not parse are ignored; raw stdout is never printed.
function parseEvents(stdout: string): Events {
  const ev: Events = { threadId: null, messages: [], commands: 0, errors: [] };
  for (const line of stdout.split("\n")) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!e || typeof e !== "object") continue;
    if (e.type === "thread.started" && typeof e.thread_id === "string") ev.threadId = e.thread_id;
    const item = e.item as Record<string, unknown> | undefined;
    if (e.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") ev.messages.push(item.text);
    if (e.type === "item.started" && item?.type === "command_execution") ev.commands += 1;
    if (e.type === "error" && typeof e.message === "string") ev.errors.push(e.message);
    if (e.type === "turn.failed") ev.errors.push(JSON.stringify(e.error ?? ""));
  }
  return ev;
}

// The rollout files under <CODEX_HOME>/sessions (codex writes one per thread).
async function rollouts(home: string): Promise<string[]> {
  const all = await readdir(join(home, "sessions"), { recursive: true }).catch(() => [] as string[]);
  return all.filter((f) => f.endsWith(".jsonl")).map((f) => join(home, "sessions", f));
}
const count = (text: string, s: string) => text.split(s).length - 1;

const AUTH = /auth|login|log in|401|unauthor|token|credential/i;
const authLines = (r: { stderr: string }, ev: Events) =>
  [...r.stderr.split("\n"), ...ev.errors].filter((l) => AUTH.test(l)).map(redact).slice(-10);

describe("Codex resume (live, LIVE_CODEX=1)", () => {
  it.skipIf(process.env.LIVE_CODEX !== "1")("a resumed Codex session: new AGENTS.md or the old instructions?", async (ctx) => {
    const dir = await mkdtemp(join(tmpdir(), "chief-codex-resume-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const rec: AgentRecord = {
        id: "a1", label: "codex-resume", repo: "", worktree: dir, branch: "", baseBranch: "",
        sessionId: null, hookToken: "p1", status: "idle", createdAt: Date.now(), cwd: dir, runtime: "codex",
      };
      // port 1 is dead: the generated hook URLs must never reach :3100.
      // vitest.setup moved HOME, so prepare links a missing auth.json each
      // time: point it at the real login (a link, never a copy).
      const prepare = async (marker: string) => {
        const { env } = await codexRuntime.prepare(rec, { port: 1, workspaceDir: dir, systemPrompt: brainWith(marker) });
        const home = env?.CODEX_HOME;
        expect(home).toBeTruthy();
        const auth = join(home!, "auth.json");
        await rm(auth, { force: true });
        await symlink(join(userInfo().homedir, ".codex", "auth.json"), auth);
        return { env: env!, home: home!, agentsMd: await readFile(join(home!, "AGENTS.md"), "utf8") };
      };
      const codex = (args: string[], env: Record<string, string>) =>
        run(codexRuntime.bin(), args, { cwd: dir, env: childEnv(env), timeoutMs: 200_000 });
      const notRun = (what: string, r: { code: number | null; stderr: string }, ev: Events) => {
        const lines = authLines(r, ev);
        if (lines.length === 0) return false;
        console.info(`[codex-resume] not run (auth): ${what} exit=${r.code} auth lines: ${JSON.stringify(lines)}`);
        return true;
      };

      const first = await prepare(OLD);
      expect(first.agentsMd).toContain(OLD);
      // Read-only sandbox, no bypass: the real auth.json is linked in, and
      // the check needs no command. `--sandbox` is an `exec` option, so it
      // goes before `resume` (codex exec resume rejects it).
      const r1 = await codex(["exec", "--json", "--sandbox", "read-only", START], first.env);
      const e1 = parseEvents(r1.stdout);
      if ((r1.code !== 0 || !e1.threadId) && notRun("start", r1, e1)) { ctx.skip(); return; }
      expect(r1.code).toBe(0);
      expect(e1.threadId).toBeTruthy();

      const second = await prepare(NEW);
      expect(second.agentsMd).toContain(NEW);
      expect(second.agentsMd).not.toContain(OLD);
      const r2 = await codex(["exec", "--sandbox", "read-only", "resume", "--json", e1.threadId!, ASK], second.env);
      const e2 = parseEvents(r2.stdout);
      if (r2.code !== 0 && notRun("resume", r2, e2)) { ctx.skip(); return; }

      const reply = e2.messages.join("\n");
      const hasNew = reply.includes(NEW), hasOld = reply.includes(OLD), kept = KEPT.test(reply);
      // Counts only, never the rollout text: which instructions the thread's
      // rollout records, and that both turns are in one file.
      const files = await rollouts(second.home);
      const texts = await Promise.all(files.map((f) => readFile(f, "utf8")));
      const both = texts.filter((t) => t.includes(START) && t.includes(ASK.slice(0, 60))).length;
      const marks = texts.map((t) => `${OLD}=${count(t, OLD)} ${NEW}=${count(t, NEW)}`).join("; ");
      const verdict = hasNew && !hasOld ? "refresh (the resumed session reads the new AGENTS.md)"
        : hasOld && !hasNew ? "kept (the resumed session keeps the instructions it started with)"
        : hasNew && hasOld ? "both (the old and the new AGENTS.md are visible)"
        : "none (no marker quoted)";
      // A reply after a command (the model may have read AGENTS.md from disk)
      // proves nothing about the instructions, and might hold file content.
      const shown = e2.commands === 0 ? JSON.stringify(redact(reply.replace(/\s+/g, " ").trim())) : "<withheld: a command ran>";
      console.info(`[codex-resume] start exit=${r1.code} thread=${e1.threadId ? "yes" : "no"} start commands=${e1.commands}; `
        + `resume exit=${r2.code} thread=${e2.threadId === null ? "none" : e2.threadId === e1.threadId ? "same" : "other"} `
        + `commands=${e2.commands} conversation kept=${kept} reply=${shown} verdict=${verdict}; `
        + `rollout files=${files.length} with both turns=${both} marker counts: ${marks}`);
      expect(r2.code).toBe(0);
      expect(e1.commands + e2.commands).toBe(0);
      expect(hasNew || hasOld).toBe(true);
      expect(kept).toBe(true);
      expect(both).toBe(1);
    } finally {
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  }, 480_000);
});
