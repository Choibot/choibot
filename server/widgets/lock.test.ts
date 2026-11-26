// server/widgets/lock.test.ts — tests for the per-key async mutex.
import { describe, it, expect } from "vitest";
import { KeyedLock } from "./lock.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("KeyedLock", () => {
  it("runs one task per key at a time, in call order", async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const task = (name: string, ms: number) => lock.run("k", async () => {
      log.push(`${name}:start`); await sleep(ms); log.push(`${name}:end`);
    });
    await Promise.all([task("a", 30), task("b", 1)]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });
  it("does not block other keys", async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    await Promise.all([
      lock.run("k1", async () => { await sleep(30); log.push("k1"); }),
      lock.run("k2", async () => { log.push("k2"); }),
    ]);
    expect(log).toEqual(["k2", "k1"]);
  });
  it("releases the key when a task throws, and returns values", async () => {
    const lock = new KeyedLock();
    await expect(lock.run("k", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await lock.run("k", async () => 1)).toBe(1);
  });
});
