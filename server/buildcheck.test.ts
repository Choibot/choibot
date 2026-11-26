// server/buildcheck.test.ts — the rule that turns Next's own type check and lint off, and how
// next.config.mjs uses it.
import { getHeapStatistics } from "node:v8";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_CHECK_HEAP_MB, NO_CHECK_SWITCH, buildCheckSkip, skipLine } from "./buildcheck.mjs";

// The heap limits that V8 gives (heap_size_limit, MB): a 2 GB server (1914 MB: 957 MB old space
// + 96 MB young space), a 4 GB server and this 16 GB machine.
const SERVER_2GB = 1053, SERVER_4GB = 2144, MACHINE_16GB = 4288;

describe("buildCheckSkip", () => {
  it("keeps the check on a large machine with no switch: a `pnpm build` by hand", () => {
    expect(buildCheckSkip({ env: {}, heapLimitMb: MACHINE_16GB })).toBeNull();
    expect(buildCheckSkip({ env: {}, heapLimitMb: SERVER_4GB })).toBeNull();
    expect(buildCheckSkip({ env: {}, heapLimitMb: MIN_CHECK_HEAP_MB })).toBeNull();
  });

  it("turns it off for a deploy build, as before (the runner ran tsc --noEmit)", () => {
    expect(buildCheckSkip({ env: { CHOIBOT_DEPLOY_BUILD: "1" }, heapLimitMb: MACHINE_16GB })?.rule).toBe("deploy");
  });

  it("turns it off with the switch of an install's build", () => {
    expect(buildCheckSkip({ env: { [NO_CHECK_SWITCH]: "1" }, heapLimitMb: MACHINE_16GB })?.rule).toBe("switch");
  });

  it("turns it off when the heap limit is below 2 GB, with no switch: the first update from older code", () => {
    const skip = buildCheckSkip({ env: {}, heapLimitMb: SERVER_2GB });
    expect(skip?.rule).toBe("heap");
    expect(skip?.why).toContain("1053 MB, below 2048 MB");
    expect(buildCheckSkip({ env: {}, heapLimitMb: MIN_CHECK_HEAP_MB - 1 })?.rule).toBe("heap");
  });

  it("names the first rule when more than one is true", () => {
    const all = { CHOIBOT_DEPLOY_BUILD: "1", [NO_CHECK_SWITCH]: "1" };
    expect(buildCheckSkip({ env: all, heapLimitMb: SERVER_2GB })?.rule).toBe("deploy");
    expect(buildCheckSkip({ env: { [NO_CHECK_SWITCH]: "1" }, heapLimitMb: SERVER_2GB })?.rule).toBe("switch");
    expect(buildCheckSkip({ env: { CHOIBOT_DEPLOY_BUILD: "1" }, heapLimitMb: SERVER_2GB })?.rule).toBe("deploy");
  });

  it("does nothing for a switch with another value than \"1\"", () => {
    for (const value of ["", "0", "true", "yes", " 1", "1 "]) {
      expect(buildCheckSkip({ env: { [NO_CHECK_SWITCH]: value }, heapLimitMb: MACHINE_16GB })).toBeNull();
      expect(buildCheckSkip({ env: { CHOIBOT_DEPLOY_BUILD: value }, heapLimitMb: MACHINE_16GB })).toBeNull();
    }
  });

  it("gives one line that says the skip is on purpose and names the rule", () => {
    const line = skipLine(buildCheckSkip({ env: {}, heapLimitMb: SERVER_2GB })!);
    expect(line).toMatch(/^ {3}○ Next's type check and lint are off on purpose \(rule "heap"\): /);
    expect(line.split("\n")).toHaveLength(1);
    expect(skipLine(buildCheckSkip({ env: { [NO_CHECK_SWITCH]: "1" }, heapLimitMb: MACHINE_16GB })!)).toContain(`rule "switch"): ${NO_CHECK_SWITCH}=1`);
  });
});

describe("next.config.mjs", () => {
  const KEYS = ["CHOIBOT_DEPLOY_BUILD", NO_CHECK_SWITCH, "IS_NEXT_WORKER"] as const;
  let saved: Record<string, string | undefined>;
  let lines: string[];
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    lines = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { lines.push(String(s)); });
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  // The config reads the env when it loads: a new copy of the module for each case.
  const load = async (env: Partial<Record<(typeof KEYS)[number], string>>) => {
    Object.assign(process.env, env);
    return (await import("../next.config.mjs")).default as (phase: string) => { typescript: { ignoreBuildErrors: boolean }; eslint: { ignoreDuringBuilds: boolean }; distDir: string };
  };
  const BUILD = "phase-production-build";

  it("turns the type check and the lint off together with the switch, and says it once", async () => {
    const config = (await load({ [NO_CHECK_SWITCH]: "1" }))(BUILD);
    expect(config.typescript.ignoreBuildErrors).toBe(true);
    expect(config.eslint.ignoreDuringBuilds).toBe(true);
    expect(config.distDir).toBe(".next");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`rule "switch"`);
  });

  it("keeps the deploy build as before: .next-build, no type check", async () => {
    const config = (await load({ CHOIBOT_DEPLOY_BUILD: "1" }))(BUILD);
    expect(config.distDir).toBe(".next-build");
    expect(config.typescript.ignoreBuildErrors).toBe(true);
    expect(lines[0]).toContain(`rule "deploy"`);
  });

  it("with no switch, follows the heap limit of this process (on this 16 GB machine: the check runs)", async () => {
    const small = getHeapStatistics().heap_size_limit / 2 ** 20 < MIN_CHECK_HEAP_MB;
    const config = (await load({}))(BUILD);
    expect(config.typescript.ignoreBuildErrors).toBe(small);
    expect(config.eslint.ignoreDuringBuilds).toBe(small);
    expect(lines).toHaveLength(small ? 1 : 0);
  });

  it("says nothing in a worker of the build or at the start of the server", async () => {
    const config = await load({ [NO_CHECK_SWITCH]: "1" });
    config("phase-production-server");
    expect(lines).toEqual([]);
    process.env.IS_NEXT_WORKER = "true";
    expect(config(BUILD).typescript.ignoreBuildErrors).toBe(true);
    expect(lines).toEqual([]);
  });
});
