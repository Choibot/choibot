import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("./exec.js", () => ({ which: vi.fn(), run: vi.fn() }));
import { which, run } from "./exec.js";
import { runChecks, formatChecks, hasRequiredFailure, protectionLine } from "./doctor.js";
import { CONSOLE_UNIT_TEMPLATE } from "./units.js";
import { names } from "../../server/names.mjs";
import { join } from "node:path";

beforeEach(() => {
  vi.mocked(which).mockResolvedValue("/usr/bin/tool");
  vi.mocked(run).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
});

describe("doctor", () => {
  it("classifies a missing required tool as a required failure with a hint", async () => {
    vi.mocked(which).mockImplementation(async (b) => (b === "dtach" ? null : "/usr/bin/x"));
    const res = await runChecks("/nonexistent-repo");
    const dtach = res.find((r) => r.name === "dtach")!;
    expect(dtach.ok).toBe(false);
    expect(dtach.required).toBe(true);
    expect(dtach.hint).toMatch(/apt-get install/);
    expect(hasRequiredFailure(res)).toBe(true);
  });

  it("treats gh as advisory", async () => {
    vi.mocked(which).mockImplementation(async (b) => (b === "gh" ? null : "/usr/bin/x"));
    const res = await runChecks("/nonexistent-repo");
    expect(res.find((r) => r.name === "gh")!.required).toBe(false);
  });

  it("treats code-server as advisory", async () => {
    vi.mocked(which).mockImplementation(async (b) => (b === "code-server" ? null : "/usr/bin/x"));
    const res = await runChecks("/nonexistent-repo");
    const cs = res.find((r) => r.name === "code-server")!;
    expect(cs.ok).toBe(false);
    expect(cs.required).toBe(false);
  });

  it("treats codex as advisory", async () => {
    vi.mocked(which).mockImplementation(async (b) => (b === "codex" ? null : "/usr/bin/x"));
    const res = await runChecks("/nonexistent-repo");
    const codex = res.find((r) => r.name === "codex")!;
    expect(codex.ok).toBe(false);
    expect(codex.required).toBe(false);
    expect(codex.hint).toMatch(/@openai\/codex/);
    // a missing codex must never be one of the blocking failures: the console
    // runs on Claude alone.
    expect(res.filter((r) => r.required && !r.ok).map((r) => r.name)).not.toContain("codex");
  });

  it("passes the codex check when the binary resolves", async () => {
    const res = await runChecks("/nonexistent-repo");
    expect(res.find((r) => r.name === "codex")!.ok).toBe(true);
  });

  it("fails gh when the binary exists but auth status is non-zero", async () => {
    vi.mocked(run).mockImplementation(async (cmd, args) =>
      cmd === "gh" && args[0] === "auth"
        ? { code: 1, stdout: "", stderr: "not logged in" }
        : { code: 0, stdout: "Linger=yes\n", stderr: "" },
    );
    const res = await runChecks("/nonexistent-repo");
    const gh = res.find((r) => r.name === "gh")!;
    expect(gh.ok).toBe(false);
    expect(gh.required).toBe(false);
    expect(gh.detail).toMatch(/auth/i);
    // an unauthenticated gh must never be one of the blocking failures
    expect(res.filter((r) => r.required && !r.ok).map((r) => r.name)).not.toContain("gh");
  });

  it("flags placeholder .env values as failing", async () => {
    // runChecks reads <repoDir>/.env via fs; point it at a fixture dir.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "doctor-test-"));
    writeFileSync(join(dir, ".env"), "CONSOLE_COOKIE_SECRET=at-least-32-chars-of-random-secret-here\n");
    const res = await runChecks(dir);
    const envCheck = res.find((r) => r.name === ".env")!;
    expect(envCheck.ok).toBe(false);
    expect(envCheck.detail).toContain("CONSOLE_COOKIE_SECRET");
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes .env when the no-server-default keys are real, without PORT/HOST", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "doctor-test-"));
    writeFileSync(
      join(dir, ".env"),
      [
        "CONSOLE_COOKIE_SECRET=abcdefghijklmnopqrstuvwxyz0123456789",
        "WORKSPACE_DIR=/home/me/workspace",
      ].join("\n") + "\n",
    );
    const res = await runChecks(dir);
    expect(res.find((r) => r.name === ".env")!.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a missing .env file as a required failure", async () => {
    const res = await runChecks("/nonexistent-repo");
    const envCheck = res.find((r) => r.name === ".env")!;
    expect(envCheck.ok).toBe(false);
    expect(envCheck.required).toBe(true);
    expect(envCheck.detail).toMatch(/not found|missing/i);
    expect(envCheck.hint).toMatch(/pnpm choibot setup/);
  });

  it("accepts a .git FILE (git worktree), not just a directory", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "doctor-test-"));
    writeFileSync(join(dir, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
    const res = await runChecks(dir);
    expect(res.find((r) => r.name === "git repo")!.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts an install from an archive file: no .git, but the console's unit template and CLI", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "doctor-test-"));
    const repo = (await runChecks(dir)).find((r) => r.name === "git repo")!;
    expect(repo).toMatchObject({ ok: false, detail: `no .git in ${dir}` });
    mkdirSync(join(dir, "deploy"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "deploy", CONSOLE_UNIT_TEMPLATE), "");
    writeFileSync(join(dir, names().cliEntry), "");
    expect((await runChecks(dir)).find((r) => r.name === "git repo")).toMatchObject({ ok: true, detail: `${dir} (from an archive, no git history)` });
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails the systemd check when the user bus is unreachable", async () => {
    vi.mocked(run).mockImplementation(async (cmd, args) =>
      cmd === "systemctl"
        ? { code: 1, stdout: "", stderr: "Failed to connect to bus: No such file or directory" }
        : { code: 0, stdout: "Linger=yes\n", stderr: "" },
    );
    const res = await runChecks("/nonexistent-repo");
    const sd = res.find((r) => r.name === "systemd (user)")!;
    expect(sd.ok).toBe(false);
    expect(sd.required).toBe(true);
    expect(sd.hint).toMatch(/loginctl show-user/);
  });

  it("passes the systemd check in degraded state (non-zero exit, bus reachable)", async () => {
    vi.mocked(run).mockImplementation(async (cmd) =>
      cmd === "systemctl"
        ? { code: 1, stdout: "degraded\n", stderr: "" }
        : { code: 0, stdout: "Linger=yes\n", stderr: "" },
    );
    const res = await runChecks("/nonexistent-repo");
    expect(res.find((r) => r.name === "systemd (user)")!.ok).toBe(true);
  });

  it("fails the linger check when Linger=no", async () => {
    vi.mocked(run).mockImplementation(async (cmd, args) =>
      args.join(" ").includes("loginctl")
        ? { code: 0, stdout: "Linger=no\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const res = await runChecks("/nonexistent-repo");
    const linger = res.find((r) => r.name === "linger")!;
    expect(linger.ok).toBe(false);
    expect(linger.required).toBe(true);
    expect(linger.hint).toMatch(/enable-linger/);
  });

  it("fails build tools when any of make/g++/python3 is missing", async () => {
    vi.mocked(which).mockImplementation(async (b) => (b === "g++" ? null : "/usr/bin/x"));
    const res = await runChecks("/nonexistent-repo");
    const bt = res.find((r) => r.name === "build tools")!;
    expect(bt.ok).toBe(false);
    expect(bt.required).toBe(true);
    expect(bt.detail).toContain("g++");
    expect(bt.hint).toMatch(/build-essential/);
  });

  it("runs the documented checks in order", async () => {
    const res = await runChecks("/nonexistent-repo");
    expect(res.map((r) => r.name)).toEqual([
      "platform",
      "systemd (user)",
      "node",
      "git",
      "pnpm",
      "git repo",
      "dtach",
      "claude",
      "codex",
      "tailscale",
      "build tools",
      ".env",
      "chief",
      "user token in .env",
      "workspace",
      "agent env",
      "linger",
      "gh",
      "code-server",
    ]);
  });

  // setup gates step 1 on these names; a renamed check would turn that gate into
  // a silent no-op (nothing matches → nothing is fatal → setup marches on).
  it("produces a result for every check setup treats as fatal", async () => {
    const { FATAL_CHECKS } = await import("./steps.js");
    const names = (await runChecks("/nonexistent-repo")).map((r) => r.name);
    expect(FATAL_CHECKS.length).toBeGreaterThan(0);
    for (const name of FATAL_CHECKS) expect(names).toContain(name);
  });

  it("formats a table with warn symbol for advisory failures", () => {
    const s = formatChecks([{ name: "gh", ok: false, required: false, detail: "not found" }]);
    expect(s).toContain("⚠");
  });

  it("formats ok and required-failure rows with aligned names and hints", () => {
    const s = formatChecks([
      { name: "dtach", ok: false, required: true, detail: "not found", hint: "sudo apt-get install -y dtach" },
      { name: "git", ok: true, required: true, detail: "/usr/bin/git" },
    ]);
    const lines = s.split("\n");
    expect(lines[0]).toContain("✖");
    expect(lines[0]).toContain("sudo apt-get install -y dtach");
    expect(lines[1]).toContain("✔");
    // names padded to the longest ("dtach" = 5 chars) so details line up
    expect(lines[0].indexOf("not found")).toBe(lines[1].indexOf("/usr/bin/git"));
  });

  it("hasRequiredFailure ignores advisory failures", () => {
    expect(
      hasRequiredFailure([
        { name: "gh", ok: false, required: false, detail: "x" },
        { name: "git", ok: true, required: true, detail: "x" },
      ]),
    ).toBe(false);
  });
});

describe("doctor chief checks", () => {
  async function chiefRun(env: string) {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "doctor-chief-"));
    writeFileSync(join(dir, ".env"), env);
    try {
      return await runChecks(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reports off when CHIEF_ENABLED is unset", async () => {
    const c = (await chiefRun("PORT=3100\n")).find((r) => r.name === "chief")!;
    expect(c).toMatchObject({ ok: true, detail: "off" });
  });

  it("fails a required check without CHIEF_CONSOLE_URL", async () => {
    const c = (await chiefRun("CHIEF_ENABLED=1\n")).find((r) => r.name === "chief")!;
    expect(c).toMatchObject({ ok: false, required: true, detail: "CHIEF_CONSOLE_URL is not set" });
  });

  it("fails telegram mode without a Master topic", async () => {
    const c = (await chiefRun("CHIEF_ENABLED=1\nCHIEF_CONSOLE_URL=https://c.example\nCHIEF_USER_AUTH=telegram\n"))
      .find((r) => r.name === "chief")!;
    expect(c).toMatchObject({ ok: false, required: true, detail: "CHIEF_USER_AUTH=telegram but the Master topic is not configured" });
  });

  it("passes a well-formed log config", async () => {
    const c = (await chiefRun("CHIEF_ENABLED=1\nCHIEF_CONSOLE_URL=https://c.example\nCHIEF_USER_AUTH=log\n"))
      .find((r) => r.name === "chief")!;
    expect(c).toMatchObject({ ok: true, detail: "on (log mode)" });
  });

  it("warns about CHOIBOT_USER_TOKEN in .env", async () => {
    const c = (await chiefRun("CHOIBOT_USER_TOKEN=x\n")).find((r) => r.name === "user token in .env")!;
    expect(c).toMatchObject({ ok: false, required: false });
    expect(c.hint).toContain("~/.config/choibot/user-token");
  });

  it("passes the user token check when .env has none", async () => {
    const c = (await chiefRun("PORT=3100\n")).find((r) => r.name === "user token in .env")!;
    expect(c.ok).toBe(true);
  });
});

describe("doctor workspace and agent env checks", () => {
  async function inRepo(env: (repo: string) => string) {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "doctor-layout-"));
    const repo = join(root, "workspace", "choibot");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".env"), env(root));
    try {
      return { res: await runChecks(repo), root, repo };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("warns, never fails, when the console checkout is inside WORKSPACE_DIR, and says why", async () => {
    const { res, root, repo } = await inRepo((r) => `WORKSPACE_DIR=${join(r, "workspace")}\n`);
    const c = res.find((r) => r.name === "workspace")!;
    expect(c).toMatchObject({ ok: false, required: false });
    expect(c.detail).toBe(`the console checkout ${repo} is inside WORKSPACE_DIR ${join(root, "workspace")}: agents work next to its .env and data`);
    expect(c.hint).toContain("fine when your agents work on the console repo itself");
    expect(hasRequiredFailure(res.filter((r) => r.name === "workspace"))).toBe(false);
  });

  it("passes the workspace check when the checkout is outside WORKSPACE_DIR", async () => {
    const { res, root } = await inRepo((r) => `WORKSPACE_DIR=${join(r, "agent-workspace")}\n`);
    expect(res.find((r) => r.name === "workspace")).toMatchObject({ ok: true, detail: join(root, "agent-workspace") });
  });

  it("agent env: AGENT_ENV_PASS unset warns and names the extra .env keys, never a value or a secret", async () => {
    const { res } = await inRepo(() => "PORT=3100\nTELEGRAM_BOT_TOKEN=tg-doctor\nMY_DB_URL=db-doctor\nTELEGRAM_CHAT_ID=1\n");
    const c = res.find((r) => r.name === "agent env")!;
    expect(c).toMatchObject({ ok: false, required: false });
    expect(c.detail).toBe("AGENT_ENV_PASS is not set: agents get every key of the console env but its secrets, from .env: MY_DB_URL, TELEGRAM_CHAT_ID");
    expect(c.hint).toContain("AGENT_ENV_PASS=");
    expect(JSON.stringify(c)).not.toMatch(/tg-doctor|db-doctor/);
  });

  it("agent env: AGENT_ENV_PASS set passes and names the listed keys", async () => {
    const none = (await inRepo(() => "AGENT_ENV_PASS=\n")).res.find((r) => r.name === "agent env")!;
    expect(none).toMatchObject({ ok: true, detail: "agents get only what they need to run" });
    const some = (await inRepo(() => "AGENT_ENV_PASS=MY_DB_URL, MY_KEY\n")).res.find((r) => r.name === "agent env")!;
    expect(some).toMatchObject({ ok: true, detail: "agents get only what they need to run, plus MY_DB_URL, MY_KEY" });
  });
});

// Phase 2c (Ruling P12): with CHIEF_AGENT_UID set, the chief check reports the
// hardening mode and its facts. Fixtures only: temp dirs for every data dir
// and the dtach dir, a fixture /proc tree; never the live ones.
describe("doctor chief mode report (hardened deployment)", () => {
  const SELF = process.getuid!();
  const AGENT = SELF + 1;
  let root: string;
  let fx: { chief: string; cron: string; homes: string; dtach: string; proc: string; claude: string };

  type FxProc = { pid: number; argv: string[]; uid: number; fd0?: string };
  async function world(procs: FxProc[]): Promise<void> {
    const { mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(fx.proc, "1"), { recursive: true });
    writeFileSync(join(fx.proc, "1", "cmdline"), "/sbin/init\0");
    writeFileSync(join(fx.proc, "1", "status"), "Name:\tsystemd\nUid:\t0\t0\t0\t0\n");
    for (const p of procs) {
      const d = join(fx.proc, String(p.pid));
      mkdirSync(join(d, "fd"), { recursive: true });
      writeFileSync(join(d, "cmdline"), p.argv.join("\0") + "\0");
      writeFileSync(join(d, "status"), `Name:\tdtach\nState:\tS (sleeping)\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\n`);
      if (p.fd0) symlinkSync(p.fd0, join(d, "fd", "0"));
    }
  }
  const dtachArgv = (sock: string) => ["/usr/local/bin/dtach", "-A", `${fx.dtach}/${sock}`, "-E", "-z", "-r", "winch", "claude"];
  const env = (over: Record<string, string | null> = {}): string => {
    const base: Record<string, string | null> = {
      CHIEF_ENABLED: "1", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_USER_AUTH: "log",
      CHIEF_AGENT_UID: String(AGENT), CHIEF_DATA_DIR: fx.chief, CRON_DATA_DIR: fx.cron,
      AGENT_HOME_ROOT: fx.homes, AGENT_DTACH_DIR: fx.dtach, AGENT_CLAUDE_CONFIG_DIR: fx.claude, ...over,
    };
    return Object.entries(base).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  };
  async function chiefOf(dotenv: string, envMode = 0o600) {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(root, ".env"), dotenv);
    chmodSync(join(root, ".env"), envMode); // checklist C2; check (1) reads it (ruling F6)
    return (await runChecks(root, { procRoot: fx.proc })).find((r) => r.name === "chief")!;
  }

  beforeEach(async () => {
    const { mkdtempSync, mkdirSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    root = mkdtempSync(join(tmpdir(), "doctor-hardened-"));
    fx = {
      chief: join(root, "chief"), cron: join(root, "cron"), homes: join(root, "homes"), dtach: join(root, "dtach"),
      proc: join(root, "proc"), claude: join(root, "agent-claude"),
    };
    for (const d of Object.values(fx)) mkdirSync(d);
    chmodSync(fx.chief, 0o700);
    chmodSync(fx.cron, 0o700);
    chmodSync(fx.homes, 0o3770);
    chmodSync(fx.dtach, 0o2770);
    chmodSync(fx.claude, 0o700);
  });
  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
  });

  it("strong: prints the mode, the data, cron and homes dirs' owner and mode, and the uid of every live agent session", async () => {
    await world([
      // a1: the agent-uid master (its fd/0 unreadable to the console) and the console's own client on a pts.
      { pid: 4101, argv: dtachArgv("choibot-a1.sock"), uid: AGENT },
      { pid: 4102, argv: dtachArgv("choibot-a1.sock"), uid: SELF, fd0: "/dev/pts/3" },
      { pid: 4201, argv: dtachArgv("choibot-b2.sock"), uid: AGENT },
      // A service session runs as the console uid by design: not an agent.
      { pid: 4301, argv: dtachArgv("choibot-svc-web.sock"), uid: SELF, fd0: "/dev/null" },
    ]);
    const c = await chiefOf(env());
    expect(c).toMatchObject({ ok: true, required: true });
    expect(c.detail).toBe([
      "on (log mode)",
      "mode: strong (gate assumed)",
      `data dir ${SELF} 0700`,
      `cron dir ${SELF} 0700`,
      `homes ${SELF} 3770`,
      `agent claude dir ${SELF} 0700`,
      `dtach dir ${fx.dtach}`,
      `agents: a1=${AGENT}, b2=${AGENT}`,
    ].join("\n"));
  });

  it("a 0755 cron dir is a weak reason", async () => {
    const { chmodSync } = await import("node:fs");
    chmodSync(fx.cron, 0o755);
    await world([{ pid: 4101, argv: dtachArgv("choibot-a1.sock"), uid: AGENT }]);
    const c = await chiefOf(env());
    expect(c.ok).toBe(true);
    expect(c.detail.split("\n")).toEqual([
      "on (log mode)",
      `mode: weak (gate assumed): cron dir ${fx.cron} mode 0755, want 0700`,
      `data dir ${SELF} 0700`,
      `cron dir ${SELF} 0755`,
      `homes ${SELF} 3770`,
      `agent claude dir ${SELF} 0700`,
      `dtach dir ${fx.dtach}`,
      `agents: a1=${AGENT}`,
    ]);
  });

  it("an agent session at the console uid: weak, named in the mode line and listed with its uid", async () => {
    await world([
      { pid: 4101, argv: dtachArgv("choibot-a1.sock"), uid: AGENT },
      { pid: 4401, argv: dtachArgv("choibot-c3.sock"), uid: SELF, fd0: "/dev/null" },
      { pid: 4402, argv: dtachArgv("choibot-c3.sock"), uid: SELF, fd0: "/dev/pts/7" },
    ]);
    const lines = (await chiefOf(env())).detail.split("\n");
    expect(lines[1]).toBe("mode: weak (gate assumed): agent c3: console-uid dtach pid 4401 fd/0 is /dev/null");
    expect(lines[6]).toBe(`dtach dir ${fx.dtach}`);
    expect(lines[7]).toBe(`agents: a1=${AGENT}, c3=${SELF}`);
  });

  // Ruling F6: the doctor and the server's check (1) read the same facts.
  it("a 0644 .env and a 2770 or agent-owned AGENT_HOME_ROOT are weak reasons", async () => {
    const { chmodSync } = await import("node:fs");
    await world([]);
    expect((await chiefOf(env(), 0o644)).detail.split("\n")[1])
      .toBe(`mode: weak (gate assumed): .env ${join(root, ".env")} mode 0644, want 0600`);
    chmodSync(fx.homes, 0o2770);
    expect((await chiefOf(env())).detail.split("\n")[1]).toBe(`mode: weak (gate assumed): homes ${fx.homes} mode 2770, want 3770`);
    chmodSync(fx.homes, 0o3770);
    expect((await chiefOf(env({ CHIEF_AGENT_UID: String(SELF) }))).detail.split("\n")[1])
      .toBe(`mode: weak (gate assumed): homes ${fx.homes} owner uid ${SELF} is CHIEF_AGENT_UID`);
  });

  it("names AGENT_CLAUDE_CONFIG_DIR when it is unset: hardened claude agents are refused (ruling F1)", async () => {
    await world([]);
    expect((await chiefOf(env({ AGENT_CLAUDE_CONFIG_DIR: null }))).detail.split("\n")[5])
      .toBe("agent claude dir: AGENT_CLAUDE_CONFIG_DIR not set (claude agents are refused)");
  });

  it("weak data dir first; no AGENT_HOME_ROOT; no live agent", async () => {
    const { chmodSync } = await import("node:fs");
    chmodSync(fx.chief, 0o750);
    await world([]);
    expect((await chiefOf(env({ AGENT_HOME_ROOT: null }))).detail.split("\n")).toEqual([
      "on (log mode)",
      `mode: weak (gate assumed): data dir ${fx.chief} mode 0750, want 0700`,
      `data dir ${SELF} 0750`,
      `cron dir ${SELF} 0700`,
      "homes: AGENT_HOME_ROOT not set",
      `agent claude dir ${SELF} 0700`,
      `dtach dir ${fx.dtach}`,
      "agents: none",
    ]);
  });

  it("a missing cron dir is unreadable, and a weak reason", async () => {
    await world([]);
    const missing = `${fx.cron}-missing`;
    expect((await chiefOf(env({ CRON_DATA_DIR: missing }))).detail.split("\n").slice(1, 4)).toEqual([
      `mode: weak (gate assumed): cron dir ${missing} unreadable (ENOENT)`,
      `data dir ${SELF} 0700`,
      "cron dir unreadable (ENOENT)",
    ]);
  });

  it("the plain line of `doctor`: Strong when the checks pass; a pointer to the details when one fails; none when not hardened", async () => {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { parseEnv } = await import("./env.js");
    const line = (dotenv: string) => {
      writeFileSync(join(root, ".env"), dotenv);
      chmodSync(join(root, ".env"), 0o600);
      return protectionLine(root, Object.fromEntries(parseEnv(dotenv)), fx.proc);
    };
    await world([]);
    expect(line(env())).toMatch(/^Protection: Strong\. Your agents run under their own account on this server/);
    chmodSync(fx.chief, 0o750);
    expect(line(env())).toMatch(/^Protection: Strong is set up, but one of its checks fails\. For the reason: .*doctor --details/);
    expect(line(env({ CHIEF_AGENT_UID: null }))).toBeNull();
    expect(line(env({ CHIEF_ENABLED: null }))).toBeNull();
  });

  it("not hardened: without CHIEF_AGENT_UID (or empty, or the flag off) the detail is exactly today's", async () => {
    await world([{ pid: 4401, argv: dtachArgv("choibot-c3.sock"), uid: SELF, fd0: "/dev/null" }]);
    expect(await chiefOf(env({ CHIEF_AGENT_UID: null }))).toMatchObject({ ok: true, detail: "on (log mode)" });
    expect(await chiefOf(env({ CHIEF_AGENT_UID: "" }))).toMatchObject({ ok: true, detail: "on (log mode)" });
    expect(await chiefOf(env({ CHIEF_ENABLED: null }))).toMatchObject({ ok: true, detail: "off" });
    expect(await chiefOf(env({ CHIEF_ENABLED: null, CHIEF_AGENT_UID: "abc" }))).toMatchObject({ ok: true, detail: "off" });
  });

  it("a set but invalid CHIEF_AGENT_UID: today's line plus one hint line, no report; ok stays true", async () => {
    await world([{ pid: 4401, argv: dtachArgv("choibot-c3.sock"), uid: SELF, fd0: "/dev/null" }]);
    expect(await chiefOf(env({ CHIEF_AGENT_UID: "0" }))).toMatchObject({
      ok: true, detail: 'on (log mode)\nCHIEF_AGENT_UID "0" is not a valid uid',
    });
    expect((await chiefOf(env({ CHIEF_AGENT_UID: "choibot-agent" }))).detail).toBe(
      'on (log mode)\nCHIEF_AGENT_UID "choibot-agent" is not a valid uid',
    );
  });

  // Ruling P8 (Task 2c-6): one `repo <name>: <problem>` line per
  // checkRepoProtection problem, for each direct child of WORKSPACE_DIR with a
  // .git directory. A fixture workspace only, never the real one.
  async function workspace(): Promise<string> {
    const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ws = join(root, "ws");
    const repo = (name: string, o: { config: number; gitSticky: boolean; hooksSticky: boolean; top?: number }) => {
      mkdirSync(join(ws, name, ".git", "hooks"), { recursive: true });
      chmodSync(join(ws, name), o.top ?? 0o755); // set: the test umask may be 002
      writeFileSync(join(ws, name, ".git", "config"), "[core]\n");
      chmodSync(join(ws, name, ".git", "config"), o.config);
      chmodSync(join(ws, name, ".git"), o.gitSticky ? 0o1755 : 0o775);
      chmodSync(join(ws, name, ".git", "hooks"), o.hooksSticky ? 0o1755 : 0o755);
    };
    repo("ok", { config: 0o644, gitSticky: true, hooksSticky: true });
    repo("bad", { config: 0o664, gitSticky: false, hooksSticky: true, top: 0o775 });
    repo("worse", { config: 0o644, gitSticky: true, hooksSticky: false });
    writeFileSync(join(ws, "bad", ".git", "commondir"), "/elsewhere\n"); // ruling 2c-6-d
    mkdirSync(join(ws, "wt"));
    writeFileSync(join(ws, "wt", ".git"), "gitdir: /nowhere/.git/worktrees/wt\n"); // a worktree: skipped
    mkdirSync(join(ws, "plain")); // no .git: skipped
    writeFileSync(join(ws, "a-file"), "x"); // not a dir: skipped
    return ws;
  }

  it("repo lines: one per checkRepoProtection problem, after the other lines; worktrees and non-repos skipped", async () => {
    await world([{ pid: 4101, argv: dtachArgv("choibot-a1.sock"), uid: AGENT }]);
    const ws = await workspace();
    const c = await chiefOf(env({ WORKSPACE_DIR: ws }));
    expect(c).toMatchObject({ ok: true, required: true });
    expect(c.detail.split("\n")).toEqual([
      "on (log mode)",
      "mode: strong (gate assumed)",
      `data dir ${SELF} 0700`,
      `cron dir ${SELF} 0700`,
      `homes ${SELF} 3770`,
      `agent claude dir ${SELF} 0700`,
      `dtach dir ${fx.dtach}`,
      `agents: a1=${AGENT}`,
      "repo bad: top dir is group- or world-writable (mode 0775) and has no sticky bit",
      "repo bad: .git/config mode 0664, want 0644",
      "repo bad: .git/ is group- or world-writable (mode 0775)",
      "repo bad: .git/ has no sticky bit",
      "repo bad: .git/commondir exists (a main repo has none)",
      "repo worse: .git/hooks/ has no sticky bit",
    ]);
  });

  it("repo lines: an unreadable WORKSPACE_DIR is one line", async () => {
    await world([]);
    const lines = (await chiefOf(env({ WORKSPACE_DIR: `${root}/no-ws` }))).detail.split("\n");
    expect(lines.slice(8)).toEqual([`repos: ${root}/no-ws unreadable (ENOENT)`]);
  });

  it("repo lines: none without CHIEF_AGENT_UID (or with the flag off), as today", async () => {
    await world([]);
    const ws = await workspace();
    expect(await chiefOf(env({ WORKSPACE_DIR: ws, CHIEF_AGENT_UID: null }))).toMatchObject({ ok: true, detail: "on (log mode)" });
    expect(await chiefOf(env({ WORKSPACE_DIR: ws, CHIEF_ENABLED: null }))).toMatchObject({ ok: true, detail: "off" });
  });

  it("formatChecks indents the lines of a multi-line detail under the first one", () => {
    const s = formatChecks([
      { name: "chief", ok: true, required: true, detail: "on (log mode)\nmode: strong (gate assumed)" },
      { name: "git", ok: true, required: true, detail: "/usr/bin/git" },
    ]);
    expect(s.split("\n")).toEqual([
      "✔ chief  on (log mode)",
      "         mode: strong (gate assumed)",
      "✔ git    /usr/bin/git",
    ]);
  });
});
