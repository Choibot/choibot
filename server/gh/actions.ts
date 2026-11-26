// server/gh/actions.ts
//
// Human-triggered PR/issue write actions, performed by the console server (not
// agents — the PreToolUse guard is agent-only). Every successful write busts
// the cockpit cache so the dashboard reflects the change on refresh.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { gh as defaultGh, GhError } from "./exec.js";
import { listRepos } from "./repos.js";
import { bustCockpitCache } from "./cockpit.js";
import { gateMerge, type ChiefGate } from "../chief/gate.js";
import { resolveWorkspaceDir } from "../defaults.js";

export type GhRunner = (args: string[], opts?: { cwd?: string }) => Promise<string>;

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

// `headSha`: GitHub merges only while the PR's head is this commit (a push after the user
// looked makes the merge fail). The Queue ticket's merge passes it; the GitHub tab's does not.
export const mergeArgs = (pr: number, method: MergeMethod, headSha?: string) =>
  ["pr", "merge", String(pr), `--${method}`, ...(headSha ? ["--match-head-commit", headSha] : [])];
export const prCloseArgs = (pr: number) => ["pr", "close", String(pr)];
export const prReopenArgs = (pr: number) => ["pr", "reopen", String(pr)];
export const issueCloseArgs = (n: number) => ["issue", "close", String(n)];
export const issueReopenArgs = (n: number) => ["issue", "reopen", String(n)];
export const commentArgs = (kind: "pr" | "issue", n: number, body: string) => [kind, "comment", String(n), "--body", body];

const KIND_STATUS: Record<string, number> = {
  not_authed: 401, no_github_remote: 400, not_fast_forward: 409,
  already_exists: 409, not_found: 404, rate_limited: 429, unknown: 502,
};

// The result of one gh write: ok, or the HTTP status, the gh text and its kind. `note`: a merge
// that went another way than gh's merge command (mergePullRequest), in plain words for the owner.
export type GhWriteResult = { ok: true; note?: string } | { ok: false; status: number; error: string; kind: string };

// Run a built gh command in the repo, bust the cockpit cache, map errors.
export async function runGhWrite(gh: GhRunner, repoPath: string, args: string[]): Promise<GhWriteResult> {
  try { await gh(args, { cwd: repoPath }); bustCockpitCache(); return { ok: true }; }
  catch (e) {
    const kind = e instanceof GhError ? e.kind : "unknown";
    return { ok: false, status: KIND_STATUS[kind] ?? 502, error: e instanceof Error ? e.message : String(e), kind };
  }
}

// GitHub's REST API, through gh's api command (the runner, the credentials and the repo folder of
// gh's merge command). gh fills {owner}/{repo} with the repo its pr commands use: the default of
// `gh repo set-default`, else the first remote (checked with gh 2.96).
export const prRestArgs = (pr: number) => ["api", `repos/{owner}/{repo}/pulls/${pr}`];
// No commit_title or commit_message: GitHub's default text for the method, as gh's merge command
// gives when the console passes no --subject or --body (it never does).
export const mergeRestArgs = (pr: number, method: MergeMethod, sha: string) =>
  ["api", "-X", "PUT", `repos/{owner}/{repo}/pulls/${pr}/merge`, "-f", `merge_method=${method}`, "-f", `sha=${sha}`];

// gh's merge command failed because GitHub's GraphQL service failed, not because GitHub refused
// the merge. The whole text must be one of the two forms gh printed on 2026-11-25 and before:
//   GraphQL: Something went wrong while executing your query on 2026-11-25T16:11:50Z. Please include `<id>` when reporting this issue.
//   HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)    (also 503 and 504 seen)
// A refusal of the merge names its reason and the mutation, "... (mergePullRequest)", or is gh's
// own text ("is not mergeable: ..."); a 4xx is a refusal. Any second error, path or line: no match.
const GRAPHQL_FAILED = /^GraphQL: Something went wrong while executing your query on [^\s,`]+\. Please include `[^\s,`]+` when reporting this issue\.$/;
const GRAPHQL_5XX = /^HTTP 5\d\d(?:: [^\n]*)? \(https:\/\/api\.github\.com\/graphql\)$/;
export const isGraphqlOutage = (text: string): boolean => {
  const t = text.trim();
  return GRAPHQL_FAILED.test(t) || GRAPHQL_5XX.test(t);
};

const SHA_RE = /^[0-9a-f]{40}$/i;
type RestPr = { state: "open" | "closed" | "merged"; head: string };
// The REST read of the PR: its state and head. Null when gh fails or the answer is not this PR
// with a known state and a head commit. "merged" needs GitHub's merge commit too.
async function readPr(gh: GhRunner, repoPath: string, pr: number): Promise<RestPr | null> {
  let v: { number?: unknown; state?: unknown; merged?: unknown; merge_commit_sha?: unknown; head?: { sha?: unknown } };
  try { v = JSON.parse(await gh(prRestArgs(pr), { cwd: repoPath })); } catch { return null; }
  if (!v || typeof v !== "object" || v.number !== pr) return null;
  const head = typeof v.head?.sha === "string" && SHA_RE.test(v.head.sha) ? v.head.sha.toLowerCase() : null;
  if (!head) return null;
  if (v.merged === true) return typeof v.merge_commit_sha === "string" && SHA_RE.test(v.merge_commit_sha) ? { state: "merged", head } : null;
  if (v.merged !== false || (v.state !== "open" && v.state !== "closed")) return null;
  return { state: v.state, head };
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const errOf = (e: unknown): { text: string; kind: string } => ({
  text: e instanceof Error ? e.message : String(e), kind: e instanceof GhError ? e.kind : "unknown",
});

// The one merge of a PR. Both routes that merge from the console call it: the GitHub tab's
// (/api/gh/pr/merge, below) and the Queue ticket's (chief/queue/merge.ts). Each route has its
// own gate; this function has none.
// When GitHub's GraphQL API fails (isGraphqlOutage), the same PR merges through GitHub's REST API:
// a REST read first (that failed call can have merged it; a closed PR or new commits stop here),
// then the merge bound to the head commit: `headSha`, or the read's head when the caller gives
// none (the GitHub tab). One log line each time this fallback runs.
export async function mergePullRequest(gh: GhRunner, repoPath: string, pr: number, method: MergeMethod, headSha?: string,
  opts: { log?: (s: string) => void } = {}): Promise<GhWriteResult> {
  const first = await runGhWrite(gh, repoPath, mergeArgs(pr, method, headSha));
  if (first.ok || !isGraphqlOutage(first.error)) return first;
  const log = (s: string) => (opts.log ?? ((l: string) => console.warn(l)))(`[gh] PR #${pr}: GitHub's GraphQL API failed (${oneLine(first.error)}); ${s}`);
  const failed = `GitHub's GraphQL API failed: ${first.error}`;
  const merged = (): GhWriteResult => {
    bustCockpitCache();
    return { ok: true, note: `GitHub's GraphQL API failed, but GitHub shows PR #${pr} as merged.` };
  };

  const read = await readPr(gh, repoPath, pr);
  if (!read) { log("the REST read of the PR failed: no fallback"); return first; }
  if (read.state === "merged") { log("the REST read says it is already merged"); return merged(); }
  if (read.state === "closed") {
    log("the REST read says it is closed, not merged: no merge");
    return { ok: false, status: 409, kind: "closed", error: `${failed} PR #${pr} is closed and not merged. Nothing was merged.` };
  }
  const want = headSha ? headSha.toLowerCase() : read.head;
  if (read.head !== want) {
    log(`the REST read gives head ${read.head.slice(0, 7)}, not ${want.slice(0, 7)}: no merge`);
    return { ok: false, status: 409, kind: "moved",
      error: `${failed} PR #${pr} has new commits (head ${read.head.slice(0, 7)}, not ${want.slice(0, 7)}). Nothing was merged. Look again.` };
  }

  let second: { text: string; kind: string };
  try {
    const out = JSON.parse(await gh(mergeRestArgs(pr, method, want), { cwd: repoPath })) as { merged?: unknown; message?: unknown };
    if (out?.merged === true) {
      log(`merged through GitHub's REST API (${method}, head ${want.slice(0, 7)})`);
      bustCockpitCache();
      return { ok: true, note: "GitHub's GraphQL API failed. The merge went through GitHub's REST API." };
    }
    second = { text: `GitHub answered without "merged": ${oneLine(String(out?.message ?? "")).slice(0, 200)}`, kind: "unknown" };
  } catch (e) {
    second = errOf(e);
  }
  // The GraphQL call can have merged it after all, and the first read can be a moment behind.
  if ((await readPr(gh, repoPath, pr))?.state === "merged") { log(`the REST merge failed (${oneLine(second.text)}); a read again says it is already merged`); return merged(); }
  log(`the REST merge failed too: ${oneLine(second.text)}`);
  return { ok: false, status: KIND_STATUS[second.kind] ?? 502, kind: second.kind,
    error: `${failed} Then the merge through GitHub's REST API failed too: ${second.text}` };
}

// `chief` set = CHIEF_ENABLED: the merge route takes the merge gate (spec §7).
// `onPrChange`: a PR was merged or closed here (the chief queue closes its pr item at once).
export function registerGhActionsApi(app: FastifyInstance, deps: { gh?: GhRunner; workspaceDir?: string; chief?: ChiefGate; onPrChange?: () => void }): void {
  const gh = deps.gh ?? defaultGh;
  const workspaceDir = deps.workspaceDir ?? resolveWorkspaceDir();

  async function resolveRepo(reply: FastifyReply, repoQ: unknown): Promise<string | null> {
    const repos = await listRepos(workspaceDir);
    const repo = repos.find((r) => r.name === repoQ || r.slug === repoQ);
    if (!repo) { reply.code(400); return null; }
    return repo.path;
  }
  function posInt(v: unknown): number | null {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  // The route's answer for a gh write: { ok: true } (with the merge's note, if any), or
  // { ok: false, error, kind } with its status.
  function answer(reply: FastifyReply, r: GhWriteResult) {
    if (r.ok) return r.note ? { ok: true as const, note: r.note } : { ok: true as const };
    reply.code(r.status);
    return { ok: false as const, error: r.error, kind: r.kind };
  }
  const run = async (reply: FastifyReply, path: string, args: string[]) => answer(reply, await runGhWrite(gh, path, args));
  // After a merge or a close; the hook never changes the route's answer.
  function prChanged(r: GhWriteResult): void {
    if (r.ok) { try { deps.onPrChange?.(); } catch { /* the queue's own timers still close the item */ } }
  }
  async function runPrChange(reply: FastifyReply, path: string, args: string[]) {
    const r = await runGhWrite(gh, path, args);
    prChanged(r);
    return answer(reply, r);
  }

  app.post("/api/gh/pr/merge", async (req: FastifyRequest, reply: FastifyReply) => {
    if (deps.chief && !(await gateMerge(deps.chief, req, reply))) return reply;
    const b = (req.body ?? {}) as { repo?: string; pr?: number; method?: string };
    const path = await resolveRepo(reply, b.repo); if (!path) return { error: "unknown repo" };
    const pr = posInt(b.pr); if (!pr) { reply.code(400); return { error: "pr must be a positive integer" }; }
    const method = b.method as MergeMethod;
    if (!MERGE_METHODS.includes(method)) { reply.code(400); return { error: "method must be squash|merge|rebase" }; }
    const r = await mergePullRequest(gh, path, pr, method);
    prChanged(r);
    return answer(reply, r);
  });

  for (const [route, build] of [["close", prCloseArgs], ["reopen", prReopenArgs]] as const) {
    app.post(`/api/gh/pr/${route}`, async (req: FastifyRequest, reply: FastifyReply) => {
      const b = (req.body ?? {}) as { repo?: string; pr?: number };
      const path = await resolveRepo(reply, b.repo); if (!path) return { error: "unknown repo" };
      const pr = posInt(b.pr); if (!pr) { reply.code(400); return { error: "pr must be a positive integer" }; }
      return route === "close" ? runPrChange(reply, path, build(pr)) : run(reply, path, build(pr));
    });
  }

  for (const [route, build] of [["close", issueCloseArgs], ["reopen", issueReopenArgs]] as const) {
    app.post(`/api/gh/issue/${route}`, async (req: FastifyRequest, reply: FastifyReply) => {
      const b = (req.body ?? {}) as { repo?: string; number?: number };
      const path = await resolveRepo(reply, b.repo); if (!path) return { error: "unknown repo" };
      const n = posInt(b.number); if (!n) { reply.code(400); return { error: "number must be a positive integer" }; }
      return run(reply, path, build(n));
    });
  }

  app.post("/api/gh/comment", async (req: FastifyRequest, reply: FastifyReply) => {
    const b = (req.body ?? {}) as { repo?: string; kind?: string; number?: number; body?: string };
    const path = await resolveRepo(reply, b.repo); if (!path) return { error: "unknown repo" };
    const n = posInt(b.number); if (!n) { reply.code(400); return { error: "number must be a positive integer" }; }
    if (b.kind !== "pr" && b.kind !== "issue") { reply.code(400); return { error: "kind must be pr|issue" }; }
    const body = (b.body ?? "").trim();
    if (!body) { reply.code(400); return { error: "body must not be empty" }; }
    return run(reply, path, commentArgs(b.kind, n, body));
  });
}
