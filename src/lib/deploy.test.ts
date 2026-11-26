// src/lib/deploy.test.ts — the deploy ticket on the client (chief spec §5.7): the one request,
// the pairing words, and that no key or reply box of the Queue view can answer or start it.
import { describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../../server/chief/queue/types";
import { CONSOLE_AGENT_ID, DEPLOY_CLOSED, type DeployRun } from "../../server/chief/deploy/ticket";
import { PAIR_TO_DEPLOY, pairHow, recentDeployed, startDeploy, stepStates } from "./deploy";
import { planAction } from "./queueActions";
import { detailActions } from "./queueDetail";
import { agentWord, kindChip, rowMeta } from "./queueInbox";
import { openCounts } from "./queueRow";
import { agentTickets, closedMark, closedText, kindWord } from "./threadTickets";
import { keyToAction } from "./useQueueKeys";

const A = "a".repeat(40), B = "b".repeat(40);
const ticket = (o: Partial<QueueItem> = {}): QueueItem => ({
  id: "q12345678", kind: "deploy", agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" },
  repo: "choibot", area: "choibot", title: "Console: 1 commit merged, not live", body: "#5 x", createdAt: 1_000, updatedAt: 1_000,
  status: "open", blocking: false, history: [], answerSeq: 0, deploy: { live: A, target: B, count: 1, prs: [{ number: 5, title: "x" }], more: 0 }, ...o,
});
const run = (o: Partial<DeployRun> = {}): DeployRun => ({ id: "d1", via: "tab", startedAt: 1, phase: "running", step: "build", from: A, to: B, ...o });
const keys = { inReplyBox: false, gPending: false, ctrl: false, meta: false, alt: false, shift: false, isComposing: false, targetIsButton: false };

describe("startDeploy", () => {
  const storage = { getItem: () => "tok" };
  const res = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends one POST with the user token and no body", async () => {
    const fetch = vi.fn(async () => res(200, ticket({ deploy: { ...ticket().deploy!, run: run({ step: "fetch" }) } })));
    const r = await startDeploy({ fetch: fetch as unknown as typeof globalThis.fetch, storage });
    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/deploy");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("x-choibot-user")).toBe("tok");
  });

  it("a device that is not paired gets the pairing sentence; other refusals give their reason", async () => {
    const pair = await startDeploy({ fetch: (async () => res(403, { error: "pair-required", userAuth: "telegram" })) as unknown as typeof fetch, storage: null });
    expect(pair).toEqual({ ok: false, status: 403, error: "Deploy needs a paired device — send /pair <label> in the Master topic" });
    const busy = await startDeploy({ fetch: (async () => res(409, { error: "a deploy already runs" })) as unknown as typeof fetch, storage });
    expect(busy).toEqual({ ok: false, status: 409, error: "a deploy already runs" });
    const down = await startDeploy({ fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, storage });
    expect(down).toEqual({ ok: false, status: 0, error: "offline" });
    expect(PAIR_TO_DEPLOY).toBe("Pair this device to deploy");
    expect(pairHow("log")).toBe("Deploy needs a paired device. On a paired device: Settings, Devices, “Add a device”. With no paired device: run `pnpm choibot brain pair <label>` on your server");
  });
});

describe("no Queue key, reply or accept acts on the deploy ticket", () => {
  const t = ticket();
  it("keys: only snooze", () => {
    for (const key of ["a", "c", "r", "o", "Enter", "1", "2"]) expect(keyToAction(key, { ...keys, focused: t })).toBeNull();
    expect(keyToAction("s", { ...keys, focused: t })).toEqual({ t: "snooze" });
  });
  it("plans: only snooze, even with a draft and a forged recommendation", () => {
    const forged = ticket({ recommend: { value: "A", why: "x", ruleIds: ["r_abc12"], by: "fleet-master", at: 1 } });
    const ctx = { focused: forged, readOnly: false, draft: "deploy it", snoozeMin: 60, now: 2_000 };
    for (const a of [{ t: "approve" }, { t: "accept" }, { t: "send" }, { t: "reply" }, { t: "changes" }, { t: "open" }, { t: "pick", key: "A" }] as const) {
      expect(planAction(a, ctx)).toBeNull();
    }
    expect(planAction({ t: "snooze" }, ctx)).toEqual({ t: "snooze", item: forged, minutes: 60 });
  });
  it("the detail bar: snooze and withdraw, nothing that answers; none when read-only", () => {
    expect(detailActions(t, false).map((a) => a.id)).toEqual(["snooze", "withdraw"]);
    expect(detailActions(t, true)).toEqual([]);
  });
});

describe("where the ticket shows", () => {
  it("in the fleet master's thread and on its row count, in no other agent's", () => {
    const other = ticket({ id: "q00000001", kind: "question", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" } });
    expect(agentTickets([ticket(), other], "fleet-master").map((i) => i.id)).toEqual(["q12345678"]);
    expect(agentTickets([ticket(), other], "a1").map((i) => i.id)).toEqual(["q00000001"]);
    // An agent's item cannot place itself there by naming the console.
    expect(agentTickets([ticket({ kind: "question" })], "fleet-master")).toEqual([]);
    expect(openCounts([ticket(), other], 2_000)).toEqual({ total: 2, byAgent: { "fleet-master": 1, a1: 1 } });
    expect(kindWord(ticket())).toBe("Deploy");
  });

  it("the Inbox row and the pane head name the console and the run's state", () => {
    expect(agentWord(CONSOLE_AGENT_ID)).toBe("the console itself");
    expect(kindChip(ticket(), 2_000)).toEqual({ text: "deploy · from the console", block: false });
    expect(rowMeta(ticket(), 61_000).map((p) => p.text)).toEqual(["deploy", "choibot", "1 min"]);
    expect(rowMeta(ticket({ deploy: { ...ticket().deploy!, run: run() } }), 61_000)).toContainEqual({ text: "runs: build" });
    expect(rowMeta(ticket({ deploy: { ...ticket().deploy!, run: run({ phase: "failed", step: "typecheck" }) } }), 61_000)).toContainEqual({ text: "failed at typecheck", warn: true });
  });

  it("the closed line says how it closed", () => {
    const done = run({ phase: "done", step: "restart", endedAt: 9, alive: 12, failed: 0 });
    expect(closedText(ticket({ status: "withdrawn", lastError: DEPLOY_CLOSED.deployed, deploy: { ...ticket().deploy!, run: done } })))
      .toBe("Deployed · live bbbbbbb · 12 agents alive · rollback aaaaaaa");
    expect(closedText(ticket({ status: "withdrawn", lastError: DEPLOY_CLOSED.live }))).toBe("Closed: the running build has all of main");
    expect(closedText(ticket({ status: "withdrawn" }))).toBe("Dismissed");
    expect(closedMark(ticket({ status: "withdrawn", lastError: DEPLOY_CLOSED.deployed }))).toBe("✓");
    expect(closedMark(ticket({ status: "withdrawn", lastError: DEPLOY_CLOSED.live }))).toBe("×");
    expect(kindChip(ticket({ status: "withdrawn", lastError: DEPLOY_CLOSED.deployed }), 2_000).text).toBe("deploy · deployed");
  });

  it("the Queue view keeps the result of a deployed ticket for an hour", () => {
    const closed = ticket({ status: "withdrawn", lastError: DEPLOY_CLOSED.deployed, closedAt: 10_000 });
    expect(recentDeployed([ticket(), closed], 10_000 + 59 * 60_000)?.id).toBe(closed.id);
    expect(recentDeployed([closed], 10_000 + 61 * 60_000)).toBeNull();
    expect(recentDeployed([ticket({ status: "withdrawn", lastError: DEPLOY_CLOSED.live, closedAt: 10_000 })], 10_001)).toBeNull();
  });

  it("the steps: done before the current one, to do after it", () => {
    expect(stepStates(run({ step: "typecheck" })).map((x) => `${x.step}:${x.state}`)).toEqual([
      "fetch:done", "fast-forward:done", "install:done", "typecheck:now", "build:todo", "restart:todo", "check:todo",
    ]);
    expect(stepStates(run({ phase: "done", step: "restart" })).every((x) => x.state === "done")).toBe(true);
    expect(stepStates(run({ step: "build", skipped: ["install"] })).map((x) => x.state)).toEqual(["done", "done", "skipped", "done", "now", "todo", "todo"]);
  });
});
