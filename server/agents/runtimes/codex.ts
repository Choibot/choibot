// server/agents/runtimes/codex.ts — the ChatGPT Codex runtime.
//
// Codex configures itself entirely through CODEX_HOME (see codex-home.ts), so
// unlike Claude there is no per-agent settings FLAG — the settings are the
// environment. `--dangerously-bypass-approvals-and-sandbox` is the counterpart
// of Claude's `--dangerously-skip-permissions`: the console is already the trust
// boundary (loopback bind, tailnet-only reach), so the inner sandbox is
// redundant and would only block the agent from its own worktree.
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentRuntime, ArgOpts, Preset, PrepareResult } from "./types.js";
import { buildCodexHome } from "./codex-home.js";
import { parseRolloutPlan } from "./codex-plan.js";
import { hookToStatus } from "../hooks.js";
import { hardenedDeployment } from "../../chief/hardened.js";
import { names } from "../../names.mjs";
import { isClone } from "../agentclone.js";

const BYPASS = "--dangerously-bypass-approvals-and-sandbox";
// Required, not optional. Measured against an identically installed hook
// plugin: with the flag the hooks fire, without it they are SILENTLY skipped —
// no warning, no error, a run that looks normal. Status reporting depends on it.
const HOOK_TRUST = "--dangerously-bypass-hook-trust";

export function buildCodexArgs(preset: Preset, opts: ArgOpts = {}): string[] {
  const args: string[] = [];
  // `resume` is a SUBCOMMAND, not a flag, so it and its session id must lead.
  if (opts.resume) args.push("resume", opts.resume);
  if (opts.cwd) args.push("-C", opts.cwd);
  if (preset.model) args.push("--model", preset.model);
  args.push(BYPASS, HOOK_TRUST);
  if (opts.prompt && opts.prompt.trim()) args.push(opts.prompt);
  return args;
}

// The transcript path arrives inside a hook payload, is persisted to the agent
// record, and is later opened and parsed (canResume stats it, readPlan reads
// it). Whoever holds the agent's hook token therefore names a file the console
// will read on its own behalf, so "absolute" is the floor and not the whole
// check — /proc/self/environ and /dev/urandom are absolute too. Narrow it to
// what a Codex rollout actually looks like, at this single write site, the same
// way hooks.ts narrows the session id. A future rollout format that breaks the
// suffix costs a cold start, never a bad read.
const MAX_PATH = 4096; // PATH_MAX; longer is a payload trying something, not a path
// Same 1 MB ceiling server/files/api.ts puts on a file preview: one number for
// "the most of a file this console will ever pull into memory for the UI".
const MAX_PLAN_BYTES = 1024 * 1024;
function isRollout(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && p.length <= MAX_PATH
    && !p.includes("\0") && isAbsolute(p) && p.endsWith(".jsonl");
}

function sessionsRoot(rec: Parameters<AgentRuntime["readPlan"]>[0]): string {
  return rec.repo
    ? join(rec.worktree, names().repoFolder, "codex-home", "sessions")
    : join(rec.worktree, names().agentsFolder, rec.id, "codex-home", "sessions");
}

async function safeRolloutPath(rec: Parameters<AgentRuntime["readPlan"]>[0]): Promise<string | null> {
  // Never a path in an agent's own clone (strong protection; a Codex agent has none: spawn refuses).
  if (isClone(rec)) return null;
  if (!rec.transcriptPath || !isRollout(rec.transcriptPath)) return null;
  try {
    // Resolve both paths before comparing them. This rejects parent-directory
    // symlinks that leave the agent's own Codex session directory.
    const root = await realpath(sessionsRoot(rec));
    const target = await realpath(rec.transcriptPath);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null;
    }
    // The resolved-parent check protects containment. Reject the final symlink
    // too, so a rollout name cannot act as an alias for another file.
    if ((await lstat(rec.transcriptPath)).isSymbolicLink()) return null;
    return target;
  } catch {
    return null;
  }
}

// `preset.effort` and `preset.systemPrompt` are deliberately dropped: Codex
// takes reasoning effort from config, not argv, and has no system-prompt flag —
// the system prompt travels through the generated AGENTS.md instead.
export const codexRuntime: AgentRuntime = {
  id: "codex",
  bin: () => process.env.CODEX_EXECUTABLE ?? "codex",
  async prepare(rec, ctx): Promise<PrepareResult> {
    // Hardened (ruling 2c-7-a): buildCodexHome writes by path inside the
    // agent-writable worktree, and its console-owned 0700 home could not be
    // read by the agent uid anyway. Refused before any write.
    if (hardenedDeployment()) {
      throw new Error(`[chief] ${rec.id}: codex agents are not supported in a hardened deployment yet`);
    }
    const { home, skills, skippedMcp, hooks } = await buildCodexHome(rec, ctx);
    if (skippedMcp.length) {
      console.log(`[codex] ${rec.id}: skipped unsupported mcp servers: ${skippedMcp.join(", ")}`);
    }
    // A failed registration is not fatal — the agent runs, but reports no
    // status — so say so loudly rather than leaving a silent idle agent.
    if (!hooks) console.error(`[codex] ${rec.id}: hook plugin did NOT register; status will not update`);
    console.log(`[codex] ${rec.id}: ${skills} skills shared into ${home}`);
    // Codex has no settings flag: CODEX_HOME *is* the settings.
    return { env: { CODEX_HOME: home } };
  },
  buildArgs: buildCodexArgs,

  // Codex emits the same hook event names and payload fields as Claude Code —
  // verified against a live run, payloads captured in the hooks-findings spec —
  // so the mapping is shared rather than duplicated, including its
  // filename-shaped session-id guard. The one addition is transcript_path,
  // which Codex hands us outright: no directory walk needed to find the
  // session's rollout file.
  hookToStatus(payload) {
    const base = hookToStatus(payload);
    // An unrecognized event yields nothing at all; do not smuggle a path in
    // through one.
    if (!Object.keys(base).length) return base;
    const p = payload.transcript_path;
    return isRollout(p) ? { ...base, transcriptPath: p } : base;
  },

  async canResume(rec) {
    // `codex resume <id>` needs both the id and its rollout still on disk.
    // Missing either means cold-start in the worktree, where the diffs survive —
    // the same trade the Claude path makes with a missing transcript.
    if (!rec.sessionId) return false;
    // Resolve containment before checking the target type. A FIFO or device at
    // the path would otherwise exist but could hang or flood a later reader.
    const rollout = await safeRolloutPath(rec);
    if (!rollout) return false;
    try { return (await stat(rollout)).isFile(); } catch { return false; }
  },

  async readPlan(rec) {
    // The rollout path comes from the hook payload (Task 8), so there is nothing
    // to search for. No path yet — the agent has not started a turn — is a
    // normal empty state, exactly like a Claude agent with no tasks dir.
    const rollout = await safeRolloutPath(rec);
    if (!rollout) return [];
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      // O_NONBLOCK, then fstat the HANDLE rather than stat'ing the path: the
      // `.jsonl` suffix check at the write site vets a name, never the target,
      // so a symlink to a FIFO clears it. That is not merely a slow request —
      // fsPromises.open runs on the libuv threadpool (4 threads by default) and
      // an open() blocked on a writer-less FIFO holds its slot forever. The
      // Plan rail polls, so four polls of one poisoned transcriptPath exhaust
      // the pool and every unrelated fs, dns and crypto call in the process
      // stalls behind it — one bad hook payload takes the whole console down.
      // Non-blocking open returns straight away, fstat then rejects anything
      // that is not a regular file (FIFO, device, directory). Fstat'ing the
      // handle also leaves no stat→open window for the path to be swapped.
      fh = await open(
        rollout,
        constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      const st = await fh.stat();
      if (!st.isFile()) return [];
      // Read the TAIL, not a prefix: each update_plan replaces the whole plan,
      // so a capped prefix would pin the rail to the agent's first guess while
      // the tail always holds the current one.
      //
      // The window is backed up ONE byte past the cap when it truncates, so the
      // byte before the window is visible inside it. Without that, a window that
      // happens to open exactly on a record boundary looks identical to one that
      // opens mid-record, and the partial-line drop below would throw away a
      // complete record — losing the plan outright when that record is the last
      // update_plan. With it, a boundary-aligned window starts with "\n", so the
      // drop consumes just that byte and keeps the record.
      const over = st.size > MAX_PLAN_BYTES;
      const start = over ? st.size - MAX_PLAN_BYTES - 1 : 0;
      const buf = Buffer.allocUnsafe(over ? MAX_PLAN_BYTES + 1 : st.size);
      // read() may come up short; a short read would truncate the END of the
      // buffer, which on a tail read is the newest plan — the exact thing this
      // design exists to keep. Loop until the window is full or the file ends.
      let filled = 0;
      while (filled < buf.length) {
        const { bytesRead } = await fh.read(buf, filled, buf.length - filled, start + filled);
        if (bytesRead <= 0) break; // EOF, or the file shrank under us
        filled += bytesRead;
      }
      const text = buf.subarray(0, filled).toString("utf8");
      // A truncated window may start mid-record; drop that partial first line
      // (parseRolloutPlan would skip it anyway, this just says so out loud).
      return parseRolloutPlan(start === 0 ? text : text.slice(text.indexOf("\n") + 1));
    } catch {
      return [];
    } finally {
      await fh?.close().catch(() => {});
    }
  },
};
