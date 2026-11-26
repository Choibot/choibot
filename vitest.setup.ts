import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Test isolation guard: runs before every test file. Tests must never see the
// live console's env, data, dtach dir, home config or port 3100.

const SCRUB = [
  "CHOIBOT_USER_TOKEN", "CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "CLAUDECODE", "CODEX_HOME",
  "CLAUDE_DEFAULT_ACCOUNT", "CLAUDE_CONFIG_DIR", "CLAUDE_ACCOUNTS_DIR", "PORT",
  // The data-dir resolvers prefer XDG_DATA_HOME over homedir(): an inherited
  // value would point the tests at the real data dirs.
  "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
];
for (const k of Object.keys(process.env)) {
  if (k.startsWith("CHIEF_") || k.startsWith("TELEGRAM_") || k.startsWith("CHOIBOT_") || SCRUB.includes(k)) delete process.env[k];
}

// State of the real user token, to prove the run never wrote it.
const realTokenPath = join(userInfo().homedir, ".config", "choibot", "user-token");
const tokenState = (): string => {
  try { return String(statSync(realTokenPath).mtimeMs); } catch { return "absent"; }
};
const tokenBefore = tokenState();

const chiefDir = mkdtempSync(join(tmpdir(), "chief-test-"));
const homeDir = mkdtempSync(join(tmpdir(), "chief-home-"));
const dtachDir = mkdtempSync("/tmp/hct-");
process.env.CHIEF_DATA_DIR = chiefDir;
process.env.HOME = homeDir;
process.env.AGENT_DTACH_DIR = dtachDir;
process.env.GIT_AUTHOR_NAME = "chief-test";
process.env.GIT_AUTHOR_EMAIL = "chief-test@example.invalid";
process.env.GIT_COMMITTER_NAME = "chief-test";
process.env.GIT_COMMITTER_EMAIL = "chief-test@example.invalid";

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const host = new URL(url).host;
    if (host === "127.0.0.1:3100" || host === "localhost:3100") {
      return Promise.reject(new Error("test tried to reach the live console on :3100"));
    }
  } catch { /* not a parsable URL: let the real fetch report it */ }
  return realFetch(input, init);
}) as typeof fetch;

// Remove only the dirs this setup file created, and only if the path still has
// the expected prefix under the tmp root. Errors are ignored (a dir may still be
// in use). Never glob: other runs and tests own their own tmp dirs.
const owned: Array<[string, string]> = [
  [chiefDir, join(tmpdir(), "chief-test-")],
  [homeDir, join(tmpdir(), "chief-home-")],
  [dtachDir, "/tmp/hct-"],
];
let cleaned = false;
const cleanup = (): void => {
  if (cleaned) return;
  cleaned = true;
  for (const [dir, prefix] of owned) {
    if (!dir.startsWith(prefix)) continue;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* in use: ignore */ }
  }
};
// A test file whose suites are all skipped never runs afterAll, and vitest ends
// its worker with SIGTERM: clean up on exit and on SIGTERM (then die as usual).
process.once("exit", cleanup);
process.once("SIGTERM", () => {
  cleanup();
  process.kill(process.pid, "SIGTERM");
});

afterAll(() => {
  const changed = tokenState() !== tokenBefore;
  cleanup();
  if (changed) throw new Error(`test run changed the real user token file ${realTokenPath}`);
});
