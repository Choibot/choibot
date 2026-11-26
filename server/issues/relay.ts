// server/issues/relay.ts — agent → issue. A finished turn becomes a PR link or
// a question in the Telegram thread; agent status changes move the issue.
// It ignores agent-status idle for questions: idle also fires on Notification
// hooks, boot reconcile, resume and account switch (see AgentTurnEndEvent).
import type { EventHub } from "../events.js";
import type { AgentRecord, SessionStore } from "../agents/store.js";
import type { AgentPr } from "../gh/status.js";
import type { IssueActions } from "./actions.js";
import { LIVE_STATUSES, reopened, type Issue, type IssueStore } from "./store.js";
import { isClone } from "../agents/agentclone.js";

export const WAITING_TEXT = "Agent is waiting — open it in the console";
const ERRORED_TEXT = "Agent errored — resume it in the console.";

export type RelayDeps = {
  hub: EventHub;
  store: IssueStore;
  actions: IssueActions;
  agents: Pick<SessionStore, "load" | "patch">;
  findPr: (rec: { repo: string; branch: string; prNumber?: number }) => Promise<AgentPr | null>;
  headBranch: (worktree: string, repo?: string) => Promise<string | null>;
  // Chief queue hook: adds a `pr` item. Absent when the chief is off.
  queueAdd?: (rec: AgentRecord, pr: { url: string; number: number }) => Promise<void>;
};

const isClosedWithAgent = (i: Issue) => (i.status === "done" || i.status === "error") && !!i.agentId;

function warn(e: unknown): void {
  console.warn("[issues] relay:", e instanceof Error ? e.message : e);
}

export class IssueRelay {
  constructor(private d: RelayDeps) {}

  start(): () => void {
    return this.d.hub.subscribe((e) => {
      if (e.type === "agent-turn-end") void this.onTurnEnd(e.agentId, e.lastMessage).catch(warn);
      // A quiet end (a sign-out of its login) is not the end of the issue's work.
      else if (e.type === "agent-status" && !e.quiet) void this.onStatus(e.agentId, e.status).catch(warn);
    });
  }

  private async issueAgent(agentId: string): Promise<{ rec: AgentRecord; issueId: string } | null> {
    const rec = await this.d.agents.load(agentId);
    if (!rec || rec.kind !== "issue" || !rec.issueId) return null;
    return { rec, issueId: rec.issueId };
  }

  async onTurnEnd(agentId: string, lastMessage: string): Promise<void> {
    const found = await this.issueAgent(agentId);
    if (!found) return;
    const { rec, issueId } = found;
    await this.d.store.queue(issueId, async () => {
      let cur = await this.d.store.get(issueId);
      if (!cur || cur.agentId !== agentId) return;
      // Step 5: the agent came back (resume after account switch or sweep).
      if (isClosedWithAgent(cur)) cur = (await this.d.store.mutate(issueId, reopened)) ?? cur;
      if (!LIVE_STATUSES.includes(cur.status)) return; // step 6
      // Strong protection: no git in an agent's own clone; the record's branch.
      const branch = (isClone(rec) ? null : await this.d.headBranch(rec.worktree, rec.repo)) ?? rec.branch;
      const pr = await this.d.findPr({ repo: rec.repo, branch, prNumber: rec.prNumber });
      const text = lastMessage.trim() ? lastMessage : WAITING_TEXT;
      if (pr && !cur.prUrl) { // step 2
        await this.d.agents.patch(agentId, { prUrl: pr.url, prNumber: pr.number });
        await this.d.store.mutate(issueId, (i) => ({ ...i, status: "pr-open", prUrl: pr.url, prNumber: pr.number }));
        await this.d.actions.postInQueue(issueId, `PR opened: ${pr.url}`);
        if (this.d.queueAdd) {
          try { await this.d.queueAdd(rec, { url: pr.url, number: pr.number }); } catch (e) { warn(e); }
        }
        return;
      }
      if (pr || cur.prUrl) { // step 3 (a known PR counts even when gh is offline)
        await this.d.actions.postInQueue(issueId, text);
        return;
      }
      // step 4: running or needs-input with no PR
      await this.d.store.mutate(issueId, (i) => ({ ...i, status: "needs-input" }));
      await this.d.actions.postInQueue(issueId, text);
    });
  }

  async onStatus(agentId: string, status: "running" | "idle" | "done" | "error"): Promise<void> {
    const found = await this.issueAgent(agentId);
    if (!found) return;
    const { issueId } = found;
    await this.d.store.queue(issueId, async () => {
      const cur = await this.d.store.get(issueId);
      if (!cur || cur.agentId !== agentId) return;
      if (status === "error") {
        if (cur.status === "error" || cur.status === "dropped") return; // one message only
        await this.d.store.mutate(issueId, (i) => ({ ...i, status: "error", error: "agent errored" }));
        await this.d.actions.postInQueue(issueId, ERRORED_TEXT);
        return;
      }
      if (status === "done") {
        if (cur.status === "pr-open" || cur.status === "done" || cur.status === "dropped") return;
        await this.d.store.mutate(issueId, (i) => ({ ...i, status: "done" }));
        return;
      }
      if (isClosedWithAgent(cur)) await this.d.store.mutate(issueId, reopened);
    });
  }
}

// A live issue whose agent record is gone (deleted in the Agents view) is done.
export async function closeOrphans(store: IssueStore, agents: Pick<SessionStore, "load">): Promise<void> {
  for (const i of await store.list()) {
    if (!i.agentId || !LIVE_STATUSES.includes(i.status)) continue;
    if (await agents.load(i.agentId)) continue;
    await store.update(i.id, (cur) =>
      cur.agentId === i.agentId && LIVE_STATUSES.includes(cur.status) ? { ...cur, status: "done" } : null);
  }
}
