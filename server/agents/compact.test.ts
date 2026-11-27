import { describe, expect, it } from "vitest";
import { COMPACT_WINDOW_KEY, compactSettings, compactWindow } from "./compact.js";

const env = (v?: string) => (v === undefined ? {} : { [COMPACT_WINDOW_KEY]: v });

describe("compactWindow (AGENT_COMPACT_WINDOW)", () => {
  it("unset: 200000 for a worker or an issue agent, 300000 for a lead, the fleet master and the Coordinator", () => {
    for (const k of [undefined, "worker", "issue"]) expect(compactWindow(k, env())).toBe(200_000);
    for (const k of ["lead", "fleet-master", "coordinator"]) expect(compactWindow(k, env())).toBe(300_000);
  });
  it("a number is one window for every kind; never below Claude's minimum 100000", () => {
    expect(compactWindow("lead", env("250000"))).toBe(250_000);
    expect(compactWindow("worker", env("250000"))).toBe(250_000);
    expect(compactWindow("worker", env(" 150k "))).toBe(150_000);
    expect(compactWindow("worker", env("50000"))).toBe(100_000);
  });
  it("off: Claude's own point; a value that is not a number: the default of the kind", () => {
    expect(compactWindow("worker", env("OFF"))).toBeNull();
    for (const v of ["", "abc", "-5", "1.5e5x", "0"]) expect(compactWindow("lead", env(v))).toBe(300_000);
  });
  it("compactSettings: the env of the settings file, none when off", () => {
    expect(compactSettings("worker", env())).toEqual({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" } });
    expect(compactSettings("worker", env("off"))).toEqual({});
  });
});
