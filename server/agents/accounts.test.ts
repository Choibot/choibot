// server/agents/accounts.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdtemp, rm, mkdir, writeFile, readFile, lstat, readlink, symlink } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountPaths, isAccountId, accountDir, claudeAccountEnv, createAccount, syncAccountDir, healAccountDir, isShortLife,
  listAccounts, deleteAccount, accountExists, accessTokenFor, credentialsPath, type AccountPaths,
  forgetDefaultLogin, forgetSignedOut, isSignedOut, loadSignedOut, loginInPlaceOf, markSignedOut, preferredAccount, setDefaultLogin,
} from "./accounts.js";
import { utimes } from "node:fs/promises";

let base: string;
let p: AccountPaths;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "accts-"));
  p = { root: join(base, "accounts"), defaultDir: join(base, "claude"), defaultClaudeJson: join(base, ".claude.json") };
  await mkdir(join(p.defaultDir, "projects", "x"), { recursive: true });
  await mkdir(join(p.defaultDir, "plugins"), { recursive: true });
  await mkdir(join(p.defaultDir, "statsig"), { recursive: true });
  await writeFile(join(p.defaultDir, "settings.json"), "{}");
  await writeFile(join(p.defaultDir, "CLAUDE.md"), "# rules");
  await writeFile(join(p.defaultDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-default" } }));
  await writeFile(p.defaultClaudeJson, JSON.stringify({
    hasCompletedOnboarding: true, userID: "u1", projects: { "/w": { allowedTools: [] } },
    oauthAccount: { emailAddress: "a@example.com" },
    cachedGrowthBookFeatures: { x: 1 }, modelAccessCache: { y: 2 }, cachedExperimentFeaturesAt: 3, clientDataCacheSlots: {},
  }));
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe("accountPaths", () => {
  it("defaults to ~/.claude and ~/.claude.json when CLAUDE_CONFIG_DIR is unset", () => {
    const r = accountPaths({});
    expect(r.defaultDir.endsWith("/.claude")).toBe(true);
    expect(r.defaultClaudeJson.endsWith("/.claude.json")).toBe(true);
    expect(r.defaultClaudeJson).not.toContain("/.claude/.claude.json");
    expect(r.root.endsWith("/.claude-accounts")).toBe(true);
  });
  it("follows CLAUDE_CONFIG_DIR (where claude also moves .claude.json) and CLAUDE_ACCOUNTS_DIR", () => {
    const r = accountPaths({ CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_ACCOUNTS_DIR: "/acc" });
    expect(r).toEqual({ root: "/acc", defaultDir: "/cfg", defaultClaudeJson: "/cfg/.claude.json" });
  });
});

describe("isAccountId", () => {
  it.each(["work", "default", "a1", "team-2", "x_y"])("accepts %s", (v) => expect(isAccountId(v)).toBe(true));
  it.each(["", "Work", "../x", "a/b", ".hidden", "-lead", "a".repeat(33), 1, null, undefined, {}])(
    "rejects %s", (v) => expect(isAccountId(v)).toBe(false),
  );
});

describe("accountDir / claudeAccountEnv", () => {
  it("maps the default account to the real dir with no env", () => {
    expect(accountDir(undefined, p)).toBe(p.defaultDir);
    expect(accountDir("default", p)).toBe(p.defaultDir);
    expect(claudeAccountEnv(undefined, p)).toEqual({});
    expect(claudeAccountEnv("default", p)).toEqual({});
  });
  it("points a named account at its own dir via CLAUDE_CONFIG_DIR", () => {
    expect(accountDir("work", p)).toBe(join(p.root, "work"));
    expect(claudeAccountEnv("work", p)).toEqual({ CLAUDE_CONFIG_DIR: join(p.root, "work") });
  });
});

describe("createAccount", () => {
  it("builds a shadow dir: private entries own, everything else linked to the default dir", async () => {
    const info = await createAccount("work", p);
    expect(info).toEqual({ id: "work", label: "work", email: null, loggedIn: false, isDefault: false });
    const dir = join(p.root, "work");
    // shared: symlinks back to the real entries
    for (const name of ["projects", "plugins", "settings.json", "CLAUDE.md"]) {
      expect((await lstat(join(dir, name))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(dir, name))).toBe(join(p.defaultDir, name));
    }
    // private: no credentials, no statsig, own .claude.json
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
    expect(existsSync(join(dir, "statsig"))).toBe(false);
    expect((await lstat(join(dir, ".claude.json"))).isSymbolicLink()).toBe(false);
  });

  it("seeds .claude.json from the real one with the login and account caches stripped", async () => {
    await createAccount("work", p);
    const seeded = JSON.parse(await readFile(join(p.root, "work", ".claude.json"), "utf8"));
    expect(seeded).toEqual({ hasCompletedOnboarding: true, userID: "u1", projects: { "/w": { allowedTools: [] } } });
  });

  it("starts blank when there is no default .claude.json", async () => {
    await rm(p.defaultClaudeJson);
    await createAccount("work", p);
    expect(JSON.parse(await readFile(join(p.root, "work", ".claude.json"), "utf8"))).toEqual({});
  });

  it("rejects bad ids, the default id, and duplicates", async () => {
    await expect(createAccount("../x", p)).rejects.toThrow("invalid account id");
    await expect(createAccount("default", p)).rejects.toThrow("default");
    await createAccount("work", p);
    await expect(createAccount("work", p)).rejects.toThrow("already exists");
  });
});

describe("syncAccountDir", () => {
  it("links entries the default dir grew after creation, and leaves the account's own files alone", async () => {
    await createAccount("work", p);
    const dir = join(p.root, "work");
    await mkdir(join(p.defaultDir, "skills"));                 // new shared entry
    // The account replaced its settings link with a file of its own (claude
    // rewrote it); sync must not clobber that.
    await rm(join(dir, "settings.json"));
    await writeFile(join(dir, "settings.json"), "{\"own\":1}");
    await writeFile(join(p.defaultDir, ".credentials.json"), "{}"); // still private
    await syncAccountDir("work", p);
    expect((await lstat(join(dir, "skills"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(dir, "settings.json"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe("{\"own\":1}");
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });
  it("is a no-op for the default account", async () => {
    await syncAccountDir("default", p);
    expect(existsSync(p.root)).toBe(false);
  });
  it("refuses an invalid id rather than touching the filesystem", async () => {
    await expect(syncAccountDir("../evil", p)).rejects.toThrow("invalid account id");
  });
});

// 2026-11-21: a sync ran while a Claude of the default login held its locks and temp files. Their
// links stayed after the files went; then Claude could not take its write lock in the login's
// folder and never saved a sign-in.
describe("short-life entries of the default dir", () => {
  const SHORT = [".storage-write.lock", "history.jsonl.lock", ".credentials.json.tmp.ab12"];
  afterEach(() => vi.restoreAllMocks());

  it("isShortLife: locks and temp files of a write, nothing else", () => {
    for (const n of [...SHORT, ".storage-write", "x.json.tmp", "x.tmp.123", ".credentials.json.bak"]) expect(isShortLife(n), n).toBe(true);
    // daemon.lock is a real file that lives on, with the shared `daemon` folder.
    for (const n of ["settings.json", "projects", "history.jsonl", "plugins", "CLAUDE.md", "tmp", "locks", "daemon.lock"]) expect(isShortLife(n), n).toBe(false);
  });

  it("A: a sync links none of them; settings.json and daemon.lock still get their links", async () => {
    for (const n of [...SHORT, "daemon.lock"]) await writeFile(join(p.defaultDir, n), "");
    await createAccount("work", p);
    const dir = join(p.root, "work");
    for (const n of SHORT) expect(await lstat(join(dir, n)).catch(() => null), n).toBeNull();
    expect((await lstat(join(dir, "settings.json"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(dir, "daemon.lock"))).toBe(join(p.defaultDir, "daemon.lock"));
  });

  it("B: a sync removes the stale links of an older sync, and only those", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await createAccount("work", p);
    const dir = join(p.root, "work");
    // Links to the default dir that point at nothing now (the files went).
    for (const n of SHORT) await symlink(join(p.defaultDir, n), join(dir, n));
    // A real file and a real folder with short-life names: Claude's own, in this login.
    await writeFile(join(dir, "own.lock"), "pid");
    await mkdir(join(dir, "dir.lock"));
    // A link with a short-life name to another place, and a normal link.
    await symlink(join(base, "elsewhere.lock"), join(dir, "other.lock"));
    // daemon.lock (not short-life), and a link to the main login that an owner made by hand: a
    // private name is the login itself.
    await symlink(join(p.defaultDir, "daemon.lock"), join(dir, "daemon.lock"));
    await symlink(join(p.defaultDir, ".credentials.json"), join(dir, ".credentials.json"));
    await syncAccountDir("work", p);
    for (const n of SHORT) expect(await lstat(join(dir, n)).catch(() => null), n).toBeNull();
    expect((await lstat(join(dir, "own.lock"))).isFile()).toBe(true);
    expect((await lstat(join(dir, "dir.lock"))).isDirectory()).toBe(true);
    expect(await readlink(join(dir, "other.lock"))).toBe(join(base, "elsewhere.lock"));
    expect(await readlink(join(dir, "settings.json"))).toBe(join(p.defaultDir, "settings.json"));
    expect(await readlink(join(dir, "daemon.lock"))).toBe(join(p.defaultDir, "daemon.lock"));
    expect(await readlink(join(dir, ".credentials.json"))).toBe(join(p.defaultDir, ".credentials.json"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[accounts\] login work: removed 3 stale links to short-life files/));
  });

  it("healAccountDir does the same with no sync; the default login and a login with no folder are left", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await createAccount("work", p);
    const dir = join(p.root, "work");
    await symlink(join(p.defaultDir, ".storage-write.lock"), join(dir, ".storage-write.lock"));
    await mkdir(join(p.defaultDir, "skills"));
    healAccountDir("work", p);
    expect(await lstat(join(dir, ".storage-write.lock")).catch(() => null)).toBeNull();
    expect(existsSync(join(dir, "skills"))).toBe(false); // a heal links nothing
    // The real dir is never changed.
    await writeFile(join(p.defaultDir, "x.lock"), "");
    healAccountDir("default", p);
    expect(existsSync(join(p.defaultDir, "x.lock"))).toBe(true);
    expect(() => healAccountDir("none", p)).not.toThrow();
    expect(() => healAccountDir("../evil", p)).toThrow("invalid account id");
  });
});

// The owner's console, 2026-11-25: ~/.claude/tasks is gone (Claude's own clean-up removes it), and
// the `tasks` of a login is the link of an older sync to it: a link that points at nothing. Then
// no agent of that login can save a task (Claude Code makes the folder with `mkdir -p`, which
// fails through such a link, and it ignores only EEXIST). Where the console makes or heals a
// login's folder, the target is made again: the default login's tasks folder, 0700.
describe("a login's tasks link that points at nothing", () => {
  const SID = "0b9c5a4e-7f1d-4c2a-9e3b-1d2c3b4a5f6e";
  afterEach(() => vi.restoreAllMocks());
  async function deadLink(): Promise<string> {
    await createAccount("work", p);
    const dir = join(p.root, "work");
    await symlink(join(p.defaultDir, "tasks"), join(dir, "tasks"));
    return dir;
  }

  it("the cause: Node's mkdir -p of a session's tasks folder through it fails (ENOENT; ENOTDIR async)", async () => {
    const dir = await deadLink();
    expect(() => mkdirSync(join(dir, "tasks", SID), { recursive: true })).toThrow(expect.objectContaining({ code: "ENOENT" }));
    await expect(mkdir(join(dir, "tasks", SID), { recursive: true })).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(() => writeFileSync(join(dir, "tasks", SID, "1.json"), "{}")).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("a sync makes its target (0700, the console's), one log line; then mkdir -p works and the files land in the default login's folder", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await deadLink();
    await syncAccountDir("work", p);
    const st = await lstat(join(p.defaultDir, "tasks"));
    expect([st.isDirectory(), st.mode & 0o7777, st.uid]).toEqual([true, 0o700, process.getuid!()]);
    expect(await readlink(join(dir, "tasks"))).toBe(join(p.defaultDir, "tasks"));
    mkdirSync(join(dir, "tasks", SID), { recursive: true });
    writeFileSync(join(dir, "tasks", SID, "1.json"), "{}");
    expect(existsSync(join(p.defaultDir, "tasks", SID, "1.json"))).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(`[accounts] login work: its tasks link pointed at nothing; made ${join(p.defaultDir, "tasks")} (0700)`);
  });

  it("healAccountDir does the same", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await deadLink();
    healAccountDir("work", p);
    expect((await lstat(join(p.defaultDir, "tasks"))).isDirectory()).toBe(true);
  });

  it("nothing is made for a link to another place, a link whose target is itself a link, or a real tasks folder of the login", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await createAccount("work", p);
    const dir = join(p.root, "work");
    await symlink(join(base, "elsewhere"), join(dir, "tasks"));
    await syncAccountDir("work", p);
    expect(existsSync(join(base, "elsewhere"))).toBe(false);
    expect(await lstat(join(p.defaultDir, "tasks")).catch(() => null)).toBeNull();
    // The default login's tasks is a link that points at nothing: never made through it.
    await rm(join(dir, "tasks"));
    await symlink(join(p.defaultDir, "tasks"), join(dir, "tasks"));
    await symlink(join(base, "via"), join(p.defaultDir, "tasks"));
    await syncAccountDir("work", p);
    expect(existsSync(join(base, "via"))).toBe(false);
    // A real folder of the login: left as it is.
    await rm(join(dir, "tasks"));
    await mkdir(join(dir, "tasks"));
    await syncAccountDir("work", p);
    expect((await lstat(join(dir, "tasks"))).isDirectory()).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("listAccounts / accountExists / tokens", () => {
  it("lists default first, reads email + login state per account", async () => {
    await createAccount("work", p);
    await createAccount("alt", p);
    await writeFile(join(p.root, "alt", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-alt" } }));
    await writeFile(join(p.root, "alt", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "alt@example.com" } }));
    await mkdir(join(p.root, "Not-An-Id")); // ignored: bad id
    const list = await listAccounts(p);
    expect(list).toEqual([
      { id: "default", label: "a@example.com", email: "a@example.com", loggedIn: true, isDefault: true },
      { id: "alt", label: "alt@example.com", email: "alt@example.com", loggedIn: true, isDefault: false },
      { id: "work", label: "work", email: null, loggedIn: false, isDefault: false },
    ]);
    expect(await accountExists("work", p)).toBe(true);
    expect(await accountExists("nope", p)).toBe(false);
    expect(await accountExists("default", p)).toBe(true);
    expect(await accessTokenFor(undefined, p)).toBe("tok-default");
    expect(await accessTokenFor("alt", p)).toBe("tok-alt");
    expect(await accessTokenFor("work", p)).toBeNull();
    expect(credentialsPath("alt", p)).toBe(join(p.root, "alt", ".credentials.json"));
  });
  it("returns just the default when no accounts root exists", async () => {
    expect((await listAccounts(p)).map((a) => a.id)).toEqual(["default"]);
  });
});

describe("deleteAccount", () => {
  it("removes the shadow dir without touching the real entries it linked to", async () => {
    await createAccount("work", p);
    await deleteAccount("work", p);
    expect(existsSync(join(p.root, "work"))).toBe(false);
    expect(existsSync(join(p.defaultDir, "projects", "x"))).toBe(true);
    expect(await readFile(join(p.defaultDir, "CLAUDE.md"), "utf8")).toBe("# rules");
  });
  it("refuses the default account and bad ids", async () => {
    await expect(deleteAccount("default", p)).rejects.toThrow("default");
    await expect(deleteAccount("../x", p)).rejects.toThrow("invalid");
    expect(existsSync(p.defaultDir)).toBe(true);
  });
});

describe("preferred account (CLAUDE_DEFAULT_ACCOUNT)", () => {
  it("reads a valid non-default id and ignores everything else", async () => {
    const { preferredAccount } = await import("./accounts.js");
    expect(preferredAccount({ CLAUDE_DEFAULT_ACCOUNT: "office" })).toBe("office");
    expect(preferredAccount({ CLAUDE_DEFAULT_ACCOUNT: " office " })).toBe("office");
    expect(preferredAccount({ CLAUDE_DEFAULT_ACCOUNT: "default" })).toBeUndefined();
    expect(preferredAccount({ CLAUDE_DEFAULT_ACCOUNT: "Bad Id" })).toBeUndefined();
    expect(preferredAccount({})).toBeUndefined();
  });

  it("spawn resolution: no account named → the preferred one when it exists; explicit default stays default", async () => {
    const { resolveAccount } = await import("./spawn.js");
    const { preferredAccountIfExists } = await import("./accounts.js");
    const saved = process.env.CLAUDE_DEFAULT_ACCOUNT;
    try {
      process.env.CLAUDE_DEFAULT_ACCOUNT = "office";
      expect(await resolveAccount(undefined, "claude", p)).toEqual({}); // dir missing → default
      expect(await preferredAccountIfExists(p)).toEqual({});
      await createAccount("office", p);
      expect(await resolveAccount(undefined, "claude", p)).toEqual({ account: "office" });
      expect(await resolveAccount("", "claude", p)).toEqual({ account: "office" });
      expect(await resolveAccount("default", "claude", p)).toEqual({});
      expect(await resolveAccount(undefined, "codex", p)).toEqual({});
      expect(await preferredAccountIfExists(p)).toEqual({ account: "office" });
      delete process.env.CLAUDE_DEFAULT_ACCOUNT;
      expect(await resolveAccount(undefined, "claude", p)).toEqual({});
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_DEFAULT_ACCOUNT; else process.env.CLAUDE_DEFAULT_ACCOUNT = saved;
    }
  });
});

// Ruling F1: in a hardened deployment the console never makes files by path in
// a Claude dir an agent can write: createAccount and syncAccountDir run only
// in an accounts root (and account dir) the console owns and no group can
// write. Not hardened: today's behaviour, whatever the modes.
describe("account dirs in a hardened deployment (ruling F1)", () => {
  const HARDENED = {
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
  };
  const hardened = () => { for (const [k, v] of Object.entries(HARDENED)) vi.stubEnv(k, v); };
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("createAccount refuses a group-writable accounts root: nothing made, one log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mkdir(p.root, { recursive: true });
    await chmod(p.root, 0o2770);
    hardened();
    await expect(createAccount("work", p)).rejects.toThrow(/^\[chief\] accounts dir .* mode 2770 is group- or other-writable/);
    expect(existsSync(join(p.root, "work"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("syncAccountDir skips a group-writable account dir: no link made, one log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mkdir(join(p.root, "work"), { recursive: true });
    await chmod(p.root, 0o700);
    await chmod(join(p.root, "work"), 0o770);
    hardened();
    await syncAccountDir("work", p);
    expect(existsSync(join(p.root, "work", "settings.json"))).toBe(false);
    expect(warn.mock.calls).toEqual([[
      `[chief] accounts dir ${join(p.root, "work")} mode 0770 is group- or other-writable; not synced in a hardened deployment`,
    ]]);
  });

  it("healAccountDir skips a group-writable account dir too: no link removed, one log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mkdir(join(p.root, "work"), { recursive: true });
    await chmod(p.root, 0o700);
    await chmod(join(p.root, "work"), 0o770);
    await symlink(join(p.defaultDir, ".storage-write.lock"), join(p.root, "work", ".storage-write.lock"));
    hardened();
    healAccountDir("work", p);
    expect((await lstat(join(p.root, "work", ".storage-write.lock"))).isSymbolicLink()).toBe(true);
    expect(warn.mock.calls).toEqual([[
      `[chief] accounts dir ${join(p.root, "work")} mode 0770 is group- or other-writable; not healed in a hardened deployment`,
    ]]);
  });

  it("an own accounts root no group can write: createAccount works as before", async () => {
    await mkdir(p.root, { recursive: true });
    await chmod(p.root, 0o700);
    hardened();
    await createAccount("work", p);
    expect((await lstat(join(p.root, "work", "settings.json"))).isSymbolicLink()).toBe(true);
  });

  it("not hardened: a group-writable root changes nothing", async () => {
    await mkdir(p.root, { recursive: true });
    await chmod(p.root, 0o2770);
    vi.stubEnv("CHIEF_AGENT_UID", "1001"); // a uid alone (flag off) is not hardened
    await createAccount("work", p);
    expect((await lstat(join(p.root, "work", "settings.json"))).isSymbolicLink()).toBe(true);
  });
});

// A credentials file can hold a token that no longer works ("OAuth token revoked · Please run
// /login"): only an agent's session can tell. The live console, 2026-11-20: GET /api/accounts
// said loggedIn for such a login, and new agents kept starting on it.
describe("a login that Claude reported as signed out", () => {
  const NOW = 1_800_000_000_000;
  const credsAt = (id: string, at: number) => utimes(credentialsPath(id, p), at / 1000, at / 1000);
  const logIn = async (id: string) => {
    await createAccount(id, p);
    await writeFile(credentialsPath(id, p), JSON.stringify({ claudeAiOauth: { accessToken: `tok-${id}` } }));
    await credsAt(id, NOW - 86_400_000);
  };
  beforeEach(async () => {
    forgetSignedOut(); forgetDefaultLogin();
    await credsAt("default", NOW - 86_400_000);
    await loadSignedOut(join(base, "data", "logins-signed-out.json"), p);
  });
  afterEach(() => { forgetSignedOut(); forgetDefaultLogin(); });

  it("is not logged in any more: the list says signed out, and the mark outlives a restart", async () => {
    await logIn("office");
    expect((await listAccounts(p)).map((a) => [a.id, a.loggedIn, a.signedOut])).toEqual([["default", true, undefined], ["office", true, undefined]]);
    expect(await markSignedOut("office", NOW, p)).toBe(true);
    expect((await listAccounts(p)).map((a) => [a.id, a.loggedIn, a.signedOut])).toEqual([["default", true, undefined], ["office", false, true]]);
    expect(isSignedOut("office")).toBe(true);
    forgetSignedOut();
    expect((await listAccounts(p)).find((a) => a.id === "office")!.loggedIn).toBe(true);
    await loadSignedOut(join(base, "data", "logins-signed-out.json"), p);
    expect((await listAccounts(p)).find((a) => a.id === "office")).toMatchObject({ loggedIn: false, signedOut: true });
  });

  it("the user signs in again (a newer credentials file): the mark ends", async () => {
    await logIn("office");
    await markSignedOut("office", NOW, p);
    await credsAt("office", NOW + 60_000);
    expect((await listAccounts(p)).find((a) => a.id === "office")).toMatchObject({ loggedIn: true });
    expect(isSignedOut("office")).toBe(false);
    // An error line from before that sign-in is of the old token: no new mark.
    expect(await markSignedOut("office", NOW + 30_000, p)).toBe(false);
    expect(isSignedOut("office")).toBe(false);
  });

  it("the default login moves on to a login that works, and comes back after the sign-in", async () => {
    await logIn("office");
    await setDefaultLogin("office", join(base, "data", "default-login.json"));
    expect(preferredAccount({})).toBe("office");
    await markSignedOut("office", NOW, p);
    expect(preferredAccount({})).toBeUndefined(); // the main login
    await credsAt("office", NOW + 60_000);
    await listAccounts(p);
    expect(preferredAccount({})).toBe("office");
  });

  it("the main login is signed out: the default is another login that works", async () => {
    await logIn("work");
    expect(preferredAccount({})).toBeUndefined();
    await markSignedOut(undefined, NOW, p);
    expect((await listAccounts(p))[0]).toMatchObject({ id: "default", loggedIn: false, signedOut: true });
    expect(preferredAccount({})).toBe("work");
  });

  it("a console-made agent starts on a login that works: the default first; its own login when that works", async () => {
    await logIn("office"); await logIn("work");
    expect(await loginInPlaceOf("office", p)).toBeNull();
    await markSignedOut("office", NOW, p);
    expect(await loginInPlaceOf("office", p)).toEqual({ account: undefined });
    expect(await loginInPlaceOf("work", p)).toBeNull();
    await setDefaultLogin("work", join(base, "data", "default-login.json"));
    expect(await loginInPlaceOf("office", p)).toEqual({ account: "work" });
    // No other login works: it keeps its login.
    await markSignedOut("work", NOW, p); await markSignedOut(undefined, NOW, p);
    expect(await loginInPlaceOf("office", p)).toBeNull();
  });
});
