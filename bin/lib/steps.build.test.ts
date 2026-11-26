// bin/lib/steps.build.test.ts — the `pnpm build` of an install (setup --auto, setup by hand,
// update) turns Next's own type check and lint off with the switch of server/buildcheck.mjs, in
// the env of that one child only. The exec seam is mocked (nothing is spawned, no service is
// touched); HOME and the console's folder are temp dirs.
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({ calls: [] as { line: string; env: NodeJS.ProcessEnv | undefined }[], onStart: (): void => {} }));

vi.mock("./exec.js", () => ({
  which: async (bin: string) => `/usr/bin/${bin}`,
  run: async (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) => {
    const line = [cmd, ...args].join(" ");
    box.calls.push({ line, env: opts.env });
    const done = (code: number, stdout = "") => ({ code, stdout, stderr: "" });
    if (line.includes("is-active")) return done(3);
    if (line.includes("show-user")) return done(0, "Linger=yes\n");
    if (line.includes("enable --now")) box.onStart();
    return done(0);
  },
}));
vi.mock("./doctor.js", async (orig) => {
  const real = await orig<typeof import("./doctor.js")>();
  return {
    ...real,
    runChecks: async () => ["platform", "systemd (user)", "node", "git repo"].map((name) => ({ name, required: true, ok: true, detail: "x" })),
    cliSteps: async () => [],
  };
});
vi.mock("./cron.js", () => ({ cronSync: async () => {} }));

import { NO_CHECK_SWITCH } from "../../server/buildcheck.mjs";
import { parseEnv } from "./env.js";
import { freePort, runSetup, runUpdate } from "./steps.js";
import { UNIT_NAMES } from "./units.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
let root: string, repo: string, oldHome: string | undefined, servers: Server[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "setup-build-"));
  repo = join(root, "console");
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(join(root, "home"));
  for (const unit of UNIT_NAMES) copyFileSync(join(REPO_ROOT, "deploy", unit), join(repo, "deploy", unit));
  oldHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  box.calls = [];
  // The fake service: when the unit starts, the console answers on its port. A unit that runs
  // does not start again.
  servers = [];
  box.onStart = () => {
    if (servers.length > 0) return;
    const port = Number(parseEnv(readFileSync(join(repo, ".env"), "utf8")).get("PORT"));
    servers.push(createServer((_req, res) => res.end("ok")).listen(port, "127.0.0.1"));
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.env.HOME = oldHome;
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(root, { recursive: true, force: true });
});

const aFreePort = async (): Promise<string> => String((await freePort(20000 + Math.floor(Math.random() * 20000)))!);
// The switch in the env of each call: the build has it, no other call has it.
function expectSwitchOnBuildOnly(): void {
  const builds = box.calls.filter((c) => c.line === "pnpm build");
  expect(builds).toHaveLength(1);
  expect(builds[0].env?.[NO_CHECK_SWITCH]).toBe("1");
  // The rest of the env is the one of the CLI: the build still finds its PATH and HOME.
  expect(builds[0].env?.PATH).toBe(process.env.PATH);
  expect(builds[0].env?.HOME).toBe(process.env.HOME);
  for (const c of box.calls.filter((c) => c.line !== "pnpm build")) expect(c.env?.[NO_CHECK_SWITCH], c.line).toBeUndefined();
  expect(box.calls.map((c) => c.line)).toContain("pnpm install");
  // Not exported to the CLI's own env, so no later step sees it.
  expect(process.env[NO_CHECK_SWITCH]).toBeUndefined();
}

describe("the build of an install turns Next's check off, in the build's env only", () => {
  it("setup --auto (the install script and the image build)", async () => {
    expect(await runSetup({ repoDir: repo, auto: { port: await aFreePort() } })).toBe(0);
    expectSwitchOnBuildOnly();
  });

  it("setup by hand", async () => {
    // A settings file that is complete: the set-up by hand asks nothing (no TTY in a test).
    expect(await runSetup({ repoDir: repo, auto: { port: await aFreePort() } })).toBe(0);
    appendFileSync(join(repo, ".env"), "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\n");
    box.calls = [];
    await runSetup({ repoDir: repo });
    expectSwitchOnBuildOnly();
  });

  it("update", async () => {
    mkdirSync(join(repo, ".git"));
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      expect(await runUpdate(repo)).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(box.calls.map((c) => c.line).slice(0, 3)).toEqual(["git pull --ff-only", "pnpm install", "pnpm build"]);
    expectSwitchOnBuildOnly();
  });
});
