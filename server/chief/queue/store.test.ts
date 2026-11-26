import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sortOpen } from "./priority.js";
import type { QueueItem } from "./types.js";
import { QueueStore, type NewItem } from "./store.js";

const PR_URL = "https://github.com/example-org/app-shop/pull/3";
const pr = (o: Partial<NewItem> = {}): NewItem => ({
  kind: "pr", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "app-shop", area: "app-shop",
  title: "PR #3", body: "", blocking: false, pr: { url: PR_URL, number: 3 }, ...o,
});
const local = (repo: string, branch: string): NewItem =>
  pr({ repo, area: repo, pr: { local: { repo, branch } } });
const choice = (o: Partial<NewItem> = {}): NewItem => ({
  kind: "choice", agentId: "a2", createdBy: { agentId: "a2", kind: "worker" }, repo: "app-shop", area: "app-shop",
  title: "Pick", body: "b", blocking: true, choice: { options: [{ key: "A", label: "a" }, { key: "B", label: "b" }] }, ...o,
});

let root: string;
let qdir: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-queue-store-"));
  qdir = join(root, "queue");
  clock = 1_000_000;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const mkStore = (opts: ConstructorParameters<typeof QueueStore>[1] = {}) =>
  new QueueStore(qdir, { now: () => clock, log: () => {}, ...opts });

// Set the status of an item the way later tasks do: under its item lock.
async function setStatus(s: QueueStore, id: string, status: QueueItem["status"], extra: Partial<QueueItem> = {}) {
  await s.withItem(id, async () => {
    const it = await s.get(id);
    if (!it) throw new Error("missing");
    await s.write({ ...it, status, ...extra });
  });
}

describe("QueueStore.add", () => {
  it("makes a new open item: id q + 8 base36, answerSeq 0, empty history, file 0600", async () => {
    const s = mkStore();
    const r = await s.add(choice());
    expect(r.created).toBe(true);
    expect(r.id).toMatch(/^q[0-9a-z]{8}$/);
    const it = await s.get(r.id);
    expect(it).toMatchObject({ id: r.id, status: "open", history: [], answerSeq: 0, createdAt: clock, updatedAt: clock, title: "Pick" });
    const file = join(qdir, `${r.id}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(qdir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(it);
  });

  it("store-owned fields win over the input", async () => {
    const s = mkStore();
    const sneaky = { ...choice(), id: "qzzzzzzzz", status: "answered", answerSeq: 7, history: [{}] } as unknown as NewItem;
    const r = await s.add(sneaky);
    expect(r.id).not.toBe("qzzzzzzzz");
    expect(await s.get(r.id)).toMatchObject({ status: "open", answerSeq: 0, history: [] });
  });

  it("two concurrent adds of one PR URL (relay and agent) give one item", async () => {
    const s = mkStore();
    const [a, b] = await Promise.all([
      s.add(pr({ createdBy: { agentId: "a1", kind: "relay" } })),
      s.add(pr({ createdBy: { agentId: "a1", kind: "worker" } })),
    ]);
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(await s.list()).toHaveLength(1);
  });

  it("a snoozed item with that URL blocks a new one like an open one", async () => {
    const s = mkStore();
    const a = await s.add(pr());
    await setStatus(s, a.id, "snoozed", { snoozedUntil: clock + 60_000 });
    expect(await s.add(pr())).toEqual({ id: a.id, created: false });
    expect(await s.list()).toHaveLength(1);
  });

  it.each(["answered", "auto", "undone", "withdrawn"] as const)("an %s item with that URL does not block a new one", async (status) => {
    const s = mkStore();
    const a = await s.add(pr());
    await setStatus(s, a.id, status);
    const b = await s.add(pr());
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect(await s.list()).toHaveLength(2);
  });

  it("dedups a local pr by repo + branch", async () => {
    const s = mkStore();
    const a = await s.add(local("choibot", "agent/x"));
    expect(await s.add(local("choibot", "agent/x"))).toEqual({ id: a.id, created: false });
    expect((await s.add(local("choibot", "agent/y"))).created).toBe(true);
    expect((await s.add(local("other", "agent/x"))).created).toBe(true);
    expect((await s.add(pr())).created).toBe(true);
    expect(await s.list()).toHaveLength(4);
  });

  it("never dedups non-pr items", async () => {
    const s = mkStore();
    const a = await s.add(choice());
    const b = await s.add(choice());
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  it("draws a new id when newId returns one that is taken", async () => {
    const ids = ["qaaaaaaaa", "qaaaaaaaa", "qbbbbbbbb"];
    const s = mkStore({ newId: () => ids.shift()! });
    expect((await s.add(choice())).id).toBe("qaaaaaaaa");
    expect((await s.add(choice())).id).toBe("qbbbbbbbb");
    expect(await s.list()).toHaveLength(2);
  });

  it("emits onChange once per created item, with its file on disk; onChange can call withItem without deadlock", async () => {
    const seen: { item: QueueItem; onDisk: boolean; viaLock: Promise<QueueItem | null> }[] = [];
    const s: QueueStore = mkStore({
      onChange: (item) => {
        seen.push({
          item, onDisk: existsSync(join(qdir, `${item.id}.json`)),
          viaLock: s.withItem(item.id, () => s.get(item.id)),
        });
      },
    });
    const r = await s.add(choice());
    expect(seen).toHaveLength(1);
    expect(seen[0].item).toMatchObject({ id: r.id, status: "open", answerSeq: 0 });
    expect(seen[0].onDisk).toBe(true);
    expect(await seen[0].viaLock).toEqual(seen[0].item);
    // a dedup hit writes nothing and emits nothing
    const p = await s.add(pr());
    await s.add(pr());
    expect(seen.map((x) => x.item.id)).toEqual([r.id, p.id]);
  });

  it("a throwing onChange does not fail the add (logged)", async () => {
    const log = vi.fn();
    const s = mkStore({ onChange: () => { throw new Error("hub down"); }, log });
    const r = await s.add(choice());
    expect(r.created).toBe(true);
    expect(await s.get(r.id)).not.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("hub down"));
  });
});

describe("QueueStore item lock and writes", () => {
  it("withItem serializes two writers on one item", async () => {
    const s = mkStore();
    const { id } = await s.add(choice());
    const bump = () => s.withItem(id, async () => {
      const it = (await s.get(id))!;
      await new Promise((r) => setTimeout(r, 10));
      await s.write({ ...it, answerSeq: it.answerSeq + 1 });
    });
    await Promise.all([bump(), bump()]);
    expect((await s.get(id))!.answerSeq).toBe(2);
  });

  it("write sets updatedAt and calls onChange", async () => {
    const onChange = vi.fn();
    const s = mkStore({ onChange });
    const { id } = await s.add(choice());
    onChange.mockClear();
    clock += 5_000;
    await s.withItem(id, async () => {
      const it = (await s.get(id))!;
      await s.write({ ...it, status: "answered" });
    });
    const saved = await s.get(id);
    expect(saved).toMatchObject({ status: "answered", updatedAt: clock, createdAt: clock - 5_000 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(saved);
  });

  it("write sets updatedAt on the caller's object only after the file is written", async () => {
    const onChange = vi.fn();
    const s = mkStore({ onChange });
    const { id } = await s.add(choice());
    onChange.mockClear();
    const it = (await s.get(id))!;
    clock += 5_000;
    // a dir where the tmp file must go makes the write fail (works as any user)
    mkdirSync(join(qdir, `${id}.json.tmp-${process.pid}`));
    await expect(s.withItem(id, () => s.write(it))).rejects.toThrow();
    expect(it.updatedAt).toBe(clock - 5_000);
    expect(onChange).not.toHaveBeenCalled();
    rmSync(join(qdir, `${id}.json.tmp-${process.pid}`), { recursive: true });
    await s.withItem(id, () => s.write(it));
    expect(it.updatedAt).toBe(clock);
  });

  it("remove deletes the item file", async () => {
    const s = mkStore();
    const { id } = await s.add(choice());
    await s.withItem(id, () => s.remove(id));
    expect(await s.get(id)).toBeNull();
    expect(await s.list()).toEqual([]);
  });

  it("remove also deletes the item's media folder", async () => {
    const s = mkStore();
    const { id } = await s.add(choice());
    const other = await s.add(choice());
    for (const i of [id, other.id]) { mkdirSync(join(qdir, "media", i), { recursive: true }); writeFileSync(join(qdir, "media", i, "1.png"), "x"); }
    await s.withItem(id, () => s.remove(id));
    expect(existsSync(join(qdir, "media", id))).toBe(false);
    expect(existsSync(join(qdir, "media", other.id, "1.png"))).toBe(true);
  });

  it("add takes a pre-assigned id, and refuses one that is taken or malformed", async () => {
    const s = mkStore();
    expect(await s.add(choice(), { id: "q12345678" })).toEqual({ id: "q12345678", created: true });
    expect((await s.get("q12345678"))!.id).toBe("q12345678");
    await expect(s.add(choice(), { id: "q12345678" })).rejects.toThrow(/taken/);
    await expect(s.add(choice(), { id: "../x" })).rejects.toThrow(/bad queue item id/);
  });

  it("refuses a path-like id", async () => {
    const s = mkStore();
    expect(await s.get("../x")).toBeNull();
    const it = { ...(await s.get((await s.add(choice())).id))!, id: "../evil" };
    await expect(s.write(it)).rejects.toThrow(/bad queue item id/);
    await expect(s.remove("../evil")).rejects.toThrow(/bad queue item id/);
  });
});

describe("QueueStore.list (Review Focus 2)", () => {
  it("is empty when the dir does not exist yet", async () => {
    expect(await mkStore().list()).toEqual([]);
  });

  it("skips a torn or hand-edited file, logs it once, and returns the good items", async () => {
    const log = vi.fn();
    const s = mkStore({ log });
    const a = await s.add(choice());
    clock += 1;
    const b = await s.add(pr());
    writeFileSync(join(qdir, "qbad00000.json"), "{tor");
    writeFileSync(join(qdir, "qbad00001.json"), JSON.stringify({ id: "qbad00001", title: "hand-edited" }));
    writeFileSync(join(qdir, "qbad00002.json"), JSON.stringify({ ...(await s.get(a.id)), id: "qother000" }));
    writeFileSync(join(qdir, `${a.id}.json.tmp-123`), "{half");
    writeFileSync(join(qdir, "notes.txt"), "x");
    expect((await s.list()).map((i) => i.id)).toEqual([a.id, b.id]);
    expect(await s.list()).toHaveLength(2);
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.flat().join("\n")).toMatch(/qbad00000\.json/);
    expect(await s.get("qbad00000")).toBeNull();
    expect(await s.get("qbad00002")).toBeNull();
  });
});

describe("QueueStore shape guard (Review Focus 2)", () => {
  // Plant queue/<id>.json: a valid stored item of `kind`, with `patch` on top
  // (an undefined value drops the field).
  async function plant(s: QueueStore, id: string, kind: "pr" | "choice", patch: Record<string, unknown>) {
    const src = (await s.add(kind === "pr" ? pr({ pr: { url: `${PR_URL}0`, number: 30 } }) : choice())).id;
    const base = JSON.parse(readFileSync(join(qdir, `${src}.json`), "utf8")) as Record<string, unknown>;
    rmSync(join(qdir, `${src}.json`));
    writeFileSync(join(qdir, `${id}.json`), JSON.stringify({ ...base, id, ...patch }));
  }

  it("an open pr item with \"pr\": {} is skipped (logged) and a later pr add still works", async () => {
    const log = vi.fn();
    const s = mkStore({ log });
    await plant(s, "qbad00001", "pr", { pr: {} });
    expect(await s.list()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("qbad00001.json"));
    const r = await s.add(pr());
    expect(r.created).toBe(true);
    expect((await s.add(pr())).id).toBe(r.id);
  });

  it("a bad telegram field is skipped (logged); the good item still lists with its card id", async () => {
    const log = vi.fn();
    const s = mkStore({ log });
    const a = await s.add(choice());
    await setStatus(s, a.id, "open", { telegram: { cardMessageId: 101 } });
    await plant(s, "qbad00002", "choice", { telegram: { mediaMessageIds: 5 } });
    expect((await s.list()).map((i) => [i.id, i.telegram?.cardMessageId])).toEqual([[a.id, 101]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("qbad00002.json"));
  });

  it("a \"pr\": \"x\" file does not break list() + sortOpen", async () => {
    const s = mkStore();
    const a = await s.add(pr());
    await plant(s, "qbad00003", "pr", { pr: "x" });
    expect(sortOpen(await s.list(), clock).map((i) => i.id)).toEqual([a.id]);
  });

  it.each<[string, "pr" | "choice", Record<string, unknown>]>([
    ["pr null", "pr", { pr: null }],
    ["pr without pr", "pr", { pr: undefined }],
    ["pr url not a string", "pr", { pr: { url: 5, number: 3 } }],
    ["pr number missing", "pr", { pr: { url: PR_URL } }],
    ["local pr without branch", "pr", { pr: { local: { repo: "r" } } }],
    ["local pr null", "pr", { pr: { local: null } }],
    ["telegram null", "choice", { telegram: null }],
    ["cardMessageId a string", "choice", { telegram: { cardMessageId: "1" } }],
    ["mediaMessageIds with a string", "choice", { telegram: { mediaMessageIds: [1, "2"] } }],
    ["extraMessageIds not an array", "choice", { telegram: { extraMessageIds: 5 } }],
    ["extraMessageIds with a string", "choice", { telegram: { extraMessageIds: [1, "2"] } }],
    ["postFailed a string", "choice", { telegram: { postFailed: "yes" } }],
    ["renderHash a number", "choice", { telegram: { renderHash: 5 } }],
    ["autoMessageId a string", "choice", { telegram: { autoMessageId: "9" } }],
    ["autoCleared a string", "choice", { telegram: { autoCleared: "yes" } }],
    ["mediaFailed a string", "choice", { telegram: { mediaFailed: "yes" } }],
    ["choice without choice", "choice", { choice: undefined }],
    ["choice options not an array", "choice", { choice: { options: "x" } }],
    ["choice option key a number", "choice", { choice: { options: [{ key: 1, label: "a" }] } }],
    ["choice option null", "choice", { choice: { options: [null] } }],
    ["history with null", "choice", { history: [null] }],
    ["answer a string", "choice", { answer: "B" }],
    ["delivery null", "choice", { delivery: null }],
    ["withdrawal without msgId", "choice", { withdrawal: { state: "pending", attempts: 0 } }],
    ["recommend ruleIds not an array", "choice", { recommend: { value: "A", why: "w", ruleIds: "r", by: "m", at: 1 } }],
    ["createdBy null", "choice", { createdBy: null }],
  ])("skips an item with %s", async (_name, kind, patch) => {
    const log = vi.fn();
    const s = mkStore({ log });
    await plant(s, "qbad00004", kind, patch);
    expect(await s.list()).toEqual([]);
    expect(await s.get("qbad00004")).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("keeps an item with every optional field set as later tasks write them", async () => {
    const s = mkStore();
    const ans = { value: "B", text: "t", by: "user" as const, via: "tab" as const, at: 2, ruleIds: ["r_abcde"], confidence: 0.9 };
    const full = await s.add(choice({
      closedAt: 9, snoozedUntil: 8, lastError: "agent-gone",
      recommend: { value: "A", why: "w", ruleIds: ["r_abcde"], by: "fleet-master", at: 1 },
      answer: ans, delivery: { msgId: "q-1", state: "held", deliverAfter: 3, attempts: 1, lastError: "x", at: 4 },
      withdrawal: { msgId: "q-w1", state: "pending", attempts: 0, afterMsgId: "q-1" },
      telegram: { cardMessageId: 1, mediaMessageIds: [2, 3], extraMessageIds: [4], awaiting: "changes", postFailed: true, renderHash: "ab12", autoMessageId: 5, autoCleared: true, mediaFailed: true },
    }));
    await setStatus(s, full.id, "answered", { history: [ans], answerSeq: 1 });
    const checked = await s.add(pr({ pr: { url: PR_URL, number: 3, checks: "success", mergeable: "MERGEABLE" } }));
    const loc = await s.add(pr({ pr: { local: { repo: "choibot", branch: "agent/x", aheadAtAdd: true } } }));
    const prev = await s.add({ ...choice({ choice: undefined }), kind: "preview", preview: { images: ["a.png"], url: "https://x.dev" } });
    const q = await s.add({ ...choice({ choice: undefined }), kind: "question" });
    expect((await s.list()).map((i) => i.id).sort()).toEqual([full.id, checked.id, loc.id, prev.id, q.id].sort());
  });
});
