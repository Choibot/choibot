import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";

it("scrubs chief and agent identity env", () => {
  for (const k of ["CHIEF_ENABLED", "CHOIBOT_USER_TOKEN", "CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "CLAUDECODE", "CODEX_HOME",
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_ISSUES_USER_ID", "TELEGRAM_MASTER_CHAT_ID", "TELEGRAM_MASTER_THREAD_ID",
    "CLAUDE_DEFAULT_ACCOUNT", "CLAUDE_CONFIG_DIR", "CLAUDE_ACCOUNTS_DIR", "PORT",
    "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) expect(process.env[k]).toBeUndefined();
  expect(process.env.CHIEF_DATA_DIR).toMatch(/chief-test-/);
  expect(process.env.HOME).not.toBe(userInfo().homedir);
  expect(process.env.GIT_AUTHOR_EMAIL).toBeTruthy();
  expect(process.env.AGENT_DTACH_DIR).not.toBe(join(tmpdir(), "choibot-dtach"));
});

it("refuses fetch to the live console port", async () => {
  await expect(fetch("http://127.0.0.1:3100/api/agents")).rejects.toThrow(/live console/);
  await expect(fetch("http://localhost:3100/")).rejects.toThrow(/live console/);
});
