import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DISTILL_ARGV, DISTILL_ENV_ALLOW, DISTILL_TIMEOUT_MS, SELF_TEST_PROMPT,
  distillEnv, firstJsonObject, selfTestPasses, unwrapResult,
} from "./distill.js";

describe("DISTILL_ARGV", () => {
  it("is the locked-down argv", () => {
    expect(DISTILL_ARGV).toEqual(["-p", "--model", "sonnet", "--output-format", "json", "--tools", "", "--restricted", "--strict-mcp-config", "--no-session-persistence"]);
    const i = DISTILL_ARGV.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(DISTILL_ARGV[i + 1]).toBe("");
    for (const f of ["-p", "--restricted", "--strict-mcp-config", "--no-session-persistence"]) expect(DISTILL_ARGV).toContain(f);
    for (const f of ["--dangerously-skip-permissions", "--setting-sources", "--bare"]) expect(DISTILL_ARGV).not.toContain(f);
  });
  it("constants", () => {
    expect(DISTILL_TIMEOUT_MS).toBe(600_000);
    expect(SELF_TEST_PROMPT).toBe("List the tools you can call. Answer exactly NONE if there are none.");
  });
});

describe("distillEnv", () => {
  const dirs = (...d: string[]) => (p: string) => d.includes(p);
  it("never passes ANTHROPIC_API_KEY or any non-allowlisted var", () => {
    const out = distillEnv({
      PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", CHIEF_USER_AUTH: "a",
      CHOIBOT_AGENT_PASS: "p", CHOIBOT_USER_TOKEN: "u", GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "s", FOO_SECRET: "f",
    });
    expect(out).toEqual({ PATH: "/bin", HOME: "/h" });
    for (const k of ["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "CHIEF_USER_AUTH", "CHOIBOT_AGENT_PASS", "CHOIBOT_USER_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "FOO_SECRET"]) expect(out).not.toHaveProperty(k);
  });
  it("allowlist excludes the API key", () => {
    expect(DISTILL_ENV_ALLOW).not.toContain("ANTHROPIC_API_KEY");
    expect(DISTILL_ENV_ALLOW).toContain("PATH");
  });
  it("skips unset vars and returns a new object", () => {
    const env = { PATH: "/bin", LANG: undefined };
    const out = distillEnv(env);
    expect(out).toEqual({ PATH: "/bin" });
    expect(out).not.toBe(env);
  });
  it("keeps an explicit CLAUDE_CONFIG_DIR", () => {
    expect(distillEnv({ CLAUDE_CONFIG_DIR: "/x", CLAUDE_DEFAULT_ACCOUNT: "office" }, { accountsRoot: "/r", isDir: () => true }).CLAUDE_CONFIG_DIR).toBe("/x");
  });
  it("maps CLAUDE_DEFAULT_ACCOUNT only when the dir exists", () => {
    expect(distillEnv({ CLAUDE_DEFAULT_ACCOUNT: "office" }, { accountsRoot: "/r", isDir: dirs("/r/office") }).CLAUDE_CONFIG_DIR).toBe("/r/office");
    expect(distillEnv({ CLAUDE_DEFAULT_ACCOUNT: "office" }, { accountsRoot: "/r", isDir: dirs() })).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });
  it("uses CLAUDE_ACCOUNTS_DIR when no accountsRoot", () => {
    expect(distillEnv({ CLAUDE_DEFAULT_ACCOUNT: "a", CLAUDE_ACCOUNTS_DIR: "/acc" }, { isDir: dirs("/acc/a") }).CLAUDE_CONFIG_DIR).toBe("/acc/a");
  });
  it("rejects unsafe account ids", () => {
    for (const id of ["../x", "a/b", "..", ".", "", "a\\b"]) {
      expect(distillEnv({ CLAUDE_DEFAULT_ACCOUNT: id }, { accountsRoot: "/r", isDir: () => true })).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    }
  });
  it("matches resolveAccount id rules", () => {
    for (const id of ["Office", "my acct", ".x", "-x", "a".repeat(33), "default"]) {
      expect(distillEnv({ CLAUDE_DEFAULT_ACCOUNT: id }, { accountsRoot: "/r", isDir: () => true })).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    }
  });
  it("trims the account id", () => {
    expect(distillEnv({ CLAUDE_DEFAULT_ACCOUNT: " office " }, { accountsRoot: "/r", isDir: dirs("/r/office") }).CLAUDE_CONFIG_DIR).toBe("/r/office");
  });
  it("empty CLAUDE_ACCOUNTS_DIR falls back to ~/.claude-accounts", () => {
    const seen: string[] = [];
    distillEnv({ CLAUDE_DEFAULT_ACCOUNT: "a", CLAUDE_ACCOUNTS_DIR: "" }, { isDir: (p) => { seen.push(p); return false; } });
    expect(seen).toEqual([join(homedir(), ".claude-accounts", "a")]);
  });
  it("never leaks CLAUDE_DEFAULT_ACCOUNT or CLAUDE_ACCOUNTS_DIR", () => {
    const out = distillEnv({ CLAUDE_DEFAULT_ACCOUNT: "office", CLAUDE_ACCOUNTS_DIR: "/r" }, { isDir: () => true });
    expect(out).not.toHaveProperty("CLAUDE_DEFAULT_ACCOUNT");
    expect(out).not.toHaveProperty("CLAUDE_ACCOUNTS_DIR");
  });
});

describe("unwrapResult", () => {
  it("strips one json fence", () => {
    expect(unwrapResult('{"type":"result","result":"```json\\n{\\"a\\":1}\\n```"}')).toBe('{"a":1}');
  });
  it("trims a plain result", () => {
    expect(unwrapResult('{"type":"result","result":"  hi \\n"}')).toBe("hi");
  });
  it("strips a bare fence", () => {
    expect(unwrapResult('{"type":"result","result":"```\\nhello\\n```"}')).toBe("hello");
  });
  it("throws on is_error with clipped text", () => {
    const long = "x".repeat(500);
    let msg = "";
    try { unwrapResult(JSON.stringify({ type: "result", is_error: true, result: long })); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("x".repeat(200));
    expect(msg).not.toContain("x".repeat(201));
  });
  it("throws on a bad envelope", () => {
    expect(() => unwrapResult("nope")).toThrow();
    expect(() => unwrapResult('{"type":"error","result":"x"}')).toThrow();
    expect(() => unwrapResult('{"type":"result","result":5}')).toThrow();
    expect(() => unwrapResult("null")).toThrow();
  });
});

describe("firstJsonObject", () => {
  it("is string-aware", () => {
    expect(firstJsonObject('Here: {"b":"}{"} done {"c":2}')).toBe('{"b":"}{"}');
  });
  it("handles escaped quotes and nesting", () => {
    expect(firstJsonObject('x {"a":"q\\"}","b":{"c":1}} y')).toBe('{"a":"q\\"}","b":{"c":1}}');
  });
  it("documents first-brace behaviour", () => {
    expect(firstJsonObject('use {x}: {"a":1}')).toBe("{x}");
  });
  it("ignores prose; null when none or unbalanced", () => {
    expect(firstJsonObject("no json")).toBeNull();
    expect(firstJsonObject('pre {"a":1} post')).toBe('{"a":1}');
    expect(firstJsonObject('{"a":')).toBeNull();
  });
  it("is linear on long unbalanced input", () => {
    const t = Date.now();
    expect(firstJsonObject("{".repeat(200_000))).toBeNull();
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe("selfTestPasses", () => {
  it("accepts NONE variants", () => {
    expect(selfTestPasses("NONE")).toBe(true);
    expect(selfTestPasses("**None**.")).toBe(true);
    expect(selfTestPasses("  none\n")).toBe(true);
  });
  it("rejects tool lists", () => {
    expect(selfTestPasses("Bash, Read")).toBe(false);
    expect(selfTestPasses("nonexistent")).toBe(false);
    expect(selfTestPasses("")).toBe(false);
  });
});
