import { describe, it, expect } from "vitest";
import { pick, isRuntimeId } from "./index.js";
import type { AgentRecord } from "../store.js";

const rec = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "a", label: "l", repo: "/r", worktree: "/w", branch: "b", baseBranch: "m",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...over,
});

describe("pick", () => {
  it("defaults to the claude runtime when none is recorded", () => {
    expect(pick(rec()).id).toBe("claude");
  });
  it("returns the claude runtime when recorded explicitly", () => {
    expect(pick(rec({ runtime: "claude" })).id).toBe("claude");
  });
  it("falls back to claude for an unknown runtime rather than throwing", () => {
    expect(pick(rec({ runtime: "bogus" as never })).id).toBe("claude");
  });
  // The runtime table is a plain object, so every Object.prototype key is
  // reachable by index. Without an own-property check `pick` hands back
  // Object.prototype.toString — truthy, so the `?? claudeRuntime` fallback never
  // fires — and the agent then dies at `.prepare is not a function` on every
  // resume and hook call.
  it.each(["toString", "constructor", "valueOf", "__proto__", "hasOwnProperty"])(
    "falls back to claude for the inherited key %s",
    (key) => {
      const runtime = pick(rec({ runtime: key as never }));
      expect(runtime.id).toBe("claude");
      expect(typeof runtime.prepare).toBe("function");
    },
  );

  it("builds claude argv through the adapter", () => {
    const args = pick(rec()).buildArgs({ systemPrompt: "S" }, { prompt: "P", settingsPath: "/s.json" });
    expect(args).toEqual([
      "--append-system-prompt", "S", "--dangerously-skip-permissions", "--settings", "/s.json", "P",
    ]);
  });
});

describe("isRuntimeId", () => {
  it("accepts the ids that have a table entry", () => {
    expect(isRuntimeId("claude")).toBe(true);
    expect(isRuntimeId("codex")).toBe(true);
  });

  // This is the guard POST /api/agents leans on, so a false positive here means
  // an orphaned worktree and an unusable record on disk.
  it.each(["toString", "constructor", "valueOf", "__proto__", "hasOwnProperty", "isPrototypeOf"])(
    "rejects the inherited key %s",
    (key) => { expect(isRuntimeId(key)).toBe(false); },
  );

  it.each([["a typo", "gpt4all"], ["blank", ""], ["a number", 123], ["null", null],
    ["undefined", undefined], ["an object", {}], ["an array", []]])(
    "rejects %s",
    (_label, v) => { expect(isRuntimeId(v)).toBe(false); },
  );
});
