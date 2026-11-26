import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { foldMetrics } from "./metrics.js";
import { ClassifiedLog, DecisionLog, namedAts, startDailyCompaction, unclassifiedAts, type ClassifiedEntry,
  type DecisionLine } from "./store.js";

// A hook before every atomicWrite of the brain stores, so a test can act in
// the window between the compaction's read and its rename.
const hooks = vi.hoisted(() => ({ beforeWrite: undefined as undefined | ((path: string) => Promise<void>) }));
vi.mock("../files.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../files.js")>();
  return {
    ...m,
    atomicWrite: async (path: string, data: string) => {
      await hooks.beforeWrite?.(path);
      return m.atomicWrite(path, data);
    },
  };
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T = Date.UTC(2026, 7, 1, 12, 0, 0);

let dir: string;
let df: string;
let cf: string;
let clock: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chief-classified-"));
  df = join(dir, "brain", "decisions.jsonl");
  cf = join(dir, "brain", "classified.jsonl");
  clock = T;
  hooks.beforeWrite = undefined;
});
afterEach(() => {
  hooks.beforeWrite = undefined;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const decisions = () => new DecisionLog(df, { now: () => clock });
const classified = () => new ClassifiedLog(cf);

function fileLines<T>(f: string): T[] {
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
}

function seed(f: string, objs: unknown[]): void {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, objs.map((o) => JSON.stringify(o) + "\n").join(""));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// p, or a clear failure when it does not settle in time (a deadlock).
async function within<T>(p: Promise<T>, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("did not finish (deadlock?)")), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

const masterTabUser = { via: "master-tab", by: "user", correction: null } as const;
const QUOTE = "never offer to merge";

describe("ClassifiedLog (spec §6.5)", () => {
  it("appends entries in order and latest() keeps the last entry per at", async () => {
    const cl = classified();
    await cl.append([{ at: 1, correction: false, by: "distill", runAt: 50 }]);
    await cl.append([{ at: 1, correction: true, by: "master-chat" }, { at: 2, correction: false, by: "distill", runAt: 50 }]);
    expect(await cl.read()).toEqual([
      { at: 1, correction: false, by: "distill", runAt: 50 },
      { at: 1, correction: true, by: "master-chat" },
      { at: 2, correction: false, by: "distill", runAt: 50 },
    ]);
    const latest = await cl.latest();
    expect([...latest.keys()]).toEqual([1, 2]);
    expect(latest.get(1)).toEqual({ at: 1, correction: true, by: "master-chat" });
    expect(latest.get(2)).toEqual({ at: 2, correction: false, by: "distill", runAt: 50 });
  });

  it("read and latest skip lines that are not well-formed entries", async () => {
    mkdirSync(dirname(cf), { recursive: true });
    writeFileSync(cf, [
      JSON.stringify({ at: 1, correction: true, by: "master-chat" }),
      "null",
      JSON.stringify({ at: "2", correction: true, by: "distill" }),
      JSON.stringify({ at: 1, correction: "no", by: "distill" }),
      JSON.stringify({ at: 1, correction: false, by: "someone" }),
      JSON.stringify({ at: 1, correction: false, by: "distill", runAt: "x" }),
    ].join("\n") + "\n");
    const cl = classified();
    expect(await cl.read()).toEqual([{ at: 1, correction: true, by: "master-chat" }]);
    expect((await cl.latest()).get(1)).toEqual({ at: 1, correction: true, by: "master-chat" });
  });

  it("append refuses an entry that read would skip and writes nothing", async () => {
    const cl = classified();
    const bad = { at: 1, correction: "yes", by: "distill" } as unknown as ClassifiedEntry;
    await expect(cl.append([{ at: 2, correction: true, by: "master-chat" }, bad])).rejects.toThrow();
    expect(existsSync(cf)).toBe(false);
  });
});

describe("torn last line (crash mid-append)", () => {
  it("a ClassifiedLog append after a torn line starts a new line and survives", async () => {
    mkdirSync(dirname(cf), { recursive: true });
    writeFileSync(cf, JSON.stringify({ at: 1, correction: true, by: "master-chat" }) + '\n{"at":2,"corr');
    const cl = classified();
    await cl.append([{ at: 3, correction: false, by: "distill", runAt: 9 }]);
    expect(readFileSync(cf, "utf8").split("\n")[1]).toBe('{"at":2,"corr');
    expect(await cl.read()).toEqual([
      { at: 1, correction: true, by: "master-chat" },
      { at: 3, correction: false, by: "distill", runAt: 9 },
    ]);
  });

  it("a DecisionLog append after a torn line starts a new line and survives", async () => {
    mkdirSync(dirname(df), { recursive: true });
    writeFileSync(df, JSON.stringify({ ...masterTabUser, at: 1, text: "a" }) + '\n{"at":2,"via":"comp');
    const log = decisions();
    await log.append({ ...masterTabUser, text: "after the crash" });
    expect((await log.read()).map((l) => l.text)).toEqual(["a", "after the crash"]);
  });
});

describe("countMasterCorrection (spec §6.2 source 3)", () => {
  it("a Master-tab line quoted 10 min later gets one classified entry and no new decision line", async () => {
    const log = decisions();
    const cl = classified();
    const user = await log.append({ ...masterTabUser, text: "No, never offer to merge." });
    clock = T + 10 * MIN;
    expect(await within(log.countMasterCorrection({ quote: QUOTE, via: "master-tab" }, cl))).toEqual({ marked: 1 });
    expect(fileLines(cf)).toEqual([{ at: user.at, correction: true, by: "master-chat" }]);
    expect(fileLines(df)).toEqual([user]);
  });

  it("marks the newest matching line; a Master-topic line counts too", async () => {
    const log = decisions();
    const cl = classified();
    await log.append({ ...masterTabUser, text: "Never offer to merge!" });
    clock = T + 2 * MIN;
    const newest = await log.append({ ...masterTabUser, via: "master-telegram", text: "I said: never   OFFER to merge." });
    clock = T + 3 * MIN;
    await log.append({ ...masterTabUser, text: "something else" });
    clock = T + 10 * MIN;
    expect(await within(log.countMasterCorrection({ quote: "Never offer to merge.", via: "master-telegram" }, cl)))
      .toEqual({ marked: 1 });
    expect(fileLines(cf)).toEqual([{ at: newest.at, correction: true, by: "master-chat" }]);
    expect(fileLines(df)).toHaveLength(3);
  });

  it("with no matching line appends one master line with correction true and no refAt", async () => {
    const log = decisions();
    const cl = classified();
    const res = await within(log.countMasterCorrection({ quote: QUOTE, via: "master-tab" }, cl));
    const line: DecisionLine = { at: T, via: "master-tab", by: "master", reason: "master-chat", correction: true, text: QUOTE };
    expect(res).toEqual({ appended: line });
    expect(fileLines(df)).toEqual([line]);
    expect(fileLines(df)[0]).not.toHaveProperty("refAt");
    expect(fileLines(cf)).toEqual([]);
  });

  it("a non-matching user line 5 min earlier is named by the master line's refAt", async () => {
    const log = decisions();
    const cl = classified();
    const user = await log.append({ ...masterTabUser, via: "master-telegram", text: "stop doing that" });
    clock = T + 5 * MIN;
    const res = await within(log.countMasterCorrection(
      { quote: QUOTE, via: "master-telegram", agentId: "w1", prUrl: "https://github.com/o/r/pull/7" }, cl));
    const line: DecisionLine = { at: T + 5 * MIN, via: "master-telegram", by: "master", reason: "master-chat",
      correction: true, text: QUOTE, agentId: "w1", prUrl: "https://github.com/o/r/pull/7", refAt: user.at };
    expect(res).toEqual({ appended: line });
    expect(fileLines(df)).toEqual([user, line]);
    expect(fileLines(cf)).toEqual([]);
  });

  it("only master-tab|master-telegram user lines of the last 30 min match or are named", async () => {
    const log = decisions();
    const cl = classified();
    await log.append({ ...masterTabUser, text: "No, never offer to merge." }); // 31 min old at lookup
    clock = T + 2 * MIN;
    await log.append({ ...masterTabUser, via: "composer", text: "never offer to merge" }); // a worker line
    clock = T + 3 * MIN;
    await log.append({ via: "master-tab", by: "master", correction: null, reason: "master-chat", text: "never offer to merge" });
    clock = T + 31 * MIN;
    const res = await within(log.countMasterCorrection({ quote: QUOTE, via: "master-tab" }, cl));
    expect(res).toEqual({ appended: { at: T + 31 * MIN, via: "master-tab", by: "master", reason: "master-chat", correction: true, text: QUOTE } });
    expect(fileLines(cf)).toEqual([]);
  });

  it("a line exactly 30 min old still matches", async () => {
    const log = decisions();
    const cl = classified();
    const user = await log.append({ ...masterTabUser, text: "never offer to merge" });
    clock = T + 30 * MIN;
    expect(await within(log.countMasterCorrection({ quote: QUOTE, via: "master-tab" }, cl))).toEqual({ marked: 1 });
    expect(fileLines(cf)).toEqual([{ at: user.at, correction: true, by: "master-chat" }]);
  });

  it("a blank quote never marks a line", async () => {
    const log = decisions();
    const cl = classified();
    const user = await log.append({ ...masterTabUser, text: "anything at all" });
    clock = T + MIN;
    const res = await within(log.countMasterCorrection({ quote: "  .! ", via: "master-tab" }, cl));
    expect(res).toMatchObject({ appended: { by: "master", correction: true, refAt: user.at } });
    expect(fileLines(cf)).toEqual([]);
  });

  it("a quote holding a secret matches the redacted user line", async () => {
    const log = decisions();
    const cl = classified();
    const user = await log.append({ ...masterTabUser, text: "Never paste sk-abcdefghijklmnop in a PR." });
    expect(user.text).toBe("Never paste [redacted] in a PR.");
    clock = T + MIN;
    expect(await within(log.countMasterCorrection({ quote: "never paste sk-abcdefghijklmnop in a PR", via: "master-tab" }, cl)))
      .toEqual({ marked: 1 });
  });

  it("does not deadlock with a concurrent compact (both finish)", async () => {
    clock = T - 91 * DAY;
    const log = decisions();
    const cl = classified();
    await log.append({ ...masterTabUser, text: "old words" });
    clock = T;
    const user = await log.append({ ...masterTabUser, text: "No, never offer to merge." });
    clock = T + MIN;
    const [compacted, hit, miss] = await within(Promise.all([
      log.compact(cl, clock),
      log.countMasterCorrection({ quote: QUOTE, via: "master-tab" }, cl),
      log.countMasterCorrection({ quote: "no other wording here", via: "master-tab" }, cl),
    ]));
    expect(compacted).toEqual({ deleted: 1, cleared: 0 });
    expect(hit).toEqual({ marked: 1 });
    expect(miss).toMatchObject({ appended: { by: "master", refAt: user.at } });
    expect(fileLines<DecisionLine>(df).map((l) => l.text)).toEqual(["No, never offer to merge.", "no other wording here"]);
    expect(fileLines(cf)).toEqual([{ at: user.at, correction: true, by: "master-chat" }]);
  });
});

describe("two master corrections in one 30-min window (spec §6.2 source 3, §6.5)", () => {
  const OTHER = "always run the tests first"; // in no user line: a lookup miss

  // This week's numbers and the lines the distiller may still classify.
  async function counts(log: DecisionLog, cl: ClassifiedLog) {
    const lines = await log.read();
    const entries = await cl.read();
    const latest = new Map(entries.map((e) => [e.at, e] as const));
    const { decisions, corrections } = foldMetrics(lines, entries, { weeks: 1, now: clock }).weeks[0]!;
    return { decisions, corrections, open: unclassifiedAts(lines, latest) };
  }

  it("a single hit counts 1 (unchanged)", async () => {
    const log = decisions();
    const cl = classified();
    await log.append({ ...masterTabUser, text: "No, never offer to merge." });
    clock = T + MIN;
    expect(await within(log.countMasterCorrection({ quote: QUOTE, via: "master-tab" }, cl))).toEqual({ marked: 1 });
    expect(await counts(log, cl)).toEqual({ decisions: 1, corrections: 1, open: new Set() });
  });

  it("a single miss counts 1 and its named line stays out (unchanged)", async () => {
    const log = decisions();
    const cl = classified();
    const user = await log.append({ ...masterTabUser, text: "stop doing that" });
    clock = T + MIN;
    expect(await within(log.countMasterCorrection({ quote: OTHER, via: "master-tab" }, cl)))
      .toMatchObject({ appended: { refAt: user.at } });
    expect(await counts(log, cl)).toEqual({ decisions: 1, corrections: 1, open: new Set() });
  });

  it("(a) a hit, then a miss whose refAt names the hit line, counts 2", async () => {
    const log = decisions();
    const cl = classified();
    const user = await log.append({ ...masterTabUser, text: "No, never offer to merge." });
    clock = T + MIN;
    expect(await within(log.countMasterCorrection({ quote: QUOTE, via: "master-tab" }, cl))).toEqual({ marked: 1 });
    clock = T + 2 * MIN;
    expect(await within(log.countMasterCorrection({ quote: OTHER, via: "master-tab" }, cl)))
      .toMatchObject({ appended: { by: "master", correction: true, refAt: user.at } });
    expect(await counts(log, cl)).toEqual({ decisions: 2, corrections: 2, open: new Set() });
  });

  it("(b) a miss, then a hit on the line its refAt names, counts 2", async () => {
    const log = decisions();
    const cl = classified();
    const user = await log.append({ ...masterTabUser, text: "No, never offer to merge." });
    clock = T + MIN;
    expect(await within(log.countMasterCorrection({ quote: OTHER, via: "master-tab" }, cl)))
      .toMatchObject({ appended: { refAt: user.at } });
    clock = T + 2 * MIN;
    expect(await within(log.countMasterCorrection({ quote: QUOTE, via: "master-tab" }, cl))).toEqual({ marked: 1 });
    expect(fileLines(cf)).toEqual([{ at: user.at, correction: true, by: "master-chat" }]);
    expect(await counts(log, cl)).toEqual({ decisions: 2, corrections: 2, open: new Set() });
  });

  it("a concurrent hit and miss (no lock) count 2", async () => {
    const log = decisions();
    const cl = classified();
    await log.append({ ...masterTabUser, text: "No, never offer to merge." });
    clock = T + MIN;
    await within(Promise.all([
      log.countMasterCorrection({ quote: QUOTE, via: "master-tab" }, cl),
      log.countMasterCorrection({ quote: OTHER, via: "master-tab" }, cl),
    ]));
    expect(await counts(log, cl)).toEqual({ decisions: 2, corrections: 2, open: new Set() });
  });

  it("two misses naming the same line count 2 (unchanged)", async () => {
    const log = decisions();
    const cl = classified();
    const user = await log.append({ ...masterTabUser, text: "stop doing that" });
    clock = T + MIN;
    await within(log.countMasterCorrection({ quote: OTHER, via: "master-tab" }, cl));
    clock = T + 2 * MIN;
    expect(await within(log.countMasterCorrection({ quote: "and keep PRs small", via: "master-tab" }, cl)))
      .toMatchObject({ appended: { refAt: user.at } });
    expect(await counts(log, cl)).toEqual({ decisions: 2, corrections: 2, open: new Set() });
  });

  it("with a distill verdict in the window, each counts once and no named or marked line goes to the distiller", async () => {
    const log = decisions();
    const cl = classified();
    const early = await log.append({ ...masterTabUser, text: "ok, go ahead" });
    await cl.append([{ at: early.at, correction: false, by: "distill", runAt: T }]);
    clock = T + MIN / 2;
    const worker = await log.append({ via: "composer", by: "user", correction: null, text: "fix the lint" });
    clock = T + MIN;
    const named = await log.append({ ...masterTabUser, text: "stop doing that" });
    clock = T + 2 * MIN;
    expect(await within(log.countMasterCorrection({ quote: OTHER, via: "master-tab" }, cl)))
      .toMatchObject({ appended: { refAt: named.at } });
    clock = T + 3 * MIN;
    const hit = await log.append({ ...masterTabUser, text: "No, never offer to merge." });
    clock = T + 4 * MIN;
    expect(await within(log.countMasterCorrection({ quote: QUOTE, via: "master-tab" }, cl))).toEqual({ marked: 1 });
    clock = T + 5 * MIN;
    expect(await within(log.countMasterCorrection({ quote: "and keep PRs small", via: "master-tab" }, cl)))
      .toMatchObject({ appended: { refAt: hit.at } });
    // early: a decision; named: out; two master lines and the hit line: corrections.
    expect(await counts(log, cl)).toEqual({ decisions: 4, corrections: 3, open: new Set([worker.at]) });
  });
});

describe("namedAts", () => {
  it("holds the lines a refAt names, except a line whose latest entry is a master-chat hit", () => {
    const l = (at: number, o: Partial<DecisionLine> = {}): DecisionLine =>
      ({ at, via: "master-tab", by: "user", text: "t", correction: null, ...o });
    const m = (at: number, refAt: number): DecisionLine =>
      l(at, { by: "master", reason: "master-chat", correction: true, refAt });
    const lines = [l(1), l(2), l(3), l(4), m(11, 1), m(12, 2), m(13, 3), m(14, 1)];
    const latest = new Map<number, ClassifiedEntry>([
      [2, { at: 2, correction: true, by: "distill", runAt: 9 }],
      [3, { at: 3, correction: true, by: "master-chat" }],
    ]);
    expect(namedAts(lines, latest)).toEqual(new Set([1, 2]));
  });
});

describe("unclassifiedAts", () => {
  it("holds raw-null lines with no entry that no refAt names", () => {
    const l = (at: number, o: Partial<DecisionLine> = {}): DecisionLine =>
      ({ at, via: "composer", by: "user", text: "t", correction: null, ...o });
    const lines = [
      l(1), // unclassified
      l(2), // has an entry
      l(3, { via: "master-tab" }), // named by a refAt
      l(4, { by: "master", via: "master-tab", reason: "master-chat", correction: true, refAt: 3 }),
      l(5, { correction: false, reason: "undo-own" }),
      l(6, { correction: true, reason: "differs-from-recommend" }),
      l(7, { by: "master", via: "master-tab", reason: "master-chat" }), // a `brain decision` line
    ];
    const latest = new Map<number, ClassifiedEntry>([[2, { at: 2, correction: false, by: "distill", runAt: 9 }]]);
    expect(unclassifiedAts(lines, latest)).toEqual(new Set([1, 7]));
  });
});

describe("compact (spec §6.2 write-time rules)", () => {
  const OLD = T - 91 * DAY;
  const unclassifiedOld: DecisionLine = { at: OLD, via: "composer", by: "user", text: "old words", correction: null, agentId: "w1" };
  const queueOld: DecisionLine = {
    at: OLD + 1, via: "queue-tab", by: "user", text: "B, because tests", value: "B", correction: true,
    reason: "differs-from-recommend", itemId: "q12345678", agentId: "w1", repo: "choibot", area: "ui",
    prUrl: "https://github.com/o/r/pull/1", recommend: { value: "A", ruleIds: ["r_abcde"] },
  };
  const distilledOld: DecisionLine = { at: OLD + 2, via: "master-telegram", by: "user", text: "no, the other one", correction: null };
  const distilledEntry: ClassifiedEntry = { at: OLD + 2, correction: false, by: "distill", runAt: OLD + DAY };
  const namedOld: DecisionLine = { at: OLD + 3, via: "master-tab", by: "user", text: "stop that", correction: null };
  const masterOld: DecisionLine = { at: OLD + 4, via: "master-tab", by: "master", text: "never do X", correction: true,
    reason: "master-chat", refAt: OLD + 3 };
  const recent: DecisionLine = { at: T - 89 * DAY, via: "composer", by: "user", text: "recent words", correction: null };
  // An entry whose line is gone (no line has its `at`).
  const orphanEntry: ClassifiedEntry = { at: OLD - 5, correction: true, by: "master-chat" };

  it("at day 91 deletes unclassified old lines, clears the text of the others and drops their entries", async () => {
    seed(df, [unclassifiedOld, queueOld, distilledOld, namedOld, masterOld, recent]);
    seed(cf, [orphanEntry, distilledEntry]);
    const res = await within(decisions().compact(classified(), T));
    expect(res).toEqual({ deleted: 2, cleared: 3 });
    expect(fileLines(df)).toEqual([
      { ...queueOld, text: "" },
      { ...distilledOld, text: "" },
      { ...masterOld, text: "" },
      recent,
    ]);
    expect(fileLines(cf)).toEqual([distilledEntry]);
  });

  it("a second compaction changes nothing and counts nothing", async () => {
    seed(df, [unclassifiedOld, queueOld, recent]);
    const log = decisions();
    expect(await log.compact(classified(), T)).toEqual({ deleted: 1, cleared: 1 });
    const before = readFileSync(df, "utf8");
    expect(await log.compact(classified(), T)).toEqual({ deleted: 0, cleared: 0 });
    expect(readFileSync(df, "utf8")).toBe(before);
    expect(existsSync(cf)).toBe(false);
  });

  it("with no files writes nothing", async () => {
    expect(await decisions().compact(classified(), T)).toEqual({ deleted: 0, cleared: 0 });
    expect(existsSync(df)).toBe(false);
    expect(existsSync(cf)).toBe(false);
  });

  it("an append started during compact lands after the rewrite (both lines present)", async () => {
    seed(df, [unclassifiedOld, queueOld]);
    const log = decisions();
    const first = await log.append({ ...masterTabUser, text: "before compaction" }); // ats loaded: no chain wait left
    let during: Promise<DecisionLine> | undefined;
    hooks.beforeWrite = async (path) => {
      if (path !== df || during) return;
      during = log.append({ ...masterTabUser, text: "typed during compaction" });
      await sleep(30); // an append off the chain would write now and be lost in the rename
    };
    const res = await within(log.compact(classified(), T));
    expect(res).toEqual({ deleted: 1, cleared: 1 });
    expect(during).toBeDefined();
    const added = await within(during!);
    expect(fileLines(df)).toEqual([{ ...queueOld, text: "" }, first, added]);
  });

  it("acquires the decision-log chain before the classified chain", async () => {
    seed(df, [unclassifiedOld, distilledOld]);
    seed(cf, [distilledEntry]);
    const log = decisions();
    const cl = classified();
    const order: string[] = [];
    const spyLock = (name: string, o: { lock<T>(fn: () => Promise<T>): Promise<T> }) => {
      const orig = o.lock.bind(o);
      vi.spyOn(o, "lock").mockImplementation(<T>(fn: () => Promise<T>) => {
        order.push(`${name}:asked`);
        return orig(async () => {
          order.push(`${name}:held`);
          try {
            return await fn();
          } finally {
            order.push(`${name}:released`);
          }
        });
      });
    };
    spyLock("decisions", log);
    spyLock("classified", cl);
    await within(log.compact(cl, T));
    expect(order).toEqual([
      "decisions:asked", "decisions:held", "classified:asked", "classified:held", "classified:released", "decisions:released",
    ]);
  });
});

// The daily compaction timer (spec §6.2), at CHIEF_DISTILL_AT in host TZ.
describe("startDailyCompaction", () => {
  // Local (host TZ) 03:00, so a 03:30 slot is 30 min away.
  const LOCAL_3AM = new Date(2026, 10, 9, 3, 0, 0, 0).getTime();

  function fakeTimers() {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const setTimer = (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return { clear: () => { t.cleared = true; } };
    };
    return { timers, setTimer };
  }

  it("now at 03:00: the first compaction 30 min later, then one per day", () => {
    let now = LOCAL_3AM;
    const log = decisions();
    const cl = classified();
    const compact = vi.spyOn(log, "compact").mockResolvedValue({ deleted: 0, cleared: 0 });
    const { timers, setTimer } = fakeTimers();
    const stop = startDailyCompaction({ decisions: log, classified: cl, at: "03:30", now: () => now, setTimer });
    expect(timers.map((t) => t.ms)).toEqual([30 * MIN]);
    expect(compact).not.toHaveBeenCalled();
    now += 30 * MIN;
    timers[0]!.fn();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(cl, now);
    expect(timers.map((t) => t.ms)).toEqual([30 * MIN, DAY]);
    now += DAY;
    timers[1]!.fn();
    expect(compact).toHaveBeenCalledTimes(2);
    expect(timers.map((t) => t.ms)).toEqual([30 * MIN, DAY, DAY]);
    stop();
    expect(timers[2]!.cleared).toBe(true);
    // A fire that races the stop runs nothing and arms nothing.
    timers[2]!.fn();
    expect(compact).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(3);
  });

  it("an `at` already past today → tomorrow", () => {
    const { timers, setTimer } = fakeTimers();
    startDailyCompaction({ decisions: decisions(), classified: classified(), at: "02:15", now: () => LOCAL_3AM, setTimer })();
    expect(timers[0]!.ms).toBe(new Date(2026, 10, 10, 2, 15, 0, 0).getTime() - LOCAL_3AM);
  });

  it("a throwing or rejecting compact is logged and keeps the timer alive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = LOCAL_3AM;
    const log = decisions();
    const compact = vi.spyOn(log, "compact")
      .mockImplementationOnce(() => { throw new Error("boom"); })
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue({ deleted: 0, cleared: 0 });
    const { timers, setTimer } = fakeTimers();
    const stop = startDailyCompaction({ decisions: log, classified: classified(), at: "03:30", now: () => now, setTimer });
    now += 30 * MIN;
    expect(() => timers[0]!.fn()).not.toThrow();
    expect(warn).toHaveBeenCalledWith("[chief] compaction failed: boom");
    expect(timers).toHaveLength(2);
    now += DAY;
    expect(() => timers[1]!.fn()).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[chief] compaction failed: disk full"));
    expect(timers).toHaveLength(3);
    now += DAY;
    timers[2]!.fn();
    expect(compact).toHaveBeenCalledTimes(3);
    expect(timers).toHaveLength(4);
    stop();
  });

  it("a throwing setTimer is logged; start never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = startDailyCompaction({ decisions: decisions(), classified: classified(), at: "03:30", now: () => LOCAL_3AM,
      setTimer: () => { throw new Error("no timers"); } });
    expect(warn).toHaveBeenCalledWith("[chief] compaction timer failed: no timers");
    expect(() => stop()).not.toThrow();
  });

  it("the slot runs the real compaction: a 91-day-old unclassified line goes", async () => {
    let now = LOCAL_3AM;
    const old: DecisionLine = { at: LOCAL_3AM - 91 * DAY, via: "composer", by: "user", text: "old words", correction: null };
    const recent: DecisionLine = { at: LOCAL_3AM - DAY, via: "composer", by: "user", text: "recent words", correction: null };
    seed(df, [old, recent]);
    const { timers, setTimer } = fakeTimers();
    const stop = startDailyCompaction({ decisions: decisions(), classified: classified(), at: "03:30", now: () => now, setTimer });
    now += 30 * MIN;
    timers[0]!.fn();
    await vi.waitFor(() => expect(fileLines(df)).toEqual([recent]));
    stop();
  });
});
