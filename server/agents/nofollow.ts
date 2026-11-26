// server/agents/nofollow.ts — the console's own writes into dirs the agent
// uid can write (a hardened deployment, Phase 2c rulings 2c-7-a/b/c): the
// persistent agents' homes in AGENT_HOME_ROOT and the agent worktrees. An
// agent can swap any entry there at any time, so these writes never follow a
// symlink: a path is opened one component at a time with O_NOFOLLOW (an
// openat through /proc/self/fd), a new file is made with O_EXCL, and an
// existing one is checked on its open fd before it is changed. Linux only,
// as the hardened deployment is.
import { constants } from "node:fs";
import { mkdir, open, readdir, readlink, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Linux O_PATH (node's fs.constants has none): opens a dir for search only,
// so an ancestor such as a 0711 /home/choibot-agent needs no read permission.
const O_PATH = 0o10000000;
const O_SEARCH = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const O_DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const O_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
// No O_TRUNC: a file is emptied only after its checks. O_NONBLOCK: an
// agent's FIFO fails the open (ENXIO) instead of hanging it.
const O_REWRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export const errCode = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? "");

// `name` inside the dir open as fh: openat(fh.fd, name) through /proc.
export const at = (fh: FileHandle, name: string): string => `/proc/self/fd/${fh.fd}/${name}`;
export const fdPath = (fh: FileHandle): string => `/proc/self/fd/${fh.fd}`;

// The child dir `name` of the dir open as fh, never through a symlink: a
// symlink or a non-dir there throws, naming `shown`. create: when it is
// missing it is made, then given create.mode (if any) when the console owns
// it; absent, a missing dir throws.
type Create = { mode?: number };
async function openChild(fh: FileHandle, name: string, flags: number, shown: string, create?: Create): Promise<FileHandle> {
  const refuse = (e: unknown): never => {
    const code = errCode(e);
    if (code === "ENOTDIR" || code === "ELOOP") throw new Error(`[chief] ${shown} is a symlink or not a dir; refused`);
    if (code === "EACCES") throw new Error(`[chief] no access to ${shown} (EACCES)`);
    if (code === "ENOENT") throw new Error(`[chief] ${shown} does not exist`);
    throw e;
  };
  try {
    return await open(at(fh, name), flags);
  } catch (e) {
    if (!create || errCode(e) !== "ENOENT") return refuse(e);
  }
  try { await mkdir(at(fh, name)); } catch (e) { if (errCode(e) !== "EEXIST") refuse(e); }
  let child: FileHandle;
  try { child = await open(at(fh, name), O_DIR); } catch (e) { return refuse(e); }
  try {
    if (create.mode !== undefined && (await child.stat()).uid === process.getuid?.()) await child.chmod(create.mode);
  } catch (e) {
    await child.close();
    throw e;
  }
  return child;
}

// The dir at `path` (absolute), opened from / one component at a time, never
// through a symlink. The ancestors are opened for search only (O_PATH), the
// dir itself for reading. create: a missing component is made, the dir with
// create.mode and an ancestor with create.parentMode. A symlink, a non-dir or
// a dir the console cannot search throws a [chief] error naming the component.
export async function openDirNoFollow(path: string, create?: { mode: number; parentMode: number }): Promise<FileHandle> {
  const names = resolve(path).split(sep).filter(Boolean);
  let fh = await open("/", names.length === 0 ? O_DIR : O_SEARCH);
  let walked = "";
  try {
    for (const [i, name] of names.entries()) {
      walked += `/${name}`;
      const last = i === names.length - 1;
      const made = create ? { mode: last ? create.mode : create.parentMode } : undefined;
      const next = await openChild(fh, name, last ? O_DIR : O_SEARCH, walked, made);
      await fh.close();
      fh = next;
    }
    return fh;
  } catch (e) {
    await fh.close();
    throw e;
  }
}

// The dir <base>/<rel...>: base as given (the console's own layout: a
// worktree or home it made), each rel component never through a symlink and
// made with mkdir's own mode when missing. Opened for search only.
export async function openDirBelow(base: string, rel: string[]): Promise<FileHandle> {
  let fh = await open(base, O_PATH | constants.O_DIRECTORY);
  let walked = base;
  try {
    for (const name of rel) {
      walked += `/${name}`;
      const next = await openChild(fh, name, O_SEARCH, walked, {});
      await fh.close();
      fh = next;
    }
    return fh;
  } catch (e) {
    await fh.close();
    throw e;
  }
}

// A new file `name` in the dir open as dir (O_EXCL, so never an existing
// entry or a symlink): EEXIST when one is there. mode: set after the write
// (umask would narrow it); absent, writeFile's usual 0666 & ~umask.
export async function writeNew(dir: FileHandle, name: string, data: Uint8Array | string, mode?: number): Promise<void> {
  const f = await open(at(dir, name), O_NEW, mode ?? 0o666);
  try {
    await f.writeFile(data);
    if (mode !== undefined) await f.chmod(mode);
  } finally {
    await f.close();
  }
}

// Writes `path`, a new or an existing file, without following a final
// symlink: a symlink there is refused, so is anything but a regular file
// with one link (a hard link to a console file elsewhere). The file is
// emptied only after those checks. Mode as writeFile gives a new file.
// mode: set on the open file before the write (a new file gets 0666 less the umask; one that
// exists keeps its own mode unless this is given).
export async function writeFileNoFollow(path: string, data: string, mode?: number): Promise<void> {
  let f: FileHandle;
  try {
    f = await open(path, O_REWRITE, 0o666);
  } catch (e) {
    if (errCode(e) === "ELOOP") throw new Error(`[chief] ${path} is a symlink; refused`);
    throw e;
  }
  try {
    const st = await f.stat();
    if (!st.isFile() || st.nlink !== 1) throw new Error(`[chief] ${path} is not a regular file with one link; refused`);
    if (mode !== undefined) await f.chmod(mode);
    await f.truncate(0);
    await f.writeFile(data);
  } finally {
    await f.close();
  }
}

// The console's READ of a file in a folder that an agent can write, proven on the open fd with no
// helper call (the thread view reads often; a sudo per read would slow it). The open uses
// O_NOFOLLOW (the last part is never a link), O_NONBLOCK (an agent's FIFO does not hang it) and
// O_NOCTTY. Then, on the open object itself:
//   - its real path (readlink of /proc/self/fd/<n>) is inside `root`, a real folder that no agent
//     can move: a link in any part of the path that led out of it shows here, after the open;
//   - it is a regular file with one link (and fs.protected_hardlinks: no agent makes a hard link
//     to a file of another account);
//   - `uid`, when given, is its owner: the agent's own file.
// The checks are on the open fd, so a swap of the path after the open changes nothing. Null when
// the file is not there or fails a check (the caller treats it as "no file").
export const O_READ_PROVEN = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;
export type ReadProof = { root: string; uid?: number };

// The real path of the open fd is inside `root` (`orRoot`: or `root` itself).
export async function insideReal(fh: FileHandle, root: string, orRoot = false): Promise<boolean> {
  let real: string;
  try { real = await readlink(fdPath(fh)); } catch { return false; }
  return (orRoot && real === root) || real.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export async function openProven(path: string, p: ReadProof): Promise<FileHandle | null> {
  let fh: FileHandle;
  try { fh = await open(path, O_READ_PROVEN); } catch { return null; }
  try {
    const st = await fh.stat();
    if (st.isFile() && st.nlink === 1 && (p.uid === undefined || st.uid === p.uid) && (await insideReal(fh, p.root))) return fh;
  } catch { /* fall through to close */ }
  await fh.close().catch(() => {});
  return null;
}

// Removes the entry `name` of the dir open as dir, and all below it, never through a link: each
// sub-folder is opened with O_NOFOLLOW (a folder swapped for a link fails that open, and the link
// itself is removed), and each name is removed relative to its open parent (unlink and rmdir do not
// follow a final link). A missing entry is no error.
export async function removeEntry(dir: FileHandle, name: string): Promise<void> {
  let child: FileHandle | null = null;
  try {
    child = await open(at(dir, name), O_DIR);
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT") return;
    if (code !== "ELOOP" && code !== "ENOTDIR") throw e;
  }
  if (!child) {
    await unlink(at(dir, name)).catch((e) => { if (errCode(e) !== "ENOENT") throw e; });
    return;
  }
  try {
    for (const n of await readdir(fdPath(child))) await removeEntry(child, n);
  } finally {
    await child.close();
  }
  await rmdir(at(dir, name)).catch((e) => { if (errCode(e) !== "ENOENT") throw e; });
}
