// server/chief/queue/prgate.ts — the merge gate of a pr item (overview decision 60): is the
// item's PR merged right now? QueueActions asks at answer time, before it takes an `approve`.
// The reads are PrWatch's own (prwatch.ts): `gh pr view` for an item with a URL, `git merge-base
// --is-ancestor` for a local branch. Each has a short deadline, and every failure reads as
// `unknown`, never as merged: the caller refuses (fail closed). No lock is taken here: the
// caller runs it outside the item lock, as every gh and git call of the queue.
import type { SessionStore } from "../../agents/store.js";
import { deadline } from "../deadline.js";
import { repoOfPrUrl, type AddDeps } from "./add.js";
import type { QueueItem } from "./types.js";

// One gh or git call at answer time: the user waits on it.
export const PR_GATE_CALL_MS = 10_000;

export type MergeState =
  | { state: "merged" }
  | { state: "not-merged"; detail: string }
  | { state: "unknown"; why: string };

export type MergeGateDeps = {
  agents: Pick<SessionStore, "load">; workspaceDir: string;
  listRepos: AddDeps["listRepos"]; prStatus: AddDeps["prStatus"]; isAncestor: AddDeps["isAncestor"];
  callTimeoutMs?: number;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const WHY_MAX = 160;
const short = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > WHY_MAX ? `${one.slice(0, WHY_MAX - 1)}…` : one;
};

// What the user calls the thing to merge: "PR #7", or "branch agent/x" for a local item.
export function prLabel(item: QueueItem): string {
  const pr = item.pr;
  if (pr && "url" in pr) return `PR #${pr.number}`;
  return pr ? `branch ${pr.local.branch}` : "the PR";
}

export async function prMergeState(d: MergeGateDeps, item: QueueItem): Promise<MergeState> {
  const ms = d.callTimeoutMs ?? PR_GATE_CALL_MS;
  const pr = item.pr;
  if (item.kind !== "pr" || !pr) return { state: "unknown", why: "the item has no PR" };
  try {
    if ("url" in pr) {
      const repo = await deadline(repoOfPrUrl(d, pr.url), ms, "listRepos");
      if (!repo) return { state: "unknown", why: "its repository is not in the workspace" };
      const st = await deadline(d.prStatus(repo.path, pr.number), ms, "gh pr view");
      if (st.prState === "MERGED") return { state: "merged" };
      if (st.prState === "OPEN") return { state: "not-merged", detail: "open" };
      if (st.prState === "CLOSED") return { state: "not-merged", detail: "closed without a merge" };
      return { state: "unknown", why: `GitHub gave the state ${JSON.stringify(st.prState.slice(0, 20))}` };
    }
    const rec = await d.agents.load(item.agentId);
    if (!rec || !rec.repo) return { state: "unknown", why: "the record of its agent cannot be read" };
    // Not PrWatch's `aheadAtAdd` test: that one only guards a close nobody asked for. Here the
    // user asks, and "the branch is in its base" is the whole question.
    const merged = await deadline(d.isAncestor(rec.repo, pr.local.branch, rec.baseBranch), ms, "git merge-base");
    return merged ? { state: "merged" } : { state: "not-merged", detail: `not in ${rec.baseBranch}` };
  } catch (e) {
    return { state: "unknown", why: short(errText(e)) };
  }
}

// The refusal of an `approve`: the text every surface shows (the tab's error line, the Telegram
// reply) and a `reason` a client can test.
export type GateRefusal = { error: string; reason: "pr-not-merged" | "pr-state-unknown" };
export function gateRefusal(item: QueueItem, st: Exclude<MergeState, { state: "merged" }>): GateRefusal {
  const label = prLabel(item);
  const what = label.charAt(0).toUpperCase() + label.slice(1);
  if (st.state === "not-merged") {
    return { reason: "pr-not-merged", error: `${what} is not merged (${st.detail}). Merge it first: this item then closes on its own.` };
  }
  return { reason: "pr-state-unknown", error: `Could not read the state of ${label} (${st.why}). Approve is refused. Try again.` };
}
