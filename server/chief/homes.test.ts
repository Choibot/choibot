// server/chief/homes.test.ts — agentHomeRoot (Phase 2c, ruling P5) and the
// persistent agents' homes (Task 2c-7).
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentHomeRoot, ensureHomeModes, homeRecordPatch, migrateMemory, mkdirHome, persistentHome, retargetRecord, warnLegacyHome,
  writeHomeFile,
} from "./homes.js";
import type { AgentRecord } from "../agents/store.js";

const HARDENED = {
  CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
};
// Rollback (checklist C10): CHIEF_AGENT_UID removed, AGENT_HOME_ROOT kept.
const ROLLED_BACK = { ...HARDENED, CHIEF_AGENT_UID: undefined };

const tmps: string[] = [];
afterEach(async () => { while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true }); });
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o7777;
// Runs fn with umask 022 (the console's), then puts the old umask back.
async function withUmask022<T>(fn: () => Promise<T>): Promise<T> {
  const old = process.umask(0o022);
  try { return await fn(); } finally { process.umask(old); }
}

describe("agentHomeRoot", () => {
  it("is AGENT_HOME_ROOT (trimmed) in a hardened deployment", () => {
    expect(agentHomeRoot({ ...HARDENED, AGENT_HOME_ROOT: "/home/choibot-agent/homes" })).toBe("/home/choibot-agent/homes");
    expect(agentHomeRoot({ ...HARDENED, AGENT_HOME_ROOT: " /srv/homes\n" })).toBe("/srv/homes");
  });

  it("is null when AGENT_HOME_ROOT is unset, empty or relative", () => {
    for (const v of [undefined, "", "  ", "homes", "./homes"]) {
      expect(agentHomeRoot({ ...HARDENED, AGENT_HOME_ROOT: v }), String(v)).toBeNull();
    }
  });

  it("is null when not hardened, even with AGENT_HOME_ROOT set (rollback)", () => {
    const root = { AGENT_HOME_ROOT: "/srv/homes" };
    expect(agentHomeRoot({ ...HARDENED, ...root, CHIEF_AGENT_UID: undefined })).toBeNull();
    expect(agentHomeRoot({ ...HARDENED, ...root, CHIEF_AGENT_UID: "0" })).toBeNull();
    expect(agentHomeRoot({ ...HARDENED, ...root, CHIEF_ENABLED: undefined })).toBeNull();
    expect(agentHomeRoot({ ...HARDENED, ...root, CHIEF_CONSOLE_URL: undefined })).toBeNull();
    expect(agentHomeRoot()).toBeNull(); // process.env: vitest.setup.ts scrubs CHIEF_*
  });
});

describe("persistentHome", () => {
  const legacy = { agentDir: "/data/master/agent", memoryDir: "/data/master/memory", inboxDir: "/data/master/inbox" };

  it("not hardened: the legacy paths, the very same object (Review Focus 4)", () => {
    for (const env of [{}, { AGENT_HOME_ROOT: "/h" }, { ...ROLLED_BACK, AGENT_HOME_ROOT: "/h" }, { ...HARDENED }]) {
      for (const kind of ["fleet-master", "cron-master", "lead"] as const) {
        expect(persistentHome(kind, { env, area: "app-shop", legacy }), `${kind} ${JSON.stringify(env)}`).toBe(legacy);
      }
    }
    expect(persistentHome("fleet-master", { legacy })).toBe(legacy); // process.env
  });

  it("hardened with AGENT_HOME_ROOT=/h: <root>/<kind>/{agent,memory}, the fleet master also an inbox", () => {
    const env = { ...HARDENED, AGENT_HOME_ROOT: "/h" };
    expect(persistentHome("fleet-master", { env, legacy })).toEqual({
      agentDir: "/h/fleet-master/agent", memoryDir: "/h/fleet-master/memory", inboxDir: "/h/fleet-master/inbox",
    });
    expect(persistentHome("cron-master", { env, legacy })).toEqual({
      agentDir: "/h/cron-master/agent", memoryDir: "/h/cron-master/memory",
    });
    expect(persistentHome("lead", { env, area: "app-shop", legacy })).toEqual({
      agentDir: "/h/leads/app-shop/agent", memoryDir: "/h/leads/app-shop/memory",
    });
  });

  it("hardened: a lead area that is not one plain path segment throws", () => {
    const env = { ...HARDENED, AGENT_HOME_ROOT: "/h" };
    for (const area of [undefined, "", "*", ".", "..", ".x", "a/b", "a\nb"]) {
      expect(() => persistentHome("lead", { env, area, legacy }), String(area)).toThrow(/lead area/);
    }
  });
});

describe("retargetRecord", () => {
  const rec = { id: "fleet-master", cwd: "/old/agent", worktree: "/old/agent" } as AgentRecord;
  it("{cwd, worktree} when they differ from the home's agent dir", () => {
    expect(retargetRecord(rec, { agentDir: "/h/fleet-master/agent" })).toEqual({
      cwd: "/h/fleet-master/agent", worktree: "/h/fleet-master/agent",
    });
    expect(retargetRecord({ ...rec, worktree: "/x" }, { agentDir: "/old/agent" })).toEqual({ cwd: "/old/agent", worktree: "/old/agent" });
  });
  it("null when both already are the agent dir", () => {
    expect(retargetRecord(rec, { agentDir: "/old/agent" })).toBeNull();
  });
});

describe("homeRecordPatch", () => {
  const legacy = { agentDir: "/data/master/agent", memoryDir: "/data/master/memory" };
  const home = { agentDir: "/h/fleet-master/agent", memoryDir: "/h/fleet-master/memory" };
  const at = (cwd: string) => ({ id: "fleet-master", cwd, worktree: cwd }) as AgentRecord;

  it("hardened: a legacy record moves into the home; one already there is not written", () => {
    const env = { ...HARDENED, AGENT_HOME_ROOT: "/h" };
    expect(homeRecordPatch(at(legacy.agentDir), home, env)).toEqual({ cwd: home.agentDir, worktree: home.agentDir });
    expect(homeRecordPatch(at(home.agentDir), home, env)).toBeNull();
  });

  it("rollback (CHIEF_AGENT_UID removed): a record under AGENT_HOME_ROOT goes back to the legacy home", () => {
    const env = { ...ROLLED_BACK, AGENT_HOME_ROOT: "/h" };
    expect(homeRecordPatch(at(home.agentDir), legacy, env)).toEqual({ cwd: legacy.agentDir, worktree: legacy.agentDir });
    expect(homeRecordPatch(at("/h"), legacy, env)).toEqual({ cwd: legacy.agentDir, worktree: legacy.agentDir });
  });

  it("rollback: a record that never moved, or sits outside AGENT_HOME_ROOT, is not written", () => {
    const env = { ...ROLLED_BACK, AGENT_HOME_ROOT: "/h" };
    expect(homeRecordPatch(at(legacy.agentDir), legacy, env)).toBeNull();
    expect(homeRecordPatch(at("/hx/fleet-master/agent"), legacy, env)).toBeNull(); // a path-boundary check, not a prefix
    expect(homeRecordPatch(at("/elsewhere/agent"), legacy, env)).toBeNull();
  });

  it("rollback with AGENT_HOME_ROOT unset too: leaves the record and logs one line", () => {
    const log = vi.fn();
    expect(homeRecordPatch(at(home.agentDir), legacy, ROLLED_BACK, log)).toBeNull();
    expect(log.mock.calls).toEqual([[
      `[chief] fleet-master cwd ${home.agentDir} is outside the legacy home; set AGENT_HOME_ROOT to move it back`,
    ]]);
    log.mockClear();
    expect(homeRecordPatch(at(legacy.agentDir), legacy, ROLLED_BACK, log)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it("flag off: never a write and never a log, even for a record under AGENT_HOME_ROOT", () => {
    const log = vi.fn();
    for (const env of [{}, { AGENT_HOME_ROOT: "/h" }]) {
      expect(homeRecordPatch(at(home.agentDir), legacy, env, log)).toBeNull();
      expect(homeRecordPatch(at(legacy.agentDir), legacy, env, log)).toBeNull();
    }
    expect(log).not.toHaveBeenCalled();
  });
});

describe("migrateMemory", () => {
  it("copies the *.md files once, then reports present", async () => {
    const from = join(await tmp("legacy-mem-"), "memory");
    await mkdir(from);
    await writeFile(join(from, "MEMORY.md"), "- [a](a.md)\n");
    await writeFile(join(from, "a.md"), "fact a\n");
    await writeFile(join(from, "notes.txt"), "not memory\n");
    const to = join(await tmp("home-"), "fleet-master", "memory");
    expect(await withUmask022(() => migrateMemory(from, to))).toBe("copied");
    // Item 4: migrateMemory gives its own copies (and the dir it made) their mode.
    expect(await mode(join(to, "MEMORY.md"))).toBe(0o660);
    expect(await mode(join(to, "a.md"))).toBe(0o660);
    expect(await mode(to)).toBe(0o2770);
    expect(await readFile(join(to, "MEMORY.md"), "utf8")).toBe("- [a](a.md)\n");
    expect(await readFile(join(to, "a.md"), "utf8")).toBe("fact a\n");
    await expect(stat(join(to, "notes.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    // The agent edits its memory; a second launch copies nothing over it.
    await writeFile(join(to, "MEMORY.md"), "agent's own\n");
    expect(await migrateMemory(from, to)).toBe("present");
    expect(await readFile(join(to, "MEMORY.md"), "utf8")).toBe("agent's own\n");
  });

  it("none when the legacy dir is missing or holds no *.md; the target is still made", async () => {
    const base = await tmp("legacy-mem-");
    const to = join(await tmp("home-"), "memory");
    expect(await migrateMemory(join(base, "missing"), to)).toBe("none");
    expect((await stat(to)).isDirectory()).toBe(true);
    await mkdir(join(base, "empty"));
    expect(await migrateMemory(join(base, "empty"), to)).toBe("none");
  });

  it("a target that is a symlink is refused, never written through", async () => {
    const from = await tmp("legacy-mem-");
    await writeFile(join(from, "MEMORY.md"), "m\n");
    const victim = await tmp("victim-");
    const root = await tmp("home-");
    await symlink(victim, join(root, "memory"));
    await expect(migrateMemory(from, join(root, "memory"))).rejects.toThrow(/symlink/);
    await expect(stat(join(victim, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("mkdirHome and ensureHomeModes", () => {
  it("the home dir 2750, agent/ 3770 (sticky, S1), its other console-owned subdirs 2770, nothing below them (a .git stays 0755/0644)", async () => {
    const root = await tmp("home-");
    const home = join(root, "fleet-master");
    await withUmask022(async () => {
      await mkdir(join(home, "agent", ".git", "hooks"), { recursive: true });
      await mkdir(join(home, "memory"));
      await writeFile(join(home, "agent", ".git", "config"), "[core]\n");
      await writeFile(join(home, "memory", "MEMORY.md"), "m\n");
      await ensureHomeModes(home);
    });
    expect(await mode(home)).toBe(0o2750);
    // S1: sticky, so the agent uid cannot rename the console's .git or
    // .choibot-hooks.json in its cwd.
    expect(await mode(join(home, "agent"))).toBe(0o3770);
    expect(await mode(join(home, "memory"))).toBe(0o2770);
    expect(await mode(join(home, "agent", ".git"))).toBe(0o755);
    expect(await mode(join(home, "agent", ".git", "hooks"))).toBe(0o755);
    expect(await mode(join(home, "agent", ".git", "config"))).toBe(0o644);
    expect(await mode(join(home, "memory", "MEMORY.md"))).toBe(0o644); // files get their mode when written
    expect(await mode(root)).toBe(0o700); // the root itself is not the console's to change (mkdtemp made it 0700)
  });

  it("mkdirHome: the dir it makes is 2770, a missing parent 2750", async () => {
    const root = await tmp("home-");
    await withUmask022(() => mkdirHome(join(root, "cron-master", "memory")));
    expect(await mode(join(root, "cron-master"))).toBe(0o2750);
    expect(await mode(join(root, "cron-master", "memory"))).toBe(0o2770);
    await withUmask022(() => mkdirHome(join(root, "leads", "app-shop"), 0o2750));
    expect(await mode(join(root, "leads"))).toBe(0o2750);
    expect(await mode(join(root, "leads", "app-shop"))).toBe(0o2750);
  });

  it("never follows a symlink inside the home: its target keeps its mode", async () => {
    const outside = await tmp("console-private-");
    await chmod(outside, 0o700);
    const root = await tmp("home-");
    await mkdirHome(join(root, "fleet-master", "memory"));
    await symlink(outside, join(root, "fleet-master", "inbox"));
    await ensureHomeModes(join(root, "fleet-master"));
    expect(await mode(outside)).toBe(0o700);
    expect(await readlink(join(root, "fleet-master", "inbox"))).toBe(outside);
  });

  it("refuses a home path with a symlink in it (no chmod through it)", async () => {
    const outside = await tmp("console-private-");
    await chmod(outside, 0o700);
    const root = await tmp("home-");
    await symlink(outside, join(root, "fleet-master"));
    await expect(ensureHomeModes(join(root, "fleet-master"))).rejects.toThrow(/symlink/);
    await expect(mkdirHome(join(root, "fleet-master", "agent"))).rejects.toThrow(/symlink/);
    expect(await mode(outside)).toBe(0o700);
    await expect(lstat(join(outside, "agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Item 5: a home dir another uid owns (an agent made it first) is refused
  // before anything goes in it. "/" stands in for it: root-owned, and the
  // check comes before any chmod (skipped when the tests run as root).
  it.skipIf(process.getuid?.() === 0)("refuses a home dir the console does not own", async () => {
    await expect(ensureHomeModes("/")).rejects.toThrow(/^\[chief\] \/ is owned by uid 0, not the console/);
  });

  // Item 3: /home/choibot-agent may be 0711/0751: search permission on the
  // dirs above AGENT_HOME_ROOT is enough.
  it("works below an ancestor the console can only search (0311)", async () => {
    const base = await tmp("anc-");
    const anc = join(base, "choibot-agent");
    const root = join(anc, "homes");
    await mkdir(root, { recursive: true });
    const legacy = join(base, "legacy");
    await mkdir(legacy);
    await writeFile(join(legacy, "MEMORY.md"), "m\n");
    await chmod(anc, 0o311);
    try {
      await mkdirHome(join(root, "fleet-master", "agent"));
      expect(await migrateMemory(legacy, join(root, "fleet-master", "memory"))).toBe("copied");
      await ensureHomeModes(join(root, "fleet-master"));
      await writeHomeFile(join(root, "fleet-master", "inbox"), "1.jpg", Buffer.from("i"));
    } finally {
      await chmod(anc, 0o755);
    }
    expect(await readFile(join(root, "fleet-master", "memory", "MEMORY.md"), "utf8")).toBe("m\n");
  });

  it("an ancestor the console cannot search: a clear [chief] error naming it", async () => {
    const base = await tmp("anc-");
    const anc = join(base, "choibot-agent");
    await mkdir(join(anc, "homes"), { recursive: true });
    await chmod(anc, 0o600);
    try {
      await expect(mkdirHome(join(anc, "homes", "fleet-master"))).rejects.toThrow(
        new RegExp(`^\\[chief\\] .*no access to ${join(anc, "homes")}`),
      );
    } finally {
      await chmod(anc, 0o755);
    }
  });
});

describe("warnLegacyHome", () => {
  it("a hardened deployment without AGENT_HOME_ROOT: one [chief] line", () => {
    const log = vi.fn();
    warnLegacyHome("fleet-master", HARDENED, log);
    expect(log.mock.calls).toEqual([[
      "[chief] fleet-master: CHIEF_AGENT_UID is set but AGENT_HOME_ROOT is unset or not absolute; it keeps its legacy home, which the agent uid cannot use (set AGENT_HOME_ROOT)",
    ]]);
  });
  it("silent with AGENT_HOME_ROOT set, and when not hardened", () => {
    const log = vi.fn();
    warnLegacyHome("fleet-master", { ...HARDENED, AGENT_HOME_ROOT: "/h" }, log);
    warnLegacyHome("fleet-master", ROLLED_BACK, log);
    warnLegacyHome("fleet-master", {}, log);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("writeHomeFile", () => {
  it("writes a new 0660 file in a 2770 dir and returns its path", async () => {
    const root = await tmp("home-");
    const dir = join(root, "fleet-master", "inbox");
    const p = await withUmask022(() => writeHomeFile(dir, "9.jpg", Buffer.from("img")));
    expect(p).toBe(join(dir, "9.jpg"));
    expect(await readFile(p, "utf8")).toBe("img");
    expect(await mode(p)).toBe(0o660);
    expect(await mode(dir)).toBe(0o2770);
    expect(await mode(join(root, "fleet-master"))).toBe(0o2750);
    // The same message again (a re-delivery) replaces the file.
    await writeHomeFile(dir, "9.jpg", Buffer.from("img2"));
    expect(await readFile(p, "utf8")).toBe("img2");
  });

  it("a planted symlink at the file name is replaced, its target never written", async () => {
    const outside = await tmp("console-private-");
    await writeFile(join(outside, "bashrc"), "keep\n");
    const root = await tmp("home-");
    const dir = join(root, "inbox");
    await mkdirHome(dir);
    await symlink(join(outside, "bashrc"), join(dir, "9.jpg"));
    await writeHomeFile(dir, "9.jpg", Buffer.from("img"));
    expect(await readFile(join(outside, "bashrc"), "utf8")).toBe("keep\n");
    expect((await lstat(join(dir, "9.jpg"))).isFile()).toBe(true);
  });
});
