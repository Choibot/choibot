// server/widgets/files.ts — small filesystem helpers for widget folders.
// Widget folders are agent-writable, so the console never writes through a
// name the agent may have pointed elsewhere: every console write goes to a
// fresh temp file in the same folder, then is renamed over the target (rename
// replaces a symlink, it does not follow it), and a reader never sees half a
// file. Reads are capped by size.
// Strong protection (a hardened deployment): an agent can also put a link in place of a widget
// folder, or of the agent's folder above it. So each read is proven on its open fd, each write goes
// through the folder opened and proven first, a list reads the proven folder, and a delete removes
// entry by entry relative to its open parent (agents/nofollow.ts): no read, write or delete reaches
// a place outside the widgets folder.
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, open, readdir, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hardenedDeployment } from "../chief/hardened.js";
import { O_DIR, at, fdPath, insideReal, openProven, removeEntry, writeNew } from "../agents/nofollow.js";
import { WidgetError } from "./errors.js";
import { resolveWidgetsDataDir } from "./paths.js";

// The real widgets folder of a hardened deployment (the console's own folder: no agent moves it),
// or null: not hardened, the reads and writes are as before.
export function widgetsRoot(env: Record<string, string | undefined> = process.env): string | null {
  return hardenedDeployment(env) ? realpathSync(resolveWidgetsDataDir(env)) : null;
}

// A folder of the widgets folder, open and proven (inside it; `orRoot`: the folder itself too).
async function openProvenDir(path: string, root: string, orRoot = false): Promise<FileHandle> {
  const fh = await open(path, O_DIR);
  if (await insideReal(fh, root, orRoot)) return fh;
  await fh.close().catch(() => {});
  throw new WidgetError(404, "not found");
}

export async function writeAtomic(path: string, text: string): Promise<void> {
  const root = widgetsRoot();
  if (root) {
    const dir = await openProvenDir(dirname(path), root);
    const name = basename(path);
    const tmp = `.${name}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeNew(dir, tmp, text);
      await rename(at(dir, tmp), at(dir, name));
    } catch (e) {
      await rm(at(dir, tmp), { force: true }).catch(() => { /* never created */ });
      throw e;
    } finally {
      await dir.close();
    }
    return;
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, text, { flag: "wx" });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => { /* never created */ });
    throw e;
  }
}

// mtime of a regular file (symlinks followed), else null. Hardened: of the proven open file only
// (a link to a console file gives null, not that file's time).
export async function mtimeOf(path: string): Promise<number | null> {
  const root = widgetsRoot();
  if (root) {
    const fh = await openProven(path, { root }).catch(() => null);
    if (!fh) return null;
    try { return (await fh.stat()).mtimeMs; } catch { return null; } finally { await fh.close(); }
  }
  try {
    const st = await stat(path);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

// Any directory entry, a dangling symlink included.
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

// The names in a folder (a widget folder, or an agent's folder of widgets). Missing: [].
export async function listNames(path: string): Promise<string[]> {
  const root = widgetsRoot();
  if (!root) return readdir(path).catch(() => []);
  let dir: FileHandle;
  try { dir = await openProvenDir(path, root); } catch { return []; }
  try { return await readdir(fdPath(dir)); } catch { return []; } finally { await dir.close(); }
}

// Removes a folder and all in it. Hardened: entry by entry, relative to its proven parent.
export async function removeTree(path: string): Promise<void> {
  const root = widgetsRoot();
  if (!root) return rm(path, { recursive: true, force: true });
  let parent: FileHandle;
  try { parent = await openProvenDir(dirname(path), root, true); } catch { return; }
  try { await removeEntry(parent, basename(path)); } finally { await parent.close(); }
}

// null = missing or not a regular file. Over `max` bytes → WidgetError 413.
export async function readCapped(path: string, max: number): Promise<string | null> {
  const root = widgetsRoot();
  if (root) return readCappedProven(path, max, root);
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  const tooLarge = () => new WidgetError(413, `${basename(path)} is over ${max} bytes`);
  if (size > max) throw tooLarge();
  let buf: Buffer;
  try { buf = await readFile(path); } catch { return null; }
  if (buf.length > max) throw tooLarge(); // grew between stat and read
  return buf.toString("utf8");
}

async function readCappedProven(path: string, max: number, root: string): Promise<string | null> {
  const fh = await openProven(path, { root });
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (st.size > max) throw new WidgetError(413, `${basename(path)} is over ${max} bytes`);
    const buf = Buffer.allocUnsafe(max + 1);
    let got = 0;
    while (got <= max) {
      const { bytesRead } = await fh.read(buf, got, max + 1 - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got > max) throw new WidgetError(413, `${basename(path)} is over ${max} bytes`); // grew between stat and read
    return buf.subarray(0, got).toString("utf8");
  } finally {
    await fh.close();
  }
}

// Parsed JSON, or null when missing, too large or not JSON. For files whose
// damage must never fail a request (meta.json, ui.json, status.json, state.json).
export async function readJsonSoft(path: string, max: number): Promise<unknown> {
  try {
    const raw = await readCapped(path, max);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}
