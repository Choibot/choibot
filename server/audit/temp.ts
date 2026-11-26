// server/audit/temp.ts — is a folder in use? "Nothing changed it for days" does not prove that a
// folder is dead: a folder that holds the socket of a running program (tmux, an ssh agent, an
// agent's session) shows no change for weeks while it is in use. The scan and the removal ask
// this file, with the same code:
//   never   it is not a row and it is never removed:
//           - a temp folder with a name that is never touched, whatever its age (NEVER_NAME),
//           - it holds a socket, a named pipe or a device file, at any depth,
//           - a running program has a file of it open, runs from it or has it as its work folder,
//           - it holds a pid file whose process is alive,
//   locked  it holds a lock file, or a pid file of a process that is gone: never "safe", never
//           in a row of many folders,
//   free    none of these.
// When the facts cannot be read (/proc, or the walk of the folder), nothing is known: the caller
// then treats every folder as "never".
import { basename, sep } from "node:path";
import { NEW_NAMES, OLD_NAMES } from "../names.mjs";

// One marked entry of a walk: `type` is the letter of `find -printf %y` (s socket, p pipe, b and
// c devices, f file, l link, d folder).
export type Mark = { type: string; path: string };

export type UseDeps = {
  // The marked entries under `dir` (sockets, pipes, devices, pid files, lock files), in one run.
  // `skip`: full paths that the run does not go into. Null: no answer.
  marks: (dir: string, skip: string[]) => Promise<Mark[] | null>;
  // Every path that a running program of this user has open, runs from or works in. Null: not known.
  inUse: () => string[] | null;
  // Is the process of this pid file alive? (The one read of a file's content in the audit: a
  // regular file of at most 32 bytes that holds one number.)
  livePid: (pidFile: string) => Promise<boolean>;
};

// Names of a temp folder that are never touched: the sockets of terminal sessions, of logins and
// of the desktop, the private temp folders of services, the session folders of every console
// instance (of an install with the old names and with the new names, and hc-* of a test
// instance), and the work folders of running Claude sessions (claude-<user id>).
const OTHER_PROGRAMS = /^(tmux-|screen-|ssh-|gpg-|keyring-|dbus-|pulse-|runtime-|systemd-private-|snap-private-tmp$|snap\.|\.X11-unix$|\.ICE-unix$|\.XIM-unix$|\.font-unix$|\.Test-unix$|hc-|claude(-\d+)?$|code-server|vscode-)/;
const SESSION_DIRS = [OLD_NAMES.dtachDir, NEW_NAMES.dtachDir];
export const NEVER_NAME = { test: (name: string): boolean => OTHER_PROGRAMS.test(name) || SESSION_DIRS.some((d) => name.startsWith(d)) };

// Names that ChoiBot's own tests and tools make in a temp folder. Only these can be "safe".
// (tsx-<user id> and node-compile-cache: caches that the tools make again.)
// A short list on purpose: a name that another program of the owner could use is not in it.
export const OUR_NAME = /^(chief-|choibot-index-|path-test|install-test|tsx-\d+$|node-compile-cache$)/;

const SPECIAL = new Set(["s", "p", "b", "c"]);
const isPidFile = (m: Mark): boolean => m.type === "f" && /(^|\.)pid$/.test(basename(m.path));
const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir === sep ? sep : dir + sep);

export type Facts = { special: Set<string>; live: Set<string>; locked: Set<string>; used: string[] };
export type UseState = "never" | "locked" | "free";

/**
 * The facts for some folders (`roots`) under `dir`, from one walk of `dir` and one read of the
 * running programs. Null: not known.
 */
export async function useFacts(dir: string, roots: string[], skip: string[], d: UseDeps): Promise<Facts | null> {
  const used = d.inUse();
  if (used === null) return null;
  const marks = await d.marks(dir, skip);
  if (marks === null) return null;
  // The longest root first: a mark belongs to the folder nearest to it.
  const sorted = [...roots].sort((a, b) => b.length - a.length);
  const f: Facts = { special: new Set(), live: new Set(), locked: new Set(), used };
  for (const m of marks) {
    const root = sorted.find((r) => within(m.path, r));
    if (!root) continue;
    if (SPECIAL.has(m.type)) f.special.add(root);
    else if (isPidFile(m)) { if (await d.livePid(m.path)) f.live.add(root); else f.locked.add(root); }
    else if (m.type !== "d") f.locked.add(root);
  }
  return f;
}

// temp: the folder is directly in a temp folder (the names of NEVER_NAME count there only).
export function useState(path: string, f: Facts, o: { temp: boolean }): UseState {
  if (o.temp && NEVER_NAME.test(basename(path))) return "never";
  if (f.special.has(path) || f.live.has(path) || f.used.some((u) => within(u, path))) return "never";
  return f.locked.has(path) ? "locked" : "free";
}
