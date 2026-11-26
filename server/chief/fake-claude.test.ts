// The `-p` mode of scripts/chief-fake-claude.sh (Task 1b-20): the isolated
// instance's distill child. The child gets only distillEnv's allowlist, so
// the fake takes its knobs from <its dir>/../fake-claude.env, the file that
// scripts/chief-instance.sh writes next to <root>/bin/claude; env vars are
// the fallback.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISTILL_ARGV, distillEnv, makeClaudeRun, SELF_TEST_PROMPT, selfTestPasses, unwrapResult } from "./brain/distill.js";

const SCRIPT = join(__dirname, "..", "..", "scripts", "chief-fake-claude.sh");
const BASE_ENV: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" };

let root: string;
let bin: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-fake-p-"));
  mkdirSync(join(root, "bin"));
  bin = join(root, "bin", "claude");
  copyFileSync(SCRIPT, bin);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const conf = (lines: string[]) => writeFileSync(join(root, "fake-claude.env"), lines.map((l) => `${l}\n`).join(""));
const fake = (stdin: string, env: Record<string, string> = {}, args = [...DISTILL_ARGV]) =>
  spawnSync("bash", [bin, ...args], { input: stdin, env: { ...BASE_ENV, ...env } as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });

describe("chief-fake-claude.sh -p", () => {
  it("answers the self-test with NONE when no knob is set", () => {
    conf([]);
    const r = fake(SELF_TEST_PROMPT);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ type: "result", result: "NONE" });
    expect(selfTestPasses(unwrapResult(r.stdout))).toBe(true);
  });

  it("answers the self-test with CHIEF_FAKE_SELFTEST from the file", () => {
    conf(["CHIEF_FAKE_SELFTEST=Bash"]);
    const r = fake(SELF_TEST_PROMPT);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ type: "result", result: "Bash" });
    expect(selfTestPasses(unwrapResult(r.stdout))).toBe(false);
  });

  it("answers any other prompt with the CHIEF_FAKE_DISTILL file as a JSON string", () => {
    const out = join(root, "distill.json");
    const text = '{"brain": "# Brain (2026-11-09)\\n\\n## Workers only\\n- Always run the tests. [r_1]", "retire": []}\n"quotes" \\ é\n';
    writeFileSync(out, text);
    conf([`CHIEF_FAKE_DISTILL=${out}`]);
    const r = fake("You maintain the user's preferences …\n\n{}");
    expect(r.status).toBe(0);
    const e = JSON.parse(r.stdout);
    expect(e).toEqual({ type: "result", result: text });
    expect(typeof e.result).toBe("string");
  });

  it("falls back to env vars when the file is missing", () => {
    const out = join(root, "d.json");
    writeFileSync(out, "{}");
    expect(JSON.parse(fake(SELF_TEST_PROMPT, { CHIEF_FAKE_SELFTEST: "Read" }).stdout).result).toBe("Read");
    expect(JSON.parse(fake("x", { CHIEF_FAKE_DISTILL: out }).stdout).result).toBe("{}");
  });

  it("the file wins over the env", () => {
    conf(["CHIEF_FAKE_SELFTEST=NONE"]);
    expect(JSON.parse(fake(SELF_TEST_PROMPT, { CHIEF_FAKE_SELFTEST: "Bash" }).stdout).result).toBe("NONE");
  });

  it("exits 1 with a stderr line when the distill file is not set or missing", () => {
    conf([]);
    const r = fake("x");
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/fake claude: CHIEF_FAKE_DISTILL/);
    conf([`CHIEF_FAKE_DISTILL=${join(root, "missing.json")}`]);
    expect(fake("x").status).toBe(1);
  });

  it("logs argv and env to CHIEF_FAKE_LOG from the file", () => {
    const log = join(root, "log");
    mkdirSync(log);
    conf([`CHIEF_FAKE_LOG=${log}`]);
    fake(SELF_TEST_PROMPT);
    fake(SELF_TEST_PROMPT);
    expect(readFileSync(join(log, "print.argv.1"), "utf8").split("\0").slice(0, -1)).toEqual([...DISTILL_ARGV]);
    expect(readFileSync(join(log, "print.argv.2"), "utf8")).toContain("--no-session-persistence");
    expect(readFileSync(join(log, "print.env.1"), "utf8")).toContain("HOME=/nonexistent");
  });

  it("ignores lines of other keys in the file", () => {
    conf(["PATH=/evil", "CHIEF_FAKE_SELFTEST=NONE", "garbage line"]);
    const r = fake(SELF_TEST_PROMPT);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).result).toBe("NONE");
  });

  it("works through makeClaudeRun with the distill env allowlist (the knobs in the env are dropped)", async () => {
    const out = join(root, "distill.json");
    writeFileSync(out, '{"brain": "# Brain (2026-11-09)"}');
    conf([`CHIEF_FAKE_DISTILL=${out}`]);
    const env = distillEnv({ ...BASE_ENV, CHIEF_FAKE_SELFTEST: "Bash", CHIEF_FAKE_DISTILL: "/nope" });
    expect(env.CHIEF_FAKE_SELFTEST).toBeUndefined();
    const run = makeClaudeRun(bin);
    const self = await run([...DISTILL_ARGV], { stdin: SELF_TEST_PROMPT, cwd: root, env, timeoutMs: 20_000 });
    expect(self.code).toBe(0);
    expect(selfTestPasses(unwrapResult(self.stdout))).toBe(true);
    const d = await run([...DISTILL_ARGV], { stdin: "inputs", cwd: root, env, timeoutMs: 20_000 });
    expect(d.code).toBe(0);
    expect(unwrapResult(d.stdout)).toBe('{"brain": "# Brain (2026-11-09)"}');
  });

  it("keeps the interactive mode: without -p it still needs CHIEF_FAKE_LOG", () => {
    conf([]);
    const r = fake("", {}, ["--settings", "/nonexistent"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/CHIEF_FAKE_LOG is not set/);
  });
});
