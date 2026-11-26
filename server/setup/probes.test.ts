// server/setup/probes.test.ts — the probes of the step list give plain facts: each one against
// a fake tool (the exec seam is mocked: nothing is spawned) or fake console state.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../bin/lib/exec.js", () => ({ which: vi.fn(), run: vi.fn() }));
vi.mock("../gh/repos.js", () => ({ listRepos: vi.fn() }));
vi.mock("../gh/exec.js", async (orig) => ({ ...(await orig<typeof import("../gh/exec.js")>()), gh: vi.fn() }));
vi.mock("../agents/git.js", async (orig) => ({ ...(await orig<typeof import("../agents/git.js")>()), runGit: vi.fn() }));

import { run, which } from "../../bin/lib/exec.js";
import { runGit } from "../agents/git.js";
import type { AgentRecord } from "../agents/store.js";
import type { QueueItem } from "../chief/queue/types.js";
import { gh, GhError } from "../gh/exec.js";
import { listRepos } from "../gh/repos.js";
import type { AppTokenState } from "../gh/applogin.js";
import { boxProbes, consoleProbes, pushRepos, type ConsoleDeps } from "./probes.js";
import type { BoxFacts } from "./steps.js";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "") => ({ code: 1, stdout: "", stderr });
const box = (env: Record<string, string | undefined> = {}) => boxProbes({ env, box: async () => ({}) as BoxFacts });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "setup-probes-"));
  vi.mocked(which).mockReset().mockImplementation(async (b) => `/usr/bin/${b}`);
  vi.mocked(run).mockReset().mockResolvedValue(ok());
  vi.mocked(listRepos).mockReset().mockResolvedValue([]);
  vi.mocked(gh).mockReset().mockResolvedValue("");
  vi.mocked(runGit).mockReset().mockResolvedValue({ stdout: "abc\n", stderr: "" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("claude", () => {
  const env = (over: Record<string, string> = {}) => ({ CLAUDE_CONFIG_DIR: dir, CLAUDE_ACCOUNTS_DIR: join(dir, "accounts"), PATH: "", ...over });

  it("finds the program the settings name, and no login in an empty config dir", async () => {
    expect(await box(env({ CLAUDE_CODE_EXECUTABLE: process.execPath })).claude()).toEqual({ installed: true, loggedIn: false });
  });

  it("says not installed when the named program is not there, or none is on the box", async () => {
    expect((await box(env({ CLAUDE_CODE_EXECUTABLE: join(dir, "no-claude") })).claude()).installed).toBe(false);
    expect((await box(env()).claude()).installed).toBe(false);
  });

  it("sees a login", async () => {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "made-up-for-this-test" } }));
    expect((await box(env()).claude()).loggedIn).toBe(true);
  });
});

describe("access", () => {
  it("says none without Tailscale", async () => {
    vi.mocked(which).mockResolvedValue(null);
    expect(await box().access()).toEqual({ state: "none" });
  });

  it("says signed out when Tailscale does not answer", async () => {
    vi.mocked(run).mockResolvedValue(fail("tailscaled not running"));
    expect(await box().access()).toEqual({ state: "signed-out" });
  });

  it("is ready only when the address goes to the console's own port", async () => {
    vi.mocked(run).mockResolvedValue(ok("https://box.example.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3100\n"));
    expect(await box().access()).toEqual({ state: "ready" });
    expect(await box({ PORT: "3101" }).access()).toEqual({ state: "no-address" });
  });
});

describe("github", () => {
  // git config --global --get <key>: the value, or exit 1 when it is not set.
  const commits = (name = "Ada", mail = "ada@example.invalid") => vi.mocked(runGit).mockImplementation(async (_p, args) => {
    const v = args.includes("user.name") ? name : mail;
    if (!v) throw new Error("exit 1");
    return { stdout: `${v}\n`, stderr: "" };
  });

  it("gives the login and the commit name", async () => {
    vi.mocked(gh).mockResolvedValue("ada-dev\n");
    commits();
    expect(await box().github()).toEqual({ installed: true, login: "ada-dev", commitName: true });
    expect(vi.mocked(gh)).toHaveBeenCalledWith(["api", "user", "--jq", ".login"]);
  });

  it("says not installed when the GitHub tool is not on the box", async () => {
    vi.mocked(gh).mockRejectedValue(new GhError("unknown", "spawn gh ENOENT"));
    expect(await box().github()).toEqual({ installed: false, login: null, commitName: false });
  });

  it("tells a missing login from no answer", async () => {
    commits();
    vi.mocked(gh).mockRejectedValue(new GhError("not_authed", "To get started with GitHub CLI, please run:  gh auth login"));
    expect(await box().github()).toEqual({ installed: true, login: null, problem: "signed-out", commitName: true });
    vi.mocked(gh).mockRejectedValue(new GhError("unknown", "gh: Bad credentials (HTTP 401)"));
    expect(await box().github()).toMatchObject({ login: null, problem: "signed-out" });
    vi.mocked(gh).mockRejectedValue(new GhError("unknown", "error connecting to api.github.com"));
    expect(await box().github()).toMatchObject({ login: null, problem: "no-answer" });
  });

  it("takes only a text that is a GitHub login", async () => {
    vi.mocked(gh).mockResolvedValue("{\"message\": \"not a login\"}");
    expect(await box().github()).toMatchObject({ login: null, problem: "no-answer" });
  });

  it("with the GitHub app switch on, only the app's key counts: never another login of gh", async () => {
    vi.mocked(gh).mockClear();
    vi.mocked(gh).mockResolvedValue("ada-dev\n");
    commits();
    const withApp = (t: AppTokenState) => boxProbes({ env: {}, box: async () => ({}) as BoxFacts, githubApp: async () => t });
    expect(await withApp({ state: "none" }).github()).toEqual({ installed: true, login: null, problem: "app-none", commitName: false });
    expect(await withApp({ state: "signed-out", why: "refused" }).github()).toMatchObject({ login: null, problem: "app-refused" });
    expect(await withApp({ state: "signed-out", why: "ended" }).github()).toMatchObject({ login: null, problem: "app-ended" });
    // gh was not asked: its stored login (the old one) never makes the step done.
    expect(vi.mocked(gh)).not.toHaveBeenCalled();
    expect(await withApp({ state: "ok", accessExpiresAt: null, refreshExpiresAt: null }).github()).toEqual({ installed: true, login: "ada-dev", commitName: true });
    expect(await withApp({ state: "ok", accessExpiresAt: null, refreshExpiresAt: null, unsaved: true }).github()).toMatchObject({ login: "ada-dev", unsaved: true });
  });

  it("needs both a name and an e-mail for commits", async () => {
    vi.mocked(gh).mockResolvedValue("ada-dev");
    commits("Ada", "");
    expect((await box().github()).commitName).toBe(false);
    commits("", "ada@example.invalid");
    expect((await box().github()).commitName).toBe(false);
  });
});

describe("repos", () => {
  const repo = (name: string) => ({ name, slug: `acme/${name}`, path: join(dir, name) });
  const push = (can: string[]) => vi.mocked(gh).mockImplementation(async (args) =>
    (can.some((n) => args[1] === `repos/acme/${n}`) ? "true\n" : "false\n"));

  it("counts no repo", async () => {
    expect(await box({ WORKSPACE_DIR: dir }).repos()).toEqual({ onBox: 0, canPush: null });
    expect(vi.mocked(listRepos)).toHaveBeenCalledWith(dir);
    expect(vi.mocked(gh)).not.toHaveBeenCalled();
  });

  it("gives the first repo, by name, that GitHub lets this login push to", async () => {
    vi.mocked(listRepos).mockResolvedValue([repo("api"), repo("infra"), repo("shop")]);
    push(["infra", "shop"]);
    expect(await box().repos()).toEqual({ onBox: 3, canPush: "infra" });
  });

  it("says no push when every repo is read only, or GitHub gives no answer", async () => {
    vi.mocked(listRepos).mockResolvedValue([repo("api"), repo("shop")]);
    push([]);
    expect(await box().repos()).toEqual({ onBox: 2, canPush: null });
    vi.mocked(gh).mockRejectedValue(new GhError("not_authed", "gh auth login"));
    expect(await box().repos()).toEqual({ onBox: 2, canPush: null });
  });

  it("skips a repo with no commit", async () => {
    vi.mocked(listRepos).mockResolvedValue([repo("empty"), repo("shop")]);
    vi.mocked(runGit).mockImplementation(async (path) => {
      if (path.endsWith("empty")) throw new Error("fatal: needed a single revision");
      return { stdout: "abc\n", stderr: "" };
    });
    push(["empty", "shop"]);
    expect(await box().repos()).toEqual({ onBox: 2, canPush: "shop" });
  });

  it("stops asking GitHub after the first group with a hit", async () => {
    vi.mocked(listRepos).mockResolvedValue(Array.from({ length: 12 }, (_, i) => repo(`r${String(i).padStart(2, "0")}`)));
    push(["r01"]);
    expect((await box().repos()).canPush).toBe("r01");
    expect(vi.mocked(gh)).toHaveBeenCalledTimes(5);
  });

  it("pushRepos gives every repo with push access, in the order of the work folder (the first task)", async () => {
    vi.mocked(listRepos).mockResolvedValue([repo("api"), repo("empty"), repo("infra"), repo("notes"), repo("old"), repo("shop"), repo("zed")]);
    vi.mocked(runGit).mockImplementation(async (path) => {
      if (path.endsWith("empty")) throw new Error("fatal: needed a single revision");
      return { stdout: "abc\n", stderr: "" };
    });
    push(["api", "empty", "notes", "shop"]);
    expect(await pushRepos({ WORKSPACE_DIR: dir })).toEqual({ onBox: 7, names: ["api", "notes", "shop"] });
    expect(await pushRepos({ WORKSPACE_DIR: dir }, { first: true })).toEqual({ onBox: 7, names: ["api"] });
  });
});

describe("the probes of the running console", () => {
  const TOKEN = "123456789:AAH-made-up-token-for-tests-ONLY_x";
  const rec = (id: string, over: Partial<AgentRecord> = {}): AgentRecord =>
    ({ id, label: id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null, hookToken: "h", status: "idle", createdAt: 1, ...over });
  const item = (id: string, over: Partial<QueueItem> = {}): QueueItem =>
    ({ id, kind: "pr", status: "open", ...over }) as QueueItem;

  function deps(o: { records?: AgentRecord[]; items?: QueueItem[]; devices?: number; problem?: string | null; chief?: boolean;
    areas?: Record<string, { repos: string[]; leadId?: string }> | null; env?: Record<string, string>; botOk?: boolean; link?: ConsoleDeps["link"] } = {}) {
    const records = o.records ?? [];
    const list = vi.fn(async () => o.items ?? []);
    const bot = vi.fn(async () => (o.botOk === false ? { ok: false as const, error: "Unauthorized" } : { ok: true as const, username: "b", name: "B" }));
    const d: ConsoleDeps = {
      env: o.env ?? {},
      agents: { list: async () => records, exists: async (id) => records.some((r) => r.id === id) },
      ...(o.chief === false ? {} : { chief: {
        problem: o.problem ?? null,
        devices: { list: async () => Array.from({ length: o.devices ?? 0 }, (_, i) => ({ label: `d${i}`, createdAt: 1, lastUsedAt: 1 })) },
        queue: { list },
      } }),
      ...(o.areas === null ? {} : { areas: { read: async () => o.areas ?? {} } }),
      bot,
      ...(o.link ? { link: o.link } : {}),
    };
    return { probes: consoleProbes(d), list, bot };
  }

  it("counts the paired devices, and says when pairing is off", async () => {
    expect(await deps({ devices: 2 }).probes.devices()).toEqual({ pairing: true, count: 2 });
    expect(await deps({ chief: false }).probes.devices()).toEqual({ pairing: false, count: 0 });
    expect(await deps({ devices: 2, problem: "the Queue cannot start" }).probes.devices()).toEqual({ pairing: false, count: 0 });
  });

  it("counts worker agents only, and the pull requests on record", async () => {
    const { probes } = deps({
      records: [
        rec("w1", { status: "running" }), rec("w2", { status: "running", closedAt: 5 }), rec("w3", { kind: "issue" }),
        rec("fleet-master", { kind: "fleet-master", status: "running" }), rec("lead-app", { kind: "lead", status: "running" }),
      ],
      items: [item("q1"), item("q2", { kind: "choice" }), item("q3", { status: "withdrawn", lastError: "merged" })],
    });
    expect(await probes.agents()).toEqual({ started: 3, running: 1, pullRequests: 2, tickets: true });
  });

  it("counts only a pull request ticket that closed as merged", async () => {
    const { probes, list } = deps({ items: [
      item("q1"), item("q2", { status: "withdrawn", lastError: "closed" }), item("q3", { status: "withdrawn", lastError: "merged" }),
      item("q4", { kind: "choice", status: "withdrawn", lastError: "merged" }), item("q5", { status: "answered" }),
    ] });
    expect(await probes.merged()).toEqual({ count: 1 });
    await probes.agents();
    expect(list).toHaveBeenCalledTimes(1); // the tickets are read one time for both probes
    expect(await deps({ chief: false }).probes.merged()).toEqual({ count: 0 });
  });

  it("says Telegram is not set up without a bot, and asks nobody", async () => {
    const { probes, bot } = deps();
    expect(await probes.telegram()).toEqual({ bot: "none", account: false, tested: false, name: null, tickets: false, master: false });
    expect(bot).not.toHaveBeenCalled();
  });

  it("reads the account that a one-time code connected: its name and the test message", async () => {
    const env = { TELEGRAM_BOT_TOKEN: TOKEN };
    const link = (v: { connected: boolean; name: string | null; tested: boolean }) => async () => v;
    expect(await deps({ env, link: link({ connected: false, name: null, tested: false }) }).probes.telegram())
      .toEqual({ bot: "ok", account: false, tested: false, name: null, tickets: false, master: false });
    // The account is in the settings after the restart: the ticket cards go to its chat with the bot.
    const bound = { ...env, TELEGRAM_ISSUES_USER_ID: "4242" };
    expect(await deps({ env: bound, link: link({ connected: true, name: "@ada", tested: true }) }).probes.telegram())
      .toEqual({ bot: "ok", account: true, tested: true, name: "@ada", tickets: true, master: false });
    // With the Queue off no ticket card goes anywhere.
    expect((await deps({ env: bound, chief: false, link: link({ connected: true, name: "@ada", tested: true }) }).probes.telegram()).tickets).toBe(false);
  });

  it("sees the bot and the chat of the tickets, and never gives the token", async () => {
    const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ISSUES_USER_ID: "4242", TELEGRAM_MASTER_CHAT_ID: "-1001234567890", TELEGRAM_MASTER_THREAD_ID: "2" };
    const full = await deps({ env }).probes.telegram();
    // The ids set by hand in the settings file (the owner's console): an account, no test on record.
    const byHand = { account: true, tested: false, name: null };
    expect(full).toEqual({ bot: "ok", ...byHand, tickets: true, master: true });
    expect(JSON.stringify(full)).not.toContain(TOKEN);
    expect(await deps({ env: { TELEGRAM_BOT_TOKEN: TOKEN } }).probes.telegram()).toEqual({ bot: "ok", account: false, tested: false, name: null, tickets: false, master: false });
    expect(await deps({ env, botOk: false }).probes.telegram()).toEqual({ bot: "failed", ...byHand, tickets: true, master: true });
    expect(await deps({ env, chief: false }).probes.telegram()).toEqual({ bot: "ok", ...byHand, tickets: false, master: true });
  });

  it("counts the leads that exist", async () => {
    const areas = { app: { repos: ["shop"], leadId: "lead-app" }, api: { repos: ["api"], leadId: "lead-api" }, docs: { repos: ["docs"] } };
    expect(await deps({ areas, records: [rec("lead-app", { kind: "lead" })] }).probes.leads()).toEqual({ on: true, live: 1 });
    expect(await deps({ areas: null }).probes.leads()).toEqual({ on: false, live: 0 });
  });
});
