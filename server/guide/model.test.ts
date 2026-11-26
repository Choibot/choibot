// server/guide/model.test.ts — the child of the guide: it starts with no tool, with an env
// allowlist and in an empty folder, and a failure is a kind, never a throw.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISTILL_ARGV, type ClaudeRun } from "../chief/brain/distill.js";
import { classifyFailure, GUIDE_ARGV, guideArgs, limitUntil, makeGuideModel, readAnswer } from "./model.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "guide-model-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ok = (text: string) => ({ code: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: text }), stderr: "" });

describe("the argv of the guide (rule 2: no free shell, no free file access)", () => {
  it("takes away every tool, every settings file and every MCP server", () => {
    const args = guideArgs("SYSTEM");
    const at = args.indexOf("--tools");
    expect(args[at + 1]).toBe("");
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("-p");
    expect(args.slice(-2)).toEqual(["--system-prompt", "SYSTEM"]);
  });

  it("has no flag that gives a tool, a config or a permission back", () => {
    const args = guideArgs("SYSTEM");
    for (const flag of ["--dangerously-skip-permissions", "--mcp-config", "--allowedTools", "--allowed-tools", "--add-dir", "--settings",
      "--permission-mode", "--plugin-dir", "--resume", "--continue", "--append-system-prompt"]) expect(args, flag).not.toContain(flag);
  });

  it("is the child of the brain distiller, plus the model's own prompt", () => {
    // The distiller's flags are the ones a self-test proves at each start of the console.
    expect([...GUIDE_ARGV]).toEqual([...DISTILL_ARGV]);
  });
});

describe("makeGuideModel", () => {
  it("runs in an empty folder made new, with an env allowlist, and the input on stdin", async () => {
    const runDir = join(dir, "run");
    const seen: { args: string[]; stdin: string; cwd: string; env: Record<string, string>; left: boolean }[] = [];
    const run: ClaudeRun = async (args, o) => { seen.push({ args, ...o, left: existsSync(join(o.cwd, "CLAUDE.md")) }); writeFileSync(join(o.cwd, "CLAUDE.md"), "planted"); return ok("Hello."); };
    const model = makeGuideModel({ run, runDir, log: () => {},
      env: { PATH: "/usr/bin", HOME: dir, TELEGRAM_BOT_TOKEN: "t", ANTHROPIC_API_KEY: "k", GH_TOKEN: "g", SESSION_SECRET: "s" } });
    expect(await model({ system: "S", input: "IN" })).toEqual({ ok: true, text: "Hello." });
    expect(await model({ system: "S", input: "IN2" })).toEqual({ ok: true, text: "Hello." });
    expect(seen[0].stdin).toBe("IN");
    expect(seen[0].cwd).toBe(runDir);
    expect(seen[0].args).toEqual(guideArgs("S"));
    expect(seen[0].env).toEqual({ PATH: "/usr/bin", HOME: dir });
    // What the first call left in the folder is gone before the second one.
    expect(seen[1].left).toBe(false);
  });

  it("gives a kind for each failure and never throws", async () => {
    const logs: string[] = [];
    const model = (run: ClaudeRun) => makeGuideModel({ run, runDir: join(dir, "run"), env: {}, log: (s) => logs.push(s) })({ system: "S", input: "IN" });
    expect(await model(async () => { throw Object.assign(new Error("spawn /x/claude ENOENT"), { code: "ENOENT" }); })).toEqual({ ok: false, why: "down" });
    expect(await model(async () => { throw new Error("timed out after 90 s"); })).toEqual({ ok: false, why: "down" });
    expect(await model(async () => ({ code: 1, stdout: JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }), stderr: "" }))).toEqual({ ok: false, why: "login" });
    expect(await model(async () => ({ code: 1, stdout: JSON.stringify({ type: "result", is_error: true, result: "You've hit your session limit · resets 3pm" }), stderr: "" }))).toEqual({ ok: false, why: "limit" });
    expect(await model(async () => ({ code: 1, stdout: "", stderr: "error: unknown option '--restricted'" }))).toEqual({ ok: false, why: "down" });
    expect(await model(async () => ok("   "))).toEqual({ ok: false, why: "down" });
    // The log has fixed words: no path, no line of the program.
    expect(logs.join("\n")).not.toMatch(/\/x\/claude|unknown option|Please run/);
  });
});

describe("readAnswer and classifyFailure", () => {
  it("takes the text of a good envelope only", () => {
    expect(readAnswer(ok("Hi"), 0)).toEqual({ ok: true, text: "Hi" });
    expect(readAnswer({ code: 0, stdout: "not json", stderr: "" }, 0)).toEqual({ ok: false, why: "down" });
    expect(readAnswer({ code: 0, stdout: JSON.stringify({ type: "result", is_error: true, result: "API Error: 529 overloaded" }), stderr: "" }, 0)).toEqual({ ok: false, why: "down" });
    expect(readAnswer({ code: null, stdout: "", stderr: "" }, 0)).toEqual({ ok: false, why: "down" });
  });

  it("reads the time a plan comes back, when the answer has it", () => {
    expect(classifyFailure("Claude AI usage limit reached|1900000000", 1_000)).toEqual({ why: "limit", until: 1_900_000_000_000 });
    expect(classifyFailure("Claude AI usage limit reached|1000000000", 1_900_000_000_000)).toEqual({ why: "limit" });
    expect(classifyFailure("Invalid API key · Please run /login", 0)).toEqual({ why: "login" });
    expect(classifyFailure("API Error: 500", 0)).toEqual({ why: "down" });
  });

  it("limitUntil: the soonest reset of a full window", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(limitUntil({ ok: true, windows: [{ percent: 100, resetsAt: iso(9_000_000) }, { percent: 100, resetsAt: iso(5_000_000) }, { percent: 40, resetsAt: iso(2_000_000) }] }, 1_000_000)).toBe(5_000_000);
    expect(limitUntil({ ok: true, windows: [{ percent: 99, resetsAt: iso(5_000_000) }] }, 1_000_000)).toBeNull();
    expect(limitUntil({ ok: false }, 0)).toBeNull();
  });
});
