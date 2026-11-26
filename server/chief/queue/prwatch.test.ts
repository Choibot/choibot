import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import type { PrStatus } from "../../gh/status.js";
import { PrWatch } from "./prwatch.js";
import { QueueStore, type NewItem } from "./store.js";
import type { QueueItem } from "./types.js";

const URL1 = "https://github.com/example-org/app-shop/pull/7";
const rec = (o: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "a1", label: "x", repo: "/ws/app-shop", worktree: "/ws/wt", branch: "agent/x", baseBranch: "main",
  sessionId: null, hookToken: "t", status: "running", createdAt: 1, ...o,
});
const st = (o: Partial<PrStatus> = {}): PrStatus => ({
  prState: "OPEN", mergeable: "MERGEABLE", reviewDecision: "", url: URL1,
  checks: { total: 1, passed: 1, failed: 0, pending: 0, rollup: "success" }, ...o,
});
const prItem = (pr: NewItem["pr"]): NewItem => ({
  kind: "pr", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "app-shop", area: "app-shop",
  title: "t", body: "b", blocking: false, pr,
});
const urlItem = (): NewItem => prItem({ url: URL1, number: 7, checks: "pending", mergeable: "UNKNOWN" });
const localItem = (aheadAtAdd?: boolean): NewItem =>
  prItem({ local: { repo: "app-shop", branch: "agent/x", ...(aheadAtAdd === undefined ? {} : { aheadAtAdd }) } });

let root: string;
let events: QueueItem[];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "chief-prwatch-")); events = []; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

function mk(o: { prStatus?: PrWatchDeps["prStatus"]; isAncestor?: PrWatchDeps["isAncestor"]; listRepos?: PrWatchDeps["listRepos"]; now?: () => number; agent?: AgentRecord | null; callTimeoutMs?: number; onMerged?: (id: string) => void } = {}) {
  const store = new QueueStore(join(root, "queue"), { log: () => {}, onChange: (i) => events.push(i) });
  const prStatus = vi.fn(o.prStatus ?? (async () => st()));
  const isAncestor = vi.fn(o.isAncestor ?? (async () => false));
  const agent = o.agent === undefined ? rec() : o.agent;
  const logs: string[] = [];
  const merged: string[] = [];
  const w = new PrWatch({
    log: (m) => logs.push(m), onMerged: o.onMerged ?? ((id) => { merged.push(id); }),
    store, agents: { load: async () => agent }, workspaceDir: "/ws",
    listRepos: o.listRepos ?? (async () => [{ name: "app-shop", slug: "example-org/app-shop", path: "/ws/app-shop" }]),
    prStatus, isAncestor, now: o.now ?? (() => 5000),
    ...(o.callTimeoutMs !== undefined ? { callTimeoutMs: o.callTimeoutMs } : {}),
  });
  return { w, store, prStatus, isAncestor, logs, merged };
}
type PrWatchDeps = ConstructorParameters<typeof PrWatch>[0];

describe("PrWatch.checkRemote", () => {
  it("MERGED withdraws with merged, closedAt and a hub event", async () => {
    const { w, store } = mk({ prStatus: async () => st({ prState: "MERGED" }) });
    const { id } = await store.add(urlItem());
    events.length = 0;
    await w.checkRemote();
    const got = (await store.get(id))!;
    expect(got).toMatchObject({ status: "withdrawn", lastError: "merged", closedAt: 5000 });
    expect(events.at(-1)).toMatchObject({ id, status: "withdrawn" });
  });
  it("CLOSED withdraws with closed", async () => {
    const { w, store } = mk({ prStatus: async () => st({ prState: "CLOSED" }) });
    const { id } = await store.add(urlItem());
    await w.checkRemote();
    expect(await store.get(id)).toMatchObject({ status: "withdrawn", lastError: "closed" });
  });
  it("OPEN updates checks and mergeable", async () => {
    const { w, store } = mk();
    const { id } = await store.add(urlItem());
    await w.checkRemote();
    const got = (await store.get(id))!;
    expect(got.status).toBe("open");
    expect(got.pr).toEqual({ url: URL1, number: 7, checks: "success", mergeable: "MERGEABLE" });
  });
  it("a snoozed item is refreshed and closed like an open one", async () => {
    const { w, store } = mk({ prStatus: async () => st({ prState: "MERGED" }) });
    const { id } = await store.add(urlItem());
    await store.withItem(id, async () => { const i = (await store.get(id))!; await store.write({ ...i, status: "snoozed", snoozedUntil: 99999 }); });
    await w.checkRemote();
    expect(await store.get(id)).toMatchObject({ status: "withdrawn", lastError: "merged" });
  });
  it("a gh error leaves the item", async () => {
    const { w, store } = mk({ prStatus: async () => { throw new Error("gh down"); } });
    const { id } = await store.add(urlItem());
    const before = await store.get(id);
    await w.checkRemote();
    expect(await store.get(id)).toEqual(before);
  });
  it("runs gh outside the item lock; a late MERGED after an answer writes nothing", async () => {
    let release!: (s: PrStatus) => void;
    const { w, store } = mk({ prStatus: () => new Promise<PrStatus>((r) => { release = r; }) });
    const { id } = await store.add(urlItem());
    const run = w.checkRemote();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // The lock is free while gh hangs: an answer commits.
    await store.withItem(id, async () => {
      const i = (await store.get(id))!;
      await store.write({ ...i, status: "answered", answer: { value: "approve", by: "user", via: "tab", at: 1 }, answerSeq: 1 });
    });
    release(st({ prState: "MERGED" }));
    await run;
    expect(await store.get(id)).toMatchObject({ status: "answered" });
    expect((await store.get(id))!.lastError).toBeUndefined();
  });
});

// Overview decision 60: the merge is the approve. The close leaves the merged notice on the
// item, and onMerged (the Deliverer's kick) is told once the item lock is free.
describe("PrWatch: a merged item owes its agent the merged line", () => {
  it("MERGED: the notice slot is pending, the snooze is ended, onMerged gets the id after the write", async () => {
    let seen: QueueItem | null = null;
    let store0!: QueueStore;
    const { w, store, merged } = mk({ prStatus: async () => st({ prState: "MERGED" }), onMerged: (id) => {
      merged.push(id);
      void store0.get(id).then((i) => { seen = i; });
    } });
    store0 = store;
    const { id } = await store.add(urlItem());
    await store.withItem(id, async () => { const i = (await store.get(id))!; await store.write({ ...i, status: "snoozed", snoozedUntil: 99999 }); });
    await w.checkRemote();
    const got = (await store.get(id))!;
    expect(got).toMatchObject({ status: "withdrawn", lastError: "merged", closedAt: 5000, delivery: { msgId: `${id}-m`, state: "pending", attempts: 0 } });
    expect(got.snoozedUntil).toBeUndefined();
    expect(got.answer).toBeUndefined();
    expect(merged).toEqual([id]);
    await vi.waitFor(() => expect(seen).toMatchObject({ status: "withdrawn" }));
  });
  it("CLOSED and OPEN: no notice, no onMerged", async () => {
    for (const prState of ["CLOSED", "OPEN"]) {
      const { w, store, merged } = mk({ prStatus: async () => st({ prState }) });
      const { id } = await store.add({ ...urlItem(), pr: { url: `${URL1}${prState.length}`, number: 7 } });
      await w.checkRemote();
      expect((await store.get(id))!.delivery).toBeUndefined();
      expect(merged).toEqual([]);
    }
  });
  it("a local branch merged into its base: the same notice and onMerged", async () => {
    const { w, store, merged } = mk({ isAncestor: async () => true });
    const { id } = await store.add(localItem(true));
    await w.checkLocal();
    expect(await store.get(id)).toMatchObject({ status: "withdrawn", lastError: "merged", delivery: { msgId: `${id}-m`, state: "pending" } });
    expect(merged).toEqual([id]);
  });
  it("an item answered while gh ran is left alone: no notice, no onMerged", async () => {
    let store0!: QueueStore;
    let id0 = "";
    const { w, store, merged } = mk({ prStatus: async () => {
      await store0.withItem(id0, async () => {
        const i = (await store0.get(id0))!;
        await store0.write({ ...i, status: "answered", answer: { value: "changes", text: "x", by: "user", via: "tab", at: 1 }, answerSeq: 1,
          delivery: { msgId: `${id0}-1`, state: "pending", attempts: 0 } });
      });
      return st({ prState: "MERGED" });
    } });
    store0 = store;
    id0 = (await store.add(urlItem())).id;
    await w.checkRemote();
    expect(await store.get(id0)).toMatchObject({ status: "answered", delivery: { msgId: `${id0}-1` } });
    expect(merged).toEqual([]);
  });
  it("an onMerged that throws is logged; the item stays closed and the run goes on", async () => {
    const { w, store, logs } = mk({ prStatus: async () => st({ prState: "MERGED" }), onMerged: () => { throw new Error("kick broke"); } });
    const a = (await store.add(urlItem())).id;
    const b = (await store.add({ ...urlItem(), pr: { url: `${URL1}1`, number: 71 } })).id;
    await w.checkRemote();
    expect((await store.get(a))!.status).toBe("withdrawn");
    expect((await store.get(b))!.status).toBe("withdrawn");
    expect(logs.filter((l) => l.includes("kick broke"))).toHaveLength(2);
  });
  it("checkNow (a merge made through the console) runs both checks at once, and again after a run in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const states = ["OPEN", "MERGED"];
    let calls = 0;
    const { w, store, isAncestor } = mk({ prStatus: async () => {
      const s = states[Math.min(calls++, 1)]!;
      if (calls === 1) await gate; // the run in flight read the state before the merge
      return st({ prState: s });
    } });
    const { id } = await store.add(urlItem());
    await store.add(localItem(true));
    const first = w.checkRemote();
    w.checkNow();
    release();
    await first;
    await vi.waitFor(async () => expect((await store.get(id))!.status).toBe("withdrawn"));
    expect(calls).toBe(2);
    expect(isAncestor).toHaveBeenCalled();
    // And it counts as the Queue tab's refresh: no third gh call right after.
    w.refreshSoon();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(2);
  });
});

describe("PrWatch.checkLocal", () => {
  it("ancestor of the base with aheadAtAdd true withdraws merged", async () => {
    const { w, store, isAncestor } = mk({ isAncestor: async () => true });
    const { id } = await store.add(localItem(true));
    await w.checkLocal();
    expect(isAncestor).toHaveBeenCalledWith("/ws/app-shop", "agent/x", "main");
    expect(await store.get(id)).toMatchObject({ status: "withdrawn", lastError: "merged", closedAt: 5000 });
  });
  it("not an ancestor leaves the item", async () => {
    const { w, store } = mk({ isAncestor: async () => false });
    const { id } = await store.add(localItem(true));
    await w.checkLocal();
    expect((await store.get(id))!.status).toBe("open");
  });
  it("aheadAtAdd false is never auto-closed", async () => {
    const { w, store, isAncestor } = mk({ isAncestor: async () => true });
    const { id } = await store.add(localItem(false));
    await w.checkLocal();
    expect((await store.get(id))!.status).toBe("open");
    expect(isAncestor).not.toHaveBeenCalled();
  });
  it("aheadAtAdd absent is never auto-closed", async () => {
    const { w, store, isAncestor } = mk({ isAncestor: async () => true });
    const { id } = await store.add(localItem());
    await w.checkLocal();
    expect((await store.get(id))!.status).toBe("open");
    expect(isAncestor).not.toHaveBeenCalled();
  });
  it("a git error leaves the item", async () => {
    const { w, store } = mk({ isAncestor: async () => { throw new Error("git broke"); } });
    const { id } = await store.add(localItem(true));
    await w.checkLocal();
    expect((await store.get(id))!.status).toBe("open");
  });
  it("a missing agent leaves the item", async () => {
    const { w, store, isAncestor } = mk({ agent: null, isAncestor: async () => true });
    const { id } = await store.add(localItem(true));
    await w.checkLocal();
    expect((await store.get(id))!.status).toBe("open");
    expect(isAncestor).not.toHaveBeenCalled();
  });
});

describe("PrWatch.refreshSoon and start", () => {
  it("refreshSoon twice within 60 s runs one check", async () => {
    let t = 1_000_000;
    const { w, store, prStatus } = mk({ now: () => t });
    await store.add(urlItem());
    w.refreshSoon(); w.refreshSoon();
    await vi.waitFor(() => expect(prStatus).toHaveBeenCalledTimes(1));
    t += 30_000; w.refreshSoon();
    await new Promise((r) => setTimeout(r, 20));
    expect(prStatus).toHaveBeenCalledTimes(1);
    t += 31_000; w.refreshSoon();
    await vi.waitFor(() => expect(prStatus).toHaveBeenCalledTimes(2));
  });
  it("start runs remote and local every 60 s, and stops", async () => {
    vi.useFakeTimers();
    const { w } = mk();
    const remote = vi.spyOn(w, "checkRemote").mockResolvedValue();
    const local = vi.spyOn(w, "checkLocal").mockResolvedValue();
    const stop = w.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(remote).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(local).toHaveBeenCalledTimes(1);
    expect(remote).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(540_000);
    expect(remote).toHaveBeenCalledTimes(10);
    expect(local).toHaveBeenCalledTimes(10);
    stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(remote).toHaveBeenCalledTimes(10);
  });
  it("the 60 s timer closes a pr item merged on github.com: one gh call per item per run", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // the store's file I/O keeps real time
    let state: PrStatus["prState"] = "OPEN";
    const { w, store, prStatus, merged } = mk({ prStatus: async () => st({ prState: state }) });
    const { id } = await store.add(urlItem());
    const runs = vi.spyOn(w, "checkRemote"); // the real method: each timer run's promise
    const stop = w.start();
    vi.advanceTimersByTime(60_000);
    expect(runs).toHaveBeenCalledTimes(1);
    await runs.mock.results[0]!.value;
    expect(prStatus).toHaveBeenCalledTimes(1);
    expect((await store.get(id))!.status).toBe("open");
    state = "MERGED";
    vi.advanceTimersByTime(60_000);
    await runs.mock.results[1]!.value;
    expect(merged).toEqual([id]);
    expect(await store.get(id)).toMatchObject({ status: "withdrawn", lastError: "merged" });
    expect(prStatus).toHaveBeenCalledTimes(2);
    // No open pr item is left: the next runs call no gh.
    vi.advanceTimersByTime(180_000);
    expect(runs).toHaveBeenCalledTimes(5);
    await Promise.all(runs.mock.results.map((r) => r.value));
    expect(prStatus).toHaveBeenCalledTimes(2);
    stop();
  });
  it("no open pr item with a PR URL: a remote run lists no repo and calls no gh", async () => {
    const listRepos = vi.fn(async () => [{ name: "app-shop", slug: "example-org/app-shop", path: "/ws/app-shop" }]);
    const { w, store, prStatus } = mk({ listRepos });
    await store.add(localItem(true)); // a local pr item has no PR URL
    const answered = await store.add(urlItem());
    await store.withItem(answered.id, async () => { await store.write({ ...(await store.get(answered.id))!, status: "withdrawn", closedAt: 1 }); });
    await w.checkRemote();
    expect(listRepos).not.toHaveBeenCalled();
    expect(prStatus).not.toHaveBeenCalled();
  });
  it("a throwing check never escapes the timer", async () => {
    vi.useFakeTimers();
    const { w } = mk();
    vi.spyOn(w, "checkLocal").mockRejectedValue(new Error("boom"));
    const stop = w.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.checkLocal).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("PrWatch hardening", () => {
  it("checkRemote is single-flight while gh hangs", async () => {
    const { w, store, prStatus } = mk({ prStatus: () => new Promise<PrStatus>(() => {}) });
    await store.add(urlItem());
    void w.checkRemote(); void w.checkRemote();
    w.refreshSoon();
    await new Promise((r) => setTimeout(r, 30));
    expect(prStatus).toHaveBeenCalledTimes(1);
  });
  it("checkLocal is single-flight while git hangs", async () => {
    const { w, store, isAncestor } = mk({ isAncestor: () => new Promise<boolean>(() => {}) });
    await store.add(localItem(true));
    void w.checkLocal(); void w.checkLocal();
    await new Promise((r) => setTimeout(r, 30));
    expect(isAncestor).toHaveBeenCalledTimes(1);
  });
  // Final fix wave, minor 2: a hung gh or git call is cut at the deadline, so the single-flight run
  // ends (logged) and the next run can start.
  it("a hung gh pr view is cut at the deadline: the run ends, the item stays, the next run starts", async () => {
    const { w, store, prStatus, logs } = mk({ prStatus: () => new Promise<PrStatus>(() => {}), callTimeoutMs: 30 });
    const { id } = await store.add(urlItem());
    await w.checkRemote();
    expect(logs.join("\n")).toMatch(/gh pr view timed out after 30 ms/);
    expect(await store.get(id)).toMatchObject({ status: "open" });
    await w.checkRemote();
    expect(prStatus).toHaveBeenCalledTimes(2);
  });
  it("a hung repo list is cut at the deadline: checkRemote settles", async () => {
    const listRepos = vi.fn(() => new Promise<never>(() => {}));
    const { w, store } = mk({ listRepos, callTimeoutMs: 30 });
    await store.add(urlItem());
    await expect(w.checkRemote()).rejects.toThrow(/listRepos timed out after 30 ms/);
    await expect(w.checkRemote()).rejects.toThrow(/timed out/);
    expect(listRepos).toHaveBeenCalledTimes(2);
  });
  it("a hung git merge-base is cut at the deadline: the run ends and the next run starts", async () => {
    const { w, store, isAncestor, logs } = mk({ isAncestor: () => new Promise<boolean>(() => {}), callTimeoutMs: 30 });
    const { id } = await store.add(localItem(true));
    await w.checkLocal();
    expect(logs.join("\n")).toMatch(/git merge-base timed out after 30 ms/);
    expect(await store.get(id)).toMatchObject({ status: "open" });
    await w.checkLocal();
    expect(isAncestor).toHaveBeenCalledTimes(2);
  });
  it("a finished run lets the next one start", async () => {
    const { w, store, prStatus } = mk();
    await store.add(urlItem());
    await w.checkRemote(); await w.checkRemote();
    expect(prStatus).toHaveBeenCalledTimes(2);
  });
  it("unchanged OPEN status writes nothing and emits no event", async () => {
    const { w, store } = mk();
    const { id } = await store.add(urlItem());
    await w.checkRemote();
    const before = await store.get(id);
    events.length = 0;
    await w.checkRemote();
    expect(events).toEqual([]);
    expect(await store.get(id)).toEqual(before);
  });
  it("one item's error lets the loop continue", async () => {
    let n = 0;
    const { w, store } = mk({ prStatus: async () => { if (n++ === 0) throw new Error("gh down"); return st({ prState: "MERGED" }); } });
    const a = await store.add(urlItem());
    const b = await store.add(prItem({ url: "https://github.com/example-org/app-shop/pull/8", number: 8 }));
    await w.checkRemote();
    const got = [await store.get(a.id), await store.get(b.id)].map((i) => i!.status).sort();
    expect(got).toEqual(["open", "withdrawn"]);
  });
  it("lists repos once per run", async () => {
    const listRepos = vi.fn(async () => [{ name: "app-shop", slug: "example-org/app-shop", path: "/ws/app-shop" }]);
    const store = new QueueStore(join(root, "queue"), { log: () => {} });
    const w = new PrWatch({ store, agents: { load: async () => rec() }, workspaceDir: "/ws", listRepos, prStatus: async () => st(), isAncestor: async () => false, log: () => {} });
    await store.add(urlItem());
    await store.add(prItem({ url: "https://github.com/example-org/app-shop/pull/8", number: 8 }));
    await w.checkRemote();
    expect(listRepos).toHaveBeenCalledTimes(1);
  });
  it("a late isAncestor after an answer writes nothing", async () => {
    let release!: (b: boolean) => void;
    const { w, store } = mk({ isAncestor: () => new Promise<boolean>((r) => { release = r; }) });
    const { id } = await store.add(localItem(true));
    const run = w.checkLocal();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await store.withItem(id, async () => {
      const i = (await store.get(id))!;
      await store.write({ ...i, status: "answered", answer: { value: "approve", by: "user", via: "tab", at: 1 }, answerSeq: 1 });
    });
    release(true);
    await run;
    expect(await store.get(id)).toMatchObject({ status: "answered" });
  });
  it("a null rejection is logged, not thrown, and a repeated error logs once", async () => {
    const { w, store, logs } = mk({ isAncestor: async () => { throw null; } });
    await store.add(localItem(true));
    await w.checkLocal(); await w.checkLocal();
    expect(logs.filter((l) => l.startsWith("[queue]"))).toHaveLength(1);
  });
});
