// server/audit/api.ts — the clean-up audit of the Server page.
//   GET  /api/server/audit   the last result with its time, and whether an audit runs
//   POST /api/server/audit   start an audit (one at a time; it takes some minutes)
//   POST /api/server/audit/remove   remove the thing of ONE row ({ id, checkedAt }), or every row
//                                   of the safe group ({ all: "safe", checkedAt }), after the
//                                   user's confirm on the page
// An audit removes nothing and changes nothing on the server. A removal takes an id of the last
// result, never a path: the path is the server's own, and every rule is checked again before the
// thing is removed (./remove.ts).
// WHO: the paired user only starts an audit, reads it and removes a thing. A console with no device pairing answers 403.
// The AI step uses the Claude plan of the server only when the user presses: no timer starts one.
import { execFile } from "node:child_process";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { constants, existsSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "../agents/git.js";
import { gateUser, type ChiefGate } from "../chief/gate.js";
import { lowPriority } from "../health/places.js";
import type { Audit } from "./audit.js";
import type { Measured } from "./scan.js";
import type { Mark, UseDeps } from "./temp.js";

export const MEASURE_TIMEOUT_MS = 90_000;
export const AUDIT_NO_PAIRING = { error: "needs-pairing", text: "Pair a device first. The clean-up audit is for a paired device only." };

// The size of a folder and the time of its newest file: one `du` at the lowest priority, on one
// disk (-x), with a time limit. No shell: the path is one argument. Null: no answer.
export function systemMeasure(timeoutMs = MEASURE_TIMEOUT_MS): (path: string) => Promise<Measured | null> {
  return (path) => new Promise((done) => {
    const argv = lowPriority(["du", "-s", "-k", "-x", "--time", "--time-style=+%s", "--", path]);
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      if (err && ((err as { killed?: boolean }).killed === true || (err as { code?: unknown }).code === "ENOENT")) return done(null);
      // "<kilobytes>\t<seconds>\t<path>": the last line is the folder itself.
      const f = (stdout.trim().split("\n").pop() ?? "").split("\t");
      const kb = Number(f[0]);
      const at = Number(f[1]);
      done(f.length >= 3 && Number.isFinite(kb) ? { bytes: kb * 1024, newest: Number.isFinite(at) && at > 0 ? at * 1000 : null } : null);
    });
  });
}

// The temp folders that an audit looks at. A test instance (CHIEF_TEST=1, scripts/chief-instance.sh)
// looks only at <its own home>/tmp: a test never lists, and so never removes, a temp folder of
// the machine that it runs on.
export function auditTmpDirs(env: Record<string, string | undefined>, home: string, systemTmp: string): string[] {
  return env.CHIEF_TEST === "1" ? [join(home, "tmp")] : [...new Set(["/tmp", systemTmp])];
}

// A read-only git command in a folder: its output, or null when git gave an error.
export const auditGit = (cwd: string, args: string[]): Promise<string | null> =>
  runGit(cwd, ["-C", cwd, ...args], { timeout: 15_000 }).then((r) => r.stdout, () => null);

export const CHILDREN_TIMEOUT_MS = 5 * 60_000;

// The same for each folder directly in `dir`, in one `du` (depth 1). `skip`: full paths that du
// does not go into (a glob character in a path is taken as itself).
export function systemMeasureChildren(timeoutMs = CHILDREN_TIMEOUT_MS): (dir: string, skip: string[]) => Promise<Map<string, Measured> | null> {
  return (dir, skip) => new Promise((done) => {
    const argv = lowPriority(["du", "-k", "-x", "-d", "1", "--time", "--time-style=+%s", ...skip.map((p) => `--exclude=${p.replace(/[\\*?[\]]/g, "\\$&")}`), "--", dir]);
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      if (err && ((err as { killed?: boolean }).killed === true || (err as { code?: unknown }).code === "ENOENT" || (err as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) return done(null);
      const out = new Map<string, Measured>();
      for (const line of stdout.split("\n")) {
        const a = line.indexOf("\t");
        const b = line.indexOf("\t", a + 1);
        if (a < 0 || b < 0) continue;
        const kb = Number(line.slice(0, a));
        const at = Number(line.slice(a + 1, b));
        const path = line.slice(b + 1);
        if (Number.isFinite(kb) && path !== dir) out.set(path, { bytes: kb * 1024, newest: Number.isFinite(at) && at > 0 ? at * 1000 : null });
      }
      done(out);
    });
  });
}

export const MARKS_TIMEOUT_MS = 5 * 60_000;
const LOCK_NAMES = ["*.pid", "pid", "*.lock", "lock", "LOCK", "SingletonLock"];
// `find` says this for an entry that it may not read or that went away: the walk is still good.
const FIND_SOFT = /Permission denied|No such file or directory/;

// The marked entries under a folder (./temp.ts): every socket, pipe and device file, and every
// pid file and lock file by its name. One `find` at the lowest priority, on one disk (-xdev),
// with a time limit; it reads names and kinds, no content. No shell: each path is one argument.
// Null: no full answer (a time-out, a `find` that does not know -printf, an error).
export function systemMarks(timeoutMs = MARKS_TIMEOUT_MS): UseDeps["marks"] {
  return async (dir, skip) => {
    // A start folder that is not there is no answer (find calls it a soft error).
    try { if (!(await lstat(dir)).isDirectory()) return null; } catch { return null; }
    return run(dir, skip);
  };
  function run(dir: string, skip: string[]): Promise<Mark[] | null> { return new Promise((done) => {
    const glob = (p: string): string => p.replace(/[\\*?[\]]/g, "\\$&");
    const prune = skip.length ? ["(", ...skip.flatMap((p, i) => [...(i ? ["-o"] : []), "-path", glob(p)]), ")", "-prune", "-o"] : [];
    const wanted = ["-type", "s", "-o", "-type", "p", "-o", "-type", "b", "-o", "-type", "c", ...LOCK_NAMES.flatMap((n) => ["-o", "-name", n])];
    const argv = lowPriority(["find", dir, "-xdev", ...prune, "(", ...wanted, ")", "-printf", "%y\\t%p\\0"]);
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const hard = (err as { killed?: boolean }).killed === true || typeof (err as { code?: unknown }).code !== "number"
          || stderr.split("\n").some((l) => l.trim() !== "" && !FIND_SOFT.test(l));
        if (hard) return done(null);
      }
      const out: Mark[] = [];
      for (const rec of stdout.split("\0")) {
        const tab = rec.indexOf("\t");
        if (tab === 1) out.push({ type: rec[0], path: rec.slice(2) });
      }
      done(out);
    });
  }); }
}

// Every path that a running program of this user has open (/proc/<pid>/fd), runs from (exe) or
// works in (cwd). Null: /proc cannot be read, or this process itself is not in it.
export function liveUse(uid: number, procRoot = "/proc"): string[] | null {
  let pids: string[];
  try { pids = readdirSync(procRoot).filter((n) => /^\d+$/.test(n)); } catch { return null; }
  const out = new Set<string>();
  let self = false;
  const add = (link: string): void => {
    try {
      const to = readlinkSync(link).replace(/ \(deleted\)$/, "");
      if (to.startsWith("/")) out.add(to);
    } catch { /* gone */ }
  };
  for (const pid of pids) {
    const dir = join(procRoot, pid);
    try { if (statSync(dir).uid !== uid) continue; } catch { continue; }
    let fds: string[];
    try { fds = readdirSync(join(dir, "fd")); } catch { continue; }
    if (Number(pid) === process.pid) self = true;
    add(join(dir, "cwd"));
    add(join(dir, "exe"));
    for (const fd of fds) add(join(dir, "fd", fd));
  }
  return self ? [...out] : null;
}

// Is the process of a pid file alive? The file must be a regular file of at most 32 bytes that
// holds one number (a link is not followed).
export async function livePid(pidFile: string, procRoot = "/proc"): Promise<boolean> {
  let fh;
  try { fh = await open(pidFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return false; }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > 32) return false;
    const pid = /^\s*(\d{1,10})\s*$/.exec((await fh.readFile("utf8")))?.[1];
    return pid !== undefined && existsSync(join(procRoot, pid));
  } catch { return false; } finally { await fh.close().catch(() => {}); }
}

export function registerAuditApi(app: FastifyInstance, d: { gate?: ChiefGate; audit: Audit }): void {
  const user = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!d.gate) { reply.code(403).send(AUDIT_NO_PAIRING); return false; }
    return (await gateUser(d.gate, req, reply)) !== null;
  };

  app.get("/api/server/audit", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    return d.audit.view();
  });

  app.post("/api/server/audit", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const { started } = d.audit.start();
    return reply.code(started ? 202 : 409).send(started ? { started: true } : { error: "busy", text: "An audit runs now. Its result comes in some minutes." });
  });

  app.post("/api/server/audit/remove", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const body = (req.body ?? {}) as { id?: unknown; all?: unknown; checkedAt?: unknown };
    const r = await d.audit.remove({ id: body.id, all: body.all, checkedAt: body.checkedAt });
    return r.started ? reply.code(202).send({ started: true }) : reply.code(409).send({ error: "not-removed", text: r.text });
  });
}
