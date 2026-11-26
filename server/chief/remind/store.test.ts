// server/chief/remind/store.test.ts — reminders.json: one file, atomic
// writes, one lock, the per-agent open limit.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOpenReminder, ReminderStore, type NewReminder } from "./store.js";

let dir: string;
let path: string;
let now: number;
let changes: number;
let ids: string[];
const mk = (o: { log?: (s: string) => void } = {}) => {
  let n = 0;
  return new ReminderStore(path, {
    now: () => now, onChange: () => { changes++; }, newId: () => ids[n++] ?? `r_${String(n).padStart(8, "0")}`, ...o,
  });
};
const input = (o: Partial<NewReminder> = {}): NewReminder => ({
  agentId: "a1", agentLabel: "app-shop", setBy: "a1", dueAt: 5_000_000, text: "check the canary", ...o,
});
const raw = () => JSON.parse(readFileSync(path, "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chief-remind-store-"));
  path = join(dir, "chief", "reminders.json");
  now = 1_000_000;
  changes = 0;
  ids = ["r_aaaaaaa1", "r_aaaaaaa2", "r_aaaaaaa3"];
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("ReminderStore", () => {
  it("lists nothing without a file", async () => {
    expect(await mk().list()).toEqual([]);
  });

  it("add writes an open reminder and calls onChange", async () => {
    const s = mk();
    const r = await s.add(input());
    expect(r).toEqual({ ok: true, reminder: {
      id: "r_aaaaaaa1", agentId: "a1", agentLabel: "app-shop", setBy: "a1", dueAt: 5_000_000, text: "check the canary",
      state: "open", attempts: 0, createdAt: 1_000_000, updatedAt: 1_000_000,
    } });
    expect(raw()).toEqual({ reminders: [(r as { reminder: unknown }).reminder] });
    expect(changes).toBe(1);
    // A second instance (a restart) reads the same file.
    expect(await new ReminderStore(path).list()).toEqual([(r as { reminder: unknown }).reminder]);
  });

  it("refuses more than the open limit per target; closed ones and other agents do not count", async () => {
    ids = [];
    const s = mk();
    for (let i = 0; i < 10; i++) expect((await s.add(input())).ok).toBe(true);
    expect(await s.add(input())).toEqual({ ok: false, error: "too-many" });
    expect((await s.add(input({ agentId: "a2" }))).ok).toBe(true);
    const first = (await s.list())[0];
    await s.update(first.id, (r) => ({ ...r, state: "delivered" }));
    expect((await s.add(input())).ok).toBe(true);
    expect((await s.list()).filter((r) => r.agentId === "a1" && isOpenReminder(r))).toHaveLength(10);
  });

  it("serializes concurrent adds under one lock", async () => {
    ids = [];
    const s = mk();
    const rs = await Promise.all(Array.from({ length: 12 }, () => s.add(input())));
    expect(rs.filter((r) => r.ok)).toHaveLength(10);
    expect(raw().reminders).toHaveLength(10);
  });

  it("update writes fn's result with a new updatedAt; null writes nothing", async () => {
    const s = mk();
    await s.add(input());
    now = 2_000_000;
    changes = 0;
    expect(await s.update("r_aaaaaaa1", () => null)).toBeNull();
    expect(changes).toBe(0);
    const next = await s.update("r_aaaaaaa1", (r) => ({ ...r, state: "cancelled", cancelledBy: "user" }));
    expect(next).toMatchObject({ state: "cancelled", cancelledBy: "user", updatedAt: 2_000_000 });
    expect(raw().reminders[0]).toMatchObject({ state: "cancelled", updatedAt: 2_000_000 });
    expect(changes).toBe(1);
    expect(await s.update("r_zzzzzzzz", (r) => r)).toBeNull();
  });

  it("get finds one by id and refuses a malformed id", async () => {
    const s = mk();
    await s.add(input());
    expect((await s.get("r_aaaaaaa1"))?.text).toBe("check the canary");
    expect(await s.get("../x")).toBeNull();
  });

  it("list sorts by dueAt", async () => {
    const s = mk();
    await s.add(input({ dueAt: 9 }));
    await s.add(input({ dueAt: 3 }));
    expect((await s.list()).map((r) => r.dueAt)).toEqual([3, 9]);
  });

  it("mutateAll rewrites the whole list; null writes nothing", async () => {
    const s = mk();
    await s.add(input());
    await s.add(input({ agentId: "a2" }));
    changes = 0;
    await s.mutateAll(() => null);
    expect(changes).toBe(0);
    await s.mutateAll((list) => list.filter((r) => r.agentId !== "a2"));
    expect((await s.list()).map((r) => r.agentId)).toEqual(["a1"]);
    expect(changes).toBe(1);
  });

  it("purgeHolds: \"open\" while an agent has an open or delivering reminder, else when its last one settled; none: absent", async () => {
    ids = ["r_aaaaaaa1", "r_aaaaaaa2", "r_aaaaaaa3", "r_aaaaaaa4", "r_aaaaaaa5"];
    const s = mk();
    await s.add(input({ agentId: "a1" }));
    await s.add(input({ agentId: "a2" }));
    await s.add(input({ agentId: "a2" }));
    await s.add(input({ agentId: "a3" }));
    await s.add(input({ agentId: "a4" }));
    now = 2_000_000;
    await s.update("r_aaaaaaa2", (r) => ({ ...r, state: "delivered" }));
    now = 3_000_000;
    await s.update("r_aaaaaaa3", (r) => ({ ...r, state: "cancelled" }));
    await s.update("r_aaaaaaa4", (r) => ({ ...r, state: "delivering" }));
    now = 1_500_000;
    await s.update("r_aaaaaaa5", (r) => ({ ...r, state: "failed" }));
    expect(Object.fromEntries(await s.purgeHolds())).toEqual({ a1: "open", a2: 3_000_000, a3: "open", a4: 1_500_000 });
  });

  it("skips a hand-broken entry, logs it once and keeps it on write", async () => {
    const logs: string[] = [];
    const s = mk({ log: (l) => logs.push(l) });
    await s.add(input());
    const file = raw();
    file.reminders.push({ id: "r_bbbbbbbb", agentId: 7 });
    writeFileSync(path, JSON.stringify(file));
    expect((await s.list()).map((r) => r.id)).toEqual(["r_aaaaaaa1"]);
    await s.list();
    expect(logs).toHaveLength(1);
    await s.add(input());
    expect(raw().reminders.map((r: { id: string }) => r.id)).toEqual(["r_aaaaaaa1", "r_aaaaaaa2", "r_bbbbbbbb"]);
  });

  it("never overwrites a file that is not JSON", async () => {
    const s = mk();
    await s.add(input());
    writeFileSync(path, "{torn");
    await expect(s.list()).rejects.toThrow(/reminders.json/);
    await expect(s.add(input())).rejects.toThrow(/reminders.json/);
    expect(readFileSync(path, "utf8")).toBe("{torn");
  });
});
