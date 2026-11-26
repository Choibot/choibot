import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputResult } from "../../agents/composer.js";
import { SessionStore, type AgentRecord } from "../../agents/store.js";
import { EventHub } from "../../events.js";
import { InboxError, type Surface } from "../../master/inbox.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import { Deliverer, RETENTION_MS, type DelivererDeps } from "./deliver.js";
import { sortOpen } from "./priority.js";
import { QueueStore, type NewItem } from "./store.js";
import type { Answer, QueueItem } from "./types.js";

const UNDO_MS = 600_000;
const DAY = 86_400_000;
const W = "a1";

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-deliver-scan-"));
  clock = 50 * DAY;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const choice = (agentId: string): NewItem => ({
  kind: "choice", agentId, createdBy: { agentId, kind: agentId === FLEET_MASTER_ID ? "fleet-master" : "worker" },
  repo: "app-shop", area: "app-shop", title: "Pick", body: "b", blocking: true,
  choice: { options: [{ key: "A", label: "Hand-rolled" }, { key: "B", label: "Registry-driven" }] },
});
const record = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/r", worktree: "/w", branch: "b", baseBranch: "main",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...o,
});
const OK: InputResult = { code: 200, body: { delivered: true } };

async function setup(o: {
  input?: () => Promise<InputResult>;
  exists?: (id: string, real: (id: string) => Promise<boolean>) => Promise<boolean>;
  tickMs?: number;
  queueDir?: string;
} = {}) {
  const changes: QueueItem[] = [];
  const store = new QueueStore(o.queueDir ?? join(root, "queue"), { now: () => clock, log: () => {}, onChange: (i) => changes.push(i) });
  const sessions = new SessionStore(join(root, "agents"));
  await sessions.save(record(W));
  await sessions.save(record(FLEET_MASTER_ID, { kind: "fleet-master" }));
  const inputs: { agentId: string; msgId: string; text: string }[] = [];
  const pushes: { text: string; surface: Surface | null; msgId?: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  const logs: string[] = [];
  const deps: DelivererDeps = {
    store,
    agents: {
      load: (id) => sessions.load(id),
      exists: (id) => (o.exists ? o.exists(id, (x) => sessions.exists(x)) : sessions.exists(id)),
    },
    composer: {
      inputInternal: async (agentId, m) => {
        inputs.push({ agentId, ...m });
        return o.input ? o.input() : OK;
      },
    },
    inbox: {
      pushConsole: (text, surface, opts = {}) =>
        new Promise<void>((resolve, reject) => { pushes.push({ text, surface, msgId: opts.msgId, resolve, reject }); }),
    },
    rules: { hit: async () => {} },
    hub: new EventHub(),
    now: () => clock,
    undoMs: UNDO_MS,
    log: (s) => logs.push(s),
    ...(o.tickMs !== undefined ? { tickMs: o.tickMs } : {}),
  };
  return { store, sessions, inputs, pushes, logs, changes, deliverer: new Deliverer(deps) };
}

async function patch(s: QueueStore, id: string, f: (it: QueueItem) => QueueItem): Promise<void> {
  await s.withItem(id, async () => { await s.write(f((await s.get(id))!)); });
}
const get = async (s: QueueStore, id: string) => (await s.get(id))!;
// An open item after the undo of answer B: its withdrawal line waits to go out.
const undone = (it: QueueItem): QueueItem => ({
  ...it, answerSeq: 1, history: [{ value: "B", by: "user", via: "tab", at: clock }],
  withdrawal: { msgId: `${it.id}-w1`, state: "pending", attempts: 0 },
});
const answered = (a: Partial<Answer> = {}) => (it: QueueItem): QueueItem => ({
  ...it, status: "answered", answerSeq: 1,
  answer: { value: "B", by: "user", via: "tab", at: clock, ...a },
  delivery: { msgId: `${it.id}-1`, state: "pending", attempts: 0 },
});

describe("Deliverer.tick", () => {
  it("a held slot (deliverAfter = now + 60 s) stays held at +55 s and is sent at +60 s", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice(W));
    const held = clock + 60_000;
    await patch(f.store, id, (it) => ({
      ...it, status: "auto", answerSeq: 1,
      answer: { value: "B", by: "master", via: "cli", at: clock, ruleIds: ["r_8f3k2"], confidence: 0.95 },
      delivery: { msgId: `${id}-1`, state: "held", deliverAfter: held, attempts: 0 },
    }));
    clock += 55_000;
    await f.deliverer.tick();
    expect((await get(f.store, id)).delivery?.state).toBe("held");
    expect(f.inputs).toEqual([]);
    clock += 5_000;
    await f.deliverer.tick();
    await vi.waitFor(async () => expect((await get(f.store, id)).delivery?.state).toBe("delivered"));
    expect(f.inputs).toEqual([{ agentId: W, msgId: `${id}-1`, text: `[queue ${id}] auto (rule r_8f3k2): choice: B (Registry-driven)` }]);
  });

  it("a `pending` slot is delivered by the tick; one that stays `pending` (409 starting) is retried on the next tick", async () => {
    const results: InputResult[] = [{ code: 409, body: { reason: "starting" } }, OK];
    const f = await setup({ input: async () => results.shift()! });
    const { id } = await f.store.add(choice(W));
    await patch(f.store, id, answered());
    await f.deliverer.tick();
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    await vi.waitFor(async () => expect((await get(f.store, id)).delivery?.state).toBe("pending"));
    clock += 5_000;
    await f.deliverer.tick();
    await vi.waitFor(async () => expect((await get(f.store, id)).delivery?.state).toBe("delivered"));
    expect(f.inputs).toHaveLength(2);
  });

  it("a snoozed item wakes at snoozedUntil: status `open` and a hub event (onChange)", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice(W));
    const until = clock + 3_600_000;
    await patch(f.store, id, (it) => ({ ...it, status: "snoozed", snoozedUntil: until }));
    clock = until - 1;
    await f.deliverer.tick();
    expect((await get(f.store, id)).status).toBe("snoozed");
    const seen = f.changes.length;
    clock = until;
    await f.deliverer.tick();
    const it = await get(f.store, id);
    expect(it.status).toBe("open");
    expect(it.snoozedUntil).toBeUndefined();
    expect(f.changes.slice(seen)).toEqual([expect.objectContaining({ id, status: "open" })]);
  });

  it("a delivered user answer gets closedAt only once the undo window has passed", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice(W));
    const at = clock;
    await patch(f.store, id, (it) => ({ ...answered()(it), delivery: { msgId: `${id}-1`, state: "delivered", attempts: 1, at } }));
    clock = at + UNDO_MS - 1;
    await f.deliverer.tick();
    expect((await get(f.store, id)).closedAt).toBeUndefined();
    clock = at + UNDO_MS;
    await f.deliverer.tick();
    const it = await get(f.store, id);
    expect(it.closedAt).toBe(at + UNDO_MS);
    expect(it.status).toBe("answered");
  });

  it("an answer that is not delivered never gets closedAt, however old", async () => {
    const f = await setup({ input: async () => ({ code: 409, body: { reason: "not-live" } }) });
    const { id } = await f.store.add(choice(W));
    await patch(f.store, id, (it) => ({ ...answered()(it), delivery: { msgId: `${id}-1`, state: "failed", lastError: "not-live", attempts: 1 } }));
    clock += 10 * UNDO_MS;
    await f.deliverer.tick();
    expect((await get(f.store, id)).closedAt).toBeUndefined();
  });

  it("Review Focus 1: the agent record of an open item is deleted → after one tick `withdrawn`, agent-gone, closedAt, out of sortOpen", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice(W));
    expect(sortOpen(await f.store.list(), clock).map((i) => i.id)).toEqual([id]);
    await f.sessions.delete(W);
    await f.deliverer.tick();
    const it = await get(f.store, id);
    expect(it).toMatchObject({ status: "withdrawn", lastError: "agent-gone", closedAt: clock });
    expect(sortOpen(await f.store.list(), clock)).toEqual([]);
  });

  it("a snoozed item whose agent is gone is withdrawn too", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice(W));
    await patch(f.store, id, (it) => ({ ...it, status: "snoozed", snoozedUntil: clock + 3_600_000 }));
    await f.sessions.delete(W);
    await f.deliverer.tick();
    expect(await get(f.store, id)).toMatchObject({ status: "withdrawn", lastError: "agent-gone", closedAt: clock });
  });

  it("a half-written record file (`{\"id\":`: load null, exists true) → the item stays open", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice(W));
    writeFileSync(join(root, "agents", `${W}.json`), "{\"id\":");
    expect(await f.sessions.load(W)).toBeNull();
    await f.deliverer.tick();
    const it = await get(f.store, id);
    expect(it.status).toBe("open");
    expect(it.closedAt).toBeUndefined();
  });

  it("an open item whose agent is gone: its waiting withdrawal fails agent-gone in the same write and is never sent", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice(W));
    await patch(f.store, id, (it) => ({
      ...it, answerSeq: 1, history: [{ value: "B", by: "user", via: "tab", at: clock }],
      withdrawal: { msgId: `${id}-w1`, state: "pending", attempts: 0 },
    }));
    await f.sessions.delete(W);
    await f.deliverer.tick();
    await f.deliverer.tick();
    const it = await get(f.store, id);
    expect(it).toMatchObject({ status: "withdrawn", lastError: "agent-gone" });
    expect(it.withdrawal).toMatchObject({ state: "failed", lastError: "agent-gone" });
    expect(f.inputs).toEqual([]);
  });

  it("a `failed` no-master slot goes back to `pending` once the master record exists, then is pushed", async () => {
    const f = await setup();
    await f.sessions.delete(FLEET_MASTER_ID);
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await patch(f.store, id, (it) => ({ ...answered()(it), delivery: { msgId: `${id}-1`, state: "failed", lastError: "no-master", attempts: 0 } }));
    // An answered item is not withdrawn for a missing agent; the slot stays failed.
    await f.deliverer.tick();
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "failed", lastError: "no-master" });
    expect(f.pushes).toEqual([]);
    await f.sessions.save(record(FLEET_MASTER_ID, { kind: "fleet-master" }));
    await f.deliverer.tick();
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    expect(f.pushes[0].msgId).toBe(`${id}-1`);
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "delivering", attempts: 1 });
    expect((await get(f.store, id)).delivery?.lastError).toBeUndefined();
    f.pushes[0].resolve();
    await vi.waitFor(async () => expect((await get(f.store, id)).delivery?.state).toBe("delivered"));
  });

  it("the master record is deleted while a withdrawal line is out: its timeout fails it agent-gone, and a new master never gets the stale line", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await patch(f.store, id, undone);
    await f.deliverer.tick();
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    await f.sessions.delete(FLEET_MASTER_ID);
    clock += 5_000;
    await f.deliverer.tick();
    // withdrawnGone leaves the in-flight slot to its send.
    expect(await get(f.store, id)).toMatchObject({ status: "withdrawn", lastError: "agent-gone", withdrawal: { state: "delivering" } });
    f.pushes[0].reject(new InboxError("timeout"));
    await vi.waitFor(async () => expect((await get(f.store, id)).withdrawal?.state).not.toBe("delivering"));
    expect((await get(f.store, id)).withdrawal).toMatchObject({ state: "failed", lastError: "agent-gone", attempts: 1 });
    clock += 5_000;
    await f.deliverer.tick();
    await f.sessions.save(record(FLEET_MASTER_ID, { kind: "fleet-master" }));
    clock += 5_000;
    await f.deliverer.tick();
    await f.store.withItem(id, async () => {}); // any delivery a tick started
    expect(f.pushes).toHaveLength(1);
    expect((await get(f.store, id)).withdrawal).toMatchObject({ state: "failed", lastError: "agent-gone" });
  });

  it("an agent-gone item's `failed` no-master slot stays failed once a master record exists; a user-withdrawn item's is revived and pushed", async () => {
    const f = await setup();
    const gone = (await f.store.add(choice(FLEET_MASTER_ID))).id;
    const byUser = (await f.store.add(choice(FLEET_MASTER_ID))).id;
    const noMaster = { state: "failed", lastError: "no-master", attempts: 1, at: clock - 60_000 } as const;
    await patch(f.store, gone, (it) => ({
      ...undone(it), status: "withdrawn", lastError: "agent-gone", closedAt: clock - 1_000,
      withdrawal: { msgId: `${it.id}-w1`, ...noMaster },
    }));
    // Spec §5.6, "when in doubt the rule is withdraw": the line still goes out.
    await patch(f.store, byUser, (it) => ({
      ...undone(it), status: "withdrawn", closedAt: clock - 1_000, withdrawal: { msgId: `${it.id}-w1`, ...noMaster },
    }));
    await f.deliverer.tick();
    for (const id of [gone, byUser]) await f.store.withItem(id, async () => {}); // the deliveries the tick started
    expect((await get(f.store, gone)).withdrawal).toMatchObject({ state: "failed", lastError: "no-master" });
    expect(f.pushes.map((p) => p.msgId)).toEqual([`${byUser}-w1`]);
    const w = (await get(f.store, byUser)).withdrawal!;
    expect(w).toMatchObject({ state: "delivering", attempts: 2, at: clock - 60_000 });
    expect(w.lastError).toBeUndefined();
  });

  it("does not wait on master pushes, and never pushes a slot twice while it is `delivering`", async () => {
    const f = await setup();
    const a = (await f.store.add(choice(FLEET_MASTER_ID))).id;
    const b = (await f.store.add(choice(FLEET_MASTER_ID))).id;
    await patch(f.store, a, answered());
    await patch(f.store, b, answered());
    await f.deliverer.tick(); // returns although neither push settles
    await vi.waitFor(() => expect(f.pushes).toHaveLength(2));
    clock += 5_000;
    await f.deliverer.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.pushes.map((p) => p.msgId).sort()).toEqual([`${a}-1`, `${b}-1`].sort());
    for (const p of f.pushes) p.resolve();
  });

  it("retention: an item closed 31 days ago is removed, one closed 29 days ago stays; the purge runs once an hour", async () => {
    const f = await setup();
    const old = (await f.store.add(choice(W))).id;
    const recent = (await f.store.add(choice(W))).id;
    await patch(f.store, old, (it) => ({ ...it, status: "withdrawn", lastError: "merged", closedAt: clock - 31 * DAY }));
    await patch(f.store, recent, (it) => ({ ...it, status: "withdrawn", lastError: "merged", closedAt: clock - 29 * DAY }));
    await f.deliverer.tick();
    expect(await f.store.get(old)).toBeNull();
    expect(await f.store.get(recent)).not.toBeNull();
    // Two days later the second one is past 30 days, but the purge waits for the hour.
    clock += 2 * DAY;
    const later = (await f.store.add(choice(W))).id;
    await patch(f.store, later, (it) => ({ ...it, status: "withdrawn", lastError: "merged", closedAt: clock - RETENTION_MS - 1 }));
    // The first purge ran at the first tick: 2 days ago, so this tick purges again.
    await f.deliverer.tick();
    expect(await f.store.get(recent)).toBeNull();
    expect(await f.store.get(later)).toBeNull();
    const next = (await f.store.add(choice(W))).id;
    await patch(f.store, next, (it) => ({ ...it, status: "withdrawn", lastError: "merged", closedAt: clock - RETENTION_MS - 1 }));
    clock += 3_599_999;
    await f.deliverer.tick();
    expect(await f.store.get(next)).not.toBeNull();
    clock += 1;
    await f.deliverer.tick();
    expect(await f.store.get(next)).toBeNull();
  });

  // An answer image that the user added and never sent (answerImages.ts) goes after a day.
  it("the hourly purge removes the drafts of answer images older than a day, of an open or a closed ticket; a kept image stays", async () => {
    const f = await setup();
    const open = (await f.store.add(choice(W))).id;
    const shut = (await f.store.add(choice(W))).id;
    await patch(f.store, shut, (it) => ({ ...it, status: "withdrawn", closedAt: clock - DAY }));
    const at = (n: string, t: number) => { writeFileSync(n, "x"); utimesSync(n, t / 1000, t / 1000); };
    for (const id of [open, shut]) {
      mkdirSync(join(f.store.mediaDir, id), { recursive: true });
      at(join(f.store.mediaDir, id, "d-00000000000000aa.png"), clock - DAY - 1);
      at(join(f.store.mediaDir, id, "d-00000000000000bb.png"), clock - DAY + 60_000);
      at(join(f.store.mediaDir, id, "a1-1.png"), clock - 3 * DAY);
    }
    await f.deliverer.tick();
    for (const id of [open, shut]) expect(readdirSync(join(f.store.mediaDir, id)).sort()).toEqual(["a1-1.png", "d-00000000000000bb.png"]);
  });

  it("retention: a ticket shared outside stays until the user stops sharing it", async () => {
    const f = await setup();
    const id = (await f.store.add(choice(W))).id;
    const share = { docId: "doc-a", link: "https://share.example.test/doc-a", at: 1, device: "phone", checked: true };
    await patch(f.store, id, (it) => ({ ...it, status: "withdrawn", lastError: "merged", closedAt: clock - 31 * DAY, share }));
    await f.deliverer.tick();
    expect(await f.store.get(id)).not.toBeNull();
    await patch(f.store, id, ({ share: _s, ...it }) => it as QueueItem);
    clock += 3_600_000;
    await f.deliverer.tick();
    expect(await f.store.get(id)).toBeNull();
  });

  it("an item that throws does not stop the tick for the others (logged)", async () => {
    const f = await setup({
      exists: async (id, real) => { if (id === "boom") throw new Error("EIO"); return real(id); },
    });
    const bad = (await f.store.add(choice("boom"))).id;
    clock += 1;
    const good = (await f.store.add(choice(W))).id;
    await patch(f.store, good, (it) => ({ ...it, status: "snoozed", snoozedUntil: clock }));
    await f.deliverer.tick();
    expect((await get(f.store, good)).status).toBe("open");
    expect((await get(f.store, bad)).status).toBe("open");
    expect(f.logs.some((l) => l.includes(bad) && l.includes("EIO"))).toBe(true);
  });

  it("never throws: an unreadable queue dir is logged", async () => {
    const file = join(root, "not-a-dir");
    writeFileSync(file, "x");
    const f = await setup({ queueDir: file });
    await expect(f.deliverer.tick()).resolves.toBeUndefined();
    expect(f.logs.some((l) => l.includes("[queue] scan failed"))).toBe(true);
  });
});

describe("Deliverer.start", () => {
  it("ticks on its interval, delivers ids kicked before start(), and kick() delivers at once after it; stop ends the ticks", async () => {
    // The kicked item's scan always throws, so only the kicked set (Ruling P2)
    // can deliver it.
    const f = await setup({
      tickMs: 10,
      exists: async (id, real) => { if (id === "boom") throw new Error("EIO"); return real(id); },
    });
    const { id } = await f.store.add(choice("boom"));
    await patch(f.store, id, undone);
    f.deliverer.kick(id);
    await new Promise((r) => setTimeout(r, 30));
    expect(f.inputs).toEqual([]);
    const stop = f.deliverer.start();
    await vi.waitFor(async () => expect((await get(f.store, id)).withdrawal?.state).toBe("delivered"));
    expect(f.logs.some((l) => l.includes(`[queue] scan of ${id} failed`) && l.includes("EIO"))).toBe(true);
    expect(f.inputs).toEqual([{ agentId: "boom", msgId: `${id}-w1`, text: `[queue ${id}] the earlier answer (B) is withdrawn; wait for the user` }]);
    stop();
    // After stop no tick wakes a due snooze.
    const s = (await f.store.add(choice(W))).id;
    await patch(f.store, s, (it) => ({ ...it, status: "snoozed", snoozedUntil: clock }));
    await new Promise((r) => setTimeout(r, 40));
    expect((await get(f.store, s)).status).toBe("snoozed");
    // kick after start delivers without a tick.
    const k = (await f.store.add(choice(W))).id;
    await patch(f.store, k, answered());
    f.deliverer.kick(k);
    await vi.waitFor(async () => expect((await get(f.store, k)).delivery?.state).toBe("delivered"));
  });
});
