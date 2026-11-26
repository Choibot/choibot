// server/files/api.ts
//
// View-only file API, sandboxed to a single workspace directory. Every path the
// caller supplies is resolved AND realpath'd, then checked to be inside the
// realpath'd ROOT — so neither a `..` segment nor a symlink can escape the
// workspace. The routes only ever read (list/stat/readFile); nothing mutates.
// Every route also refuses the console's secrets (./refused.ts: its .env, data
// dirs, credential stores, .git), for every caller in every mode.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { constants } from "node:fs";
import { open, realpath, readdir, readFile, readlink, stat, type FileHandle } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { gitArgs, gitEnv, gitHardened, mainRepoOf, runGit } from "../agents/git.js";
import { parseDocsManifest, sharedDocKind } from "./shared.js";
import { resolveWorkspaceDir } from "../defaults.js";
import { isRefused, refusalFor, REFUSED_TEXT } from "./refused.js";
import { repoFoldersToRead } from "../names.mjs";

const run = promisify(execFile);

const MAX_BYTES = 1024 * 1024; // 1 MB preview cap
const TEXT_CAP = 400; // per-line text truncation for search/definition results

type Status = "modified" | "added" | "deleted" | "untracked" | "renamed";

// Map a 2-char porcelain status code (e.g. " M", "A ", "??", "R ") to a label.
function mapStatus(code: string): Status {
  if (code === "??") return "untracked";
  const x = code[0];
  const y = code[1];
  if (x === "R" || y === "R") return "renamed";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

// Parse `relpath:line:text` (git grep / grep -n) lines into structured rows.
// Split on the first two colons only — the matched text may itself contain colons.
// hide (the files guard, non-USER callers): rows whose path it hides are skipped.
function parseGrep(
  stdout: string,
  root: string,
  cap: number,
  hide?: (rel: string) => boolean,
): { path: string; rel: string; line: number; text: string }[] {
  const out: { path: string; rel: string; line: number; text: string }[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw || out.length >= cap) break;
    const i1 = raw.indexOf(":");
    if (i1 < 0) continue;
    const i2 = raw.indexOf(":", i1 + 1);
    if (i2 < 0) continue;
    let rel = raw.slice(0, i1);
    if (rel.startsWith("./")) rel = rel.slice(2); // plain-grep "." target prefix
    if (hide?.(rel)) continue;
    const line = Number(raw.slice(i1 + 1, i2));
    if (!Number.isInteger(line)) continue;
    let text = raw.slice(i2 + 1);
    if (text.length > TEXT_CAP) text = text.slice(0, TEXT_CAP);
    out.push({ path: join(root, rel), rel, line, text });
  }
  return out;
}

// Hardened deployments only (server/chief/coderoutes.ts filesGuard, ruling
// 2c-3-b). The code-route gate checks a path before the route runs, but an
// agent owns its worktree and can swap a file or dir for a symlink after
// that. So for a non-USER caller the content, search, all and definition
// routes check again what they really opened, and run git, grep and find in
// that open directory. Without a guard (and for a USER caller) every route
// runs today's code.
export type FilesGuard = {
  // A USER caller: today's code, no second check.
  user(req: FastifyRequest): Promise<boolean>;
  // The gate's rule on a real path (the console checkout, .env*).
  refused(real: string): Promise<boolean>;
  // A result path (relative) a non-USER caller does not get: .env*.
  hidden(rel: string): boolean;
  // The gate's refusal (403 pair-required).
  refuse(reply: FastifyReply): FastifyReply;
};

const GUARD_MAX_BUFFER = 32 * 1024 * 1024;
// The walk's skipped dirs (all, below), for find.
const FIND_SKIP = [".git", "node_modules", ".next", "dist", "build"];
const FIND_CAP = 20000;

// Runs cmd in an open directory: the handle is the child's fd 3 and its cwd
// is /proc/self/fd/3, so a symlink swapped in after the check cannot move the
// run. Settles like promisify(execFile): { stdout }, or an error with `code`
// (the exit code, or ERR_CHILD_PROCESS_STDIO_MAXBUFFER) and `stdout`. env:
// the child's env (git passes gitEnv); undefined inherits process.env.
export function runInDir(
  dir: FileHandle, cmd: string, args: string[], maxBuffer = GUARD_MAX_BUFFER, env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string }> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: "/proc/self/fd/3", stdio: ["ignore", "pipe", "ignore", dir.fd], env });
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    child.stdout!.on("data", (b: Buffer) => {
      if (over) return;
      size += b.length;
      if (size > maxBuffer) {
        over = true;
        child.kill();
        return;
      }
      chunks.push(b);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      if (code === 0 && !over) ok({ stdout });
      else fail(Object.assign(new Error(`${cmd} failed`), { code: over ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : code, stdout }));
    });
  });
}

export function registerFilesApi(
  app: FastifyInstance,
  // checkoutDir and env: the console's checkout (default the cwd) and env
  // (default process.env), for the refusal (./refused.ts). Tests pass fixtures.
  opts: { workspaceDir?: string; guard?: FilesGuard; checkoutDir?: string; env?: Record<string, string | undefined> } = {},
): void {
  const workspaceDir = opts.workspaceDir ?? resolveWorkspaceDir();
  const guard = opts.guard;
  // What no route serves, to any caller, in every mode (./refused.ts).
  const refusal = refusalFor({ env: opts.env, checkout: opts.checkoutDir });
  const refused = (p: string): boolean => isRefused(p, refusal);
  // Resolve the sandbox root once. If it can't be realpath'd at startup, every
  // safe() call will fail closed (ROOT stays a value nothing can match).
  let rootPromise: Promise<string> | null = null;
  const getRoot = () => (rootPromise ??= realpath(resolve(workspaceDir)));

  // The realpath of `p` when it is the workspace root or strictly inside it
  // and not refused; else why not. realpath() throws on a missing path → outside.
  async function resolveIn(p: string): Promise<{ real: string } | { code: 400 | 403 }> {
    try {
      const root = await getRoot();
      const real = await realpath(resolve(p));
      if (real !== root && !real.startsWith(root + sep)) return { code: 400 };
      return refused(real) ? { code: 403 } : { real };
    } catch {
      return { code: 400 };
    }
  }

  // Returns the realpath of `p` iff it is the workspace root or strictly inside
  // it and not refused; otherwise null.
  async function safe(p: string): Promise<string | null> {
    const r = await resolveIn(p);
    return "real" in r ? r.real : null;
  }

  // A route's path param: its realpath, or null once the 400 or 403 was sent.
  async function realOr(reply: FastifyReply, p: string): Promise<string | null> {
    const r = await resolveIn(p);
    if ("real" in r) return r.real;
    reply.code(r.code).send({ error: r.code === 403 ? REFUSED_TEXT : "outside workspace" });
    return null;
  }

  // A result row (root-relative): its lexical path is refused. git, grep and
  // find do not follow a symlink below the root, so the lexical path is the real one.
  const hiddenRow = (root: string, rel: string): boolean => refused(join(root, rel));

  // The guard for a non-USER caller, else null (no guard, or a USER caller).
  const guardFor = async (req: FastifyRequest): Promise<FilesGuard | null> =>
    (guard && !(await guard.user(req)) ? guard : null);

  // What fh really is (/proc/self/fd) passes both rules: the workspace (as
  // safe()) and the guard's. False after the refusal was sent.
  async function openedOk(g: FilesGuard, fh: FileHandle, reply: FastifyReply): Promise<boolean> {
    let p: string;
    let root: string;
    try {
      p = await readlink(`/proc/self/fd/${fh.fd}`);
      root = await getRoot();
    } catch {
      g.refuse(reply);
      return false;
    }
    if ((p !== root && !p.startsWith(root + sep)) || refused(p) || (await g.refused(p))) {
      g.refuse(reply);
      return false;
    }
    return true;
  }

  // GET /api/files/content for a non-USER caller: open, check what was
  // opened, read from that same handle. A hard link (nlink > 1) may share
  // the inode of a file the rules refuse; a FIFO or device is no file (and
  // O_NONBLOCK keeps a FIFO from hanging the open).
  async function readChecked(g: FilesGuard, real: string, reply: FastifyReply) {
    let fh: FileHandle;
    try {
      fh = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    try {
      if (!(await openedOk(g, fh, reply))) return reply;
      const st = await fh.stat();
      if (st.isDirectory()) return reply.code(400).send({ error: "is a directory" });
      if (!st.isFile() || st.nlink > 1) return g.refuse(reply);
      if (st.size > MAX_BYTES) return { path: real, tooLarge: true, size: st.size };
      let buf: Buffer;
      try {
        buf = await fh.readFile();
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (buf.includes(0)) return { path: real, binary: true, size: st.size };
      return { path: real, content: buf.toString("utf8"), size: st.size };
    } finally {
      await fh.close().catch(() => {});
    }
  }

  // search, all and definition for a non-USER caller: open root, check what
  // was opened, run fn in that open dir. Not a directory: `empty`, as today's
  // runs give.
  async function inCheckedDir<T>(
    g: FilesGuard, root: string, reply: FastifyReply, empty: T, fn: (dir: FileHandle) => Promise<T>,
  ): Promise<T | FastifyReply> {
    let fh: FileHandle;
    try {
      fh = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    } catch {
      return empty;
    }
    try {
      if (!(await openedOk(g, fh, reply))) return reply;
      return await fn(fh);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  app.get("/api/files/list", async (req: FastifyRequest, reply: FastifyReply) => {
    const q = (req.query as { path?: string } | undefined)?.path;
    const target = q && q.length > 0 ? q : await getRoot();
    const real = await realOr(reply, target);
    if (!real) return reply;
    let entries;
    try {
      entries = await readdir(real, { withFileTypes: true });
    } catch {
      return reply.code(404).send({ error: "not a directory" });
    }
    const items = entries
      .filter((e) => e.name !== ".git" && !refused(resolve(real, e.name)))
      .map((e) => ({
        name: e.name,
        path: resolve(real, e.name),
        type: e.isDirectory() ? ("dir" as const) : ("file" as const),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { path: real, items };
  });

  app.get("/api/files/content", async (req: FastifyRequest, reply: FastifyReply) => {
    const q = (req.query as { path?: string } | undefined)?.path ?? "";
    const real = await realOr(reply, q);
    if (!real) return reply;
    const g = await guardFor(req);
    if (g) return readChecked(g, real, reply);
    // Read from what was opened, and check what it really is (/proc/self/fd):
    // a file swapped for a symlink after realOr cannot reach a refused one.
    let fh: FileHandle;
    try {
      fh = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    try {
      const opened = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
      const root = await getRoot();
      if (opened === null || (opened !== root && !opened.startsWith(root + sep))) {
        return reply.code(400).send({ error: "outside workspace" });
      }
      if (refused(opened)) return reply.code(403).send({ error: REFUSED_TEXT });
      const st = await fh.stat();
      if (st.isDirectory()) return reply.code(400).send({ error: "is a directory" });
      if (st.size > MAX_BYTES) return { path: real, tooLarge: true, size: st.size };
      let buf: Buffer;
      try {
        buf = await fh.readFile();
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (buf.includes(0)) return { path: real, binary: true, size: st.size };
      return { path: real, content: buf.toString("utf8"), size: st.size };
    } finally {
      await fh.close().catch(() => {});
    }
  });

  // Agent-shared docs: the manifest at <root>/<repo folder>/docs.json lists markdown
  // docs and self-contained HTML artifacts the agent wants surfaced in the
  // console. Entries are re-validated here — extension allowlist in the
  // parser, realpath containment per file — so a hostile manifest can name
  // nothing outside the root. Missing/broken manifest or entries fail soft.
  app.get("/api/files/docs", async (req: FastifyRequest, reply: FastifyReply) => {
    const rootQ = (req.query as { root?: string } | undefined)?.root ?? "";
    const root = await realOr(reply, rootQ);
    if (!root) return reply;
    // The folder of this install first; a new install also reads the old folder name.
    let raw: string | null = null;
    for (const folder of repoFoldersToRead()) {
      try {
        raw = await readFile(join(root, folder, "docs.json"), "utf8");
        break;
      } catch {
        // no manifest in this folder
      }
    }
    if (raw === null) return { docs: [] };
    const docs: { path: string; title: string; kind: "md" | "html"; mtime: number; size: number }[] = [];
    for (const entry of parseDocsManifest(raw)) {
      // safe() only proves "inside the workspace" — a symlink could still point
      // at a sibling repo, so re-check containment against this root itself.
      const real = await safe(join(root, entry.path));
      if (!real || (real !== root && !real.startsWith(root + sep))) continue;
      let st;
      try {
        st = await stat(real);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const base = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      docs.push({
        path: entry.path,
        title: entry.title ?? base,
        kind: sharedDocKind(entry.path)!,
        mtime: Math.round(st.mtimeMs),
        size: st.size,
      });
    }
    return { docs };
  });

  // ---- Navigation API ------------------------------------------------------
  // All four endpoints reuse safe() to sandbox `root` to the workspace, and run
  // git/grep via execFile (array args, NO shell) so nothing is interpolated into
  // a command line. search/definition additionally neutralize their inputs:
  // search uses git grep -F (fixed string, no regex) and definition sanitizes
  // `symbol` to an identifier before building a regex from it.

  // 1. Uncommitted changes (VS Code "Source Control" semantics).
  app.get("/api/files/changes", async (req: FastifyRequest, reply: FastifyReply) => {
    const rootQ = (req.query as { root?: string } | undefined)?.root ?? "";
    const root = await realOr(reply, rootQ);
    if (!root) return reply;
    // Hardened (ruling 2c-6-d): status may run a clean filter, so the common
    // dir is pinned to the repo the console's own layout names for root;
    // none it can name, no git (ls-files/grep below run none: left unpinned).
    let main: string | undefined;
    if (gitHardened()) {
      const m = mainRepoOf(root, await getRoot(), process.getuid?.() ?? -1);
      if (m === null) return { changes: [], git: false };
      main = m;
    }
    let stdout: string;
    try {
      ({ stdout } = await runGit(root, [
        "-C",
        root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ], undefined, main));
    } catch {
      return { changes: [], git: false };
    }
    const changes: { path: string; rel: string; status: Status }[] = [];
    for (const raw of stdout.split("\n")) {
      if (!raw) continue;
      const code = raw.slice(0, 2);
      let rel = raw.slice(3);
      // Renames are reported "old -> new"; take the new path.
      const arrow = rel.indexOf(" -> ");
      if (arrow >= 0) rel = rel.slice(arrow + 4);
      if (hiddenRow(root, rel)) continue;
      changes.push({ path: join(root, rel), rel, status: mapStatus(code) });
    }
    return { git: true, changes };
  });

  // 2. Newest superpowers plan doc, for the rail's Plan view: two stats, no
  // content (the client fetches that via /api/files/content and parses it).
  // Missing dir or no .md files is a normal state — {} — never an error.
  app.get("/api/files/plan", async (req: FastifyRequest, reply: FastifyReply) => {
    const rootQ = (req.query as { root?: string } | undefined)?.root ?? "";
    const root = await realOr(reply, rootQ);
    if (!root) return reply;
    const dir = join(root, "docs", "superpowers", "plans");
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".md"));
    } catch {
      return {};
    }
    let best: { path: string; mtime: number } | null = null;
    for (const name of names) {
      // realpath-check each candidate so a symlinked plan can't point outside.
      const real = await safe(join(dir, name));
      if (!real || !real.startsWith(root + sep)) continue;
      let st;
      try {
        st = await stat(real);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const mtime = Math.round(st.mtimeMs);
      if (!best || mtime > best.mtime) {
        best = { path: relative(root, join(dir, name)), mtime };
      }
    }
    return best ?? {};
  });

  // 3. Flat file list for Quick Open.
  app.get("/api/files/all", async (req: FastifyRequest, reply: FastifyReply) => {
    const rootQ = (req.query as { root?: string } | undefined)?.root ?? "";
    const root = await realOr(reply, rootQ);
    if (!root) return reply;
    const g = await guardFor(req);
    if (g) {
      return inCheckedDir(g, root, reply, { files: [] as string[] }, async (dir) => {
        let found: string[];
        try {
          const { stdout } = await runInDir(dir, "git", gitArgs(root, [
            "-c", "core.quotepath=off", "ls-files", "--cached", "--others", "--exclude-standard",
          ]), 1024 * 1024, gitEnv(root));
          found = stdout.split("\n").filter(Boolean);
        } catch {
          // find for today's walk: regular files only, symlinks never followed.
          const skip = FIND_SKIP.flatMap((n, i) => (i === 0 ? ["-name", n] : ["-o", "-name", n]));
          try {
            const { stdout } = await runInDir(dir, "find", [
              ".", "-mindepth", "1", "(", "-type", "d", "(", ...skip, ")", ")", "-prune", "-o", "-type", "f", "-print",
            ]);
            found = stdout.split("\n").filter(Boolean).map((l) => l.slice(2)).slice(0, FIND_CAP);
          } catch {
            found = [];
          }
        }
        return { files: found.filter((f) => !g.hidden(f) && !hiddenRow(root, f)).sort() };
      });
    }
    let files: string[];
    try {
      // quotepath=off: emit non-ASCII paths verbatim instead of quoted
      // octal escapes, which the UI would show (and re-send) as garbage.
      const { stdout } = await runGit(root, [
        "-C",
        root,
        "-c",
        "core.quotepath=off",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
      ]);
      files = stdout.split("\n").filter(Boolean);
    } catch {
      // Fallback: bounded recursive walk skipping noisy/vendored dirs.
      const SKIP = new Set([".git", "node_modules", ".next", "dist", "build"]);
      const CAP = 20000;
      files = [];
      const stack: string[] = [root];
      while (stack.length > 0 && files.length < CAP) {
        const dir = stack.pop()!;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (files.length >= CAP) break;
          const abs = join(dir, e.name);
          if (e.isDirectory()) {
            if (!SKIP.has(e.name)) stack.push(abs);
          } else if (e.isFile()) {
            files.push(relative(root, abs));
          }
        }
      }
    }
    return { files: files.filter((f) => !hiddenRow(root, f)).sort() };
  });

  // 4. Content search — literal (fixed-string) match, never a regex.
  app.get("/api/files/search", async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as { root?: string; q?: string; max?: string } | undefined;
    const root = await realOr(reply, query?.root ?? "");
    if (!root) return reply;
    const q = query?.q ?? "";
    if (q.trim().length === 0) return { results: [] };
    const max = Math.max(1, Math.min(2000, Number(query?.max) || 200));
    const g = await guardFor(req);
    if (g) {
      return inCheckedDir(g, root, reply, { results: [] as ReturnType<typeof parseGrep> }, async (dir) => {
        let out: string;
        try {
          // quotepath off (S2): a non-ASCII name prints raw, so `hidden` sees its .env* component.
          ({ stdout: out } = await runInDir(dir, "git", gitArgs(root, ["-c", "core.quotepath=off", "grep", "-n", "-I", "--no-color", "--untracked", "-F", "-e", q]),
            GUARD_MAX_BUFFER, gitEnv(root)));
        } catch (err) {
          if ((err as { code?: unknown }).code === 1) return { results: [] };
          try {
            ({ stdout: out } = await runInDir(dir, "grep", ["-rnI", "-F", "-e", q, "."]));
          } catch {
            return { results: [] };
          }
        }
        return { results: parseGrep(out, root, max, (rel) => g.hidden(rel) || hiddenRow(root, rel)) };
      });
    }
    let stdout: string;
    try {
      ({ stdout } = await runGit(
        root,
        ["-C", root, "grep", "-n", "-I", "--no-color", "--untracked", "-F", "-e", q],
        { maxBuffer: 32 * 1024 * 1024 },
      ));
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      // git grep exit 1 = ran fine, no matches (in a git work tree).
      if (e.code === 1) return { results: [] };
      // Any other exit (128 = not a git work tree, ENOENT = no git) → plain grep.
      try {
        // Run inside root with target "." so output paths are relative (like
        // git grep), matching parseGrep's rel/join contract.
        ({ stdout } = await run(
          "grep",
          ["-rnI", "-F", "-e", q, "."],
          { cwd: root, maxBuffer: 32 * 1024 * 1024 },
        ));
      } catch {
        // grep exit 1 (no match) or any failure → no results.
        return { results: [] };
      }
    }
    return { results: parseGrep(stdout, root, max, (rel) => hiddenRow(root, rel)) };
  });

  // 5. Heuristic go-to-definition. `symbol` is sanitized to an identifier so it
  // is safe to interpolate into the POSIX ERE built below.
  app.get("/api/files/definition", async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as { root?: string; symbol?: string } | undefined;
    const root = await realOr(reply, query?.root ?? "");
    if (!root) return reply;
    const symbol = query?.symbol ?? "";
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) {
      return reply.code(400).send({ error: "invalid symbol" });
    }
    // Common definition forms across languages (POSIX ERE for git grep -E).
    const kw = "(function|class|interface|type|enum|const|let|var|struct|def|func|fn)";
    const re =
      `${kw}[[:space:]]+${symbol}\\b` +
      `|\\b${symbol}[[:space:]]*[:=][[:space:]]*(function|\\(|async|class)` +
      `|(export[[:space:]]+(default[[:space:]]+)?)(function|class|const|interface|type|enum)[[:space:]]+${symbol}\\b`;
    const g = await guardFor(req);
    if (g) {
      return inCheckedDir(g, root, reply, { candidates: [] as ReturnType<typeof parseGrep> }, async (dir) => {
        let out: string;
        try {
          ({ stdout: out } = await runInDir(dir, "git", gitArgs(root, ["-c", "core.quotepath=off", "grep", "-nE", "-I", "--no-color", "--untracked", "-e", re]),
            GUARD_MAX_BUFFER, gitEnv(root)));
        } catch (err) {
          const e = err as { stdout?: string };
          if (typeof e.stdout === "string" && e.stdout.length > 0) out = e.stdout;
          else return { candidates: [] };
        }
        return { candidates: parseGrep(out, root, 50, (rel) => g.hidden(rel) || hiddenRow(root, rel)) };
      });
    }
    let stdout: string;
    try {
      ({ stdout } = await runGit(
        root,
        ["-C", root, "grep", "-nE", "-I", "--no-color", "--untracked", "-e", re],
        { maxBuffer: 32 * 1024 * 1024 },
      ));
    } catch (err) {
      const e = err as { code?: number; stdout?: string };
      if (typeof e.stdout === "string" && e.stdout.length > 0) {
        stdout = e.stdout;
      } else {
        return { candidates: [] };
      }
    }
    return { candidates: parseGrep(stdout, root, 50, (rel) => hiddenRow(root, rel)) };
  });
}
