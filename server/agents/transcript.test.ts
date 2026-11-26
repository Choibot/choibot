import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "./transcript.js";

// A unique-enough path per test without Date.now/Math.random (banned in some
// harnesses, fine here, but a counter keeps it deterministic).
let n = 0;
function tmpPath(): string {
  return join(tmpdir(), `choibot-transcript-test-${process.pid}-${n++}.log`);
}

describe("Transcript", () => {
  it("persists appended chunks and reads them back", () => {
    const t = new Transcript(tmpPath());
    t.append("HISTORY_A\n");
    t.append("HISTORY_B\n");
    expect(t.read()).toBe("HISTORY_A\nHISTORY_B\n");
  });

  it("a fresh Transcript over the same path reads prior history (survives 'restart')", () => {
    const path = tmpPath();
    const a = new Transcript(path);
    a.append("BEFORE_RESTART\n");
    // New instance = restarted server: same file, empty memory.
    const b = new Transcript(path);
    expect(b.read()).toBe("BEFORE_RESTART\n");
  });

  it("returns empty string when no file exists yet", () => {
    expect(new Transcript(tmpPath()).read()).toBe("");
  });

  it("keeps only the tail once it exceeds the cap", () => {
    const t = new Transcript(tmpPath(), 100);
    for (let i = 0; i < 50; i++) t.append(`line-${i}\n`); // far over 100 bytes
    const out = t.read();
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith("line-49\n")).toBe(true); // newest survives
    expect(out).not.toContain("line-0\n"); // oldest trimmed
  });

  it("remove() deletes the backing file", () => {
    const path = tmpPath();
    const t = new Transcript(path);
    t.append("x");
    expect(existsSync(path)).toBe(true);
    t.remove();
    expect(existsSync(path)).toBe(false);
  });

  it("append is a no-op for empty chunks (no stray bytes on disk)", () => {
    const path = tmpPath();
    const t = new Transcript(path);
    t.append("");
    expect(existsSync(path)).toBe(false);
    t.append("real");
    expect(readFileSync(path, "utf8")).toBe("real");
  });

  it("a failed write (e.g. disk full) never throws into the live stream", () => {
    // A path under a missing dir makes appendFileSync throw, like ENOSPC does.
    const t = new Transcript(join(tmpPath(), "missing-dir", "t.log"));
    expect(() => t.append("chunk")).not.toThrow();
  });
});
