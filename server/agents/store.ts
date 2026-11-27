// server/agents/store.ts
import type { AgentModel } from "./model.js";
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isAgentId } from "../ids.js";

export type AgentRuntimeId = "claude" | "codex";

export type AgentRecord = {
  id: string; label: string; repo: string; worktree: string;
  branch: string; baseBranch: string;
  // The runtime's own session id (Claude session, Codex rollout). Persisted
  // under this name; records written before the Codex runtime landed carry it
  // as `claudeSessionId` and are mapped on read.
  sessionId: string | null; hookToken: string;
  status: "running" | "idle" | "done" | "error"; createdAt: number;
  prUrl?: string; prNumber?: number;
  kind?: "issue" | "fleet-master" | "lead" | "coordinator"; // absent = normal worker agent; "issue" = started from the Issues subsystem
  issueId?: string;        // kind "issue" only: the Issue (server/issues/store.ts) this agent works on
  cwd?: string;           // explicit spawn/resume dir; falls back to repo?worktree:workspaceDir
  runtime?: AgentRuntimeId; // absent = "claude"
  // Absolute path of the runtime's session transcript, captured from the hook
  // payload's `transcript_path`. Codex uses it to resume and to read its plan;
  // Claude ignores it (it derives the path from cwd + session id instead).
  transcriptPath?: string;
  // Strong protection (design B, agentclone.ts): the agent works in its own clone (worktree =
  // AGENT_HOME_ROOT/clones/<id>). Set at spawn only.
  clone?: true;
  // Claude login the agent runs under (see accounts.ts). Absent = the box's
  // default login. Codex agents ignore it.
  account?: string;
  // The model the agent starts and resumes on (`--model`, model.ts), set at spawn only.
  // Absent = the console's setting (startModel). Codex agents never have one.
  model?: AgentModel;
  // Rail position set by drag-to-reorder. Absent = after every ordered agent,
  // by createdAt.
  order?: number;
  // When the user closed the agent from the rail. Close stops its session (and
  // every process it started) but keeps the record, worktree, branch and
  // sessionId; only an explicit Reopen/Resume or a new prompt starts it again,
  // and the closed-agent purge (closed.ts) deletes it after CLOSED_TTL_MS.
  closedAt?: number;
  // The CHIEF_PROMPT_REV (server/chief/paths.ts) the agent was last launched
  // with while chiefActive(). Absent = launched with the flag off; a flag-off
  // launch clears it (spec §5.2).
  chiefRev?: number;
  // kind "lead" only: the area the lead owns (spec §13).
  area?: string;
  // The agent id that spawned this one, set by the server from the caller's
  // identity while chief is on. Absent otherwise.
  spawnedBy?: string;
  // The last turn was cut by an error of the Claude program: the plan (or one model of it) is
  // at its limit, or the model does not work for the login (stopwhy.ts). Set when the agent
  // stops; gone when it works again.
  stop?: { why: "limit" | "model" | "login"; text: string; at: number };
  // The user moved the agent to another login while `stop` was set: at the next start of its
  // session the console tells it to go on, one time. `to`: the name of the new login.
  goOn?: { to: string; at: number; signedOut?: true };
  // The time of the last move of the agent to another login. A stop line of the session file
  // that is older is of the old login: it does not mark the agent as stopped again.
  movedAt?: number;
  // The default login had no room when the agent started, so it started on another login.
  // `from`: the name of the default login; `until`: when that login comes back, if known.
  startedOn?: { from: string; until: number | null };
  // No login had room when the agent was made: it has no session yet. It starts when a login
  // comes back or when the user moves it. `prompt`: its first message, kept until then (it
  // never goes to a page).
  waitsLogin?: { until: number | null; prompt: string };
};

// The fleet master is an agent record but not a worker: no repo, no disposable
// worktree, no Telegram pings, its own system prompt. (The cron master was
// the second master; it is retired: server/cron/retire.ts.)
export function isMasterKind(kind?: string): boolean {
  return kind === "fleet-master";
}

// Agents that live as long as the console: the fleet master, a lead (spec §13) and the
// Coordinator (server/coordinator). The Coordinator is not a master: isMasterKind is false for it.
export function isPersistentKind(kind?: string): boolean {
  return isMasterKind(kind) || kind === "lead" || kind === "coordinator";
}

// The id is the file name, and Fastify decodes %2F in a route param
// (`x%2F..%2Ffleet-master` arrives as `x/../fleet-master`). So an id that is
// not an agent id never reaches the file system: load gives null, save throws,
// delete and patch do nothing. list() reads the names readdir gives, unchanged.
export class SessionStore {
  constructor(private dir: string) {}
  private file(id: string) { return join(this.dir, `${id}.json`); }
  private async ensure() { await mkdir(this.dir, { recursive: true }); }

  async save(rec: AgentRecord): Promise<void> {
    if (!isAgentId(rec.id)) throw new Error(`invalid agent id: ${String(rec.id).slice(0, 64)}`);
    await this.ensure();
    await writeFile(this.file(rec.id), JSON.stringify(rec, null, 2));
  }
  async load(id: string): Promise<AgentRecord | null> {
    if (!isAgentId(id)) return null;
    return this.read(this.file(id));
  }
  // Whether the record file is there, for "agent gone" decisions (queue
  // Deliverer and scanner, plan decision 37): save is a plain writeFile, so
  // load() can read a half-written record as null. False only on ENOENT (or an
  // id that is not an agent id); any other stat error counts as present.
  async exists(id: string): Promise<boolean> {
    if (!isAgentId(id)) return false;
    try {
      await stat(this.file(id));
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
    }
  }
  private async read(path: string): Promise<AgentRecord | null> {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as
        AgentRecord & { claudeSessionId?: string | null };
      // Records predating the runtime split store the session id under the old
      // key and carry no runtime. Normalize both on read, so nothing downstream
      // has to know the legacy shape.
      const { claudeSessionId, ...rest } = raw;
      return {
        ...rest,
        sessionId: rest.sessionId ?? claudeSessionId ?? null,
        runtime: rest.runtime ?? "claude",
      };
    } catch { return null; }
  }
  async list(): Promise<AgentRecord[]> {
    await this.ensure();
    const names = (await readdir(this.dir)).filter((n) => n.endsWith(".json"));
    const recs = await Promise.all(names.map((n) => this.read(join(this.dir, n))));
    return recs.filter((r): r is AgentRecord => r !== null).sort((a, b) => a.createdAt - b.createdAt);
  }
  async patch(id: string, fields: Partial<AgentRecord>): Promise<void> {
    const rec = await this.load(id);
    if (!rec) return;
    await this.save({ ...rec, ...fields });
  }
  async delete(id: string): Promise<void> {
    if (!isAgentId(id)) return;
    try { await unlink(this.file(id)); } catch { /* already gone */ }
  }
}
