// bin/lib/steps.env.test.ts — setup must not rewrite a .env it did not change.
// Separate file from steps.test.ts on purpose: that one must import steps.ts with
// ./exec.js REAL (the no-top-level-side-effects guard); this one mocks the exec
// seam so nothing is ever spawned, and points HOME at a temp dir so no real
// user directory is touched.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "./steps.js";
import { parseEnv } from "./env.js";

vi.mock("./doctor.js", () => ({
  runChecks: async () => [{ name: "platform", ok: true, required: true, detail: "linux" }],
  formatChecks: () => "✔ platform  linux",
  hasRequiredFailure: () => false,
}));

// Every tool setup looks for is "present" (so step 3 downloads nothing and
// prompts for nothing) and every spawn fails — which stops the run at step 4's
// `pnpm install`, i.e. AFTER the two .env-touching steps and BEFORE anything is
// rendered, enabled or started.
const mocks = vi.hoisted(() => ({ absent: new Set<string>() }));
vi.mock("./exec.js", () => ({
  which: async (bin: string) => (mocks.absent.has(bin) ? null : `/usr/bin/${bin}`),
  run: async () => ({ code: 1, stdout: "", stderr: "exec is mocked in this test" }),
}));
afterEach(() => mocks.absent.clear());

// Every core/telegram key is already set AND the three resolved-binary
// keys already hold the paths `which` reports — so neither step 2 nor step 3 has
// anything to add, and the only reason to touch the file would be a bug. The
// GATE_* and WALLET_* keys are legacy leftovers no longer in the schema: unknown
// keys must survive a rewrite untouched.
const COMPLETE_ENV = `# hand-written by a human — comments and ordering must survive
GATE_OWNER_ID=123456789
GATE_BOT_TOKEN=1234:abcdef

# the console
CONSOLE_COOKIE_SECRET=an-actually-random-secret-value-here-32
WORKSPACE_DIR=/home/someone/workspace
PORT=3100
GATE_PORT=3200
HOST=127.0.0.1
CODE_SERVER_BIND=127.0.0.1:8081

# resolved by an earlier setup run
AGENT_DTACH_BIN=/usr/bin/dtach
CLAUDE_CODE_EXECUTABLE=/usr/bin/claude
CODEX_EXECUTABLE=/usr/bin/codex

# optional groups, already answered
WALLET_KEYPAIR=/home/someone/.config/solana/id.json
WALLET_RPC_URL=https://rpc.example
SOLANA_BIN_DIR=/home/someone/.local/share/solana/bin
TELEGRAM_BOT_TOKEN=1234:ghijkl
TELEGRAM_CHAT_ID=987654321
`;

// Runs setup against a throwaway repo dir with HOME pointed at a temp dir, and
// returns the exit code — never touching the real user's files.
async function setupIn(envText: string | null): Promise<{ code: number; env: string; path: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "choibot-env-"));
  const home = mkdtempSync(join(tmpdir(), "choibot-home-"));
  const envPath = join(dir, ".env");
  if (envText !== null) writeFileSync(envPath, envText);
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runSetup({ repoDir: dir });
    return {
      code,
      env: readFileSync(envPath, "utf8"),
      path: envPath,
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      },
    };
  } finally {
    log.mockRestore();
    err.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
}

describe("setup .env writes", () => {
  it("leaves a complete .env byte-identical instead of reserializing it", async () => {
    // Fails at build (mocked `pnpm install`), i.e. past both .env steps.
    const r = await setupIn(COMPLETE_ENV);
    try {
      expect(r.code).toBe(1);
      expect(r.env).toBe(COMPLETE_ENV);
    } finally {
      r.cleanup();
    }
  });

  it("leaves a Claude-only box untouched — no codex on PATH, no CODEX_EXECUTABLE", async () => {
    // Codex is optional: on a box without it, setup must add nothing (a key
    // pointing at a binary that is not there would be worse than no key), so
    // the file stays byte-identical.
    mocks.absent.add("codex");
    const claudeOnly = COMPLETE_ENV.replace("CODEX_EXECUTABLE=/usr/bin/codex\n", "");
    const r = await setupIn(claudeOnly);
    try {
      expect(r.code).toBe(1);
      expect(r.env).toBe(claudeOnly);
      expect(parseEnv(r.env).has("CODEX_EXECUTABLE")).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it("still pins the resolved binary paths when they are absent", async () => {
    const partial = COMPLETE_ENV.replace("AGENT_DTACH_BIN=/usr/bin/dtach\n", "")
      .replace("CLAUDE_CODE_EXECUTABLE=/usr/bin/claude\n", "")
      .replace("CODEX_EXECUTABLE=/usr/bin/codex\n", "");
    const r = await setupIn(partial);
    try {
      expect(r.code).toBe(1);
      const values = parseEnv(r.env);
      expect(values.get("AGENT_DTACH_BIN")).toBe("/usr/bin/dtach");
      expect(values.get("CLAUDE_CODE_EXECUTABLE")).toBe("/usr/bin/claude");
      expect(values.get("CODEX_EXECUTABLE")).toBe("/usr/bin/codex");
      // and the rest of the hand-written values survived the rewrite
      expect(values.get("GATE_BOT_TOKEN")).toBe("1234:abcdef");
      expect(values.get("TELEGRAM_CHAT_ID")).toBe("987654321");
    } finally {
      r.cleanup();
    }
  });

  it("does not overwrite a hand-picked binary path with the one on PATH", async () => {
    const custom = COMPLETE_ENV.replace(
      "CLAUDE_CODE_EXECUTABLE=/usr/bin/claude",
      "CLAUDE_CODE_EXECUTABLE=/home/someone/bin/claude-wrapper",
    );
    const r = await setupIn(custom);
    try {
      expect(r.code).toBe(1);
      expect(r.env).toBe(custom);
    } finally {
      r.cleanup();
    }
  });
});
