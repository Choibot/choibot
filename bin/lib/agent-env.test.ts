import { describe, expect, it } from "vitest";
import { AGENT_ENV_ALLOW, NEVER_PASS, agentEnv, agentEnvPass } from "./agent-env.mjs";
import { ENV_SCHEMA } from "./env.js";

// A console env as the unit gives it: .env keys, systemd and pnpm keys.
const CONSOLE_ENV = {
  PATH: "/usr/bin", HOME: "/home/u", USER: "u", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm-256color",
  XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", SSH_AUTH_SOCK: "/run/ssh",
  HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
  CLAUDE_CONFIG_DIR: "/home/u/.claude-accounts/a", CODEX_HOME: "/home/u/.codex",
  PORT: "3100", CHIEF_CONSOLE_URL: "https://console.example", WORKSPACE_DIR: "/home/u/workspace",
  CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p1",
  CONSOLE_COOKIE_SECRET: "cookie-secret", TELEGRAM_BOT_TOKEN: "tg-token", CHOIBOT_USER_TOKEN: "user-token",
  ANTHROPIC_API_KEY: "ak",
  TELEGRAM_CHAT_ID: "123", CHIEF_ENABLED: "1", MY_APP_DB_URL: "postgres://x", NODE_ENV: "production",
  INVOCATION_ID: "abc", npm_lifecycle_event: "start",
};

describe("agent env", () => {
  it("never passes a console secret, in either mode, even when AGENT_ENV_PASS names it", () => {
    for (const pass of [undefined, "", "TELEGRAM_BOT_TOKEN,CONSOLE_COOKIE_SECRET,CHOIBOT_USER_TOKEN,ANTHROPIC_API_KEY"]) {
      const env = agentEnv({ ...CONSOLE_ENV, ...(pass === undefined ? {} : { AGENT_ENV_PASS: pass }) });
      for (const k of NEVER_PASS) expect(env, `${k} with AGENT_ENV_PASS=${pass}`).not.toHaveProperty(k);
    }
  });

  it("AGENT_ENV_PASS unset: every other key of the console env passes, as before", () => {
    const env = agentEnv(CONSOLE_ENV);
    const want: Record<string, string> = { ...CONSOLE_ENV };
    for (const k of NEVER_PASS) delete want[k];
    expect(env).toEqual(want);
  });

  it("AGENT_ENV_PASS set: only the allowlist, the LC_* keys and the listed keys pass", () => {
    const env = agentEnv({ ...CONSOLE_ENV, AGENT_ENV_PASS: " MY_APP_DB_URL , NOT_SET,bad-name" });
    expect(Object.keys(env).sort()).toEqual([
      "CHIEF_CONSOLE_URL", "CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "DBUS_SESSION_BUS_ADDRESS", "HOME",
      "HTTPS_PROXY", "LANG", "LC_ALL", "MY_APP_DB_URL", "NODE_EXTRA_CA_CERTS", "PATH", "PORT",
      "SSH_AUTH_SOCK", "TERM", "USER", "WORKSPACE_DIR", "XDG_RUNTIME_DIR",
    ]);
    expect(env.MY_APP_DB_URL).toBe("postgres://x");
  });

  it("AGENT_ENV_PASS empty: the allowlist alone (console config and process keys stop)", () => {
    const env = agentEnv({ ...CONSOLE_ENV, AGENT_ENV_PASS: "" });
    for (const k of ["TELEGRAM_CHAT_ID", "CHIEF_ENABLED", "MY_APP_DB_URL", "NODE_ENV", "INVOCATION_ID", "npm_lifecycle_event", "AGENT_ENV_PASS"]) {
      expect(env).not.toHaveProperty(k);
    }
    expect(env.PATH).toBe("/usr/bin");
  });

  it("agentEnvPass: null when unset, the valid names otherwise", () => {
    expect(agentEnvPass({})).toBeNull();
    expect(agentEnvPass({ AGENT_ENV_PASS: "" })).toEqual([]);
    expect(agentEnvPass({ AGENT_ENV_PASS: "A, B_2,,9x,a-b" })).toEqual(["A", "B_2"]);
  });

  it("the allowlist keeps the sudoers env_keep keys a strong-mode spawn needs", () => {
    for (const k of ["CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "PORT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TERM", "LANG",
      "CHOIBOT_WIDGET_DIR", "CHOIBOT_CRON_SPOOL", "CRON_DATA_DIR", "TZ", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
      expect(AGENT_ENV_ALLOW).toContain(k);
    }
  });

  it("no allowlisted key is a console secret, and every secret key of the .env schema is never passed", () => {
    for (const k of NEVER_PASS) expect(AGENT_ENV_ALLOW).not.toContain(k);
    const secrets = ENV_SCHEMA.filter((e) => e.secret).map((e) => e.key);
    expect(secrets).toEqual(expect.arrayContaining(["CONSOLE_COOKIE_SECRET", "TELEGRAM_BOT_TOKEN"]));
    for (const k of secrets) expect(NEVER_PASS).toContain(k);
  });
});
