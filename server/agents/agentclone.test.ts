// server/agents/agentclone.test.ts — design B of strong protection on the console's side: its own
// folders under AGENT_HOME_ROOT, the helper calls, which agents count as clones, the start commit,
// the uploads, the queue's reads, and the console that never opens a path in an agent's clone
// (the hostile cases: the clone's .git, or its HEAD, as a link to a file of the console).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLONE_DIFF_TOO_LARGE, CLONE_NO_GIT, CLONE_NO_HELPER, parseRead, cloneChangedFiles, cloneDiff, cloneFolders, cloneForAgent, cloneGitState, dropCloneReads, isClone, ownFolderProblem, ownSubfolder, readAsAgent, removeClone, removeCloneFiles, setCloneExec } from "./agentclone.js";
import { SUDO_ENV_KEEP } from "./terminal.js";
import { saveCloneUpload } from "./upload.js";
import { startCommit } from "./worktree.js";
import { acceptMedia, readAgentFile } from "../chief/queue/media.js";

const X = { sudo: "/usr/bin/sudo", helper: "/usr/local/bin/choibot-agent-exec", uid: 4242 };
let dir = "";
let homes = "";
const strongEnv = () => ({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "4242", AGENT_HOME_ROOT: homes });
const stub = () => { for (const [k, v] of Object.entries(strongEnv())) vi.stubEnv(k, v); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentclone-"));
  homes = join(dir, "homes");
  for (const d of ["clones", "uploads", "settings"]) mkdirSync(join(homes, d), { recursive: true });
  chmodSync(join(homes, "uploads"), 0o750);
  chmodSync(join(homes, "settings"), 0o750);
});
afterEach(() => { setCloneExec(null); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("the console's own folders under AGENT_HOME_ROOT", () => {
  it("are used only when each is a real folder of the console's user with no group or other write", async () => {
    expect(await ownFolderProblem(join(homes, "uploads"))).toBeNull();
    chmodSync(join(homes, "uploads"), 0o770);
    expect(await ownFolderProblem(join(homes, "uploads"))).toMatch(/writable by its group or others/);
    expect(await ownFolderProblem(join(homes, "settings"), 1)).toMatch(/not the console's/);
    expect(await ownFolderProblem(join(homes, "none"))).toMatch(/does not exist/);
    // Made by an agent before the console's own: a link.
    rmSync(join(homes, "settings"), { recursive: true });
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(homes, "settings"));
    expect(await ownFolderProblem(join(homes, "settings"))).toMatch(/not a folder/);
  });

  it("an upload goes to uploads/<id>/ (a new file, 0640); refused when that folder is not the console's", async () => {
    stub();
    const p = await saveCloneUpload("a1", Buffer.from("png"), "png");
    expect(p.startsWith(join(homes, "uploads", "a1") + "/")).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("png");
    chmodSync(join(homes, "uploads"), 0o2770);
    await expect(saveCloneUpload("a1", Buffer.from("x"), "png")).rejects.toThrow(/writable by its group/);
    chmodSync(join(homes, "uploads"), 0o750);
    await expect(ownSubfolder(join(homes, "uploads"), "../x")).rejects.toThrow(/invalid agent id/);
  });
});

describe("which agents work in a clone", () => {
  it("a fact of the record (set at spawn), not of this start of the console: no helper, no env, it stays a clone", () => {
    const rec = { id: "a1", repo: "/srv/w/repo", worktree: join(homes, "clones", "a1"), clone: true as const };
    expect(isClone(rec)).toBe(true);
    stub();
    setCloneExec(X);
    expect(isClone(rec)).toBe(true);
    expect(isClone({ ...rec, clone: undefined })).toBe(false);
    expect(isClone({ ...rec, clone: false })).toBe(false);
    expect(cloneFolders({})).toBeNull();
  });
});

describe("the helper calls", () => {
  type Seen = { bin: string; args: string[]; env: Record<string, string | undefined> };
  const fake = (seen: Seen[], out = "", err: Error | null = null) =>
    ((bin: string, args: string[], o: { env: Record<string, string> }, cb: (e: Error | null, so: Buffer, se: Buffer) => void) => { seen.push({ bin, args, env: o.env }); cb(err, Buffer.from(out), Buffer.from(err ? "choibot-agent-exec: agent id refused: x\n" : "")); }) as never;
  const pre = ["-n", "-u", "#4242", "/usr/local/bin/choibot-agent-exec"];

  it("repo-clone, repo-remove and read-file: sudo, the verb and its fixed arguments; no console secret in the env", async () => {
    const seen: Seen[] = [];
    const f = cloneFolders(strongEnv())!;
    const sha = "a".repeat(40);
    expect(await cloneForAgent(X, f, "/srv/w/repo", "a1", "agent/a1", sha, { run: fake(seen), env: { TELEGRAM_BOT_TOKEN: "t", LANG: "C.UTF-8" } })).toBe(join(homes, "clones", "a1"));
    await removeClone(X, "a1", { run: fake(seen) });
    expect((await readAsAgent(X, "/srv/w/x", 10, { run: fake(seen, "0123456789") })).toString()).toBe("0123456789");
    expect(seen.map((s) => [s.bin, ...s.args])).toEqual([
      ["/usr/bin/sudo", ...pre, "repo-clone", "/srv/w/repo", "a1", "agent/a1", sha],
      ["/usr/bin/sudo", ...pre, "repo-remove", "a1"],
      ["/usr/bin/sudo", ...pre, "read-file", "/srv/w/x", "10"],
    ]);
    expect(seen[0].env).toEqual({ LANG: "C.UTF-8" });
  });

  it("refuses an id or a sha of another shape before any call; the helper's reason line becomes the error", async () => {
    const seen: Seen[] = [];
    const f = cloneFolders(strongEnv())!;
    await expect(cloneForAgent(X, f, "/r", "../x", "b", "a".repeat(40), { run: fake(seen) })).rejects.toThrow(/invalid agent id/);
    await expect(cloneForAgent(X, f, "/r", "a1", "b", "HEAD", { run: fake(seen) })).rejects.toThrow(/invalid start commit/);
    await expect(removeClone(X, "a/b", { run: fake(seen) })).rejects.toThrow(/invalid agent id/);
    expect(seen).toEqual([]);
    await expect(removeClone(X, "a1", { run: fake(seen, "", new Error("exit 2")) })).rejects.toThrow("choibot-agent-exec: agent id refused: x");
    await expect(readAsAgent(X, "/x", 3, { run: fake(seen, "0123") })).rejects.toThrow(/larger than 3/);
  });
});

describe("parseRead: the framed output of repo-read is untrusted", () => {
  it("takes well-formed frames; a frame of another shape ends the parse; the first frame of a name wins", () => {
    const ok = Buffer.from("== head 0 9\nagent/a1\n\n== sha 1 0\n\n");
    expect([...parseRead(ok)]).toEqual([["head", { code: 0, out: "agent/a1\n" }], ["sha", { code: 1, out: "" }]]);
    const cases = [
      "== head 0 99\nshort\n",            // a size past the end
      "== head 0 2\nabc\n",               // no newline after the bytes
      "== HEAD 0 1\nx\n",                 // a name of another shape
      "== head 0 -1\nx\n",
      `== head 0 1${"0".repeat(80)}\nx\n`, // a header line that is too long
    ];
    for (const c of cases) expect(parseRead(Buffer.from(c)).size).toBe(0);
    expect(parseRead(Buffer.from("== head 0 1\nx\n== head 0 1\ny\n")).get("head")).toEqual({ code: 0, out: "x" });
  });
});

describe("repo-read answers: kept a few seconds and shared, small in memory", () => {
  const frames = (steps: Record<string, [number, string]>) => Buffer.from(Object.entries(steps).map(([n, [c, o]]) => `== ${n} ${c} ${Buffer.byteLength(o)}\n${o}\n`).join(""));
  const rec = { id: "a1", worktree: "/srv/homes/clones/a1", branch: "agent/a1", baseBranch: "main" };
  const sha = "a".repeat(40);
  type Call = { args: string[]; maxBuffer: number };
  // A fake helper run that answers after a short time (so that calls overlap), and counts.
  const counting = (calls: Call[], out: () => Buffer, fail: () => boolean = () => false) =>
    ((_bin: string, args: string[], o: { maxBuffer: number }, cb: (e: Error | null, so: Buffer, se: Buffer) => void) => {
      calls.push({ args: args.slice(-3), maxBuffer: o.maxBuffer });
      setTimeout(() => cb(fail() ? new Error("exit 2") : null, fail() ? Buffer.alloc(0) : out(), Buffer.from(fail() ? "choibot-agent-exec: no clone of a1\n" : "")), 5);
    }) as never;
  const state = frames({ head: [0, "agent/a1\n"], sha: [0, "abc1234\n"], aheadbehind: [0, "0\t1\n"], staged: [0, ""], unstaged: [0, ""], untracked: [0, ""], stashes: [0, ""] });
  afterEach(() => { vi.restoreAllMocks(); });

  it("N calls at once = 1 run; a call within the window = no run; a stop of the turn, another base commit or the end of the window = a new run", async () => {
    const calls: Call[] = [];
    setCloneExec(X, counting(calls, () => state));
    const got = await Promise.all(Array.from({ length: 5 }, () => cloneGitState(X, rec, sha)));
    expect(calls).toHaveLength(1);
    expect(got.every((s) => s.head === "agent/a1" && s.ahead === 1 && !s.error)).toBe(true);
    await cloneGitState(X, rec, sha);
    expect(calls).toHaveLength(1);
    dropCloneReads("a1");
    await cloneGitState(X, rec, sha);
    expect(calls).toHaveLength(2);
    await cloneGitState(X, rec, "b".repeat(40));
    expect(calls).toHaveLength(3);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_001);
    await cloneGitState(X, rec, sha);
    expect(calls).toHaveLength(4);
    // Each read asks for at most its own cap: 7 list steps of 1 MB for the state.
    expect(calls[0]).toEqual({ args: ["a1", "state", sha], maxBuffer: 7 * 1024 * 1024 + 4096 + 4096 });
  });

  it("a failed run is not kept: the next call runs again", async () => {
    const calls: Call[] = [];
    let fail = true;
    setCloneExec(X, counting(calls, () => frames({ dirty: [0, ""], namestatus: [0, "M\tREADME.md\n"], untracked: [0, ""], numstat: [0, "1\t0\tREADME.md\0"] }), () => fail));
    expect(await cloneChangedFiles(X, rec, sha)).toEqual([]);
    fail = false;
    expect((await cloneChangedFiles(X, rec, sha)).map((f) => f.path)).toEqual(["/srv/homes/clones/a1/README.md"]);
    expect(calls).toHaveLength(2);
  });

  it("a diff above its cap (exit 98): too large to show; the diff asks for at most 4 MB", async () => {
    const calls: Call[] = [];
    setCloneExec(X, counting(calls, () => frames({ diff: [98, ""] })));
    await expect(cloneDiff(X, rec, sha)).rejects.toThrow(CLONE_DIFF_TOO_LARGE);
    expect(calls[0].maxBuffer).toBe(4 * 1024 * 1024 + 4096 + 4096);
  });
});

describe("the start commit (the console's own repo)", () => {
  it("the tip of the branch when the repo has it, else the start point of a new branch", async () => {
    const repo = join(dir, "repo");
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "init.defaultBranch=main", ...a], { cwd: repo, encoding: "utf8" }).trim();
    mkdirSync(repo);
    g("init", "-q");
    writeFileSync(join(repo, "f"), "1");
    g("add", "f");
    g("commit", "-qm", "one");
    const main = g("rev-parse", "HEAD");
    g("checkout", "-qb", "feature");
    writeFileSync(join(repo, "f"), "2");
    g("commit", "-qam", "two");
    const feature = g("rev-parse", "HEAD");
    g("checkout", "-q", "main");
    expect(await startCommit(repo, "main", "agent/new")).toBe(main);
    expect(await startCommit(repo, "main", "feature")).toBe(feature);
  });
});

describe("the queue's reads in strong mode: as the agent, never a path opened by the console", () => {
  it("readAgentFile and acceptMedia call the helper with the path in the agent's folder; nothing outside it is asked", async () => {
    const asked: string[] = [];
    const asAgent = async (abs: string, max: number) => { asked.push(`${abs} ${max}`); return abs.endsWith(".png") ? Buffer.from("\x89PNG\r\n\x1a\n0000", "latin1") : Buffer.from("<p>hi</p>"); };
    // The folder does not even exist for the console: it opens nothing there.
    const cwd = join(homes, "clones", "a1");
    expect(await readAgentFile({ roots: [], cwd, path: "page.html", maxBytes: 100, maxText: "100 B", asAgent })).toEqual({ ok: true, data: Buffer.from("<p>hi</p>") });
    expect(await readAgentFile({ roots: [], cwd, path: "../../../etc/passwd", maxBytes: 100, maxText: "100 B", asAgent })).toEqual({ ok: false, error: '"../../../etc/passwd": outside the agent folder' });
    const media = await acceptMedia({ roots: [], cwd, images: ["shot.png"], destDir: join(dir, "media", "q1"), asAgent });
    expect(media).toEqual({ ok: true, names: ["1.png"] });
    expect(asked).toEqual([`${cwd}/page.html 100`, `${cwd}/shot.png ${5 * 1024 * 1024}`]);
    const failing = async () => { throw new Error("choibot-agent-exec: read-file: larger than 100 bytes"); };
    expect(await readAgentFile({ roots: [], cwd, path: "big.html", maxBytes: 100, maxText: "100 B", asAgent: failing })).toEqual({ ok: false, error: '"big.html": larger than 100 B' });
  });
});

describe("hostile clones: the console never reads a path in an agent's clone", () => {
  it("the agents list shows the record's branch for a clone whose .git, or whose HEAD, is a link to a file of the console", async () => {
    stub();
    setCloneExec(X);
    const Fastify = (await import("fastify")).default;
    const { registerAgentApi } = await import("./api.js");
    const { SessionStore } = await import("./store.js");
    const { EventHub } = await import("../events.js");
    const secret = join(dir, "console-secret");
    writeFileSync(secret, "ref: refs/heads/SECRET-OF-THE-CONSOLE\n");
    const store = new SessionStore(join(dir, "store"));
    for (const [id, how] of [["a1", "git"], ["a2", "head"]] as const) {
      const clone = join(homes, "clones", id);
      mkdirSync(clone);
      if (how === "git") symlinkSync(secret, join(clone, ".git"));
      else { mkdirSync(join(clone, ".git")); symlinkSync(secret, join(clone, ".git", "HEAD")); }
      await store.save({ id, label: id, repo: join(dir, "repo"), worktree: clone, branch: `agent/${id}`, baseBranch: "main", sessionId: null, hookToken: "t", status: "idle", createdAt: 1, clone: true } as never);
    }
    const a = Fastify();
    registerAgentApi(a, { terminals: { has: () => false, hasSession: async () => false } as never, store, hub: new EventHub(), workspaceDir: dir });
    try {
      const body = (await a.inject({ method: "GET", url: "/api/agents" })).body;
      const sessions = JSON.parse(body).sessions as { id: string; head: string }[];
      expect(sessions.map((s) => [s.id, s.head]).sort()).toEqual([["a1", "agent/a1"], ["a2", "agent/a2"]]);
      expect(body).not.toContain("SECRET");
    } finally {
      await a.close();
    }
    expect(existsSync(secret)).toBe(true);
  });

  // The console's repo, and a clone of agent a3 that the agent replaced by a link to it.
  async function linkedClone() {
    stub();
    const Fastify = (await import("fastify")).default;
    const { registerAgentApi } = await import("./api.js");
    const { SessionStore } = await import("./store.js");
    const { EventHub } = await import("../events.js");
    const repo = join(dir, "repo");
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "init.defaultBranch=main", "-C", repo, ...a], { encoding: "utf8" }).trim();
    mkdirSync(repo);
    g("init", "-q");
    writeFileSync(join(repo, "f"), "1");
    g("add", "f");
    g("commit", "-qm", "one");
    writeFileSync(join(repo, "f"), "the user's own change");
    symlinkSync(repo, join(homes, "clones", "a3"));
    const store = new SessionStore(join(dir, "store"));
    await store.save({ id: "a3", label: "a3", repo, worktree: join(homes, "clones", "a3"), branch: "agent/a3", baseBranch: "main", sessionId: null, hookToken: "t", status: "idle", createdAt: 1, clone: true } as never);
    const a = Fastify();
    registerAgentApi(a, { terminals: { has: () => false, hasSession: async () => false } as never, store, hub: new EventHub(), workspaceDir: dir });
    return { a, g, repo, store };
  }
  async function noChange(t: Awaited<ReturnType<typeof linkedClone>>) {
    for (const [url, payload] of [["/api/agents/a3/discard-file", { rel: "f" }], ["/api/agents/a3/merge", {}]] as const) {
      const d = await t.a.inject({ method: "POST", url, payload });
      expect([url, d.statusCode, d.json().error]).toEqual([url, 409, CLONE_NO_GIT]);
    }
    await t.a.close();
    expect(readFileSync(join(t.repo, "f"), "utf8")).toBe("the user's own change");
    const { commitPending, pushBranch } = await import("./reconcile.js");
    const rec = (await t.store.load("a3"))!;
    expect(await commitPending(rec)).toEqual({ ok: false, message: CLONE_NO_GIT });
    await expect(pushBranch(rec, "agent/a3")).rejects.toThrow(CLONE_NO_GIT);
    expect(t.g("status", "--porcelain")).toBe("M f");
  }

  it("a clone replaced by a link to the console's own repo, with the helper: the views come only from the helper (as the agent), never from the console's git; no action changes anything", async () => {
    const asked: string[][] = [];
    const frame = (steps: [string, number, string][]) => Buffer.concat(steps.map(([n, c, out]) => Buffer.concat([Buffer.from(`== ${n} ${c} ${Buffer.byteLength(out)}\n`), Buffer.from(out), Buffer.from("\n")])));
    const bundles: Record<string, Buffer> = {
      state: frame([["head", 0, "agent/a3\n"], ["sha", 0, "abc1234\n"], ["aheadbehind", 0, "0\t2\n"], ["staged", 0, ""], ["unstaged", 0, "x.ts\n"], ["untracked", 0, "u.txt\n"], ["stashes", 0, ""]]),
      changed: frame([["dirty", 0, "x.ts\n"], ["namestatus", 0, "M\tx.ts\nA\tnew.ts\n"], ["untracked", 0, "u.txt\n"], ["numstat", 0, "3\t1\tx.ts\0"]]),
      diff: frame([["diff", 0, "diff --git a/x.ts b/x.ts\n+agent\n"]]),
    };
    setCloneExec(X, ((_bin: string, args: string[], _o: unknown, cb: (e: Error | null, so: Buffer, se: Buffer) => void) => { asked.push(args.slice(-4)); cb(null, bundles[args.at(-2)!], Buffer.alloc(0)); }) as never);
    const t = await linkedClone();
    const sha = t.g("rev-parse", "main");
    const changed = (await t.a.inject({ method: "GET", url: "/api/agents/a3/changed" })).json().files;
    expect(changed.map((f: { rel: string; status: string; state: string; add?: number }) => [f.rel, f.status, f.state, f.add])).toEqual([
      ["x.ts", "modified", "uncommitted", 3], ["new.ts", "added", "committed", undefined], ["u.txt", "untracked", "untracked", undefined],
    ]);
    expect((await t.a.inject({ method: "GET", url: "/api/agents/a3/diff" })).json().diff).toBe("diff --git a/x.ts b/x.ts\n+agent\n");
    expect((await t.a.inject({ method: "GET", url: "/api/agents/a3/git" })).json().git).toMatchObject({ head: "agent/a3", sha: "abc1234", onTracked: true, ahead: 2, behind: 0, unstaged: 1, untracked: 1, error: false });
    expect(asked).toEqual([["repo-read", "a3", "changed", sha], ["repo-read", "a3", "diff", sha], ["repo-read", "a3", "state", sha]]);
    await noChange(t);
  });

  it("the same with no helper (its probe failed at this start): the views refuse, the git bar is unavailable, no action changes anything", async () => {
    setCloneExec(null);
    const t = await linkedClone();
    for (const url of ["/api/agents/a3/changed", "/api/agents/a3/diff"]) {
      const r = await t.a.inject({ method: "GET", url });
      expect([url, r.statusCode, r.json().error]).toEqual([url, 409, CLONE_NO_HELPER]);
    }
    expect((await t.a.inject({ method: "GET", url: "/api/agents/a3/git" })).json().git).toMatchObject({ head: "", error: true });
    await noChange(t);
  });
});

describe("an agent with a clone and no helper (fix 1) and the clean-up of its console files (fix 2)", () => {
  async function app() {
    const Fastify = (await import("fastify")).default;
    const { registerAgentApi } = await import("./api.js");
    const { SessionStore } = await import("./store.js");
    const { EventHub } = await import("../events.js");
    const store = new SessionStore(join(dir, "store"));
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    mkdirSync(join(homes, "clones", "a4"));
    await store.save({ id: "a4", label: "a4", repo, worktree: join(homes, "clones", "a4"), branch: "agent/a4", baseBranch: "main", sessionId: null, hookToken: "t", status: "idle", createdAt: 1, clone: true } as never);
    const a = Fastify();
    registerAgentApi(a, { terminals: { has: () => false, hasSession: async () => false, kill: () => {} } as never, store, hub: new EventHub(), workspaceDir: dir });
    return { a, store, repo };
  }

  it("discard removes its hook settings file and its uploads first, then refuses (no helper): no git runs, the clone stays", async () => {
    stub();
    writeFileSync(join(homes, "settings", "a4.json"), "{}");
    mkdirSync(join(homes, "uploads", "a4"), { mode: 0o750 });
    writeFileSync(join(homes, "uploads", "a4", "shot.png"), "png");
    writeFileSync(join(homes, "settings", "a5.json"), "{}");
    const { a, store, repo } = await app();
    try {
      const { discard } = await import("./reconcile.js");
      await expect(discard((await store.load("a4"))!)).rejects.toThrow(CLONE_NO_HELPER);
      expect(existsSync(join(homes, "settings", "a4.json"))).toBe(false);
      expect(existsSync(join(homes, "uploads", "a4"))).toBe(false);
      expect(existsSync(join(homes, "settings", "a5.json"))).toBe(true); // another agent's: kept
      expect(existsSync(join(homes, "clones", "a4"))).toBe(true);
      // No `git worktree remove` and no `branch -D` in the console's repo.
      expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
      // Delete refuses too, and keeps the record (a later delete with the helper removes the clone).
      const del = await a.inject({ method: "POST", url: "/api/agents/a4/delete" });
      expect([del.statusCode, del.json().error]).toEqual([409, CLONE_NO_HELPER]);
      expect(await store.load("a4")).not.toBeNull();
    } finally {
      await a.close();
    }
  });

  it("the clean-up leaves alone a console folder that is not the console's own", async () => {
    stub();
    writeFileSync(join(homes, "settings", "a6.json"), "{}");
    chmodSync(join(homes, "settings"), 0o770);
    mkdirSync(join(homes, "uploads", "a6"), { mode: 0o770 });
    await removeCloneFiles("a6");
    expect(existsSync(join(homes, "settings", "a6.json"))).toBe(true);
    expect(existsSync(join(homes, "uploads", "a6"))).toBe(true);
    await expect(removeCloneFiles("../x")).rejects.toThrow(/invalid agent id/);
  });

  it("no launch, no Codex home and no ticket read falls back to the console: each refuses", async () => {
    stub();
    const rec = { id: "a7", label: "a7", repo: "/r", worktree: join(homes, "clones", "a7"), branch: "b", baseBranch: "main", sessionId: null, hookToken: "t", status: "idle", createdAt: 1, clone: true } as never;
    const { claudeRuntime } = await import("./runtimes/claude.js");
    await expect(claudeRuntime.prepare(rec, { port: 1, workspaceDir: dir } as never)).rejects.toThrow(CLONE_NO_HELPER);
    expect(existsSync(join(homes, "settings", "a7.json"))).toBe(false);
    const { codexHomeFor } = await import("./runtimes/codex-home.js");
    expect(() => codexHomeFor(rec, dir)).toThrow(/only a Claude agent/);
    // A ticket page of this agent: refused before any read (the console never reads it itself).
    const { addItem } = await import("../chief/queue/add.js");
    const d = { agents: { load: async () => rec }, agentRoots: [homes], areaOf: async () => "x" } as never;
    await expect(addItem(d, "a7", { kind: "question", title: "t", body: "b", html: { file: "p.html", height: 100 } } as never, { agentId: "a7", kind: "worker" }))
      .rejects.toThrow(CLONE_NO_HELPER);
  });
});
