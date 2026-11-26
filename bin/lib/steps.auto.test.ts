// bin/lib/steps.auto.test.ts — `setup --auto`: the set-up that asks nothing. No terminal is
// there in a test run (stdin is not a TTY), so every prompt would fail the run: a run that
// ends with 0 asked nothing. The exec seam is mocked (nothing is spawned, no service is
// touched); HOME and the console's folder are temp dirs.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({
  absent: new Set<string>(),      // tools that are not on the server
  sudo: false,                    // sudo with no password
  active: false,                  // the service runs
  linger: true,
  failing: new Set<string>(),     // technical checks that fail
  buildFails: false,
  calls: [] as string[],
  onStart: (): void => {},
}));

vi.mock("./exec.js", () => ({
  which: async (bin: string) => (box.absent.has(bin) ? null : `/usr/bin/${bin}`),
  run: async (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(" ");
    box.calls.push(line);
    const done = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr });
    if (cmd === "sudo") return done(box.sudo ? 0 : 1);
    if (cmd === "pnpm") return box.buildFails && args[0] === "build" ? done(1, "compiling…", "Type error: something is wrong") : done(0);
    if (line.includes("is-active")) return done(box.active ? 0 : 3);
    // Starting a unit that runs does nothing.
    if (line.includes("enable --now")) { if (!box.active) { box.active = true; box.onStart(); } return done(0); }
    if (line.includes("enable-linger")) return done(box.linger ? 0 : 1);
    if (line.includes("show-user")) return done(0, box.linger ? "Linger=yes\n" : "Linger=no\n");
    return done(0);
  },
}));

// The technical checks and the step list are tested in their own files. Here: every check
// passes unless the test says so, and the list is a fixed one.
vi.mock("./doctor.js", async (orig) => {
  const real = await orig<typeof import("./doctor.js")>();
  return {
    ...real,
    runChecks: async () => ["platform", "systemd (user)", "node", "git repo"].map((name) => ({ name, required: true, ok: !box.failing.has(name), detail: "x" })),
    cliSteps: async () => [
      { id: "install", title: "Install the console", why: "w", optional: false, state: "done", text: "Ready" },
      { id: "claude", title: "Log in to Claude", why: "w", optional: false, state: "todo", text: "Claude is not logged in on the server." },
    ],
  };
});

import { DISPLAY_NAME } from "../../server/brand.js";
import { chiefActive } from "../../server/chief/paths.js";
import { cli } from "../../server/setup/steps.js";
import { parseEnv } from "./env.js";
import { checkAutoOpts, freePort, probePort, runSetup } from "./steps.js";
import { UNIT_NAMES } from "./units.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
let root: string, repo: string, home: string, oldHome: string | undefined;
let out: string[], servers: Server[];

const listen = (port: number): Promise<Server> => new Promise((resolve) => {
  const srv = createServer((_req, res) => res.end("ok")).listen(port, "127.0.0.1", () => resolve(srv));
  servers.push(srv);
});
const envFile = (): string => readFileSync(join(repo, ".env"), "utf8");
const env = (): Map<string, string> => parseEnv(envFile());
const text = (): string => out.join("\n");
// A port that is free now, far from the default of a real console.
const aFreePort = async (): Promise<number> => (await freePort(20000 + Math.floor(Math.random() * 20000)))!;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "setup-auto-"));
  repo = join(root, "console");
  home = join(root, "home");
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(home);
  for (const unit of UNIT_NAMES) copyFileSync(join(REPO_ROOT, "deploy", unit), join(repo, "deploy", unit));
  oldHome = process.env.HOME;
  process.env.HOME = home;
  Object.assign(box, { sudo: false, active: false, linger: true, buildFails: false, calls: [] });
  box.absent.clear();
  box.failing.clear();
  // The fake service: when the unit starts, the console answers on its port. A build makes its marker.
  box.onStart = () => { void listen(Number(env().get("PORT"))); };
  out = [];
  servers = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(String(s)); });
  vi.spyOn(console, "error").mockImplementation((s: string) => { out.push(String(s)); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.env.HOME = oldHome;
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(root, { recursive: true, force: true });
});

const built = (): void => { mkdirSync(join(repo, ".next"), { recursive: true }); writeFileSync(join(repo, ".next", "BUILD_ID"), "b1"); };

describe("setup --auto on a new box", () => {
  it("asks nothing, picks every value, starts the console and ends with the step list", async () => {
    const port = await aFreePort();
    expect(await runSetup({ repoDir: repo, auto: { port: String(port) } })).toBe(0);

    const v = env();
    expect(v.get("CONSOLE_COOKIE_SECRET")!.length).toBeGreaterThanOrEqual(32);
    expect(v.get("PORT")).toBe(String(port));
    expect(v.get("HOST")).toBe("127.0.0.1");
    // The workspace is outside the console's folder.
    expect(v.get("WORKSPACE_DIR")).toBe(join(home, "workspace"));
    expect(existsSync(join(home, "workspace"))).toBe(true);
    // Agents get only what they need to run (PR #45), and the Queue and the leads are on.
    expect(v.get("AGENT_ENV_PASS")).toBe("");
    expect(v.get("CHIEF_ENABLED")).toBe("1");
    expect(v.get("CHIEF_USER_AUTH")).toBe("log");
    expect(v.get("CHIEF_CONSOLE_URL")).toBe(`http://127.0.0.1:${port}`);
    expect(chiefActive(Object.fromEntries(v))).toBe(true);
    // Telegram, Tailscale and GitHub are steps of the list, not questions of the installer.
    expect([...v.keys()].filter((k) => /TELEGRAM|TAILSCALE|GITHUB/.test(k))).toEqual([]);
    expect(box.calls.some((c) => c.startsWith("tailscale"))).toBe(false);

    expect(box.calls).toContain("pnpm install");
    expect(box.calls).toContain("pnpm build");
    expect(box.calls).toContain(`systemctl --user enable --now ${UNIT_NAMES[0]}`);
    expect(existsSync(join(home, ".config", "systemd", "user", UNIT_NAMES[0]))).toBe(true);

    expect(text()).toContain("✔ Settings written");
    expect(text()).toContain("✔ Service started. It stays on after you log out.");
    expect(text()).toContain(`✔ ${DISPLAY_NAME} answers on this server`);
    // Then the step list with its state, and last the way to pair the first device (a new install).
    expect(out[out.length - 2]).toContain("1 of 2 steps done");
    expect(out[out.length - 2]).toContain("✖ Log in to Claude     Claude is not logged in on the server.");
    expect(out[out.length - 1]).toContain("To pair your first device");
  });

  it("--brief (the install script): the same set-up, with no title, no step list and no code at the end", async () => {
    const port = await aFreePort();
    expect(await runSetup({ repoDir: repo, auto: { port: String(port), brief: true } })).toBe(0);
    expect(env().get("PORT")).toBe(String(port));
    expect(box.calls).toContain(`systemctl --user enable --now ${UNIT_NAMES[0]}`);
    expect(out[0]).toBe(`  ✔ This server can run ${DISPLAY_NAME}`);
    expect(out[out.length - 1]).toBe(`  ✔ ${DISPLAY_NAME} answers on this server`);
    expect(text()).not.toContain("steps done");
  });

  it("speaks plain words: no settings key, no file path, no secret", async () => {
    await runSetup({ repoDir: repo, auto: { port: String(await aFreePort()) } });
    expect(text()).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/);
    expect(text()).not.toContain(root);
    expect(text()).not.toContain(".env");
    expect(text()).not.toContain(env().get("CONSOLE_COOKIE_SECRET"));
  });

  it("takes the next free port when the first one is in use, and says so", async () => {
    const taken = await aFreePort();
    await listen(taken);
    expect(await runSetup({ repoDir: repo, auto: { port: String(taken) } })).toBe(0);
    const port = Number(env().get("PORT"));
    expect(port).toBeGreaterThan(taken);
    expect(text()).toContain(`✔ Port ${taken} is in use by another program. ${DISPLAY_NAME} uses ${port}.`);
    expect(env().get("CHIEF_CONSOLE_URL")).toBe(`http://127.0.0.1:${port}`);
  });

  it("uses the workspace and the address a caller gives", async () => {
    const ws = join(root, "my-work");
    await runSetup({ repoDir: repo, auto: { port: String(await aFreePort()), workspace: ws, url: "https://box.example.ts.net" } });
    expect(env().get("WORKSPACE_DIR")).toBe(ws);
    expect(env().get("CHIEF_CONSOLE_URL")).toBe("https://box.example.ts.net");
  });

  it("goes on without Claude and GitHub: they are later steps", async () => {
    box.absent.add("claude").add("gh").add("codex");
    expect(await runSetup({ repoDir: repo, auto: { port: String(await aFreePort()) } })).toBe(0);
    expect(env().has("CLAUDE_CODE_EXECUTABLE")).toBe(false);
    expect(text()).toContain("○ The Claude program is not on the server yet. Agents cannot start without it.");
  });

  it("starts the service when it cannot make it stay on, and says the one command", async () => {
    box.linger = false;
    expect(await runSetup({ repoDir: repo, auto: { port: String(await aFreePort()) } })).toBe(0);
    expect(text()).toContain("○ Service started. It stops when you log out. To keep it on, run: sudo loginctl enable-linger $USER");
  });
});

describe("setup --auto is safe to run again", () => {
  it("changes nothing on the second run, and makes no new build under the console that runs", async () => {
    box.onStart = () => { built(); void listen(Number(env().get("PORT"))); };
    expect(await runSetup({ repoDir: repo, auto: { port: String(await aFreePort()) } })).toBe(0);
    const before = envFile();
    const unit = readFileSync(join(home, ".config", "systemd", "user", UNIT_NAMES[0]), "utf8");
    box.calls = [];
    out.length = 0;

    expect(await runSetup({ repoDir: repo, auto: {} })).toBe(0);
    expect(envFile()).toBe(before);
    expect(readFileSync(join(home, ".config", "systemd", "user", UNIT_NAMES[0]), "utf8")).toBe(unit);
    expect(box.calls.filter((c) => c.startsWith("pnpm"))).toEqual([]);
    expect(box.calls.filter((c) => /restart/.test(c))).toEqual([]);
    expect(text()).toContain("✔ Settings are complete. Nothing is changed.");
    expect(text()).toContain(`✔ ${DISPLAY_NAME} is built and runs. No new build.`);
    expect(text()).toContain("✔ The service runs. It stays on after you log out.");
  });

  it("goes on where it stopped: a run after a failed build keeps the settings of the first run", async () => {
    box.buildFails = true;
    const port = String(await aFreePort());
    expect(await runSetup({ repoDir: repo, auto: { port } })).toBe(1);
    expect(text()).toContain("Type error: something is wrong");
    expect(text()).toContain("✖ The build failed. The lines above say why.");
    expect(text()).toContain(`Then run this again: ${cli("setup --auto")}. It goes on where it stopped.`);
    const first = envFile();
    box.buildFails = false;
    expect(await runSetup({ repoDir: repo, auto: {} })).toBe(0);
    expect(envFile()).toBe(first);
    expect(env().get("CHIEF_ENABLED")).toBe("1");
  });
});

describe("setup --auto on an install that is there", () => {
  // The values differ from every default, and the file has comments and keys the console does
  // not know: all of it must stay, byte for byte.
  const OWN = (port: number) => `# written by hand
GATE_OWNER_ID=123456789

CONSOLE_COOKIE_SECRET=an-actually-random-secret-value-here-32
WORKSPACE_DIR=/srv/own/workspace
PORT=${port}
HOST=127.0.0.1
CODE_SERVER_BIND=127.0.0.1:9191
TELEGRAM_CHAT_ID=-100777
AGENT_DTACH_BIN=/opt/own/dtach
CLAUDE_CODE_EXECUTABLE=/opt/own/claude
CODEX_EXECUTABLE=/opt/own/codex
`;

  it("writes nothing: each value of the file wins over each default", async () => {
    const port = await aFreePort();
    writeFileSync(join(repo, ".env"), OWN(port));
    built();
    box.active = true;
    await listen(port);
    expect(await runSetup({ repoDir: repo, auto: { port: "4555", workspace: join(root, "other"), url: "https://other.example" } })).toBe(0);
    expect(envFile()).toBe(OWN(port));
    expect(existsSync(join(root, "other"))).toBe(false);
    expect(box.calls.filter((c) => c.startsWith("pnpm"))).toEqual([]);
  });

  it("never turns the Queue on, or the strict agent env, in a settings file from before", async () => {
    const port = await aFreePort();
    // An older install: the paths of the tools are not written yet.
    writeFileSync(join(repo, ".env"), OWN(port).split("\n").filter((l) => !/^(AGENT_DTACH_BIN|CLAUDE_CODE_EXECUTABLE|CODEX_EXECUTABLE)=/.test(l)).join("\n"));
    await listen(port);
    box.active = true;
    built();
    expect(await runSetup({ repoDir: repo, auto: {} })).toBe(0);
    const v = env();
    expect([...v.keys()].filter((k) => k.startsWith("CHIEF_") || k === "AGENT_ENV_PASS")).toEqual([]);
    expect(v.get("WORKSPACE_DIR")).toBe("/srv/own/workspace");
    expect(v.get("PORT")).toBe(String(port));
    expect(v.get("CODE_SERVER_BIND")).toBe("127.0.0.1:9191");
    expect(v.get("TELEGRAM_CHAT_ID")).toBe("-100777");
    expect(v.get("GATE_OWNER_ID")).toBe("123456789");
    expect(v.get("CLAUDE_CODE_EXECUTABLE")).toBe("/usr/bin/claude"); // only what was missing is added
    expect(text()).toContain("✔ Settings completed. No value that was there is changed.");
  });
});

describe("setup --auto stops with the fix, in plain words", () => {
  it("names the one command when tools are missing and sudo needs a password", async () => {
    box.absent.add("dtach").add("make");
    expect(await runSetup({ repoDir: repo, auto: { port: String(await aFreePort()) } })).toBe(1);
    expect(text()).toContain("✖ The tools dtach, make are not on the server. Install them with: sudo apt-get install -y dtach build-essential");
    expect(box.calls.filter((c) => c.startsWith("pnpm") || c.includes("enable --now"))).toEqual([]);
  });

  it("installs the missing tools itself when sudo needs no password", async () => {
    box.absent.add("dtach");
    box.sudo = true;
    // The fake apt-get puts nothing on the box: the tool is still missing after it.
    expect(await runSetup({ repoDir: repo, auto: { port: String(await aFreePort()) } })).toBe(1);
    expect(box.calls).toContain("sudo apt-get install -y dtach");
  });

  it("says what is wrong with the server, with the sentence of the step list", async () => {
    box.failing.add("systemd (user)");
    expect(await runSetup({ repoDir: repo, auto: {} })).toBe(1);
    expect(text()).toContain("✖ This user cannot run services on your server. Log in to your server as this user with SSH, not with su.");
    expect(existsSync(join(repo, ".env"))).toBe(false);
  });

  it("refuses a value that is not valid, before it does anything", async () => {
    expect(await runSetup({ repoDir: repo, auto: { port: "80" } })).toBe(1);
    expect(text()).toContain("✖ The port must be a number from 1024 to 65535.");
    expect(existsSync(join(repo, ".env"))).toBe(false);
    expect(checkAutoOpts({})).toBeNull();
    expect(checkAutoOpts({ port: "3101", workspace: "/srv/ws", url: "http://127.0.0.1:3101" })).toBeNull();
    expect(checkAutoOpts({ port: "abc" })).toMatch(/port/);
    expect(checkAutoOpts({ workspace: "relative/dir" })).toMatch(/workspace/);
    expect(checkAutoOpts({ url: "https://x.example/path" })).toMatch(/address/);
  });
});

describe("freePort", () => {
  it("gives the first port at or above the start that is free", async () => {
    expect(await freePort(3100, async (p) => p >= 3103)).toBe(3103);
    expect(await freePort(3100, async () => true)).toBe(3100);
    expect(await freePort(3100, async () => false)).toBeNull();
    expect(await freePort(65530, async () => false)).toBeNull();
  });

  it("sees a real port that is in use", async () => {
    const taken = await aFreePort();
    await listen(taken);
    expect(await probePort(taken)).toBe(false);
    expect(await freePort(taken)).toBeGreaterThan(taken);
  });
});
