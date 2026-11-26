// src/lib/deploy.ts — the Deploy button of the console's own deploy ticket (chief spec §5.7).
// One POST with no body: the server decides what is deployed, the request only says "go". The
// route needs this device's user token (chiefFetch adds it); an unpaired device gets 403
// pair-required and the button says so.
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { DEPLOY_CLOSED, DEPLOY_STEPS, type DeployRun, type DeployStep } from "../../server/chief/deploy/ticket";
import { chiefFetch, pairSentence, refusalSentence } from "./chief";

export type DeployResult = { ok: true; item: QueueItem } | { ok: false; status: number; error: string };

type Deps = { fetch?: typeof fetch; storage?: Pick<Storage, "getItem"> | null };

export async function startDeploy(deps: Deps = {}): Promise<DeployResult> {
  try {
    const res = await chiefFetch("/api/deploy", { method: "POST" }, deps);
    const b = (await res.json().catch(() => null)) as (Partial<QueueItem> & { error?: string; userAuth?: string }) | null;
    if (res.ok && b) return { ok: true, item: b as QueueItem };
    const fixed = refusalSentence(res.status, b, "Deploy");
    return { ok: false, status: res.status, error: fixed ?? (typeof b?.error === "string" ? b.error : `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "network error" };
  }
}

// What the place of the button says on a device with no user token.
export const PAIR_TO_DEPLOY = "Pair this device to deploy";
export const pairHow = (userAuth: "telegram" | "log" | null): string => pairSentence(userAuth, "Deploy");

export type StepState = "done" | "now" | "todo" | "skipped";
// The runner's steps with where the run is. A failed run stops at its step; a step the runner
// did not need (install with no package change) shows as skipped.
export function stepStates(run: Pick<DeployRun, "step" | "phase" | "skipped">): { step: DeployStep; state: StepState }[] {
  const at = DEPLOY_STEPS.indexOf(run.step);
  return DEPLOY_STEPS.map((step, n) => ({
    step, state: run.skipped?.includes(step) ? "skipped" : n < at || run.phase === "done" ? "done" : n === at ? "now" : "todo",
  }));
}

// How long a deployed ticket stays in the Queue view after it closed.
export const DEPLOYED_SHOWN_MS = 60 * 60_000;

// The newest deploy ticket that closed as deployed a short time ago: the Queue view shows its result.
export function recentDeployed(items: QueueItem[], now: number): QueueItem | null {
  let best: QueueItem | null = null;
  for (const i of items) {
    if (i.kind !== "deploy" || i.status !== "withdrawn" || i.lastError !== DEPLOY_CLOSED.deployed || i.closedAt === undefined) continue;
    if (now - i.closedAt > DEPLOYED_SHOWN_MS) continue;
    if (!best || i.closedAt > (best.closedAt ?? 0)) best = i;
  }
  return best;
}
