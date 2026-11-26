// acceptMedia: copy an agent's preview screenshots into the console's media
// folder (spec §9). The agent controls every path, so this is a filesystem
// boundary: the agent's real cwd must be one of the agent roots or sit below
// one; each file must resolve inside that cwd, must not be a symlink itself,
// must still be inside the cwd once opened (a dir swapped for a symlink
// between the check and the open), must be a regular file with no other hard
// link (another name for it may sit outside the cwd), of at most 5 MB with
// PNG/JPEG/WebP magic bytes. All or nothing. Linux only (/proc).
import { constants } from "node:fs";
import { mkdir, open, readlink, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const MEDIA_MAX_BYTES = 5 * 1024 * 1024, MEDIA_MAX_FILES = 10;

export type MediaResult = { ok: true; names: string[] } | { ok: false; error: string };
// GIF only for an image of a ticket answer (answerImages.ts): a preview stays PNG, JPEG or WebP.
export type ImageExt = "png" | "jpg" | "gif" | "webp";
type PreviewExt = Exclude<ImageExt, "gif">;
// The names acceptMedia writes (`<n>.<ext>`): the only names ever read back.
export const MEDIA_NAME_RE = /^\d{1,2}\.(png|jpg|webp)$/;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The one check of an image's type from its bytes (never from its name or its content type).
export function sniffImage(buf: Buffer): ImageExt | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return "gif";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

// O_NONBLOCK: an open of a FIFO for reading would otherwise wait for a writer
// forever; it has no effect on a regular file.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const code = (err: unknown): string => (err as NodeJS.ErrnoException | undefined)?.code ?? "error";

// Thrown inside the copy loop to stop it with an error text for the agent.
class Refused extends Error {}

// The agent's real cwd equals, or sits below, the real path of one root (a
// path-boundary check: /a/bc is not below /a/b). A root that does not
// resolve is skipped.
async function insideRoots(realCwd: string, roots: string[]): Promise<boolean> {
  for (const r of roots) {
    let real: string;
    try {
      real = await realpath(r);
    } catch {
      continue;
    }
    if (realCwd === real || realCwd.startsWith(real.endsWith("/") ? real : `${real}/`)) return true;
  }
  return false;
}

/**
 * Copy `images` (relative to `cwd`, or absolute) to `destDir/<n>.<ext>`.
 * `roots` are the dirs an agent's cwd may sit in (see insideRoots).
 * `destDir` must not exist yet; it is created (0700, parent with `recursive`)
 * and, on any failure, removed again. Error texts go back to the agent: they
 * name the path as the agent gave it, never a resolved path.
 * `afterCheck` is a test-only seam, called between the realpath check and the
 * open of each file.
 */
export async function acceptMedia(o: {
  roots: string[];
  cwd: string;
  images: string[];
  destDir: string;
  afterCheck?: (abs: string) => Promise<void>;
  // Strong protection: read each file AS the agent (agentclone.ts readAsAgent); the console then
  // opens no path in the agent's folder.
  asAgent?: AsAgent;
}): Promise<MediaResult> {
  const { images, destDir } = o;
  if (!Array.isArray(images) || images.length === 0) return { ok: false, error: "no images" };
  if (images.length > MEDIA_MAX_FILES) return { ok: false, error: `too many images (max ${MEDIA_MAX_FILES})` };
  for (const [i, p] of images.entries()) {
    if (typeof p !== "string" || p === "" || p.includes("\0")) return { ok: false, error: `image ${i + 1}: invalid path` };
  }

  let root = "";
  if (!o.asAgent) {
    let realCwd: string;
    try {
      realCwd = await realpath(o.cwd);
    } catch {
      return { ok: false, error: "agent folder not found" };
    }
    if (!(await insideRoots(realCwd, o.roots))) return { ok: false, error: "agent folder outside the agent roots" };
    root = realCwd.endsWith("/") ? realCwd : `${realCwd}/`;
  }

  let created = false;
  try {
    await mkdir(dirname(destDir), { recursive: true, mode: 0o700 });
    try {
      await mkdir(destDir, { mode: 0o700 });
    } catch (err) {
      // Never mix with, or delete, files this call did not write.
      if (code(err) === "EEXIST") return { ok: false, error: "media folder already exists" };
      throw err;
    }
    created = true;
    const names: string[] = [];
    for (const p of images) {
      const { data, ext } = o.asAgent ? await readImageAsAgent(o.cwd, p, o.asAgent) : await readImage(o.cwd, root, p, o.afterCheck);
      const name = `${names.length + 1}.${ext}`;
      await writeFile(join(destDir, name), data, { mode: 0o600, flag: "wx" });
      names.push(name);
    }
    return { ok: true, names };
  } catch (err) {
    if (created) {
      await rm(destDir, { recursive: true, force: true }).catch((e) => {
        console.warn(`[chief] media cleanup failed for ${basename(destDir)}: ${code(e)}`);
      });
    }
    if (err instanceof Refused) return { ok: false, error: err.message };
    return { ok: false, error: `could not save images (${code(err)})` };
  }
}

// A preview image: PNG, JPEG or WebP by its bytes.
function previewExt(data: Buffer, p: string): PreviewExt {
  const ext = sniffImage(data);
  if (!ext || ext === "gif") throw refusal(p, "not a PNG, JPEG or WebP image");
  return ext;
}

async function readImage(
  cwd: string, root: string, p: string, afterCheck?: (abs: string) => Promise<void>,
): Promise<{ data: Buffer; ext: PreviewExt }> {
  const data = await readInside(cwd, root, p, MEDIA_MAX_BYTES, "5 MB", afterCheck);
  return { data, ext: previewExt(data, p) };
}

// Strong protection: one file read by the agent user through the helper (agentclone.ts). The
// path must lie in the agent's folder by its text; the helper checks its real path against its
// roots, as the agent: a link anywhere in the path leads only where that user may read.
export type AsAgent = (abs: string, maxBytes: number) => Promise<Buffer>;

async function readAsAgentInside(cwd: string, p: string, maxBytes: number, maxText: string, asAgent: AsAgent): Promise<Buffer> {
  const base = resolve(cwd);
  const abs = resolve(base, p);
  if (abs !== base && !abs.startsWith(`${base}/`)) throw refusal(p, "outside the agent folder");
  let data: Buffer;
  try {
    data = await asAgent(abs, maxBytes);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw refusal(p, /larger than/.test(why) ? `larger than ${maxText}` : /not found/.test(why) ? "not found" : "cannot read");
  }
  if (data.length > maxBytes) throw refusal(p, `larger than ${maxText}`);
  return data;
}

async function readImageAsAgent(cwd: string, p: string, asAgent: AsAgent): Promise<{ data: Buffer; ext: PreviewExt }> {
  const data = await readAsAgentInside(cwd, p, MEDIA_MAX_BYTES, "5 MB", asAgent);
  return { data, ext: previewExt(data, p) };
}

const refusal = (p: string, why: string): Refused => {
  const shown = p.length > 200 ? `${p.slice(0, 200)}…` : p; // the agent controls the text
  return new Refused(`${JSON.stringify(shown)}: ${why}`);
};

/**
 * One file of an agent (for the ticket's rich part, rich.ts): the same boundary as an image. `p`
 * is relative to `cwd` or absolute; the file must be a regular file inside the agent's real cwd,
 * of at most `maxBytes`. The error text names the path as the agent gave it.
 */
export async function readAgentFile(o: { roots: string[]; cwd: string; path: string; maxBytes: number; maxText: string; asAgent?: AsAgent }): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
  if (typeof o.path !== "string" || o.path === "" || o.path.includes("\0")) return { ok: false, error: "invalid path" };
  if (o.asAgent) {
    try {
      return { ok: true, data: await readAsAgentInside(o.cwd, o.path, o.maxBytes, o.maxText, o.asAgent) };
    } catch (err) {
      return { ok: false, error: err instanceof Refused ? err.message : "could not read the file" };
    }
  }
  let realCwd: string;
  try {
    realCwd = await realpath(o.cwd);
  } catch {
    return { ok: false, error: "agent folder not found" };
  }
  if (!(await insideRoots(realCwd, o.roots))) return { ok: false, error: "agent folder outside the agent roots" };
  try {
    return { ok: true, data: await readInside(o.cwd, realCwd.endsWith("/") ? realCwd : `${realCwd}/`, o.path, o.maxBytes, o.maxText) };
  } catch (err) {
    return { ok: false, error: err instanceof Refused ? err.message : `could not read the file (${code(err)})` };
  }
}

// The bytes of one file that must sit inside `root` (the agent's real cwd, with a trailing "/").
async function readInside(
  cwd: string, root: string, p: string, maxBytes: number, maxText: string, afterCheck?: (abs: string) => Promise<void>,
): Promise<Buffer> {
  const refuse = (why: string): Refused => refusal(p, why);
  const abs = resolve(cwd, p);

  let real: string;
  try {
    real = await realpath(abs);
  } catch (err) {
    const c = code(err);
    throw refuse(c === "ENOENT" || c === "ENOTDIR" ? "not found" : `cannot read (${c})`);
  }
  if (!real.startsWith(root)) throw refuse("outside the agent folder");

  await afterCheck?.(abs);

  // Open the path as given: O_NOFOLLOW refuses a final-component symlink even
  // when its target is inside the cwd.
  let fh: FileHandle;
  try {
    fh = await open(abs, OPEN_FLAGS);
  } catch (err) {
    const c = code(err);
    throw refuse(c === "ELOOP" ? "is a symlink" : c === "ENOENT" ? "not found" : `cannot read (${c})`);
  }
  try {
    // The kernel's path of the open file. readlink, not realpath: realpath
    // would walk that path again and reopen the swap window it closes.
    let opened: string;
    try {
      opened = await readlink(`/proc/self/fd/${fh.fd}`);
    } catch (err) {
      throw refuse(`cannot read (${code(err)})`);
    }
    if (!opened.startsWith(root)) throw refuse("left the agent folder while opening");

    const st = await fh.stat();
    if (!st.isFile()) throw refuse("not a regular file");
    if (st.nlink > 1) throw refuse("has other hard links");
    if (st.size > maxBytes) throw refuse(`larger than ${maxText}`);
    const data = await readCapped(fh, st.size, maxBytes);
    if (!data) throw refuse("changed while reading"); // grew after the fstat
    return data;
  } finally {
    await fh.close();
  }
}

// The file's size (at most `maxBytes`, checked by the caller) in one
// buffer with a byte to spare; null when the file grew past `size`.
async function readCapped(fh: FileHandle, size: number, maxBytes: number): Promise<Buffer | null> {
  const cap = Math.min(size, maxBytes);
  const buf = Buffer.alloc(cap + 1);
  let n = 0;
  while (n < buf.length) {
    const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
    if (bytesRead === 0) break;
    n += bytesRead;
  }
  return n > cap ? null : buf.subarray(0, n);
}
