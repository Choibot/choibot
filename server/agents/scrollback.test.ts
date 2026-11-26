import { describe, it, expect } from "vitest";
import { Scrollback } from "./scrollback.js";

describe("Scrollback", () => {
  it("accumulates pushed chunks into the snapshot", () => {
    const sb = new Scrollback(1024);
    sb.push("hello ");
    sb.push("world");
    expect(sb.snapshot()).toBe("hello world");
  });

  it("evicts oldest bytes once over the cap, keeping the tail", () => {
    const sb = new Scrollback(10); // 10 bytes
    sb.push("abcdefgh");  // 8
    sb.push("ijkl");      // +4 = 12 → drop 2 from front
    const snap = sb.snapshot();
    expect(snap.length).toBeLessThanOrEqual(10);
    expect(snap.endsWith("ijkl")).toBe(true);
    expect(snap).toBe("cdefghijkl");
  });

  it("handles a single chunk larger than the cap by keeping the tail", () => {
    const sb = new Scrollback(4);
    sb.push("abcdefg");
    expect(sb.snapshot()).toBe("defg");
  });

  it("reports byteLength", () => {
    const sb = new Scrollback(100);
    sb.push("abc");
    expect(sb.byteLength).toBe(3);
  });

  it("returns the output after an offset, while the ring still holds it", () => {
    const b = new Scrollback(5);
    b.push("abc");
    expect(b.end).toBe(3);
    expect(b.since(1)).toBe("bc");
    expect(b.since(3)).toBe("");
    b.push("defg"); // ring keeps "cdefg", offsets 2..7
    expect(b.end).toBe(7);
    expect(b.since(2)).toBe("cdefg");
    expect(b.since(6)).toBe("g");
    expect(b.since(1)).toBeNull(); // trimmed away
    expect(b.since(8)).toBeNull(); // past the end: not this stream
    expect(b.since(1.5)).toBeNull();
  });
});
