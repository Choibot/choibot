// bin/lib/steps.test.ts — the pure helpers behind `choibot setup`. This file
// imports ./steps.js WITHOUT mocking ./exec.js, so steps.ts must stay free of
// top-level side effects (no prompts, no which(), no process.exit).
import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aptPlan, ask, askHidden, probePort, runPort, runSetup, PromptError } from "./steps.js";

// Only ./doctor.js is stubbed (so step 1 passes without probing this host);
// ./exec.js stays REAL — steps.ts must be importable without it being mocked.
vi.mock("./doctor.js", () => ({
  runChecks: async () => [{ name: "platform", ok: true, required: true, detail: "linux" }],
  formatChecks: () => "✔ platform  linux",
  hasRequiredFailure: () => false,
}));

describe("setup helpers", () => {
  it("auto-installs only with apt-get AND passwordless sudo", () => {
    expect(aptPlan(["dtach"], true, true).auto).toEqual(["dtach"]);
    expect(aptPlan(["dtach"], false, true).auto).toBeNull();
    expect(aptPlan(["dtach"], true, false).auto).toBeNull();
    expect(aptPlan(["dtach"], false, false).manual).toContain("dtach");
  });
  it("maps compiler tools to build-essential, deduped", () => {
    expect(aptPlan(["make", "g++", "python3"], true, true).auto).toEqual(["build-essential", "python3"]);
  });
  it("always offers the full manual command, even when auto is available", () => {
    expect(aptPlan(["dtach", "make"], true, true).manual).toBe("sudo apt-get install -y dtach build-essential");
    expect(aptPlan([], true, true).auto).toEqual([]);
  });
  it("probePort detects a taken port", async () => {
    const { createServer } = await import("node:net");
    const srv = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as { port: number }).port;
    expect(await probePort(port)).toBe(false);
    srv.close();
    await new Promise((r) => srv.once("close", r));
    expect(await probePort(port)).toBe(true);
  });
});

// setup is interactive; readline's question() never settles on EOF, so without
// this guard `pnpm choibot setup < /dev/null` would drain the event loop and exit 0
// having installed nothing. Both prompt helpers must refuse without a TTY —
// never hang, never silently return "".
describe("prompts without a TTY", () => {
  const original = process.stdin.isTTY;
  const setTty = (value: boolean | undefined): void => {
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
  };
  afterEach(() => setTty(original));

  it("ask() rejects instead of hanging", async () => {
    setTty(false);
    await expect(ask("workspace directory", "/tmp/x")).rejects.toBeInstanceOf(PromptError);
    await expect(ask("workspace directory", "/tmp/x")).rejects.toThrow(/interactive terminal/);
  });

  it("askHidden() rejects instead of falling back to visible input", async () => {
    setTty(false);
    await expect(askHidden("TELEGRAM_BOT_TOKEN")).rejects.toThrow(/interactive terminal/);
  });

  // The false-success this guards against: exit 0 with no .env, no units, no
  // services. runSetup must report the step and exit non-zero. This never
  // reaches step 3, so no process is ever spawned and nothing is installed.
  it("runSetup reports the step and returns non-zero, writing no .env", async () => {
    setTty(false);
    const dir = mkdtempSync(join(tmpdir(), "choibot-setup-"));
    const errors: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runSetup({ repoDir: dir })).toBe(1);
      const text = errors.join("\n");
      expect(text).toContain(".env failed");
      expect(text).toContain("interactive terminal");
      expect(text).toContain("completed steps are skipped");
      expect(existsSync(join(dir, ".env"))).toBe(false);
    } finally {
      err.mockRestore();
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("port: another port for the console", () => {
  const withEnv = async (text: string, run: (dir: string, read: () => string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "port-"));
    writeFileSync(join(dir, ".env"), text);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await run(dir, () => readFileSync(join(dir, ".env"), "utf8")); } finally { log.mockRestore(); err.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  };

  it("changes the port, and the address of the server itself that the set-up wrote", async () => {
    await withEnv("PORT=3100\nCHIEF_CONSOLE_URL=http://127.0.0.1:3100\nHOST=127.0.0.1\n", async (dir, read) => {
      expect(await runPort(dir, "3105", async () => true)).toBe(0);
      expect(read()).toContain("PORT=3105\n");
      expect(read()).toContain("CHIEF_CONSOLE_URL=http://127.0.0.1:3105\n");
      expect(read()).toContain("HOST=127.0.0.1\n");
    });
  });

  it("keeps an address that a person set, and changes nothing for a port that is in use or not valid", async () => {
    await withEnv("PORT=3100\nCHIEF_CONSOLE_URL=https://console.example.ts.net\n", async (dir, read) => {
      expect(await runPort(dir, "3105", async () => false)).toBe(1);
      expect(await runPort(dir, "80", async () => true)).toBe(1);
      expect(await runPort(dir, "3105; reboot", async () => true)).toBe(1);
      expect(read()).toBe("PORT=3100\nCHIEF_CONSOLE_URL=https://console.example.ts.net\n");
      expect(await runPort(dir, "3105", async () => true)).toBe(0);
      expect(read()).toContain("CHIEF_CONSOLE_URL=https://console.example.ts.net\n");
    });
  });
});
