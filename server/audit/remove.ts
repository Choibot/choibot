// server/audit/remove.ts — the one part of the clean-up audit that changes the disk: it removes
// ONE thing of the last audit, on the paired user's press and confirm.
//
// The browser sends an id only. The path is the server's own (the audit's table); no path of a
// request is ever removed. The scan was some time ago, so every rule is checked again NOW. Any
// doubt is a refusal with a plain reason:
//   - it is not a secret or private place (files/wide.ts), and not the console's own data,
//   - it is still there, it is this user's, it is no link, and no link is in its path (its real
//     path is the path of the audit),
//   - no disk is mounted on it or in it (a removal stays on one file system),
//   - it is not, and does not hold, a place that must stay: "/", the home folder, the work
//     folder, a repo, the console's checkout, the folder of an open agent; it is not inside the
//     folder of an open agent; of the console's checkout only a build that failed its check
//     (never the running build, never the build that a deploy goes back to),
//   - a copy of a repo: no open agent uses it, and git says again that it has no changed file
//     and no commit that is on no remote. A copy with unsaved work is never removed here,
//   - no running program uses it (./temp.ts, the same code as the scan): it holds no socket, no
//     pipe and no device file, no program has a file of it open or works in it, no pid file in
//     it names a live process; a temp folder has no name that is never touched. When this
//     cannot be read, nothing is removed,
//   - a temp folder: nothing changed it since the audit.
// HOW: a copy of a repo goes through git (`git worktree remove`), the copy of a closed agent
// through "Delete the agent"; all else through Node's fs (no shell; a link is removed as a link,
// never followed).
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { whyRefused, type Wide } from "../files/wide.js";
import { copyState, LOCKED, PLAIN, TEMP_SAFE_DAYS, type AgentRef, type Candidate, type Measured } from "./scan.js";
import { NEVER_NAME, OUR_NAME, useFacts, useState, type UseDeps } from "./temp.js";

export type RemoveDeps = UseDeps & {
  wide: Wide;
  workDir: string;
  checkout: string;
  uid: number;
  now: number;
  // The agents NOW (not the ones of the audit).
  agents: AgentRef[];
  // The places where a disk is mounted NOW (/proc/mounts).
  mounts: string[];
  measure: (path: string) => Promise<Measured | null>;
  measureChildren: (dir: string, skip: string[]) => Promise<Map<string, Measured> | null>;
  git: (cwd: string, args: string[]) => Promise<string | null>;
  // Removes a copy of a repo the way the console does it: `git worktree remove`.
  removeWorktree: (repo: string, path: string) => Promise<void>;
  // Removes a closed agent with its copy and its record ("Delete the agent").
  deleteAgent: (id: string) => Promise<void>;
  // Removes one folder or file with fs. Tests give a fake.
  rm?: (path: string) => Promise<void>;
  minBytes?: number;
};

// bytes: the space that the thing had just before it was removed. dev: its file system.
export type Removed = { ok: true; bytes: number; dev: number } | { ok: false; text: string };

const DAY = 24 * 60 * 60_000;
export const AGAIN = "Run the audit again.";
const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir === sep ? sep : dir + sep);
const real = (p: string): Promise<string> => realpath(p).catch(() => p);
const no = (text: string): Removed => ({ ok: false, text });
const IN_USE = "A running program uses it (an open file, a socket, a pipe or a live process): it is not removed.";
const NOT_KNOWN = "ChoiBot cannot see now if a program uses it: it is not removed.";

// The checks that every removal passes. A text: why not. A number: its file system (it may go).
async function check(path: string, kind: "dir" | "file", d: RemoveDeps, keep: string[]): Promise<string | number> {
  if (whyRefused(path, d.wide)) return "This place holds a key, is private or is a part of ChoiBot's records: it is not removed.";
  if (keep.some((k) => within(k, path))) return "A place that must stay is in it: it is not removed.";
  let st;
  try { st = await lstat(path); } catch { return "It is not there any more."; }
  if (st.isSymbolicLink() || (kind === "dir" ? !st.isDirectory() : !st.isFile())) return `It is not the same thing as at the audit. ${AGAIN}`;
  if (st.uid !== d.uid) return "It belongs to another user: it is not removed.";
  if ((await real(path)) !== path) return `Its path changed since the audit. ${AGAIN}`;
  if (d.mounts.some((m) => within(m, path))) return "A disk is mounted on it or in it: it is not removed.";
  return st.dev;
}

/** Removes the thing of one row of the last audit. `c` is the server's own candidate. */
export async function removeCandidate(c: Candidate, d: RemoveDeps): Promise<Removed> {
  const del = d.rm ?? ((p: string) => rm(p, { recursive: true, force: false }));
  const open = d.agents.filter((a) => !a.closed);
  const openDirs = await Promise.all(open.map((a) => real(a.worktree)));
  const workDir = await real(d.workDir);
  const checkout = await real(d.checkout);
  let repos: string[] = [];
  try { repos = (await readdir(workDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(workDir, e.name)); } catch { /* no work folder */ }
  // What must stay: nothing that is one of these, or holds one, is removed. ("/" holds the home folder.)
  const keep = [d.wide.home, workDir, checkout, ...repos, ...openDirs];

  if (c.count) return removeSmallTemp(c, d, del, keep);

  const kind = c.kind === "old-log" || c.kind === "old-archive" || c.kind === "big-file" ? "file" : "dir";
  const dev = await check(c.path, kind, d, keep);
  if (typeof dev === "string") return no(dev);
  // Of the console's own checkout only a build that failed its check at a deploy.
  if (within(c.path, checkout) && !(c.kind === "old-build" && c.path === join(checkout, ".next-failed"))) return no("This is a part of ChoiBot: it is not removed.");
  // Nothing inside the folder of an open agent (its installed parts, its build).
  if (openDirs.some((o) => within(c.path, o))) return no("An agent uses this now: it is not removed.");

  // No running program uses it.
  if (kind === "dir") {
    const facts = await useFacts(c.path, [c.path], [], d);
    if (!facts) return no(NOT_KNOWN);
    const state = useState(c.path, facts, { temp: c.kind === "temp" });
    if (state === "never") return no(IN_USE);
    // A lock file that the row did not show: the user did not see it.
    if (state === "locked" && c.kind === "temp" && !c.notes.includes(LOCKED)) return no(`It now holds a lock file: a program can use it. ${AGAIN}`);
  } else {
    const used = d.inUse();
    if (used === null) return no(NOT_KNOWN);
    if (used.includes(c.path)) return no(IN_USE);
  }

  // The space that it has now (the answer says what really came back).
  const size = kind === "dir" ? await d.measure(c.path) : { bytes: (await lstat(c.path)).blocks * 512, newest: null };
  if (!size) return no("It took too long to measure. Try again later.");

  if (c.kind === "unused-copy" || c.kind === "closed-copy") {
    if (open.some((a) => basename(c.path).startsWith(basename(a.worktree)))) return no("An agent uses this copy now: it is not removed.");
    const git = await copyState(c.path, d.git);
    if (git.state === "plain" && c.kind === "unused-copy" && c.notes.includes(PLAIN)) {
      // A left-over folder that git does not know, as the row said: a plain folder.
      try { await del(c.path); } catch { return no("It could not be removed: a file in it is in use or is not yours."); }
      return { ok: true, bytes: size.bytes, dev };
    }
    if (git.state !== "saved" || !git.repo) return no(git.state === "unsaved" ? `This copy has work that is not saved on GitHub: it is not removed. ${AGAIN}` : `Git does not say that this copy is saved: it is not removed. ${AGAIN}`);
    try {
      if (c.kind === "closed-copy") {
        const agent = d.agents.find((a) => a.id === c.agentId);
        if (!agent) return no(`The agent of this copy is not there any more. ${AGAIN}`);
        if (!agent.closed) return no("The agent of this copy is open again: it is not removed.");
        await d.deleteAgent(agent.id);
      } else {
        await d.removeWorktree(git.repo, c.path);
      }
    } catch { return no("Git could not remove this copy."); }
    return { ok: true, bytes: size.bytes, dev };
  }
  if (c.kind === "temp" && (size.newest === null || d.now - size.newest < (c.ageDays ?? 0) * DAY)) return no(`A program changed these files after the audit. ${AGAIN}`);
  try { await del(c.path); } catch { return no("It could not be removed: a file in it is in use or is not yours."); }
  return { ok: true, bytes: size.bytes, dev };
}

// The many small old folders of a temp folder: selected again by the rule of the scan (a folder
// directly in the temp folder, this user's, not refused, under the size of a row, nothing in it
// changed for TEMP_SAFE_DAYS days, no running program uses it, no lock file in it, and its name
// is of the row's kind: ChoiBot's own, or not), and each one passes the checks above.
async function removeSmallTemp(c: Candidate, d: RemoveDeps, del: (p: string) => Promise<void>, keep: string[]): Promise<Removed> {
  if (c.bulk !== "ours" && c.bulk !== "other") return no(`This row is of an older audit. ${AGAIN}`);
  const tmp = c.path;
  const minBytes = d.minBytes ?? 10 * 1024 * 1024;
  let all: string[];
  let dev: number;
  try {
    dev = (await lstat(tmp)).dev;
    all = (await readdir(tmp, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(tmp, e.name));
  } catch { return no("The temporary folder cannot be read."); }
  const skip = all.filter((p) => whyRefused(p, d.wide) || NEVER_NAME.test(basename(p)));
  const dirs = all.filter((p) => !skip.includes(p));
  const facts = await useFacts(tmp, dirs, skip, d);
  if (!facts) return no(NOT_KNOWN);
  const sizes = await d.measureChildren(tmp, skip);
  if (!sizes) return no("The temporary folder took too long to measure. Try again later.");
  let bytes = 0;
  let count = 0;
  for (const p of dirs) {
    const m = sizes.get(p);
    if (!m || m.newest === null || m.bytes >= minBytes || d.now - m.newest < TEMP_SAFE_DAYS * DAY) continue;
    if (OUR_NAME.test(basename(p)) !== (c.bulk === "ours") || useState(p, facts, { temp: true }) !== "free") continue;
    if (typeof (await check(p, "dir", d, keep)) === "string") continue;
    try { await del(p); bytes += m.bytes; count += 1; } catch { /* in use or not ours: it stays */ }
  }
  return count ? { ok: true, bytes, dev } : no("No small old folder is there any more.");
}
