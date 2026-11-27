// src/lib/agents.ts
import type { RuntimeId } from "./runtimes";
import { chiefFetch, refusalSentence } from "./chief";
import { agentMemory } from "./viewCache";

export type AgentSession = {
  id: string; label: string; status: string; branch: string; baseBranch?: string; repo: string; worktree: string; head?: string | null; runtime?: RuntimeId; account?: string; closedAt?: number;
  // A limit in the way of the agent (server/agents/store.ts): its last turn was cut; it has no
  // session yet; it started on another login than the default one.
  stop?: { why: "limit" | "model" | "login"; text: string; at: number };
  waitsLogin?: { until: number | null };
  startedOn?: { from: string; until: number | null };
  // Chief (spec §13): the agent id that spawned this one (a lead's workers carry the lead id).
  spawnedBy?: string;
  // The model of its last start (server/agents/store.ts runModel), and its own pick.
  runModel?: string; model?: string;
};
export type RepoInfo = { name: string; path: string; branch: string };
export type ChangedFile = {
  rel: string;
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  state: "committed" | "uncommitted" | "untracked";
  add?: number;
  del?: number;
};
export type GitState = {
  head: string; detached: boolean; sha: string;
  trackedBranch: string; baseBranch: string; onTracked: boolean;
  ahead: number; behind: number;
  staged: number; unstaged: number; untracked: number;
  stashes: { ref: string; message: string }[];
  error: boolean;
};

export async function fetchAgents(): Promise<{ sessions: AgentSession[] }> {
  const r = await chiefFetch("/api/agents"); if (!r.ok) throw new Error("load agents"); return r.json();
}
export async function fetchAgent(id: string): Promise<AgentSession> {
  const r = await chiefFetch(`/api/agents/${id}`); if (!r.ok) throw new Error("load agent");
  return r.json();
}
export async function fetchRepos(): Promise<{ repos: RepoInfo[] }> {
  const r = await chiefFetch("/api/repos"); if (!r.ok) throw new Error("load repos"); return r.json();
}
export async function fetchBranches(repo: string): Promise<{ local: string[]; remote: string[]; current: string; defaultBranch: string | null }> {
  const r = await chiefFetch(`/api/repos/branches?repo=${encodeURIComponent(repo)}`);
  if (!r.ok) throw new Error("load branches"); return r.json();
}
export async function addRepo(input: { url?: string; name?: string }): Promise<{ ok: boolean; repo?: RepoInfo; error?: string }> {
  const r = await chiefFetch("/api/repos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await r.json().catch(() => ({}));
  // With chief on, adding a repo is a USER action: an unpaired browser gets the pairing sentence.
  if (!r.ok) return { ok: false, error: refusalSentence(r.status, body, "Adding a repo") ?? body.error ?? `failed (${r.status})` };
  return { ok: true, repo: body.repo };
}
// Named fields rather than positionals: most launches set only some of these,
// and the runtime lives past four optionals that would otherwise be `undefined`
// padding at the call site.
export type SpawnInput = {
  repo: string;
  prompt?: string;
  baseBranch?: string;
  createFrom?: string;
  branch?: string;
  runtime?: RuntimeId;
  account?: string; // Claude login id (src/lib/accounts.ts); absent/"default" = the box's own
};
export async function spawnAgent({ repo, prompt = "", baseBranch, createFrom, branch, runtime, account }: SpawnInput): Promise<string> {
  const r = await chiefFetch("/api/agents", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, prompt, baseBranch, createFrom, branch, runtime, account }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? "spawn failed");
  return body.id as string;
}
export async function stopAgent(id: string): Promise<void> {
  await chiefFetch(`/api/agents/${id}/stop`, { method: "POST" });
}
export async function resumeAgent(id: string): Promise<void> {
  const r = await chiefFetch(`/api/agents/${id}/resume`, { method: "POST" });
  if (!r.ok) throw new Error("resume failed");
}
// A diff above the cap of strong protection (an agent's own copy): the server answers 413.
export const DIFF_TOO_LARGE = "The diff is too large to show.";
export async function agentDiff(id: string): Promise<string> {
  const r = await chiefFetch(`/api/agents/${id}/diff`);
  if (r.status === 413) throw new Error(DIFF_TOO_LARGE);
  if (!r.ok) throw new Error("diff failed");
  return (await r.json()).diff;
}
// The last list of changed files seen per agent: the pane header's count and the Changes rail
// show it on their first frame (lib/viewCache).
export const changedFilesMemory = agentMemory<ChangedFile[]>();

export async function agentChangedFiles(id: string): Promise<{ files: ChangedFile[] }> {
  const r = await chiefFetch(`/api/agents/${id}/changed`); if (!r.ok) throw new Error("changed failed"); return r.json();
}
export async function agentGitState(id: string): Promise<GitState> {
  const r = await chiefFetch(`/api/agents/${id}/git`); if (!r.ok) throw new Error("git state failed"); return (await r.json()).git;
}
export async function discardAgentFile(id: string, rel: string): Promise<boolean> {
  const r = await chiefFetch(`/api/agents/${id}/discard-file`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rel }),
  });
  return r.ok;
}
export async function mergeAgent(id: string): Promise<{ ok: boolean; conflict?: boolean; message?: string }> {
  const r = await chiefFetch(`/api/agents/${id}/merge`, { method: "POST" });
  if (r.status === 409) return { ok: false, message: "agent still live — stop it first" };
  if (r.status === 403 || r.status === 503) {
    const refusal = refusalSentence(r.status, await r.clone().json().catch(() => null));
    if (refusal) return { ok: false, message: refusal };
  }
  return r.json();
}
export async function discardAgent(id: string): Promise<boolean> {
  const r = await chiefFetch(`/api/agents/${id}/discard`, { method: "POST" }); return r.ok;
}
export async function deleteAgent(id: string): Promise<boolean> {
  const r = await chiefFetch(`/api/agents/${id}/delete`, { method: "POST" });
  return r.ok;
}
// Close moves the agent to the rail's Closed section (it keeps running); the
// server deletes it 7 days later. Reopen moves it back.
export async function closeAgent(id: string): Promise<boolean> {
  const r = await chiefFetch(`/api/agents/${id}/close`, { method: "POST" }); return r.ok;
}
// A new title for an agent (its label in the list). The answer: null, or the one line that
// says why not (the server's refusal, the pairing sentence, or "failed (500)").
export async function renameAgent(id: string, title: string): Promise<string | null> {
  const r = await chiefFetch(`/api/agents/${id}/rename`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
  if (r.ok) return null;
  const body = await r.json().catch(() => ({}));
  return refusalSentence(r.status, body, "Renaming an agent") ?? body.error ?? `failed (${r.status})`;
}
// The model an agent runs on: the --model of its last start, else its own pick. When the console
// does not know it (an agent of before runModel that has no pick, a Codex agent): none, no guess.
export function agentModel(a: { runModel?: string; model?: string }): string | undefined {
  return a.runModel ?? a.model;
}
// The model in short: "opus", "opus-5-5" for "claude-opus-5-5". The list row shows only this.
export function modelWord(model: string | undefined): string | undefined {
  return model ? model.replace(/^claude-/, "") : undefined;
}
// The login of an agent when it is not the default one.
export function loginOf(account: string | undefined): string | undefined {
  return account && account !== "default" ? account : undefined;
}
// The quiet tag of a header: the model in short, then the login: "opus · @choibot". The row's tag is
// the model only (the title gets the room); its hover text keeps this `title`.
export function modelTag(model: string | undefined, account?: string): { text: string; title: string } | null {
  const login = loginOf(account);
  const text = [modelWord(model), login && `@${login}`].filter(Boolean).join(" · ");
  if (!text) return null;
  return { text, title: [model && `Model: ${model}`, login && `Claude account: ${login}`].filter(Boolean).join(" · ") };
}
export async function reopenAgent(id: string): Promise<boolean> {
  const r = await chiefFetch(`/api/agents/${id}/reopen`, { method: "POST" }); return r.ok;
}
export const CLOSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export async function reorderAgents(ids: string[]): Promise<boolean> {
  const r = await chiefFetch("/api/agents/order", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }),
  });
  return r.ok;
}
export type AgentTask = { id: string; subject: string; activeForm?: string; status: "pending" | "in_progress" | "completed" };
export async function agentTasks(id: string): Promise<{ tasks: AgentTask[] }> {
  const r = await chiefFetch(`/api/agents/${id}/tasks`); if (!r.ok) throw new Error("tasks failed"); return r.json();
}
