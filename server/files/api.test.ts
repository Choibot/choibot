// server/files/api.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, open, rename, writeFile, realpath, rm, symlink, utimes } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFilesApi, runInDir } from "./api.js";

const run = promisify(execFile);

let ws: string; // realpath'd workspace root
let outside: string;
let app: FastifyInstance;

beforeAll(async () => {
  // Build a temp tree:
  //   <ws>/.git/          (hidden, must not be listed)
  //   <ws>/src/           (dir)
  //   <ws>/a.txt          ("hello")
  //   <ws>/big.bin        (>1MB)
  //   <ws>/bin.dat        (contains a NUL byte)
  // and an unrelated dir <outside> as a sibling.
  const base = await realpath(await mkdtemp(join(tmpdir(), "files-api-")));
  outside = base; // base itself is outside the ws root
  await mkdir(join(base, "ws"));
  ws = await realpath(join(base, "ws"));
  await mkdir(join(ws, ".git"));
  await mkdir(join(ws, "src"));
  await writeFile(join(ws, "a.txt"), "hello");
  await writeFile(join(ws, "big.bin"), Buffer.alloc(1024 * 1024 + 10, 0x41));
  await writeFile(join(ws, "bin.dat"), Buffer.from([0x68, 0x00, 0x69]));
  await writeFile(join(outside, "secret.txt"), "top secret");

  // Shared-docs fixture: <ws>/proj with a manifest referencing a doc, an
  // artifact, and several invalid entries (missing file, traversal, symlink
  // escaping the workspace).
  await mkdir(join(ws, "proj", ".choibot", "docs"), { recursive: true });
  await writeFile(join(ws, "proj", "spec.md"), "# spec");
  await writeFile(join(ws, "proj", ".choibot", "docs", "mock.html"), "<h1>mock</h1>");
  await symlink(join(outside, "secret.txt"), join(ws, "proj", "leak.md"));
  await writeFile(
    join(ws, "proj", ".choibot", "docs.json"),
    JSON.stringify([
      { path: "spec.md", title: "The Spec" },
      ".choibot/docs/mock.html",
      "missing.md",
      "../a.txt",
      "leak.md",
    ]),
  );
  await mkdir(join(ws, "empty-proj"));

  app = Fastify();
  registerFilesApi(app, { workspaceDir: ws });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(outside, { recursive: true, force: true });
});

const list = (p?: string) =>
  app.inject({ method: "GET", url: `/api/files/list${p ? `?path=${encodeURIComponent(p)}` : ""}` });
const content = (p: string) =>
  app.inject({ method: "GET", url: `/api/files/content?path=${encodeURIComponent(p)}` });

describe("files list", () => {
  it("returns children, dirs first, hides .git", async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { name: string; type: string }[];
    const names = items.map((i) => i.name);
    expect(names).not.toContain(".git");
    // dirs must come before a.txt/big.bin/bin.dat (files)
    expect(items[0].type).toBe("dir");
    expect(names).toEqual(["empty-proj", "proj", "src", "a.txt", "big.bin", "bin.dat"]);
  });

  it("rejects a `..` traversal out of the workspace", async () => {
    const res = await list(`${ws}/../`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("outside workspace");
  });

  it("rejects an absolute path outside the workspace", async () => {
    const res = await list(outside);
    expect(res.statusCode).toBe(400);
  });

  it("404s a path that is not a directory", async () => {
    const res = await list(join(ws, "a.txt"));
    expect(res.statusCode).toBe(404);
  });
});

describe("files content", () => {
  it("returns text for a small file", async () => {
    const res = await content(join(ws, "a.txt"));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe("hello");
    expect(body.size).toBe(5);
  });

  it("flags a file over 1MB as tooLarge without reading content", async () => {
    const res = await content(join(ws, "big.bin"));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tooLarge).toBe(true);
    expect(body.content).toBeUndefined();
  });

  it("flags a file with a NUL byte as binary", async () => {
    const res = await content(join(ws, "bin.dat"));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.binary).toBe(true);
    expect(body.content).toBeUndefined();
  });

  it("400s on a directory", async () => {
    const res = await content(join(ws, "src"));
    expect(res.statusCode).toBe(400);
  });

  it("rejects traversal out of the workspace", async () => {
    const res = await content(join(ws, "..", "secret.txt"));
    expect(res.statusCode).toBe(400);
  });

  it("rejects an absolute path outside the workspace", async () => {
    const res = await content(join(outside, "secret.txt"));
    expect(res.statusCode).toBe(400);
  });
});

// ---- Navigation API --------------------------------------------------------
// A second workspace that is a real git repo, with:
//   tracked.ts   (committed, then modified)  -> status "modified"
//   keep.ts      (committed, unchanged)
//   fresh.txt    (untracked, not ignored)    -> status "untracked"
//   ignored.log  (untracked, matched by .gitignore) -> absent from `all`
//   .gitignore   (committed)
let gitWs: string; // realpath'd git workspace root
let gitApp: FastifyInstance;
let plainWs: string; // non-git dir
let plainApp: FastifyInstance;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "files-api-git-")));
  gitWs = await realpath(base);
  await run("git", ["-C", gitWs, "init", "-q"]);
  await run("git", ["-C", gitWs, "config", "user.email", "t@t.t"]);
  await run("git", ["-C", gitWs, "config", "user.name", "t"]);
  await writeFile(join(gitWs, "tracked.ts"), "export const foo = 1;\nfunction bar() {}\n");
  await writeFile(join(gitWs, "keep.ts"), "const baz = 2;\n");
  await writeFile(join(gitWs, ".gitignore"), "*.log\n");
  await run("git", ["-C", gitWs, "add", "-A"]);
  await run("git", ["-C", gitWs, "commit", "-q", "-m", "init"]);
  // Now mutate the tree: modify tracked, add untracked + ignored.
  await writeFile(join(gitWs, "tracked.ts"), "export const foo = 1;\nfunction bar() {}\n// edit\n");
  await writeFile(join(gitWs, "fresh.txt"), "needle here\n");
  await writeFile(join(gitWs, "ignored.log"), "should be ignored\n");
  // Plan-discovery fixtures: two plans; b.md is newer by explicit utimes.
  await mkdir(join(gitWs, "docs", "superpowers", "plans"), { recursive: true });
  await writeFile(join(gitWs, "docs", "superpowers", "plans", "a.md"), "# A\n- [ ] one\n");
  await writeFile(join(gitWs, "docs", "superpowers", "plans", "b.md"), "# B\n- [x] one\n");
  const old = new Date(Date.now() - 60_000);
  await utimes(join(gitWs, "docs", "superpowers", "plans", "a.md"), old, old);
  // A symlinked "plan" escaping the workspace, with the freshest mtime — the
  // route must skip it, so b.md stays the winner.
  await writeFile(join(outside, "escape-plan.md"), "# outside\n");
  await symlink(join(outside, "escape-plan.md"), join(gitWs, "docs", "superpowers", "plans", "zz.md"));
  // A root whose plans dir exists but holds no .md files, and one with no
  // plans dir at all.
  await mkdir(join(gitWs, "subproj", "docs", "superpowers", "plans"), { recursive: true });
  await mkdir(join(gitWs, "bare"));

  gitApp = Fastify();
  registerFilesApi(gitApp, { workspaceDir: gitWs });
  await gitApp.ready();

  plainWs = await realpath(await mkdtemp(join(tmpdir(), "files-api-plain-")));
  await writeFile(join(plainWs, "x.txt"), "hi\n");
  // Plan fixtures where the newest file is neither first nor last in readdir
  // order (m.MD between a.md and z.md) — pins the mtime comparison itself —
  // and carries an uppercase extension — pins case-insensitive matching.
  await mkdir(join(plainWs, "docs", "superpowers", "plans"), { recursive: true });
  const older = new Date(Date.now() - 120_000);
  for (const [name, when] of [["a.md", older], ["m.MD", null], ["z.md", older]] as const) {
    const p = join(plainWs, "docs", "superpowers", "plans", name);
    await writeFile(p, "# p\n- [ ] s\n");
    if (when) await utimes(p, when, when);
  }
  plainApp = Fastify();
  registerFilesApi(plainApp, { workspaceDir: plainWs });
  await plainApp.ready();
});

afterAll(async () => {
  await gitApp.close();
  await plainApp.close();
  await rm(gitWs, { recursive: true, force: true });
  await rm(plainWs, { recursive: true, force: true });
});

const nav = (app: FastifyInstance, path: string, q: Record<string, string>) => {
  const qs = new URLSearchParams(q).toString();
  return app.inject({ method: "GET", url: `/api/files/${path}?${qs}` });
};

describe("files changes", () => {
  it("reports modified + untracked with correct statuses", async () => {
    const res = await nav(gitApp, "changes", { root: gitWs });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      git: boolean;
      changes: { rel: string; status: string; path: string }[];
    };
    expect(body.git).toBe(true);
    const byRel = Object.fromEntries(body.changes.map((c) => [c.rel, c.status]));
    expect(byRel["tracked.ts"]).toBe("modified");
    expect(byRel["fresh.txt"]).toBe("untracked");
    // ignored.log is gitignored — it should not appear as a change.
    expect(byRel["ignored.log"]).toBeUndefined();
    const tracked = body.changes.find((c) => c.rel === "tracked.ts")!;
    expect(tracked.path).toBe(join(gitWs, "tracked.ts"));
  });

  it("returns git:false for a non-git dir", async () => {
    const res = await nav(plainApp, "changes", { root: plainWs });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ changes: [], git: false });
  });

  it("rejects an outside root", async () => {
    const res = await nav(gitApp, "changes", { root: join(gitWs, "..") });
    expect(res.statusCode).toBe(400);
  });
});

describe("files all", () => {
  it("lists tracked + untracked-not-ignored, omits ignored", async () => {
    const res = await nav(gitApp, "all", { root: gitWs });
    expect(res.statusCode).toBe(200);
    const files = (res.json() as { files: string[] }).files;
    expect(files).toContain("tracked.ts");
    expect(files).toContain("keep.ts");
    expect(files).toContain("fresh.txt");
    expect(files).not.toContain("ignored.log");
    // sorted
    expect([...files]).toEqual([...files].sort());
  });

  it("rejects an outside root", async () => {
    const res = await nav(gitApp, "all", { root: join(gitWs, "..") });
    expect(res.statusCode).toBe(400);
  });
});

describe("files search", () => {
  it("finds a literal string match with path/line/text", async () => {
    const res = await nav(gitApp, "search", { root: gitWs, q: "needle here" });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as {
      results: { rel: string; line: number; text: string; path: string }[];
    }).results;
    const hit = results.find((r) => r.rel === "fresh.txt");
    expect(hit).toBeTruthy();
    expect(hit!.line).toBe(1);
    expect(hit!.text).toContain("needle here");
    expect(hit!.path).toBe(join(gitWs, "fresh.txt"));
  });

  it("returns empty for no match", async () => {
    const res = await nav(gitApp, "search", { root: gitWs, q: "zzz-not-present-zzz" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { results: unknown[] }).results).toEqual([]);
  });

  it("returns empty for blank query", async () => {
    const res = await nav(gitApp, "search", { root: gitWs, q: "   " });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { results: unknown[] }).results).toEqual([]);
  });

  it("treats regex metachars literally (no injection)", async () => {
    // "a.*b" is present nowhere literally; if it were a regex it would match
    // "baz = 2" etc. With -F it must not match.
    const res = await nav(gitApp, "search", { root: gitWs, q: "a.*b" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { results: unknown[] }).results).toEqual([]);
  });

  it("matches a literal that contains metachars when present verbatim", async () => {
    await writeFile(join(gitWs, "lit.txt"), "x a.*b y\n");
    const res = await nav(gitApp, "search", { root: gitWs, q: "a.*b" });
    const results = (res.json() as { results: { rel: string }[] }).results;
    expect(results.some((r) => r.rel === "lit.txt")).toBe(true);
    await rm(join(gitWs, "lit.txt"), { force: true });
  });

  it("falls back to plain grep in a non-git dir", async () => {
    const res = await nav(plainApp, "search", { root: plainWs, q: "hi" });
    expect(res.statusCode).toBe(200);
    const results = (res.json() as { results: { rel: string }[] }).results;
    expect(results.some((r) => r.rel === "x.txt")).toBe(true);
  });

  it("rejects an outside root", async () => {
    const res = await nav(gitApp, "search", { root: join(gitWs, ".."), q: "x" });
    expect(res.statusCode).toBe(400);
  });
});

describe("files definition", () => {
  it("finds `function bar` and `const foo =`", async () => {
    const foo = await nav(gitApp, "definition", { root: gitWs, symbol: "foo" });
    expect(foo.statusCode).toBe(200);
    const fooC = (foo.json() as { candidates: { rel: string; line: number }[] }).candidates;
    expect(fooC.some((c) => c.rel === "tracked.ts")).toBe(true);

    const bar = await nav(gitApp, "definition", { root: gitWs, symbol: "bar" });
    const barC = (bar.json() as { candidates: { rel: string }[] }).candidates;
    expect(barC.some((c) => c.rel === "tracked.ts")).toBe(true);
  });

  it("rejects an invalid symbol with 400", async () => {
    const res = await nav(gitApp, "definition", { root: gitWs, symbol: "foo;rm" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid symbol");
  });

  it("rejects an outside root", async () => {
    const res = await nav(gitApp, "definition", { root: join(gitWs, ".."), symbol: "foo" });
    expect(res.statusCode).toBe(400);
  });
});

const docs = (root: string) =>
  app.inject({ method: "GET", url: `/api/files/docs?root=${encodeURIComponent(root)}` });

describe("files docs (shared manifest)", () => {
  it("returns valid entries with kind, title fallback, and mtime; drops broken ones", async () => {
    const res = await docs(join(ws, "proj"));
    expect(res.statusCode).toBe(200);
    const got = res.json().docs as { path: string; title: string; kind: string; mtime: number; size: number }[];
    expect(got.map((d) => d.path)).toEqual(["spec.md", ".choibot/docs/mock.html"]);
    expect(got[0].title).toBe("The Spec");
    expect(got[0].kind).toBe("md");
    expect(got[1].title).toBe("mock.html"); // basename fallback
    expect(got[1].kind).toBe("html");
    expect(got[0].mtime).toBeGreaterThan(0);
    expect(got[0].size).toBeGreaterThan(0);
  });
  it("returns an empty list when there is no manifest", async () => {
    const res = await docs(join(ws, "empty-proj"));
    expect(res.statusCode).toBe(200);
    expect(res.json().docs).toEqual([]);
  });
  it("rejects a root outside the workspace", async () => {
    const res = await docs(outside);
    expect(res.statusCode).toBe(400);
  });
});

describe("files plan (newest plan pointer)", () => {
  it("returns the newest plan by mtime, repo-relative, skipping symlinks that escape the workspace", async () => {
    // zz.md symlinks outside the workspace with the freshest mtime — skipped.
    const res = await nav(gitApp, "plan", { root: gitWs });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { path?: string; mtime?: number };
    expect(body.path).toBe("docs/superpowers/plans/b.md");
    expect(body.mtime).toBeGreaterThan(0);
  });
  it("orders by mtime (not readdir position) and matches .MD case-insensitively", async () => {
    // Newest is m.MD: middle of readdir order, uppercase extension.
    const res = await nav(plainApp, "plan", { root: plainWs });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe("docs/superpowers/plans/m.MD");
  });
  it("returns {} when there is no plans dir", async () => {
    const res = await nav(gitApp, "plan", { root: join(gitWs, "bare") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });
  it("returns {} when the plans dir exists but holds no .md files", async () => {
    const res = await nav(gitApp, "plan", { root: join(gitWs, "subproj") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });
  it("rejects a root outside the workspace", async () => {
    const res = await nav(gitApp, "plan", { root: plainWs });
    expect(res.statusCode).toBe(400);
  });
});

// The files guard's runner (ruling 2c-3-b): the run stays in the directory
// that was opened and checked, whatever is swapped in at its path after.
describe("runInDir", () => {
  it("runs in the opened directory even after its path became a symlink elsewhere", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "files-runin-")));
    try {
      await mkdir(join(base, "a"));
      await mkdir(join(base, "b"));
      await writeFile(join(base, "a", "f"), "A");
      await writeFile(join(base, "b", "f"), "B");
      const dir = await open(join(base, "a"), "r");
      try {
        await rename(join(base, "a"), join(base, "a2"));
        await symlink(join(base, "b"), join(base, "a"));
        expect((await runInDir(dir, "sh", ["-c", "pwd -P; cat f"])).stdout).toBe(`${join(base, "a2")}\nA`);
        await expect(runInDir(dir, "sh", ["-c", "printf out; exit 3"])).rejects.toMatchObject({ code: 3, stdout: "out" });
        await expect(runInDir(dir, "sh", ["-c", "printf 0123456789"], 4)).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
        await expect(runInDir(dir, "no-such-cmd-xyz", [])).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await dir.close();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// The secrets work, item 3: in every mode and for every caller, no file route
// serves the console's own .env (and its .env.* copies), its data dirs, the
// console user's credential stores or git internals. By real path: a symlink
// to one is refused too. An agent's worktree (its own .env included) stays readable.
describe("files refusal of console secrets", () => {
  let sws: string;
  let sapp: FastifyInstance;
  const SECRET = "file-secret-value";
  const get = (route: string, q: string, p: string) =>
    sapp.inject({ method: "GET", url: `/api/files/${route}?${q}=${encodeURIComponent(p)}` });
  const at = (...p: string[]) => join(sws, ...p);

  beforeAll(async () => {
    sws = await realpath(await mkdtemp(join(tmpdir(), "files-secret-")));
    const put = async (rel: string, text: string) => {
      await mkdir(join(sws, rel, ".."), { recursive: true });
      await writeFile(join(sws, rel), text);
    };
    await put("console/.env", `TELEGRAM_BOT_TOKEN=${SECRET}\n`);
    await put("console/.env.bak-old", `CONSOLE_COOKIE_SECRET=${SECRET}\n`);
    await put("console/.env.example", "TELEGRAM_BOT_TOKEN=your-token\n");
    await put("console/.agent-data/a1.json", `{"hookToken":"${SECRET}"}`);
    await put("console/src/index.ts", "export const ok = 1;\n");
    await put("console/.agent-worktrees/wt1/file.ts", "export const wt = 1;\n");
    await put("data/chief/devices.json", SECRET);
    await put("data/cron/notify-token", SECRET);
    await put("data/issues/i1/issue.json", SECRET);
    await put("data/master/memory/m.md", SECRET);
    await put("repo/.git/config", `[remote "origin"]\n  url = https://x:${SECRET}@github.com/o/r\n`);
    await put("repo/README.md", "readme\n");
    await put("home/.ssh/id_ed25519", SECRET);
    await put("home/.claude-accounts/a/.credentials.json", SECRET);
    await put("home/.config/gh/hosts.yml", SECRET);
    await put("agent-wt/notes.md", `the ${SECRET} word, in an agent file\n`);
    await put("agent-wt/.env", "AGENT_OWN=1\n");
    await put("agent-wt/creds/.git-credentials", SECRET);
    await symlink(at("console/.env"), at("agent-wt/link-env"));
    await symlink(at("data/chief"), at("agent-wt/link-chief"));
    sapp = Fastify();
    registerFilesApi(sapp, {
      workspaceDir: sws,
      checkoutDir: at("console"),
      env: {
        HOME: at("home"), CHIEF_DATA_DIR: at("data/chief"), CRON_DATA_DIR: at("data/cron"),
        ISSUES_DATA_DIR: at("data/issues"), MASTER_DATA_DIR: at("data/master"),
      },
    });
    await sapp.ready();
  });

  afterAll(async () => {
    await sapp.close();
    await rm(sws, { recursive: true, force: true });
  });

  it("content refuses each secret path with 403, a symlink to one included", async () => {
    for (const rel of [
      "console/.env", "console/.env.bak-old", "console/.agent-data/a1.json",
      "data/chief/devices.json", "data/cron/notify-token", "data/issues/i1/issue.json", "data/master/memory/m.md",
      "repo/.git/config", "home/.ssh/id_ed25519", "home/.claude-accounts/a/.credentials.json", "home/.config/gh/hosts.yml",
      "agent-wt/creds/.git-credentials", "agent-wt/link-env", "agent-wt/link-chief/devices.json",
    ]) {
      const r = await get("content", "path", at(rel));
      expect(r.statusCode, rel).toBe(403);
      expect(r.body, rel).not.toContain(SECRET);
    }
  });

  it("content still serves the checkout's code, .env.example, worktrees and an agent's own .env", async () => {
    for (const rel of ["console/.env.example", "console/src/index.ts", "console/.agent-worktrees/wt1/file.ts", "agent-wt/notes.md", "agent-wt/.env", "repo/README.md"]) {
      const r = await get("content", "path", at(rel));
      expect(r.statusCode, rel).toBe(200);
    }
  });

  it("list hides the secret entries and refuses a secret dir", async () => {
    const names = (r: { json(): { items: { name: string }[] } }) => r.json().items.map((i) => i.name);
    const checkout = await get("list", "path", at("console"));
    expect(names(checkout)).toEqual(expect.arrayContaining([".env.example", "src", ".agent-worktrees"]));
    expect(names(checkout)).not.toEqual(expect.arrayContaining([".env"]));
    expect(names(checkout).some((n) => n === ".env" || n === ".env.bak-old" || n === ".agent-data")).toBe(false);
    const home = await get("list", "path", at("home"));
    expect(names(home).some((n) => n === ".ssh" || n === ".claude-accounts")).toBe(false);
    for (const rel of ["data/chief", "repo/.git", "agent-wt/link-chief"]) {
      expect((await get("list", "path", at(rel))).statusCode, rel).toBe(403);
    }
  });

  it("search, all, definition, docs, changes and plan refuse a secret root", async () => {
    for (const route of ["search", "all", "definition", "docs", "changes", "plan"]) {
      const extra = route === "search" ? "&q=x" : route === "definition" ? "&symbol=x" : "";
      const r = await sapp.inject({ method: "GET", url: `/api/files/${route}?root=${encodeURIComponent(at("data/chief"))}${extra}` });
      expect(r.statusCode, route).toBe(403);
    }
  });

  it("search and all from the workspace root never return a secret path or line", async () => {
    const s = await sapp.inject({ method: "GET", url: `/api/files/search?root=${encodeURIComponent(sws)}&q=${SECRET}` });
    expect(s.statusCode).toBe(200);
    expect(s.json().results.map((r: { rel: string }) => r.rel)).toEqual(["agent-wt/notes.md"]);
    const a = await sapp.inject({ method: "GET", url: `/api/files/all?root=${encodeURIComponent(sws)}` });
    const files: string[] = a.json().files;
    expect(files).toEqual(expect.arrayContaining(["agent-wt/notes.md", "agent-wt/.env", "console/.env.example", "console/src/index.ts"]));
    for (const f of files) expect(f).not.toMatch(/^console\/\.env$|\.env\.bak|\.agent-data|^data\/|\.git\/|\.ssh|\.credentials\.json|\.git-credentials|\.config\/gh/);
  });
});
