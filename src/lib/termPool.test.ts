import { describe, it, expect } from "vitest";
import { TermPool, poolCap, DESKTOP_POOL_CAP, MOBILE_POOL_CAP } from "./termPool";

function fixture(cap: number) {
  const disposed: string[] = [];
  const pool = new TermPool<{ id: string; dispose(): void }>(() => cap);
  const open = (id: string) => pool.acquire(id, () => ({ id, dispose: () => disposed.push(id) }));
  const visit = (id: string) => { const e = open(id); pool.release(id); return e; };
  return { pool, open, visit, disposed };
}

describe("TermPool", () => {
  it("returns the same terminal on a second visit", () => {
    const { visit, disposed } = fixture(2);
    const first = visit("a");
    visit("b");
    expect(visit("a")).toBe(first);
    expect(disposed).toEqual([]);
  });

  it("disposes the least recently used terminal past the cap", () => {
    const { visit, pool, disposed } = fixture(2);
    visit("a"); visit("b"); visit("a"); // b is now the oldest
    visit("c");
    expect(disposed).toEqual(["b"]);
    expect(pool.size).toBe(2);
  });

  it("creates a new terminal after an eviction", () => {
    const { visit, disposed } = fixture(1);
    const first = visit("a");
    visit("b");
    expect(disposed).toEqual(["a"]);
    expect(visit("a")).not.toBe(first);
  });

  it("never disposes a terminal on screen", () => {
    const { open, visit, pool, disposed } = fixture(1);
    open("master"); // stays on screen
    visit("a"); visit("b");
    expect(disposed).toEqual(["a"]);
    pool.release("master");
    expect(disposed).toEqual(["a", "master"]);
  });

  it("keeps nothing off screen with a cap of 0", () => {
    const { open, pool, disposed } = fixture(0);
    open("a");
    expect(disposed).toEqual([]);
    pool.release("a");
    expect(disposed).toEqual(["a"]);
  });

  it("drops a deleted agent's terminal once, on or off screen", () => {
    const { open, visit, pool, disposed } = fixture(5);
    visit("a"); open("b");
    pool.drop("a"); pool.drop("b"); pool.drop("nope");
    expect(disposed).toEqual(["a", "b"]);
    expect(pool.size).toBe(0);
  });
});

describe("poolCap", () => {
  it("uses the override when it is an integer, else the default for the device", () => {
    expect(poolCap(undefined, false)).toBe(DESKTOP_POOL_CAP);
    expect(poolCap(undefined, true)).toBe(MOBILE_POOL_CAP);
    expect(poolCap("x", false)).toBe(DESKTOP_POOL_CAP);
    expect(poolCap("3", true)).toBe(3);
    expect(poolCap("-1", false)).toBe(0);
  });
});
