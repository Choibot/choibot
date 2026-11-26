// server/chief/relaunch.deliver.test.ts — the Deliverer and the chief
// relaunch share one agent without a deadlock (spec §5.2, §5.4 lock order:
// item lock → typing lock; afterRelaunch runs after the typing lock is free).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerGate } from "../agents/composer.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import { EventHub } from "../events.js";
import { Deliverer } from "./queue/deliver.js";
import { QueueStore } from "./queue/store.js";
import type { QueueItem } from "./queue/types.js";
import { relaunchForChief, type ChiefRelaunchCtx } from "./relaunch.js";

// The TerminalManager surface relaunchForChief and the ComposerGate touch.
// `live` = a tracked Term, `sessions` = a dtach socket, `ready` = bracketed
// paste on. kill() ends all three.
class FakeTerms {
  live = new Set<string>();
  sessions = new Set<string>();
  ready = new Set<string>();
  writes: string[] = [];
  has(id: string) { return this.live.has(id); }
  async hasSession(id: string) { return this.sessions.has(id); }
  async reattach(id: string) { if (!this.sessions.has(id)) return null; this.live.add(id); return {}; }
  write(_id: string, d: string) { this.writes.push(d); }
  inputReady(id: string) { return this.live.has(id) && this.ready.has(id); }
  lastInputAt() { return undefined; }
  lastOutputAt() { return undefined; }
  kill(id: string) { this.live.delete(id); this.sessions.delete(id); this.ready.delete(id); }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const W = "w1";
const worker: AgentRecord = {
  id: W, label: "W", repo: "r", worktree: "/ws/r/.agent-worktrees/w1", branch: "b", baseBranch: "main",
  sessionId: "s1", hookToken: "tok-w1", status: "idle", createdAt: 1,
};

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

describe("Deliverer × relaunchForChief", () => {
  it("no deadlock: a paste waiting on the relaunch's typing lock answers 409 starting → pending; afterRelaunch → retryAgent frees a not-live slot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chief-relaunch-deliver-"));
    dirs.push(dir);
    const sessions = new SessionStore(join(dir, "agents"));
    await sessions.save(worker);
    const terms = new FakeTerms();
    terms.live.add(W); terms.sessions.add(W); terms.ready.add(W);
    const gate = new ComposerGate({
      terminals: terms as unknown as ConstructorParameters<typeof ComposerGate>[0]["terminals"],
      agentExists: async (id) => (await sessions.load(id)) !== null,
      sleep: async () => {},
    });
    const queue = new QueueStore(join(dir, "queue"), { log: () => {} });
    const deliverer = new Deliverer({
      store: queue, agents: sessions, composer: gate, rules: { hit: async () => {} }, hub: new EventHub(), undoMs: 600_000, log: () => {},
      inbox: { pushConsole: async () => { throw new Error("no master here"); } },
    });
    const answered = async (state: "pending" | "failed"): Promise<string> => {
      const { id } = await queue.add({
        kind: "question", agentId: W, createdBy: { agentId: W, kind: "worker" }, repo: "r", area: "r",
        title: "Which?", body: "", blocking: true,
      });
      await queue.withItem(id, async () => {
        const it = (await queue.get(id))!;
        await queue.write({
          ...it, status: "answered", answerSeq: 1, answer: { value: "reply", text: "the registry", by: "user", via: "tab", at: 1 },
          delivery: { msgId: `${id}-1`, state, attempts: state === "failed" ? 1 : 0, ...(state === "failed" ? { lastError: "not-live" } : {}) },
        });
      });
      return id;
    };
    const first = await answered("pending");
    const second = await answered("failed");

    const inResume = deferred();
    const resumed = deferred();
    const retried = deferred();
    const ctx: ChiefRelaunchCtx = {
      terminals: terms as unknown as ChiefRelaunchCtx["terminals"],
      store: sessions, port: 0, workspaceDir: "/ws", hub: new EventHub(), relaunching: new Set(),
      onRelaunch: () => {}, ensureFleet: async () => "fleet-master", masterHasDraft: () => false,
      afterRelaunch: async (id) => { await deliverer.retryAgent(id); retried.resolve(); },
      waitGone: async () => true,
      canResume: async () => true,
      resume: async (rec) => {
        inResume.resolve();
        await resumed.promise;
        terms.live.add(rec.id); terms.sessions.add(rec.id); // the new PTY: bracketed paste not on yet
      },
    };

    const relaunch = relaunchForChief(W, ctx);
    await Promise.race([inResume.promise, relaunch]); // the relaunch holds the typing lock
    const delivery = deliverer.deliver(first);
    // The Deliverer now holds the item lock: `delivering` is on disk and its
    // paste waits on the typing lock.
    await vi.waitFor(async () => expect((await queue.get(first))!.delivery?.state).toBe("delivering"));
    let probed = false;
    const probe = queue.withItem(first, async () => { probed = true; });
    await pause();
    expect(probed).toBe(false);

    resumed.resolve();
    expect(await relaunch).toEqual({ outcome: "relaunched" });
    await delivery;
    await probe;
    const a: QueueItem = (await queue.get(first))!;
    expect(a.delivery).toMatchObject({ state: "pending", attempts: 1 });

    await retried.promise; // afterRelaunch ran after the typing lock was released
    await vi.waitFor(async () => expect((await queue.get(second))!.delivery).toMatchObject({ state: "pending", attempts: 2 }));
    const b = (await queue.get(second))!;
    expect(b.delivery?.lastError).toBeUndefined();
    expect(terms.writes).toEqual([]); // nothing was typed into the new TUI
  }, 2_000);
});
