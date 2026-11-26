// server/widgets/history.test.ts — tests for history, status, data and agent ingest.
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory, ingestAgentData, readData, readHistory, readStatus, writeData, writeStatus } from "./history.js";

const tmp = () => mkdtemp(join(tmpdir(), "widget-hist-"));

describe("appendHistory / readHistory", () => {
  it("appends one JSON line per entry", async () => {
    const dir = await tmp();
    expect(await appendHistory(dir, { at: 1, data: { n: 1 } }, 500)).toBe(true);
    await appendHistory(dir, { at: 2, data: { n: 2 } }, 500);
    expect(await readFile(join(dir, "history.jsonl"), "utf8"))
      .toBe('{"at":1,"data":{"n":1}}\n{"at":2,"data":{"n":2}}\n');
  });
  it("keeps only the last historyMax lines", async () => {
    const dir = await tmp();
    for (let i = 0; i < 5; i++) await appendHistory(dir, { at: i, data: i }, 3);
    expect((await readHistory(dir)).map((e) => e.data)).toEqual([2, 3, 4]);
  });
  it("skips an entry whose data is over 64 KB", async () => {
    const dir = await tmp();
    expect(await appendHistory(dir, { at: 1, data: "x".repeat(70_000) }, 500)).toBe(false);
    expect(await readHistory(dir)).toEqual([]);
  });
  it("drops the oldest lines until the file is at most 2 MB", async () => {
    const dir = await tmp();
    const big = "y".repeat(60_000);
    const seed = Array.from({ length: 33 }, (_, i) => JSON.stringify({ at: i, data: big })).join("\n") + "\n";
    await writeFile(join(dir, "history.jsonl"), seed);
    await appendHistory(dir, { at: 100, data: big }, 5000);
    await appendHistory(dir, { at: 101, data: big }, 5000);
    const size = (await stat(join(dir, "history.jsonl"))).size;
    expect(size).toBeLessThanOrEqual(2 * 1024 * 1024);
    const h = await readHistory(dir);
    expect(h).toHaveLength(34);
    expect(h[0].at).toBe(1);
    expect(h[h.length - 1].at).toBe(101);
  });
  it("returns only entries after `since`, skips damaged lines, [] with no file", async () => {
    const dir = await tmp();
    expect(await readHistory(dir)).toEqual([]);
    await writeFile(join(dir, "history.jsonl"), '{"at":1,"data":1}\nnot json\n{"at":2,"data":2}\n{"at":3,"data":3}\n');
    expect(await readHistory(dir, 1)).toEqual([{ at: 2, data: 2 }, { at: 3, data: 3 }]);
    expect(await readHistory(dir)).toHaveLength(3);
  });
});

describe("status and data", () => {
  it("round-trips status.json and defaults when missing or damaged", async () => {
    const dir = await tmp();
    expect(await readStatus(dir)).toEqual({ last: null, ingestedMtime: null });
    await writeStatus(dir, { last: { at: 5, ok: false, mode: "script", error: "exit 1" }, ingestedMtime: 7 });
    expect(await readStatus(dir)).toEqual({ last: { at: 5, ok: false, mode: "script", error: "exit 1" }, ingestedMtime: 7 });
    await writeFile(join(dir, "status.json"), "{broken");
    expect(await readStatus(dir)).toEqual({ last: null, ingestedMtime: null });
  });
  it("writeData returns the new mtime; readData parses or gives null", async () => {
    const dir = await tmp();
    expect(await readData(dir)).toBeNull();
    const m = await writeData(dir, { v: 1 });
    expect(m).toBe((await stat(join(dir, "data.json"))).mtimeMs);
    expect(await readData(dir)).toEqual({ v: 1 });
    await writeFile(join(dir, "data.json"), "{x");
    expect(await readData(dir)).toBeNull();
  });
});

describe("ingestAgentData", () => {
  it("returns none without data.json", async () => {
    expect(await ingestAgentData(await tmp(), 500)).toBe("none");
  });
  it("adds a new data.json once and marks the status ok in agent mode", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "data.json"), '{"n":1}');
    expect(await ingestAgentData(dir, 500)).toBe("added");
    expect(await ingestAgentData(dir, 500)).toBe("same");
    expect((await readHistory(dir)).map((e) => e.data)).toEqual([{ n: 1 }]);
    expect((await readStatus(dir)).last).toMatchObject({ ok: true, mode: "agent" });
  });
  it("skips a half-written data.json under 2 s old, then reports it when older", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "data.json"), '{"n":');
    const m = (await stat(join(dir, "data.json"))).mtimeMs;
    expect(await ingestAgentData(dir, 500, m + 500)).toBe("skipped");
    expect((await readStatus(dir)).last).toBeNull();
    expect(await ingestAgentData(dir, 500, m + 3000)).toBe("bad");
    expect((await readStatus(dir)).last).toMatchObject({ ok: false, mode: "agent", error: "data.json is not valid JSON" });
    expect(await readHistory(dir)).toEqual([]);
    expect(await ingestAgentData(dir, 500, m + 6000)).toBe("same");
  });
  it("adds the finished write after a skipped scan exactly once", async () => {
    const dir = await tmp();
    const p = join(dir, "data.json");
    await writeFile(p, '{"n":');
    const m1 = (await stat(p)).mtimeMs;
    expect(await ingestAgentData(dir, 500, m1 + 100)).toBe("skipped");
    await writeFile(p, '{"n":2}');
    const later = new Date(m1 + 1000);
    await utimes(p, later, later);
    const m2 = (await stat(p)).mtimeMs;
    expect(await ingestAgentData(dir, 500, m2 + 100)).toBe("added");
    expect(await ingestAgentData(dir, 500, m2 + 5000)).toBe("same");
    expect((await readHistory(dir)).map((e) => e.data)).toEqual([{ n: 2 }]);
  });
  it("stamps the history entry with the data.json mtime, not the scan time", async () => {
    const dir = await tmp();
    const p = join(dir, "data.json");
    await writeFile(p, '{"n":1}');
    const t = new Date(1_700_000_000_000);
    await utimes(p, t, t);
    expect(await ingestAgentData(dir, 500, 1_800_000_000_000)).toBe("added");
    expect(await readHistory(dir)).toEqual([{ at: 1_700_000_000_000, data: { n: 1 } }]);
  });
  it("reports an oversized data.json", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "data.json"), JSON.stringify("x".repeat(300_000)));
    expect(await ingestAgentData(dir, 500)).toBe("bad");
    expect((await readStatus(dir)).last).toMatchObject({ ok: false, error: "data.json is over 256 KB" });
  });
});
