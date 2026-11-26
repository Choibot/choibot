import { chmodSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendJsonl, onChain, readJson, readJsonl, updateJson, writeJson } from "./files";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "chief-files-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("chief files", () => {
  it("serializes concurrent updateJson calls", async () => {
    const p = join(dir, "a.json");
    await Promise.all([
      updateJson<Record<string, number>>(p, {}, (c) => ({ ...c, a: 1 })),
      updateJson<Record<string, number>>(p, {}, (c) => ({ ...c, b: 2 })),
    ]);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ a: 1, b: 2 });
  });

  it("writes files with mode 0600", async () => {
    const p = join(dir, "sub", "m.json");
    await writeJson(p, { x: 1 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
  });

  it("readJson returns null on missing or invalid JSON", async () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{tor");
    expect(await readJson(p)).toBeNull();
    expect(await readJson(join(dir, "none.json"))).toBeNull();
  });

  it("readJsonl skips unparsable and blank lines", async () => {
    const p = join(dir, "l.jsonl");
    writeFileSync(p, '{"a":1}\n\n{"b"');
    expect(await readJsonl(p)).toEqual([{ a: 1 }]);
    expect(await readJsonl(join(dir, "none.jsonl"))).toEqual([]);
  });

  it("appendJsonl creates a missing parent dir with mode 0700", async () => {
    const p = join(dir, "brain", "x.jsonl");
    await Promise.all([appendJsonl(p, { n: 1 }), appendJsonl(p, { n: 2 })]);
    expect(statSync(join(dir, "brain")).mode & 0o777).toBe(0o700);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(await readJsonl(p)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("appendJsonl after a torn last line starts a new line, so the new line survives", async () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, '{"n":1}\n{"n":2');
    await appendJsonl(p, { n: 3 });
    expect(readFileSync(p, "utf8")).toBe('{"n":1}\n{"n":2\n{"n":3}\n');
    expect(await readJsonl(p)).toEqual([{ n: 1 }, { n: 3 }]);
  });

  it("appendJsonl adds no blank line to an empty file or after a whole line", async () => {
    const p = join(dir, "e.jsonl");
    writeFileSync(p, "");
    await appendJsonl(p, { n: 1 });
    await appendJsonl(p, { n: 2 });
    expect(readFileSync(p, "utf8")).toBe('{"n":1}\n{"n":2}\n');
  });

  it("onChain runs in call order and continues after a rejection", async () => {
    const order: number[] = [];
    const slow = onChain("k", async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); });
    const bad = onChain("k", async () => { order.push(2); throw new Error("boom"); });
    const last = onChain("k", async () => { order.push(3); return "ok"; });
    await expect(bad).rejects.toThrow("boom");
    expect(await last).toBe("ok");
    await slow;
    expect(order).toEqual([1, 2, 3]);
  });

  it.skipIf(process.getuid?.() === 0)("updateJson rejects on an unreadable file and keeps it intact", async () => {
    const p = join(dir, "dev.json");
    writeFileSync(p, JSON.stringify({ dev1: 1, dev2: 2 }));
    chmodSync(p, 0o000);
    try {
      await expect(updateJson<Record<string, number>>(p, {}, (c) => ({ ...c, dev3: 3 }))).rejects.toThrow();
    } finally {
      chmodSync(p, 0o600);
    }
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ dev1: 1, dev2: 2 });
  });
});
