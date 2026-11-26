import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENV_SCHEMA, parseEnv, isMissing, generateSecret, serializeEnv, renderEnvExample } from "./env.js"; // writeEnvFile imported inside its test

const byKey = (k: string) => ENV_SCHEMA.find((e) => e.key === k)!;

describe("env schema", () => {
  it("carries WIDGETS_DATA_DIR as a commented core key", () => {
    expect(byKey("WIDGETS_DATA_DIR")).toMatchObject({ group: "core", commentedInExample: true });
  });
  it("pins the weak cookie-secret placeholder verbatim", () => {
    expect(byKey("CONSOLE_COOKIE_SECRET").placeholders).toContain("at-least-32-chars-of-random-secret-here");
  });
  it("carries the fleet master keys as commented examples in the right groups", () => {
    expect(byKey("MASTER_DATA_DIR")).toMatchObject({ group: "core", commentedInExample: true });
    expect(byKey("TELEGRAM_MASTER_CHAT_ID")).toMatchObject({ group: "telegram", commentedInExample: true });
    expect(byKey("TELEGRAM_MASTER_THREAD_ID")).toMatchObject({ group: "telegram", commentedInExample: true });
  });
  it("does NOT treat a real workspace path as a placeholder", () => {
    const vals = parseEnv("WORKSPACE_DIR=/home/dev/workspace\n");
    expect(isMissing(byKey("WORKSPACE_DIR"), vals)).toBe(false);
  });
  it("keeps existing values and unknown keys on round-trip", () => {
    const vals = parseEnv("PORT=4000\nMY_CUSTOM=x\n# comment\n");
    expect(vals.get("PORT")).toBe("4000");
    expect(serializeEnv(vals)).toContain("MY_CUSTOM=x");
  });
  it("generates strong distinct secrets", () => {
    const s = generateSecret();
    expect(s.length).toBeGreaterThanOrEqual(32);
    expect(s).not.toBe(generateSecret());
  });
  it(".env.example on disk matches the schema render (drift guard)", () => {
    expect(readFileSync(new URL("../../.env.example", import.meta.url), "utf8")).toBe(renderEnvExample());
  });
  it("carries CODEX_EXECUTABLE as a resolved, commented key", () => {
    const k = ENV_SCHEMA.find((e) => e.key === "CODEX_EXECUTABLE");
    expect(k).toBeDefined();
    expect(k?.group).toBe("resolved");
    expect(k?.commentedInExample).toBe(true);
  });
  it("writeEnvFile writes mode 0600", async () => {
    const { mkdtempSync, statSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "env-test-"));
    const { writeEnvFile } = await import("./env.js");
    writeEnvFile(join(dir, ".env"), new Map([["A", "1"]]));
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries the issues keys as commented examples in the right groups", () => {
    expect(byKey("ISSUES_DATA_DIR")).toMatchObject({ group: "core", commentedInExample: true });
    expect(byKey("TELEGRAM_ISSUES_USER_ID")).toMatchObject({ group: "telegram", commentedInExample: true });
  });
});

describe("chief env group", () => {
  it("lists the eighteen chief keys in order, all commented in the example", () => {
    const keys = ENV_SCHEMA.filter((k) => k.group === "chief");
    expect(keys.map((k) => k.key)).toEqual([
      "CHIEF_ENABLED", "CHIEF_DATA_DIR", "CHIEF_CONSOLE_URL", "CHIEF_AGENT_UID", "AGENT_SUDO_BIN", "AGENT_EXEC_HELPER",
      "AGENT_HOME_ROOT", "AGENT_CLAUDE_CONFIG_DIR", "CHIEF_PERSISTENT_UID", "AGENT_CHIEF_CLAUDE_CONFIG_DIR", "AGENT_CHIEF_DTACH_DIR", "CHIEF_USER_AUTH", "CHIEF_AUTO_THRESHOLD", "CHIEF_UNDO_MINUTES", "CHIEF_DISTILL_AT", "CHIEF_TELEGRAM_AUTO", "CHIEF_TEST", "CHIEF_DEPLOY_UNIT",
    ]);
    expect(keys.every((k) => k.commentedInExample === true)).toBe(true);
  });
  it("carries the helper paths of a hardened deployment with their defaults as examples", () => {
    expect(byKey("AGENT_SUDO_BIN")).toMatchObject({ group: "chief", example: "/usr/bin/sudo" });
    expect(byKey("AGENT_EXEC_HELPER")).toMatchObject({ group: "chief", example: "/usr/local/bin/choibot-agent-exec" });
    expect(byKey("AGENT_HOME_ROOT")).toMatchObject({ group: "chief", example: "/srv/choibot-agent-homes" });
  });
  it("carries AGENT_CLAUDE_CONFIG_DIR, the agents' own Claude dir (ruling F1), commented", () => {
    expect(byKey("AGENT_CLAUDE_CONFIG_DIR")).toMatchObject({
      group: "chief", example: "/home/choibot-agent/.claude", commentedInExample: true,
    });
  });
});
