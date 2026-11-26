// server/chief/queue/merge.ts — the Merge button of an open pr ticket (the user's ask of
// 2026-11-19: merge from the Queue). The user still merges (decision 60 stays): one press in the
// ticket instead of one on github.com. Two routes (api.ts), both USER only:
//   GET  /api/queue/:id/merge   the PR's merge facts, read fresh: the confirm step shows them
//   POST /api/queue/:id/merge   { method, head, checks?: "accept" }: read fresh again, then merge
// The merge binds to what the confirm showed: the PR GitHub gives must be the ticket's PR (an
// agent wrote the ticket), its head must still be the commit `head` the user saw, and GitHub
// itself merges only that commit (--match-head-commit).
// The merge itself is gh/actions.ts mergePullRequest, the function the GitHub tab's merge route
// runs. After it, the ticket closes through QueueActions.answerUser(approve), the path of
// "I merged it": the merged notice goes to the agent and the decision line is written.
// Only these two routes hold a merge dependency: QueueActions, AutoAnswer, the recommend route,
// the Telegram card and the CLI have none.
import { MERGE_METHODS, type GhWriteResult, type MergeMethod } from "../../gh/actions.js";
import type { CheckCounts, PrMergeFacts } from "../../gh/status.js";
import { deadline } from "../deadline.js";
import type { ActionResult } from "./actions.js";
import { repoOfPrUrl, type AddDeps } from "./add.js";
import { PR_GATE_CALL_MS } from "./prgate.js";
import type { QueueStore } from "./store.js";
import type { QueueItem } from "./types.js";

export type QueueMergeDeps = {
  store: QueueStore; workspaceDir: string; listRepos: AddDeps["listRepos"];
  // The fresh read (gh/status.ts fetchPrMergeFacts) and the one merge (gh/actions.ts mergePullRequest).
  facts: (repoPath: string, pr: number) => Promise<PrMergeFacts>;
  merge: (repoPath: string, pr: number, method: MergeMethod, headSha: string) => Promise<GhWriteResult>;
  // The close of "I merged it": QueueActions.answerUser(id, { value: "approve" }, "tab").
  closeMerged: (id: string) => Promise<ActionResult>;
  // After a merge: PrWatch.checkNow (other tickets of the same PR, the cockpit's pr rows).
  onPrChange?: () => void;
  callTimeoutMs?: number; retryMs?: number; log?: (s: string) => void; now?: () => number;
};

// Why a PR cannot merge now. "unknown": GitHub has not finished its conflict check (a short
// wait); every other reason stays until something changes on GitHub.
export type MergeBlock = { why: "merged" | "closed" | "state" | "draft" | "conflicts" | "unknown"; text: string };
export type MergeView = { facts: PrMergeFacts; blocked: MergeBlock | null; checks: string | null };
// 200: GET gives a MergeView, POST { merged: true, item, note? }. Any other code: { error, reason?, item? }.
// `note`: the merge went another way than gh's merge command (GitHub's GraphQL API failed, the
// merge went through its REST API); the ticket keeps it as `mergeNote`.
export type MergeResult = { code: number; body: Record<string, unknown> };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isLive = (i: QueueItem): boolean => i.status === "open" || i.status === "snoozed";
const isClosedMerged = (i: QueueItem | null): i is QueueItem => !!i && i.status === "withdrawn" && i.lastError === "merged";
const short = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 300 ? `${one.slice(0, 299)}…` : one;
};
const RETRY_MS = 1_500;
const SHA_RE = /^[0-9a-f]{40}$/i;

// owner/repo#number of a GitHub PR url, lower case; null for any other text.
export function prKey(url: string): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url);
  return m ? `${m[1]}/${m[2]}#${Number(m[3])}`.toLowerCase() : null;
}

// The PR GitHub gave is not the ticket's PR: the refusal, or null when they are the same.
function mismatch(t: Target, f: PrMergeFacts): MergeResult | null {
  const want = prKey(t.url);
  const got = prKey(f.url);
  if (want !== null && got === want && f.number === t.number) return null;
  return { code: 409, body: {
    error: `GitHub gives ${got ?? "another PR"} for this ticket's ${want ?? `PR #${t.number}`}. Merge is off.`, reason: "mismatch",
  } };
}

export function mergeBlock(f: Pick<PrMergeFacts, "number" | "state" | "draft" | "mergeable" | "base">): MergeBlock | null {
  const what = `PR #${f.number}`;
  if (f.state === "MERGED") return { why: "merged", text: `${what} is already merged.` };
  if (f.state === "CLOSED") return { why: "closed", text: `${what} is closed.` };
  if (f.state !== "OPEN") return { why: "state", text: `GitHub gives ${what} the state ${JSON.stringify(f.state.slice(0, 20))}.` };
  if (f.draft) return { why: "draft", text: `${what} is a draft. Mark it ready on GitHub first.` };
  if (f.mergeable === "CONFLICTING") return { why: "conflicts", text: `${what} has conflicts with ${f.base || "its base"}. Fix them first.` };
  if (f.mergeable !== "MERGEABLE") return { why: "unknown", text: "GitHub has not finished its conflict check. Try again in a moment." };
  return null;
}

// The ask of a merge while checks are not green: "Checks: 1 failing." Null when they pass or none exist.
export function checksAsk(c: Pick<CheckCounts, "failed" | "pending">): string | null {
  if (c.failed > 0) return `Checks: ${c.failed} failing${c.pending > 0 ? `, ${c.pending} running` : ""}.`;
  if (c.pending > 0) return `Checks: ${c.pending} still running.`;
  return null;
}

type Target = { item: QueueItem; url: string; number: number; repoPath: string };
type Refusal = MergeResult;
const isRefusal = <T extends object>(v: T | Refusal): v is Refusal => "code" in v && "body" in v;

export class QueueMerge {
  private readonly running = new Set<string>();
  private readonly ms: number;
  private readonly log: (s: string) => void;

  constructor(private readonly d: QueueMergeDeps) {
    this.ms = d.callTimeoutMs ?? PR_GATE_CALL_MS;
    this.log = d.log ?? ((s) => console.warn(s));
  }

  // The facts the confirm step shows (GET). The pills of the ticket take the fresh read.
  async view(id: string): Promise<MergeResult> {
    const t = await this.target(id);
    if (isRefusal(t)) return t;
    const f = await this.read(t);
    if (isRefusal(f)) return f;
    const other = mismatch(t, f);
    if (other) return other;
    await this.syncPills(t, f);
    const view: MergeView = { facts: f, blocked: mergeBlock(f), checks: checksAsk(f.checks) };
    return { code: 200, body: view };
  }

  // The merge (POST). `device`: the paired device that pressed (the log line).
  async merge(id: string, body: unknown, device: string): Promise<MergeResult> {
    const b = isObj(body) ? body : {};
    const method = b.method as MergeMethod;
    if (!MERGE_METHODS.includes(method)) return { code: 400, body: { error: "method must be squash|merge|rebase" } };
    if (b.checks !== undefined && b.checks !== "accept") return { code: 400, body: { error: 'checks must be "accept"' } };
    const head = typeof b.head === "string" && SHA_RE.test(b.head) ? b.head.toLowerCase() : null;
    if (!head) return { code: 400, body: { error: "head must be the 40-hex head commit the confirm showed" } };
    // One merge per ticket at a time (two devices, a double press).
    if (this.running.has(id)) return { code: 409, body: { error: "A merge of this PR already runs.", reason: "running" } };
    this.running.add(id);
    try {
      const t = await this.target(id);
      if (isRefusal(t)) return t;
      const f = await this.read(t);
      if (isRefusal(f)) return f;
      const other = mismatch(t, f);
      if (other) return other;
      await this.syncPills(t, f);
      const current = async () => (await this.d.store.get(id)) ?? t.item;
      const blocked = mergeBlock(f);
      if (blocked) return { code: 409, body: { error: blocked.text, reason: "blocked", blocked, facts: f, item: await current() } };
      // A push since the confirm: the user has not seen what would merge now.
      if (f.headSha.toLowerCase() !== head) {
        return { code: 409, body: { error: "New commits since you opened this. Look again.", reason: "moved", facts: f, item: await current() } };
      }
      const ask = checksAsk(f.checks);
      if (ask && b.checks !== "accept") return { code: 409, body: { error: ask, reason: "checks", checks: ask, facts: f, item: await current() } };
      const r = await this.d.merge(t.repoPath, t.number, method, head);
      if (!r.ok) {
        this.log(`[queue] ${id}: merge of PR #${t.number} failed: ${short(r.error)}`);
        return { code: r.status, body: { error: r.error, reason: "github", kind: r.kind, item: await current() } };
      }
      this.log(`[queue] ${id}: PR #${t.number} merged (${method}, head ${head.slice(0, 7)}) from the ticket by device ${device}`);
      if (r.note) await this.keepNote(id, r.note);
      const item = await this.close(id, t.item);
      try { this.d.onPrChange?.(); } catch { /* PrWatch's own timer still runs */ }
      return { code: 200, body: { merged: true, item, ...(r.note ? { note: r.note } : {}) } };
    } finally {
      this.running.delete(id);
    }
  }

  // An open pr ticket with a GitHub PR, and the workspace repo of that PR.
  private async target(id: string): Promise<Target | Refusal> {
    const item = await this.d.store.get(id);
    if (!item) return { code: 404, body: { error: "not found" } };
    const pr = item.pr;
    if (item.kind !== "pr" || !pr || !("url" in pr)) return { code: 400, body: { error: "only a pr ticket with a GitHub PR can merge here" } };
    if (!isLive(item)) return { code: 409, body: { error: "The ticket is closed.", reason: "closed", item } };
    let repo: Awaited<ReturnType<typeof repoOfPrUrl>>;
    try {
      repo = await deadline(repoOfPrUrl(this.d, pr.url), this.ms, "listRepos");
    } catch (e) {
      return { code: 502, body: { error: `Could not list the workspace repos: ${short(errText(e))}` } };
    }
    if (!repo) return { code: 409, body: { error: "The repository of this PR is not in the workspace.", reason: "no-repo", item } };
    return { item, url: pr.url, number: pr.number, repoPath: repo.path };
  }

  private async read(t: Target): Promise<PrMergeFacts | Refusal> {
    try {
      return await deadline(this.d.facts(t.repoPath, t.number), this.ms, "gh pr view");
    } catch (e) {
      return { code: 502, body: { error: `Could not read PR #${t.number}: ${short(errText(e))}`, reason: "read" } };
    }
  }

  // The fresh checks and merge state go on the ticket (its pills), as PrWatch writes them.
  // Best effort: a failed write leaves the pills for PrWatch's next run.
  private async syncPills(t: Target, f: PrMergeFacts): Promise<void> {
    try {
      await this.d.store.withItem(t.item.id, async () => {
        const cur = await this.d.store.get(t.item.id);
        const pr = cur?.pr;
        if (!cur || !isLive(cur) || !pr || !("url" in pr) || pr.url !== t.url) return;
        if (pr.checks === f.checks.rollup && pr.mergeable === f.mergeable) return;
        await this.d.store.write({ ...cur, pr: { ...pr, checks: f.checks.rollup, mergeable: f.mergeable } });
      });
    } catch (e) {
      this.log(`[queue] ${t.item.id}: pill update after the merge read failed: ${errText(e)}`);
    }
  }

  // The merge's note goes on the ticket before the close (the close keeps the item's fields), so
  // a later reader of the ticket finds it. Best effort: the log line and the answer have it too.
  private async keepNote(id: string, text: string): Promise<void> {
    try {
      await this.d.store.withItem(id, async () => {
        const cur = await this.d.store.get(id);
        if (cur) await this.d.store.write({ ...cur, mergeNote: { text, at: (this.d.now ?? Date.now)() } });
      });
    } catch (e) {
      this.log(`[queue] ${id}: the merge note did not go on the ticket: ${errText(e)}`);
    }
  }

  // The PR is merged: the ticket closes as "I merged it" closes it. GitHub can show the merge a
  // moment late, so one retry; PrWatch closes the ticket later if both reads were too early.
  private async close(id: string, before: QueueItem): Promise<QueueItem> {
    for (let n = 0; ; n++) {
      let r: ActionResult | null = null;
      try {
        r = await this.d.closeMerged(id);
      } catch (e) {
        this.log(`[queue] ${id}: close after the merge failed: ${errText(e)}`);
      }
      if (r?.code === 200) return r.item;
      const cur = await this.d.store.get(id).catch(() => null);
      if (isClosedMerged(cur)) return cur; // PrWatch closed it first
      if (n >= 1) return cur ?? before;
      await new Promise((res) => setTimeout(res, this.d.retryMs ?? RETRY_MS));
    }
  }
}
