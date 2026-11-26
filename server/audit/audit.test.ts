// server/audit/audit.test.ts — the clean-up audit on a MADE-UP folder tree: what it finds, what
// it never suggests, what it does with a model answer that invents a path or a size, and who may
// start it. Nothing here removes a file: the last test proves that the tree is as it was.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { CHIEF_ERR, makeGate } from "../chief/gate.js";
import { wideFor, type Wide } from "../files/wide.js";
import type { GuideModel } from "../guide/model.js";
import { AUDIT_SYSTEM, cleanText, mergeAnswer, tableFor } from "./ai.js";
import { AUDIT_NO_PAIRING, auditGit, auditTmpDirs, liveUse, livePid, registerAuditApi, systemMarks, systemMeasure, systemMeasureChildren } from "./api.js";
import { Audit, OLD_AFTER_MS, type AuditDeps } from "./audit.js";
import { removeCandidate } from "./remove.js";
import { copyState, LOCKED, OWN_REPO, PLAIN, scan, UNSAVED, type Candidate } from "./scan.js";
import { NEVER_NAME, OUR_NAME, useFacts, useState } from "./temp.js";
import { fixedWords, rowOf } from "./words.js";

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 20);
let T: string;
let home: string;
let ws: string;
let wide: Wide;

const dir = (rel: string): string => { const p = join(T, rel); mkdirSync(p, { recursive: true }); return p; };
const file = (rel: string, bytes = 10, daysOld = 0): string => {
  const p = join(T, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, "a"));
  const at = new Date(NOW - daysOld * DAY);
  utimesSync(p, at, at);
  return p;
};

// The sizes and the newest change that the made-up `du` gives, by the path under T (MB, days ago).
const SIZES: Record<string, [number, number]> = {
  "home/you/workspace/shop/node_modules": [900, 3], "home/you/workspace/shop/.next": [300, 1], "home/you/workspace/shop/dist": [40, 9],
  "home/you/workspace/shop/pgdata": [5000, 0], "home/you/workspace/shop/src": [2, 0],
  "home/you/workspace/shop/.agent-worktrees/agent-open1": [2000, 0], "home/you/workspace/shop/.agent-worktrees/agent-open1-b": [700, 0],
  "home/you/workspace/shop/.agent-worktrees/agent-closed1": [1500, 20], "home/you/workspace/shop/.agent-worktrees/agent-gone1": [1200, 40],
  "home/you/workspace/shop/.agent-worktrees/agent-gone2": [800, 40],
  "home/you/workspace/shop/.agent-worktrees/agent-closed2": [600, 20], "home/you/workspace/shop/.agent-worktrees/agent-plain1": [310, 40],
  "home/you/workspace/shop/.agent-worktrees/agent-clone1": [250, 40],
  "home/you/workspace/tool/target": [2500, 60], "home/you/workspace/api/.venv": [400, 30], "home/you/workspace/api/__pycache__": [12, 30],
  "home/you/workspace/api/packages/core/node_modules": [70, 30],
  "home/you/workspace/console/.next": [350, 0], "home/you/workspace/console/.next-prev": [340, 2], "home/you/workspace/console/.next-failed": [120, 9], "home/you/workspace/console/node_modules": [1100, 5],
  "home/you/workspace/docs/build": [90, 5], "home/you/workspace/hidden/node_modules": [600, 5], "home/you/workspace/tiny/node_modules": [3, 5],
  "home/you/.cache/pnpm": [50, 12], "home/you/.cache/ms-playwright": [1800, 50], "home/you/.cache/mystery": [220, 300],
  "home/you/.npm/_cacache": [640, 8], "home/you/.local/share/pnpm/store": [4200, 1], "home/you/.ssh/big": [999, 100],
  "tmp/chief-old": [500, 30], "tmp/chief-new": [500, 0], "tmp/scratch-mid": [80, 4], "tmp/in-use": [900, 0], "tmp/small-new": [1, 3],
  // Many small old folders (left by test runs): one row together.
  ...Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`tmp/api-${String(i).padStart(3, "0")}`, [0.2, 20 + i] as [number, number]])),
  "tmp/my-wallet-tmp": [400, 50],
  // In use, or maybe in use (temp.ts): old, but never "dead" by its age alone.
  "tmp/sock-old": [0.5, 30], "tmp/sock-big": [300, 30], "tmp/tmux-1000": [0.1, 40], "tmp/hc-AbCd1234": [0.1, 40], "tmp/ssh-XXXXabcd": [0.1, 40],
  "tmp/open-old": [200, 30], "tmp/pid-live": [150, 30], "tmp/pid-dead": [140, 30], "tmp/lock-small": [1, 30],
  // Small old folders of ChoiBot's own tests (by their names).
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`tmp/chief-api-${i}`, [1, 20] as [number, number]])),
};
// What the made-up walk finds: a socket, a socket deep in a folder, pid files, a lock file.
const MARKS: [type: string, rel: string][] = [
  ["s", "tmp/sock-old/agent.sock"], ["s", "tmp/sock-big/a/b/c/session"], ["s", "tmp/tmux-1000/default"],
  ["f", "tmp/pid-live/run/app.pid"], ["f", "tmp/pid-dead/app.pid"], ["f", "tmp/lock-small/db.lock"],
];

beforeAll(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), "audit-")));
  home = join(T, "home", "you");
  ws = join(home, "workspace");
  for (const rel of Object.keys(SIZES)) dir(rel);
  // The marks that say what a folder is.
  file("home/you/workspace/shop/package.json"); dir("home/you/workspace/shop/.git");
  file("home/you/workspace/shop/pgdata/PG_VERSION");
  file("home/you/workspace/shop/.agent-worktrees/agent-open1/package.json"); dir("home/you/workspace/shop/.agent-worktrees/agent-open1/node_modules");
  file("home/you/workspace/tool/Cargo.toml");
  file("home/you/workspace/api/pyproject.toml"); file("home/you/workspace/api/packages/core/package.json");
  file("home/you/workspace/console/package.json");
  file("home/you/workspace/hidden/package.json"); file("home/you/workspace/tiny/package.json");
  // docs/build has no package.json beside it: "build" alone says nothing.
  // Files: old and new archives, a big file, a database file, logs.
  file("home/you/Downloads/old-backup.zip", 40_000, 90); file("home/you/Downloads/new.zip", 40_000, 2); file("home/you/Downloads/small.zip", 100, 90);
  file("home/you/video.bin", 80_000, 5); file("home/you/app.sqlite", 80_000, 5); file("home/you/wallet-backup.bin", 80_000, 5);
  file("home/you/workspace/shop/debug.log", 11 * MB, 30); file("home/you/workspace/shop/today.log", 11 * MB, 1);
  symlinkSync(join(home, ".ssh"), join(T, "tmp", "link-to-keys"));
  wide = wideFor({ env: { HOME: home, XDG_DATA_HOME: join(T, "data"), FILES_REFUSED_EXTRA: join(ws, "hidden") }, checkout: join(ws, "console"), passwd: "" });
});
afterAll(() => { rmSync(T, { recursive: true, force: true }); });

const copy = (name: string) => join(ws, "shop", ".agent-worktrees", name);
// What the made-up git says NOW about a copy (a test changes it after the audit).
let gitNow: Record<string, { dirty?: string; ahead?: string }> = {};
type Fakes = { gitAsked: string[]; measured: string[]; rmd: string[]; worktreesRemoved: string[]; agentsDeleted: string[] };
function deps(o: Partial<AuditDeps> = {}): AuditDeps & { now: number } & Fakes {
  const gitAsked: string[] = [];
  const measured: string[] = [];
  const rmd: string[] = [];
  const worktreesRemoved: string[] = [];
  const agentsDeleted: string[] = [];
  return {
    // A removal in a test removes nothing: it writes the path down.
    rm: async (p) => { rmd.push(relative(T, p)); },
    removeWorktree: async (repo, p) => { worktreesRemoved.push(`${relative(T, repo)} <- ${relative(T, p)}`); },
    deleteAgent: async (id) => { agentsDeleted.push(id); },
    mounts: () => ["/", "/proc", join(T, "elsewhere")],
    marks: async (dir, skip) => {
      measured.push(`marks of ${relative(T, dir)}`);
      const inside = (p: string, d: string) => p === d || p.startsWith(`${d}/`);
      return MARKS.map(([type, rel]) => ({ type, path: join(T, rel) })).filter((m) => inside(m.path, dir) && !skip.some((x) => inside(m.path, x)));
    },
    // A running program has a file of this folder open.
    inUse: () => [join(T, "tmp", "open-old", "log", "out.txt"), "/usr/bin/node"],
    livePid: async (file) => file.includes("pid-live"),
    wide, workDir: ws, checkout: join(ws, "console"), tmpDirs: [join(T, "tmp"), join(T, "tmp")], uid: process.getuid!(), now: NOW,
    agents: [
      { id: "a1", title: "Fix the login", repo: join(ws, "shop"), worktree: copy("agent-open1"), closed: false },
      { id: "a2", title: "Old task", repo: join(ws, "shop"), worktree: copy("agent-closed1"), closed: true },
      { id: "a3", title: "Done task", repo: join(ws, "shop"), worktree: copy("agent-closed2"), closed: true },
    ],
    measure: async (p) => {
      measured.push(relative(T, p));
      const s = SIZES[relative(T, p)];
      return s ? { bytes: s[0] * MB, newest: NOW - s[1] * DAY } : { bytes: 1024, newest: NOW };
    },
    measureChildren: async (p, skip) => {
      measured.push(`children of ${relative(T, p)}, skip ${skip.map((x) => relative(T, x)).join(",")}`);
      return new Map(Object.entries(SIZES).filter(([rel]) => join(T, rel, "..") === p && !skip.includes(join(T, rel))).map(([rel, [mb, days]]) => [join(T, rel), { bytes: mb * MB, newest: NOW - days * DAY }]));
    },
    git: async (cwd, args) => {
      gitAsked.push(`${relative(T, cwd)}: ${args.join(" ")}`);
      const name = relative(join(ws, "shop", ".agent-worktrees"), cwd);
      if (args.includes("--show-toplevel")) return name === "agent-plain1" ? `${join(ws, "shop")}\n` : `${cwd}\n`; // git finds the repo above a left-over folder
      if (args.includes("--git-common-dir")) return name === "agent-clone1" ? `${join(cwd, ".git")}\n` : `${join(ws, "shop", ".git")}\n`;
      const now = gitNow[name] ?? {};
      if (args.includes("status")) return now.dirty ?? (name === "agent-closed1" ? " M src/app.ts\n" : ""); // a changed file
      return now.ahead ?? (name === "agent-gone2" ? "3\n" : "0\n"); // 3 commits on no remote
    },
    minBytes: 10 * MB, archiveBytes: 20_000, bigBytes: 60_000,
    ...o, gitAsked, measured, rmd, worktreesRemoved, agentsDeleted,
  };
}

describe("what the audit finds", () => {
  let found: Candidate[];
  let d: ReturnType<typeof deps>;
  beforeAll(async () => { d = deps(); found = (await scan(d)).candidates; });
  const of = (where: string) => found.find((c) => c.where === where);

  it("lists what a tool makes again, the copies that no open agent uses, and what only the user can judge; biggest first", () => {
    expect(found.map((c) => [c.where, c.kind, c.floor, Math.round(c.bytes / MB)])).toEqual([
      ["~/.local/share/pnpm/store", "tool-cache", "safe", 4200],
      ["~/workspace/tool/target", "build-output", "safe", 2500],
      ["~/.cache/ms-playwright", "tool-cache", "safe", 1800],
      ["~/workspace/shop/.agent-worktrees/agent-closed1", "closed-copy", "check", 1500],
      ["~/workspace/shop/.agent-worktrees/agent-gone1", "unused-copy", "safe", 1200],
      ["~/workspace/shop/node_modules", "installed-parts", "check", 900], // an open agent works in this repo
      ["~/workspace/shop/.agent-worktrees/agent-gone2", "unused-copy", "check", 800], // work that is on no remote
      ["~/.npm/_cacache", "tool-cache", "safe", 640],
      ["~/workspace/shop/.agent-worktrees/agent-closed2", "closed-copy", "check", 600],
      [`${join(T, "tmp")}/chief-old`, "temp", "safe", 500],
      ["~/workspace/api/.venv", "installed-parts", "safe", 400],
      ["~/workspace/shop/.agent-worktrees/agent-plain1", "unused-copy", "check", 310], // git does not know it
      ["~/workspace/shop/.next", "build-output", "safe", 300],
      ["~/workspace/shop/.agent-worktrees/agent-clone1", "unused-copy", "check", 250], // a full repo of its own
      ["~/.cache/mystery", "tool-cache", "check", 220], // not a tool that the audit knows
      [`${join(T, "tmp")}/pid-dead`, "temp", "check", 140], // a pid file of a process that is gone: never "safe"
      ["~/workspace/console/.next-failed", "old-build", "safe", 120],
      [`${join(T, "tmp")}/scratch-mid`, "temp", "check", 80], // changed 4 days ago
      ["~/workspace/api/packages/core/node_modules", "installed-parts", "safe", 70],
      ["~/.cache/pnpm", "tool-cache", "safe", 50],
      ["~/workspace/shop/dist", "build-output", "safe", 40],
      [`${join(T, "tmp")}: 150 small folders of other programs, not changed for 7 days or more`, "temp", "check", 30], // not ChoiBot's by their names
      ["~/workspace/api/__pycache__", "build-output", "safe", 12],
      [`${join(T, "tmp")}: 12 small folders made by test runs of ChoiBot, not changed for 7 days or more`, "temp", "safe", 12],
      ["~/workspace/shop/debug.log", "old-log", "safe", 11],
      ["~/video.bin", "big-file", "check", 0],
      ["~/Downloads/old-backup.zip", "old-archive", "check", 0],
    ]);
    expect(found.map((c) => c.id)).toEqual(found.map((_, i) => `c${i + 1}`));
    expect(of("~/workspace/tool/target")).toMatchObject({ ageDays: 60, repo: "tool", notes: [] });
    expect(of("~/workspace/shop/node_modules")!.notes).toEqual(["1 agent works in this repo"]);
    expect(of("~/.local/share/pnpm/store")!.notes[0]).toContain("less space than this can come back");
  });

  it("keeps a copy with work that is not saved on GitHub out of \"safe\"", () => {
    expect(of("~/workspace/shop/.agent-worktrees/agent-gone2")).toMatchObject({ floor: "check", notes: [UNSAVED] });
    expect(of("~/workspace/shop/.agent-worktrees/agent-closed1")).toMatchObject({ floor: "check", notes: [UNSAVED], agent: "Old task" });
    expect(of("~/workspace/shop/.agent-worktrees/agent-gone1")).toMatchObject({ floor: "safe", notes: [] });
    expect(d.gitAsked).toContain("home/you/workspace/shop/.agent-worktrees/agent-gone2: rev-list --count HEAD --not --remotes");
    expect(d.gitAsked).toContain("home/you/workspace/shop/.agent-worktrees/agent-gone2: --no-optional-locks status --porcelain");
    expect(fixedWords(of("~/workspace/shop/.agent-worktrees/agent-gone2")!).what).toBe("A copy of the repo shop that no agent uses. It has work that is not saved on GitHub");
    // The page never removes a copy with unsaved work or a full repo; a left-over folder that git does not know has its button.
    expect(of("~/workspace/shop/.agent-worktrees/agent-clone1")!.notes).toEqual([OWN_REPO]);
    expect(of("~/workspace/shop/.agent-worktrees/agent-plain1")!.notes).toEqual([PLAIN]);
    expect(["agent-gone2", "agent-closed1", "agent-clone1", "agent-plain1", "agent-gone1", "agent-closed2"].map((n) => !!rowOf(of(`~/workspace/shop/.agent-worktrees/${n}`)!).noRemove))
      .toEqual([true, true, true, false, false, false]);
  });

  it("never suggests: an open agent's folder, a database, a secret or private place, the console's own build, a small or new thing", () => {
    const all = found.map((c) => c.where).join("\n");
    for (const never of [
      "agent-open1", // the folder of an open agent, its installed parts, and the second copy "agent-open1-b"
      "pgdata", "app.sqlite", // a database
      ".ssh", "wallet-backup.bin", "hidden", // a key store, a wallet file, a private place
      "console/.next\n", "console/.next-prev", "console/node_modules", // the console's running build, the build a deploy goes back to, its own parts
      "docs/build", // "build" with no package.json beside it
      "tiny", "small-new", "small.zip", // too small
      "my-wallet-tmp", // a refused name in the temp folder: the run does not go into it
      "sock-old", "sock-big", // a socket in it, also deep in it: a running program can use it
      "tmux-1000", "hc-AbCd1234", "ssh-XXXXabcd", // names that are never touched
      "open-old", "pid-live", // a running program has a file of it open; its pid file names a live process
      "lock-small", // a lock file in a small folder: not in a row of many
      "chief-new", "in-use", "new.zip", "today.log", // changed a short time ago
      "link-to-keys", // a link is not followed
      ".git",
    ]) expect([never, all.includes(never)]).toEqual([never, false]);
    // One run measures the temp folder and one run looks for sockets and the like; neither goes into a refused or never-touched folder.
    const runs = d.measured.filter((m) => m.startsWith("children of") || m.startsWith("marks of"));
    expect(runs.map((m) => m.split(",")[0])).toEqual(["marks of tmp", "children of tmp"]);
    expect(runs[1].split("skip ")[1].split(",").sort()).toEqual(["tmp/hc-AbCd1234", "tmp/my-wallet-tmp", "tmp/ssh-XXXXabcd", "tmp/tmux-1000"]);
    expect(d.measured.some((m) => m.startsWith("tmp/"))).toBe(false); // no run per temp folder
    const [ours, other] = [found.find((c) => c.bulk === "ours")!, found.find((c) => c.bulk === "other")!];
    expect(other).toMatchObject({ count: 150, ageDays: 20, path: join(T, "tmp"), floor: "check" });
    expect(ours).toMatchObject({ count: 12, floor: "safe" });
    expect(fixedWords(other).what).toBe("150 old temporary folders of other programs");
    expect(fixedWords(ours).what).toBe("12 small temporary folders made by test runs of ChoiBot");
    expect(found.find((c) => c.where.endsWith("/pid-dead"))!.notes).toEqual([LOCKED]);
    expect(found.find((c) => c.where.endsWith("/chief-old"))).toMatchObject({ floor: "safe", madeBy: "ChoiBot's tests" });
    // The audit did not even measure them.
    for (const p of ["home/you/.ssh/big", "home/you/workspace/hidden/node_modules", "home/you/workspace/shop/pgdata", "home/you/workspace/shop/.agent-worktrees/agent-open1", "home/you/workspace/console/node_modules", "home/you/workspace/console/.next"]) {
      expect([p, d.measured.includes(p)]).toEqual([p, false]);
    }
  });

  it("suggests nothing that another user owns, and stops at its time limit", async () => {
    expect((await scan(deps({ uid: process.getuid!() + 1 }))).candidates).toEqual([]);
    const late = await scan({ ...deps(), deadline: Date.now() - 1 });
    expect(late).toEqual({ candidates: [], partial: true });
  });

  it("the real measure gives a made-up folder its size and its newest change", async () => {
    file("measure/sub/a.bin", 300_000, 10);
    file("measure/b.bin", 10, 3);
    const m = await systemMeasure(10_000)(join(T, "measure"));
    expect(m!.bytes).toBeGreaterThanOrEqual(300_000);
    // du gives the newest change in the folder (a file, or the folder itself: made now).
    expect(m!.newest).toBeGreaterThan(NOW - 4 * DAY);
    expect(await systemMeasure(10_000)(join(T, "not-there"))).toBeNull();
    // One run for every folder of a folder; a skipped folder (also one with a glob character) is not in it.
    file("measure/keep*me/c.bin", 50_000, 10);
    const all = await systemMeasureChildren(10_000)(join(T, "measure"), [join(T, "measure", "keep*me")]);
    expect([...all!.keys()]).toEqual([join(T, "measure", "sub")]);
    expect(all!.get(join(T, "measure", "sub"))!.bytes).toBeGreaterThanOrEqual(300_000);
    expect((await systemMeasureChildren(10_000)(join(T, "measure"), []))!.size).toBe(2);
  });
});

describe("the AI step", () => {
  const cands: Candidate[] = [
    { id: "c1", path: "/x/target", where: "~/workspace/tool/target", kind: "build-output", floor: "safe", bytes: 2500 * MB, ageDays: 60, repo: "tool", notes: [] },
    { id: "c2", path: "/x/copy", where: "~/workspace/shop/.agent-worktrees/agent-gone2", kind: "unused-copy", floor: "check", bytes: 800 * MB, ageDays: 40, repo: "shop", notes: [UNSAVED] },
    { id: "c3", path: "/x/cache", where: "~/.cache/ms-playwright", kind: "tool-cache", floor: "safe", bytes: 1800 * MB, ageDays: 50, madeBy: "ms-playwright", notes: [] },
  ];
  const rows = cands.map(rowOf);
  const floors = new Map(cands.map((c) => [c.id, c.floor]));

  it("gets a table with short paths and words for the size and the age: no full path", () => {
    const table = JSON.parse(tableFor(cands)) as Record<string, unknown>[];
    expect(table[0]).toEqual({ id: "c1", where: "~/workspace/tool/target", kind: "build-output", floor: "safe", size: "2.4 GB", age: "last changed 60 days ago", repo: "tool", notes: [] });
    expect(JSON.stringify(table)).not.toContain("/x/");
    expect(AUDIT_SYSTEM).toContain("no tool");
  });

  it("drops a row with an invented path, keeps code's group, and shows no size that the model wrote", () => {
    const answer = "Here is the list:\n```json\n" + JSON.stringify([
      { id: "c1", group: "safe", what: "The files that the Rust compiler made for the tool project.", effect: "The next build makes them again. This takes some minutes.", sure: "high", bytes: 99, size: "900 GB" },
      { id: "c2", group: "safe", what: "An old copy of the shop repo.", effect: "Nothing is lost.", sure: "high" }, // code said "check"
      { id: "c3", group: "check", what: "Browsers for tests, about 1.8 GB of them.", effect: "They free 30% of the disk.", sure: "very" }, // a size in the text
      { id: "c9", group: "safe", what: "The folder /etc of the system.", effect: "Nothing.", sure: "high" }, // not in the table
      { id: "c1", group: "check", what: "A second answer for the same row.", effect: "It is not used.", sure: "low" },
      { where: "/home/you/.ssh", group: "safe", what: "Old keys.", effect: "Nothing.", sure: "high" }, // no id at all
    ]) + "\n```";
    const m = mergeAnswer(rows, floors, answer);
    expect(m.dropped).toBe(3);
    expect(m.used).toBe(2);
    expect(m.rows.map((r) => r.id)).toEqual(["c1", "c2", "c3"]);
    expect(m.rows[0]).toMatchObject({ group: "safe", byAi: true, sure: "high", what: "The files that the Rust compiler made for the tool project.", bytes: 2500 * MB });
    expect(m.rows[1]).toMatchObject({ group: "check", byAi: true }); // "safe" of the model is not taken
    expect(m.rows[2]).toMatchObject({ group: "check", byAi: false, what: rows[2].what, sure: rows[2].sure }); // more careful is taken; the words are code's
    expect(JSON.stringify(m.rows)).not.toMatch(/900 GB|1\.8 GB|30%|\/etc|Old keys/);
  });

  it("uses nothing of an answer that is not a list", () => {
    for (const bad of ["", "I cannot help with that.", "{\"id\":\"c1\"}", "[not json]", "[1, 2, 3]"]) {
      const m = mergeAnswer(rows, floors, bad);
      expect([bad, m.used, m.rows.every((r, i) => r === rows[i] || r.byAi === false)]).toEqual([bad, 0, true]);
    }
  });

  it("refuses a text with a size, a share, a link, a command or more than one line", () => {
    for (const bad of ["It is 12 GB of files.", "It uses 40% of the disk.", "See https://example.invalid for it.", "Run rm -rf on it.", "Use `du` on it.", "a", "x".repeat(300), 7, null, "Bad <b>text</b>."]) expect([bad, cleanText(bad)]).toEqual([bad, null]);
    expect(cleanText("  The next build\nmakes it again. This takes about 3 minutes. ")).toBe("The next build makes it again. This takes about 3 minutes.");
  });
});

describe("one audit", () => {
  const model = (text: string, calls: string[] = []): GuideModel => async ({ input }) => { calls.push(input); return { ok: true, text }; };
  const make = (o: { model?: GuideModel; now?: () => number; file?: string } = {}) => new Audit({
    deps: async () => deps(), file: o.file ?? join(T, "data", `audit-${Math.random().toString(36).slice(2)}.json`), model: o.model, now: o.now ?? (() => NOW), log: () => {},
  });

  it("gives the list with the model's words, and counts every size and the total itself", async () => {
    const calls: string[] = [];
    const a = make({ model: model(JSON.stringify([{ id: "c2", group: "safe", what: "The files that the Rust compiler made.", effect: "The next build makes them again.", sure: "high", bytes: 1 }, { id: "c999", group: "safe", what: "An invented row.", effect: "Nothing.", sure: "high" }]), calls) });
    expect(await a.view()).toEqual({ state: "none" });
    const run = a.start();
    expect(run.started).toBe(true);
    expect(a.start().started).toBe(false); // one at a time
    expect((await a.view()).state).toBe("running");
    await run.done;
    const v = await a.view();
    expect(v.state).toBe("done");
    expect(v.result).toMatchObject({ checkedAt: NOW, partial: false, ai: "ok", old: false });
    expect(v.result!.rows).toHaveLength(27);
    expect(v.result!.rows[1]).toMatchObject({ id: "c2", where: "~/workspace/tool/target", byAi: true, bytes: 2500 * MB });
    expect(v.result!.rows.some((r) => r.what === "An invented row.")).toBe(false);
    const sum = (g: string) => v.result!.rows.filter((r) => r.group === g).reduce((n, r) => n + r.bytes, 0);
    expect([v.result!.safeBytes, v.result!.checkBytes]).toEqual([sum("safe"), sum("check")]);
    expect(Math.round(v.result!.safeBytes / MB)).toBe(4200 + 2500 + 1800 + 1200 + 640 + 500 + 400 + 300 + 120 + 70 + 50 + 40 + 12 + 12 + 11);
    // No row has a full path of the server.
    expect(JSON.stringify(v.result!.rows)).not.toContain(home);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain(home);
  });

  it("with no Claude login or a plan at its limit the list still comes, with the fixed words", async () => {
    for (const why of ["login", "limit", "down"] as const) {
      const a = make({ model: async () => ({ ok: false, why }) });
      await a.start().done;
      const r = (await a.view()).result!;
      expect([r.ai, r.rows.length, r.rows.every((x) => !x.byAi)]).toEqual([why, 27, true]);
      expect(r.rows[1].what).toBe("A build output of the repo tool");
    }
    const none = make({});
    await none.start().done;
    expect((await none.view()).result!.ai).toBe("none");
    const junk = make({ model: model("I do not know.") });
    await junk.start().done;
    expect((await junk.view()).result!.ai).toBe("down");
  });

  it("keeps the last result over a restart and marks it old after a day", async () => {
    const f = join(T, "data", "kept.json");
    let now = NOW;
    const a = make({ file: f, now: () => now });
    await a.start().done;
    const again = make({ file: f, now: () => now });
    expect((await again.view()).result).toMatchObject({ checkedAt: NOW, old: false });
    now = NOW + OLD_AFTER_MS + 1;
    expect((await again.view()).result!.old).toBe(true);
  });
});

describe("who may start and read an audit", () => {
  const USER = "user-token";
  const HOOK = "hook-token";
  function app(gateOn = true) {
    const a = Fastify();
    const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id) ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
    const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices: { verify: async (t: string) => (t === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents } });
    let starts = 0;
    const audit = new Audit({ deps: async () => { starts += 1; return deps(); }, file: join(T, "data", `who-${Math.random().toString(36).slice(2)}.json`), log: () => {} });
    registerAuditApi(a, { gate: gateOn ? gate : undefined, audit });
    return { a, starts: () => starts };
  }

  it("the paired user starts one and reads it; a second press while it runs is refused", async () => {
    const { a, starts } = app();
    const user = { [USER_HEADER]: USER };
    expect((await a.inject({ method: "GET", url: "/api/server/audit", headers: user })).json()).toEqual({ state: "none" });
    expect((await a.inject({ method: "POST", url: "/api/server/audit", headers: user })).statusCode).toBe(202);
    expect((await a.inject({ method: "POST", url: "/api/server/audit", headers: user })).statusCode).toBe(409);
    for (let i = 0; i < 50 && (await a.inject({ method: "GET", url: "/api/server/audit", headers: user })).json().state !== "done"; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect((await a.inject({ method: "GET", url: "/api/server/audit", headers: user })).json()).toMatchObject({ state: "done", result: { ai: "none" } });
    expect(starts()).toBe(1);
    await a.close();
  });

  it("an agent, a lead, the fleet master and a browser that is not paired get 403, and no audit starts", async () => {
    const { a, starts } = app();
    for (const method of ["GET", "POST"] as const) {
      for (const headers of [{}, { [USER_HEADER]: "wrong" }, ...["w1", "lead-app", "fleet-master"].map((id) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: HOOK }))]) {
        const res = await a.inject({ method, url: "/api/server/audit", headers });
        expect([method, res.statusCode, res.json().error]).toEqual([method, 403, CHIEF_ERR.pairRequired]);
      }
    }
    const open = app(false);
    for (const method of ["GET", "POST"] as const) expect((await open.a.inject({ method, url: "/api/server/audit", headers: { [USER_HEADER]: USER } })).json()).toEqual(AUDIT_NO_PAIRING);
    expect([starts(), open.starts()]).toEqual([0, 0]);
    await a.close();
    await open.a.close();
  });
});

// A removal in these tests removes nothing (the fake writes the path down), but one: the last
// test removes a made-up folder for real.
describe("a removal", () => {
  const W = "~/workspace/";
  const C = `${W}shop/.agent-worktrees/`;
  // One audit on the made-up tree, then removals with what `over` says is true NOW.
  async function ready(over: Partial<AuditDeps> = {}, o: { now?: () => number } = {}) {
    let now: Partial<AuditDeps> = {};
    const fakes = deps();
    const logs: string[] = [];
    const a = new Audit({ deps: async () => ({ ...fakes, ...now }), file: join(T, "data", `rm-${Math.random().toString(36).slice(2)}.json`), now: o.now ?? (() => NOW), log: (l) => logs.push(l) });
    await a.start().done;
    now = over;
    const first = (await a.view()).result!;
    const id = (where: string) => first.rows.find((r) => r.where === where)!.id;
    // Removes one row and waits. The answer: null when it is gone, else why not.
    const remove = async (where: string): Promise<string | null> => {
      const r = await a.remove({ id: id(where), checkedAt: first.checkedAt });
      if (!r.started) return r.text;
      await r.done;
      return (await a.view()).refused?.text ?? null;
    };
    return { a, first, id, remove, fakes, logs, setNow: (x: Partial<AuditDeps>) => { now = x; } };
  }

  it("removes a thing with fs, a copy with git and the copy of a closed agent with \"Delete the agent\"", async () => {
    const { a, remove, fakes, logs } = await ready();
    expect(await remove(`${W}tool/target`)).toBeNull();
    expect(await remove("~/.cache/ms-playwright")).toBeNull();
    expect(await remove(`${C}agent-gone1`)).toBeNull();
    expect(await remove(`${C}agent-closed2`)).toBeNull();
    expect(await remove(`${C}agent-plain1`)).toBeNull(); // a left-over folder that git does not know
    expect(await remove(`${W}console/.next-failed`)).toBeNull();
    expect(await remove(`${W}shop/debug.log`)).toBeNull();
    expect(fakes.rmd).toEqual(["home/you/workspace/tool/target", "home/you/.cache/ms-playwright", "home/you/workspace/shop/.agent-worktrees/agent-plain1", "home/you/workspace/console/.next-failed", "home/you/workspace/shop/debug.log"]);
    expect(fakes.worktreesRemoved).toEqual(["home/you/workspace/shop <- home/you/workspace/shop/.agent-worktrees/agent-gone1"]);
    expect(fakes.agentsDeleted).toEqual(["a3"]);
    // The rows left the list, and the answer says what came back.
    const v = (await a.view()).result!;
    expect(v.rows).toHaveLength(27 - 7);
    expect(v.rows.some((r) => r.where.includes("tool/target"))).toBe(false);
    expect([v.freedCount, Math.round(v.freedBytes / MB)]).toEqual([7, 2500 + 1800 + 1200 + 600 + 310 + 120 + 11]);
    // One log line per removal: the path only when it is in the work folder or a temp folder.
    expect(logs).toHaveLength(7);
    expect(logs[0]).toMatch(new RegExp(`^\\[audit\\] removed on the user's press: build-output, 2500 MB, device \\d+, ${join(ws, "tool", "target")}$`));
    expect(logs[1]).toMatch(/^\[audit\] removed on the user's press: tool-cache, 1800 MB, device \d+$/);
  });

  it("takes an id of the last result only: never a path, an old result or a row that was removed", async () => {
    let now = NOW;
    const { a, first, id, fakes } = await ready({}, { now: () => now });
    const text = async (o: Parameters<Audit["remove"]>[0]) => { const r = await a.remove(o); return r.started ? "started" : r.text; };
    for (const bad of [join(ws, "tool", "target"), "/etc", "~/workspace/tool/target", "c999", "", 7, null, undefined, ["c1"]]) {
      expect([bad, await text({ id: bad, checkedAt: first.checkedAt })]).toEqual([bad, "This row is not in the list."]);
    }
    expect(await text({ id: id(`${W}tool/target`), checkedAt: first.checkedAt - 1 })).toBe("The list changed. Read it again.");
    expect(await text({ id: id(`${W}tool/target`) })).toBe("The list changed. Read it again.");
    expect(await text({ all: "check", checkedAt: first.checkedAt })).toBe("This row is not in the list."); // "all" is for the safe group only
    now = NOW + OLD_AFTER_MS + 1;
    expect(await text({ id: id(`${W}tool/target`), checkedAt: first.checkedAt })).toBe("This result is old. Run the audit again.");
    expect(await text({ all: "safe", checkedAt: first.checkedAt })).toBe("This result is old. Run the audit again.");
    now = NOW;
    const r = await a.remove({ id: id(`${W}tool/target`), checkedAt: first.checkedAt });
    expect(r.started).toBe(true);
    if (r.started) await r.done;
    expect(await text({ id: id(`${W}tool/target`), checkedAt: first.checkedAt })).toBe("It was removed already.");
    expect(fakes.rmd).toEqual(["home/you/workspace/tool/target"]);
  });

  it("never removes a copy with work that is not saved, a full repo, or a copy that got new work after the audit", async () => {
    const { remove, fakes } = await ready();
    expect(await remove(`${C}agent-gone2`)).toContain("its work is not saved on GitHub");
    expect(await remove(`${C}agent-closed1`)).toContain("its work is not saved on GitHub");
    expect(await remove(`${C}agent-clone1`)).toContain("it is a full repo");
    try {
      gitNow = { "agent-gone1": { ahead: "2\n" } }; // a commit that is on no remote, made after the audit
      expect(await remove(`${C}agent-gone1`)).toBe("This copy has work that is not saved on GitHub: it is not removed. Run the audit again.");
      gitNow = { "agent-gone1": { dirty: " M a.ts\n" }, "agent-closed2": { dirty: "?? new.ts\n" } };
      expect(await remove(`${C}agent-gone1`)).toContain("not saved on GitHub");
      expect(await remove(`${C}agent-closed2`)).toContain("not saved on GitHub");
    } finally { gitNow = {}; }
    expect([fakes.rmd, fakes.worktreesRemoved, fakes.agentsDeleted]).toEqual([[], [], []]);
  });

  it("refuses when the thing is not what it was at the audit: a link, another owner, a mount, a private place, an agent's folder", async () => {
    const target = join(ws, "tool", "target");
    // A link swapped in for the folder.
    const a1 = await ready();
    renameSync(target, `${target}-moved`);
    symlinkSync(join(home, ".ssh"), target);
    try { expect(await a1.remove(`${W}tool/target`)).toBe("It is not the same thing as at the audit. Run the audit again."); } finally { rmSync(target); renameSync(`${target}-moved`, target); }
    // A link swapped in for a folder above it: the real path is then another one.
    renameSync(join(ws, "tool"), join(ws, "tool-moved"));
    symlinkSync(join(ws, "tool-moved"), join(ws, "tool"));
    try { expect(await a1.remove(`${W}tool/target`)).toBe("Its path changed since the audit. Run the audit again."); } finally { rmSync(join(ws, "tool")); renameSync(join(ws, "tool-moved"), join(ws, "tool")); }
    // It is gone.
    renameSync(target, `${target}-moved`);
    try { expect(await a1.remove(`${W}tool/target`)).toBe("It is not there any more."); } finally { renameSync(`${target}-moved`, target); }
    expect(a1.fakes.rmd).toEqual([]);

    const cases: [Partial<AuditDeps>, string, string][] = [
      [{ uid: process.getuid!() + 1 }, `${W}tool/target`, "It belongs to another user: it is not removed."],
      [{ mounts: () => ["/", join(target, "cache")] }, `${W}tool/target`, "A disk is mounted on it or in it: it is not removed."],
      [{ mounts: () => ["/", target] }, `${W}tool/target`, "A disk is mounted on it or in it: it is not removed."],
      [{ mounts: () => { throw new Error("no /proc"); } }, `${W}tool/target`, "It could not be removed."], // not known = no removal
      [{ wide: wideFor({ env: { HOME: home, FILES_REFUSED_EXTRA: join(ws, "tool") }, checkout: join(ws, "console"), passwd: "" }) }, `${W}tool/target`, "This place holds a key, is private or is a part of ChoiBot's records: it is not removed."],
      // The copy became the folder of an open agent; an agent started in a folder beside it with the same name.
      [{ agents: [{ id: "n1", title: "New", repo: join(ws, "shop"), worktree: copy("agent-gone1"), closed: false }] }, `${C}agent-gone1`, "A place that must stay is in it: it is not removed."],
      [{ agents: [{ id: "n1", title: "New", repo: join(ws, "shop"), worktree: copy("agent-go"), closed: false }] }, `${C}agent-gone1`, "An agent uses this copy now: it is not removed."],
      // The closed agent was opened again, or its record is gone.
      [{ agents: [{ id: "a3", title: "Done task", repo: join(ws, "shop"), worktree: copy("agent-closed2"), closed: false }] }, `${C}agent-closed2`, "A place that must stay is in it: it is not removed."],
      [{ agents: [] }, `${C}agent-closed2`, "The agent of this copy is not there any more. Run the audit again."],
      // A program changed the temp folder after the audit.
      [{ measure: async () => ({ bytes: 500 * MB, newest: NOW - DAY }) }, `${join(T, "tmp")}/chief-old`, "A program changed these files after the audit. Run the audit again."],
      [{ measure: async () => null }, `${W}tool/target`, "It took too long to measure. Try again later."],
    ];
    for (const [over, where, why] of cases) {
      const x = await ready(over);
      expect([where, await x.remove(where)]).toEqual([where, why]);
      expect([x.fakes.rmd, x.fakes.worktreesRemoved, x.fakes.agentsDeleted]).toEqual([[], [], []]);
    }
  });

  it("never removes a place that must stay, also when a row names it (a made-up row for each)", async () => {
    const d = { ...deps(), now: NOW, mounts: ["/"] };
    const row = (path: string, kind: Candidate["kind"] = "build-output"): Candidate => ({ id: "x", path, where: path, kind, floor: "safe", bytes: 1, ageDays: 99, notes: [] });
    const must: [string, Candidate["kind"]?][] = [
      ["/"], [join(T, "home")], [home], [ws], [join(ws, "shop")], [join(ws, "console")], [copy("agent-open1")],
    ];
    for (const [p, kind] of must) expect([p, await removeCandidate(row(p, kind), d)]).toEqual([p, { ok: false, text: "A place that must stay is in it: it is not removed." }]);
    // The console's running build, the build that a deploy goes back to, and its own parts.
    for (const name of [".next", ".next-prev", "node_modules"]) {
      expect([name, await removeCandidate(row(join(ws, "console", name), "old-build"), d)]).toEqual([name, { ok: false, text: "This is a part of ChoiBot: it is not removed." }]);
    }
    // Inside the folder of an open agent.
    expect(await removeCandidate(row(join(copy("agent-open1"), "node_modules"), "installed-parts"), d)).toEqual({ ok: false, text: "An agent uses this now: it is not removed." });
    // A key store and a private place.
    for (const p of [join(home, ".ssh"), join(home, ".ssh", "big"), join(ws, "hidden", "node_modules")]) expect((await removeCandidate(row(p), d)).ok).toBe(false);
    expect(d.rmd).toEqual([]);
  });

  it("removes the many small old temp folders one by one: only the ones of the row, none that is in use", async () => {
    const TMP = join(T, "tmp");
    const x = await ready();
    expect(await x.remove(`${TMP}: 150 small folders of other programs, not changed for 7 days or more`)).toBeNull();
    expect(x.fakes.rmd).toHaveLength(150);
    expect(x.fakes.rmd.every((p) => /^tmp\/api-\d{3}$/.test(p))).toBe(true); // no sock-old, no lock-small, no tmux, no chief-*
    expect(Math.round((await x.a.view()).result!.freedBytes / MB)).toBe(30);
    expect(await x.remove(`${TMP}: 12 small folders made by test runs of ChoiBot, not changed for 7 days or more`)).toBeNull();
    expect(x.fakes.rmd.slice(150).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `tmp/chief-api-${i}`).sort());
    // After the audit: a socket came into one folder, a program opened a file in a second one, a lock file came into a third.
    const y = await ready();
    const base = deps();
    y.setNow({
      marks: async (dir, skip) => [...((await base.marks(dir, skip)) ?? []), { type: "s", path: join(TMP, "api-003", "ipc.sock") }, { type: "f", path: join(TMP, "api-005", "x.lock") }],
      inUse: () => [join(TMP, "api-004", "open.txt")],
    });
    expect(await y.remove(`${TMP}: 150 small folders of other programs, not changed for 7 days or more`)).toBeNull();
    expect(y.fakes.rmd).toHaveLength(147);
    for (const kept of ["tmp/api-003", "tmp/api-004", "tmp/api-005"]) expect(y.fakes.rmd).not.toContain(kept);
    // The facts cannot be read: nothing is removed.
    for (const over of [{ inUse: () => null }, { marks: async () => null }] as Partial<AuditDeps>[]) {
      const z = await ready();
      z.setNow(over);
      expect(await z.remove(`${TMP}: 150 small folders of other programs, not changed for 7 days or more`)).toBe("ChoiBot cannot see now if a program uses it: it is not removed.");
      expect(await z.remove(`${W}tool/target`)).toBe("ChoiBot cannot see now if a program uses it: it is not removed.");
      expect(await z.remove(`${W}shop/debug.log`)).toBe(over.inUse ? "ChoiBot cannot see now if a program uses it: it is not removed." : null);
      expect(z.fakes.rmd).toEqual(over.inUse ? [] : ["home/you/workspace/shop/debug.log"]);
    }
  });

  it("never removes a folder that a running program uses, also when a row of the result names it", async () => {
    const IN_USE = "A running program uses it (an open file, a socket, a pipe or a live process): it is not removed.";
    const d = { ...deps(), now: NOW, mounts: ["/"] };
    const row = (rel: string, o: Partial<Candidate> = {}): Candidate => ({ id: "x", path: join(T, rel), where: rel, kind: "temp", floor: "safe", bytes: MB, ageDays: 30, notes: [], ...o });
    // A folder with only a socket, 30 days old; a socket deep in a folder; names that are never touched; an open file; a live pid file.
    for (const rel of ["tmp/sock-old", "tmp/sock-big", "tmp/tmux-1000", "tmp/hc-AbCd1234", "tmp/ssh-XXXXabcd", "tmp/open-old", "tmp/pid-live"]) {
      expect([rel, await removeCandidate(row(rel), d)]).toEqual([rel, { ok: false, text: IN_USE }]);
    }
    // A lock file that the row did not show; with the row's note the user saw it (a check-first row).
    expect(await removeCandidate(row("tmp/pid-dead"), d)).toEqual({ ok: false, text: "It now holds a lock file: a program can use it. Run the audit again." });
    expect((await removeCandidate(row("tmp/pid-dead", { floor: "check", notes: [LOCKED] }), d)).ok).toBe(true);
    // A row of many folders from a result of the code before this rule.
    expect(await removeCandidate(row("tmp", { count: 150 }), d)).toEqual({ ok: false, text: "This row is of an older audit. Run the audit again." });
    expect(d.rmd).toEqual(["tmp/pid-dead"]);
    // The same through a result file with a planted row (the socket folder as a "safe" row).
    const planted = row("tmp/sock-old");
    const f = join(T, "data", "planted.json");
    writeFileSync(f, JSON.stringify({ checkedAt: NOW, partial: false, ai: "none", rows: [rowOf(planted)], candidates: [planted] }));
    const fakes = deps();
    const a = new Audit({ deps: async () => fakes, file: f, now: () => NOW, log: () => {} });
    for (const what of [{ id: "x" }, { all: "safe" }]) {
      const r = await a.remove({ ...what, checkedAt: NOW });
      expect(r.started).toBe(true);
      if (r.started) await r.done;
      expect((await a.view()).refused).toEqual({ id: "x", text: IN_USE });
    }
    expect(fakes.rmd).toEqual([]);
    // In use only after the audit: a build output with an open file, a log file that a program holds open.
    const y = await ready({ inUse: () => [join(ws, "tool", "target", "debug", "tool.bin"), join(ws, "shop", "debug.log")] });
    expect(await y.remove(`${W}tool/target`)).toBe(IN_USE);
    expect(await y.remove(`${W}shop/debug.log`)).toBe(IN_USE);
    expect(y.fakes.rmd).toEqual([]);
  });

  it("the scan lists no temp folder when it cannot see what is in use, and no thing that a program has open", async () => {
    const tmpRows = (c: Candidate[]) => c.filter((x) => x.kind === "temp").length;
    const full = await scan({ ...deps(), now: NOW });
    expect([tmpRows(full.candidates), full.partial]).toEqual([5, false]);
    for (const over of [{ inUse: () => null }, { marks: async () => null }] as Partial<AuditDeps>[]) {
      const r = await scan({ ...deps(), ...over, now: NOW });
      expect([tmpRows(r.candidates), r.partial, r.candidates.length]).toEqual([0, true, full.candidates.length - 5]);
    }
    const busy = await scan({ ...deps(), inUse: () => [join(ws, "tool", "target", "debug", "x"), join(ws, "shop", "debug.log")], now: NOW });
    expect(busy.candidates.some((c) => c.where.endsWith("tool/target") || c.where.endsWith("debug.log"))).toBe(false);
    expect(busy.candidates.some((c) => c.where.endsWith("/open-old"))).toBe(true); // no program has it open in this run
  });

  it("knows the names that are never touched and the names of ChoiBot's own temp folders", () => {
    for (const n of ["tmux-1000", "ssh-AbCdEf123", ".X11-unix", ".ICE-unix", "dbus-xyz", "systemd-private-abc-foo.service-x", "snap-private-tmp", "choibot-dtach", "choibot-dtach", "choibot-dtach-2", "hc-nCrcx73S", "claude-1000", "claude", "gpg-abc", "screen-you"]) {
      expect([n, NEVER_NAME.test(n), OUR_NAME.test(n)]).toEqual([n, true, false]);
    }
    for (const n of ["chief-srv4", "chief-api-Ab12Cd", "choibot-index-x1", "path-test-9", "install-test", "tsx-1000", "node-compile-cache"]) expect([n, NEVER_NAME.test(n), OUR_NAME.test(n)]).toEqual([n, false, true]);
    for (const n of ["api-Ab12Cd", "tmp.o8VtTDdEYw", "choibot-run", "choibot-cli-cache", "choibot-x", "claude-cfg-x", "sshfs-notes", "tsx-cache", "hcl-files", "mytmux-1"]) expect([n, NEVER_NAME.test(n), OUR_NAME.test(n)]).toEqual([n, false, false]);
  });

  it("the real readers find a socket, a pipe, a pid file and an open file in a made-up folder", async () => {
    const base = dir("realuse");
    dir("realuse/a/deep"); dir("realuse/b"); dir("realuse/c"); dir("realuse/skip*me");
    const server = createServer();
    await new Promise<void>((r) => server.listen(join(base, "a", "deep", "s.sock"), r));
    execFileSync("mkfifo", [join(base, "b", "pipe")]);
    writeFileSync(join(base, "c", "app.pid"), `${process.pid}\n`);
    writeFileSync(join(base, "c", "dead.pid"), "4194999\n");
    writeFileSync(join(base, "c", "big.pid"), "1".repeat(40));
    symlinkSync(join(base, "c", "app.pid"), join(base, "c", "link.pid"));
    writeFileSync(join(base, "c", "db.lock"), "");
    writeFileSync(join(base, "c", "plain.txt"), "x");
    writeFileSync(join(base, "skip*me", "x.lock"), "");
    try {
      const marks = (await systemMarks(20_000)(base, [join(base, "skip*me")]))!;
      expect(marks.map((m) => `${m.type} ${relative(base, m.path)}`).sort()).toEqual(["f c/app.pid", "f c/big.pid", "f c/db.lock", "f c/dead.pid", "l c/link.pid", "p b/pipe", "s a/deep/s.sock"]);
      expect((await systemMarks(20_000)(base, []))!.some((m) => m.path.endsWith("x.lock"))).toBe(true);
      expect(await systemMarks(20_000)(join(T, "not-there"), [])).toBeNull();
      expect([await livePid(join(base, "c", "app.pid")), await livePid(join(base, "c", "dead.pid")), await livePid(join(base, "c", "big.pid")), await livePid(join(base, "c", "link.pid")), await livePid(join(base, "c", "plain.txt")), await livePid(join(base, "none"))])
        .toEqual([true, false, false, false, false, false]);
      // The facts of the three folders, with the real readers: a (socket) and b (pipe) and c (a live pid file) are never removed.
      const fd = openSync(join(base, "c", "plain.txt"), "r");
      try {
        const used = liveUse(process.getuid!())!;
        expect(used).toContain(join(base, "c", "plain.txt")); // this test process has it open
        expect(used).toContain(process.cwd());
        const real = { marks: systemMarks(20_000), inUse: () => liveUse(process.getuid!()), livePid: (f: string) => livePid(f) };
        const facts = (await useFacts(base, ["a", "b", "c"].map((n) => join(base, n)), [], real))!;
        expect(["a", "b", "c"].map((n) => useState(join(base, n), facts, { temp: true }))).toEqual(["never", "never", "never"]);
        expect([facts.special.has(join(base, "a")), facts.special.has(join(base, "b")), facts.live.has(join(base, "c"))]).toEqual([true, true, true]);
      } finally { closeSync(fd); }
      expect(liveUse(process.getuid!(), join(T, "no-proc"))).toBeNull();
      expect(liveUse(process.getuid!() + 12345)).toBeNull(); // no process of that user: this process is not in the list
    } finally { await new Promise((r) => server.close(r)); }
  });

  it("\"Remove all\" takes the safe group only, one after the other, and stops at the first refusal", async () => {
    const x = await ready();
    const safe = x.first.rows.filter((r) => r.group === "safe");
    // The third safe row cannot be removed now (a disk is mounted in it).
    x.setNow({ mounts: () => ["/", join(home, ".cache", "ms-playwright", "disk")] });
    const r = await x.a.remove({ all: "safe", checkedAt: x.first.checkedAt });
    expect(r.started).toBe(true);
    // One removal at a time: nothing else starts while this one runs.
    expect(await x.a.remove({ id: safe[5].id, checkedAt: x.first.checkedAt })).toEqual({ started: false, text: "Another thing is removed now. Wait a moment." });
    expect(x.a.start().started).toBe(false);
    if (r.started) await r.done;
    const v = await x.a.view();
    expect(safe.slice(0, 3).map((s) => s.where)).toEqual(["~/.local/share/pnpm/store", "~/workspace/tool/target", "~/.cache/ms-playwright"]);
    expect(x.fakes.rmd).toEqual(["home/you/.local/share/pnpm/store", "home/you/workspace/tool/target"]);
    expect(v.refused).toEqual({ id: safe[2].id, text: "A disk is mounted on it or in it: it is not removed." });
    expect([v.removing, v.result!.freedCount]).toEqual([undefined, 2]);
    // With nothing in the way, it takes every safe row and no "check first" row.
    const y = await ready();
    const all = await y.a.remove({ all: "safe", checkedAt: y.first.checkedAt });
    if (all.started) await all.done;
    const left = (await y.a.view()).result!;
    expect([left.rows.filter((r) => r.group === "safe").length, left.rows.filter((r) => r.group === "check").length, left.safeBytes]).toEqual([0, y.first.rows.filter((r) => r.group === "check").length, 0]);
    expect(left.freedCount).toBe(safe.length);
  });

  it("a test instance looks at no temp folder of its machine", () => {
    expect(auditTmpDirs({}, "/home/you", "/var/tmp")).toEqual(["/tmp", "/var/tmp"]);
    expect(auditTmpDirs({}, "/home/you", "/tmp")).toEqual(["/tmp"]);
    expect(auditTmpDirs({ CHIEF_TEST: "1" }, "/tmp/chief-x/home", "/tmp")).toEqual(["/tmp/chief-x/home/tmp"]);
  });

  it("is for the paired user only", async () => {
    const USER = "user-token";
    const HOOK = "hook-token";
    const app = (gateOn: boolean) => {
      const f = Fastify();
      const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id) ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
      const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices: { verify: async (t: string) => (t === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents } });
      const fakes = deps();
      const audit = new Audit({ deps: async () => fakes, file: join(T, "data", `who-rm-${Math.random().toString(36).slice(2)}.json`), log: () => {}, now: () => NOW });
      registerAuditApi(f, { gate: gateOn ? gate : undefined, audit });
      return { f, audit, fakes };
    };
    const { f, audit, fakes } = app(true);
    await audit.start().done;
    const first = (await audit.view()).result!;
    const body = { id: first.rows[1].id, checkedAt: first.checkedAt };
    for (const payload of [body, { all: "safe", checkedAt: first.checkedAt }]) {
      for (const headers of [{}, { [USER_HEADER]: "wrong" }, ...["w1", "lead-app", "fleet-master"].map((id) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: HOOK }))]) {
        const res = await f.inject({ method: "POST", url: "/api/server/audit/remove", headers, payload });
        expect([res.statusCode, res.json().error]).toEqual([403, CHIEF_ERR.pairRequired]);
      }
    }
    expect(fakes.rmd).toEqual([]);
    const bad = await f.inject({ method: "POST", url: "/api/server/audit/remove", headers: { [USER_HEADER]: USER }, payload: { id: "/etc", checkedAt: first.checkedAt } });
    expect([bad.statusCode, bad.json()]).toEqual([409, { error: "not-removed", text: "This row is not in the list." }]);
    expect((await f.inject({ method: "POST", url: "/api/server/audit/remove", headers: { [USER_HEADER]: USER }, payload: body })).statusCode).toBe(202);
    for (let i = 0; i < 50 && (await audit.view()).removing; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(fakes.rmd).toEqual(["home/you/workspace/tool/target"]);
    await f.close();
    const open = app(false);
    await open.audit.start().done;
    expect((await open.f.inject({ method: "POST", url: "/api/server/audit/remove", headers: { [USER_HEADER]: USER }, payload: body })).json()).toEqual(AUDIT_NO_PAIRING);
    expect(open.fakes.rmd).toEqual([]);
    await open.f.close();
  });

  it("the real removal takes a made-up folder away and does not follow a link in it", async () => {
    const keepDir = dir("real-rm/outside");
    file("real-rm/outside/keep.txt");
    const goes = dir("real-rm/ws/app/node_modules");
    file("real-rm/ws/app/node_modules/lib/a.bin", 1000);
    symlinkSync(keepDir, join(goes, "link-out"));
    const w = wideFor({ env: { HOME: join(T, "real-rm", "home") }, checkout: join(T, "real-rm", "checkout"), passwd: "" });
    const d = { ...deps(), wide: w, workDir: join(T, "real-rm", "ws"), checkout: join(T, "real-rm", "checkout"), agents: [], now: NOW, mounts: ["/"], rm: undefined, measure: async () => ({ bytes: 4096, newest: NOW - 9 * DAY }) };
    const r = await removeCandidate({ id: "x", path: goes, where: "x", kind: "installed-parts", floor: "safe", bytes: 1, ageDays: 9, notes: [] }, d);
    expect(r).toMatchObject({ ok: true, bytes: 4096 });
    expect([existsSync(goes), existsSync(join(keepDir, "keep.txt")), existsSync(join(T, "real-rm", "ws", "app"))]).toEqual([false, true, true]);
  });
});

describe("read only", () => {
  it("the check for unsaved work does not write the index of a copy", async () => {
    const repo = dir("real-repo");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=demo", "-c", "user.email=demo@example.invalid", ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    // The file gets a new time with the same content: a plain `git status` would write the index again.
    utimesSync(join(repo, "a.txt"), new Date(NOW), new Date(NOW));
    const index = join(repo, ".git", "index");
    const old = new Date(NOW - 30 * DAY);
    utimesSync(index, old, old);
    const before = [statSync(index).mtimeMs, statSync(index).ino];
    expect(await copyState(repo, auditGit)).toEqual({ state: "own-repo" }); // a full repo, not a copy of one
    expect(await copyState(join(repo, ".git", ".."), auditGit)).toEqual({ state: "own-repo" });
    expect(await copyState(dir("real-repo/sub"), auditGit)).toEqual({ state: "plain" }); // git finds the repo above it
    expect(await auditGit(repo, ["--no-optional-locks", "status", "--porcelain"])).toBe("");
    expect(await auditGit(repo, ["rev-list", "--count", "HEAD", "--not", "--remotes"])).toBe("1\n"); // no remote: the commit is on none
    expect([statSync(index).mtimeMs, statSync(index).ino]).toEqual(before);
    expect(await auditGit(join(T, "not-a-repo"), ["status"])).toBeNull();
  });

  it("an audit leaves every file and folder of the tree as it was", async () => {
    const walk = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [`${e.name}/`, ...walk(join(p, e.name)).map((x) => `${e.name}/${x}`)] : [e.name]));
    const before = walk(join(T, "home")).concat(walk(join(T, "tmp"))).sort();
    const a = new Audit({ deps: async () => deps(), file: join(T, "data", "ro.json"), log: () => {}, now: () => NOW });
    await a.start().done;
    expect(walk(join(T, "home")).concat(walk(join(T, "tmp"))).sort()).toEqual(before);
  });
});
