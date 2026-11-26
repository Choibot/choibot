// A lead's or the fleet master's read of a worker's pull request (GET /api/agents/:id/pr-diff and
// /pr-file): the PR on the worker's RECORD, fetched by the console in its own repo (prRange, the
// fetch of the user's view), never a repo or a number of the caller and never the worker's
// clone; at most 1 MB. A real local origin with refs/pull/7/head; listRepos and gh are stubbed,
// so no call leaves this machine.
import Fastify, { type FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const repoPath = { value: "" };
vi.mock("../gh/repos.js", () => ({ listRepos: async () => [{ name: "app", slug: "o/app", path: repoPath.value }] }));
vi.mock("../gh/exec.js", () => ({ ghJson: async () => { throw new Error("no gh in this test"); } }));

const { AGENT_READ_MAX, PR_READ_ERR, registerPrApi } = await import("./api.js");

let root = "";
let app: FastifyInstance;
const records: Record<string, { id: string; repo: string; worktree: string; prNumber?: number }> = {};
const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" });

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pr-agentread-")));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "a.txt"), "one\n");
  writeFileSync(join(work, "same.txt"), "unchanged\n");
  g(work, "add", ".");
  g(work, "commit", "-q", "-m", "base");
  g(work, "remote", "add", "origin", origin);
  g(work, "push", "-q", "origin", "main");
  // PR 7: a small change. PR 8: a change over 1 MB.
  g(work, "checkout", "-q", "-b", "pr7");
  writeFileSync(join(work, "a.txt"), "one\ntwo\n");
  g(work, "commit", "-q", "-am", "pr7");
  g(work, "push", "-q", "origin", "pr7:refs/pull/7/head");
  g(work, "checkout", "-q", "main");
  g(work, "checkout", "-q", "-b", "pr8");
  writeFileSync(join(work, "big.txt"), `${"x".repeat(100)}\n`.repeat(12_000));
  g(work, "add", "big.txt");
  g(work, "commit", "-q", "-m", "pr8");
  g(work, "push", "-q", "origin", "pr8:refs/pull/8/head");
  // The console's own repo of it, in its workspace.
  const ws = join(root, "workspace");
  mkdirSync(ws);
  repoPath.value = join(ws, "app");
  execFileSync("git", ["clone", "-q", origin, repoPath.value]);
  records.w7 = { id: "w7", repo: repoPath.value, worktree: join(root, "no-such-clone"), prNumber: 7 };
  records.w8 = { id: "w8", repo: repoPath.value, worktree: join(root, "no-such-clone"), prNumber: 8 };
  records.none = { id: "none", repo: repoPath.value, worktree: join(root, "no-such-clone") };
  records.elsewhere = { id: "elsewhere", repo: join(root, "not-a-console-repo"), worktree: "", prNumber: 7 };
  app = Fastify();
  registerPrApi(app, { workspaceDir: ws, store: { load: async (id: string) => (records[id] ?? null) as never } });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/agents/:id/pr-diff", () => {
  it("the diff of the PR on the worker's record, from the console's own repo (the worker's clone does not even exist)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/agents/w7/pr-diff" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ repo: "app", slug: "o/app", pr: 7, base: "main", files: [{ status: "M", path: "a.txt" }] });
    expect(b.diff).toMatch(/\+two/);
    expect(b.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("never a repo or a number of the caller: a query or a body changes nothing", async () => {
    const r = await app.inject({ method: "GET", url: "/api/agents/w7/pr-diff?pr=8&repo=other" });
    expect(r.json()).toMatchObject({ pr: 7, files: [{ path: "a.txt" }] });
  });

  it("no record, no recorded PR, or a repo that is not the console's: 404 with a plain text", async () => {
    expect((await app.inject({ method: "GET", url: "/api/agents/ghost/pr-diff" })).json()).toEqual({ error: "unknown agent" });
    const none = await app.inject({ method: "GET", url: "/api/agents/none/pr-diff" });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toEqual({ error: PR_READ_ERR.noPr });
    expect((await app.inject({ method: "GET", url: "/api/agents/elsewhere/pr-diff" })).json()).toEqual({ error: PR_READ_ERR.notARepo });
  });

  it("over 1 MB: 413 with the files, to read one by one", async () => {
    const r = await app.inject({ method: "GET", url: "/api/agents/w8/pr-diff" });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ error: PR_READ_ERR.tooLarge, pr: 8, files: [{ status: "A", path: "big.txt" }] });
    expect(r.json()).not.toHaveProperty("diff");
    expect(AGENT_READ_MAX).toBe(1024 * 1024);
  });
});

describe("GET /api/agents/:id/pr-file", () => {
  it("a file that the PR changes: its full-context diff; another: its content at the PR head", async () => {
    const c = await app.inject({ method: "GET", url: "/api/agents/w7/pr-file?path=a.txt" });
    expect(c.json()).toMatchObject({ pr: 7, path: "a.txt", changed: true });
    expect(c.json().patch).toMatch(/ one\n\+two/);
    const u = await app.inject({ method: "GET", url: "/api/agents/w7/pr-file?path=same.txt" });
    expect(u.json()).toMatchObject({ changed: false, content: "unchanged\n" });
  });

  it("a bad path is 400; a file over 1 MB is 413; no recorded PR is 404", async () => {
    for (const p of ["", "-x", "a%00b"]) expect((await app.inject({ method: "GET", url: `/api/agents/w7/pr-file?path=${p}` })).statusCode, p).toBe(400);
    const big = await app.inject({ method: "GET", url: "/api/agents/w8/pr-file?path=big.txt" });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: PR_READ_ERR.fileTooLarge });
    expect((await app.inject({ method: "GET", url: "/api/agents/none/pr-file?path=a.txt" })).json()).toEqual({ error: PR_READ_ERR.noPr });
  });
});

describe("no program runs for an agent's read", () => {
  it("a diff driver or a text converter in the repo's config is not used (--no-ext-diff, --no-textconv)", async () => {
    const mark = join(root, "driver-ran");
    const prog = `sh -c 'touch ${mark}; echo DRIVER'`;
    g(repoPath.value, "config", "diff.evil.command", prog);
    g(repoPath.value, "config", "diff.evil.textconv", prog);
    writeFileSync(join(repoPath.value, ".git", "info", "attributes"), "* diff=evil\n");
    try {
      const d = await app.inject({ method: "GET", url: "/api/agents/w7/pr-diff" });
      expect(d.statusCode).toBe(200);
      expect(d.json().diff).toMatch(/\+two/);
      expect(d.json().diff).not.toMatch(/DRIVER/);
      for (const p of ["a.txt", "same.txt"]) {
        const f = await app.inject({ method: "GET", url: `/api/agents/w7/pr-file?path=${p}` });
        expect(JSON.stringify(f.json()), p).not.toMatch(/DRIVER/);
      }
      expect(() => statSync(mark)).toThrow();
    } finally {
      rmSync(join(repoPath.value, ".git", "info", "attributes"), { force: true });
      g(repoPath.value, "config", "--unset", "diff.evil.command");
      g(repoPath.value, "config", "--unset", "diff.evil.textconv");
    }
  });
});
