// server/chief/queue/answerImages.ts — the images of a user's answer to a ticket. Each image goes
// up alone (POST /api/queue/:id/answer-image, the paired user only) and waits as a DRAFT in the
// ticket's own media folder: <queue>/media/<id>/d-<16 hex>.<ext>. The type comes from the bytes
// (media.ts sniffImage); the server makes every name; no path comes from the client.
// The answer names its drafts. Under the item lock each one is copied to the agent the way the
// composer's upload goes (agents/upload.ts saveAgentUpload), then renamed a<seq>-<n>.<ext>: the
// ticket keeps it, and it goes with the ticket (store.remove). The other drafts go then too.
// A draft that is never sent goes after a day: at the next upload or answer of its ticket, and at
// the Deliverer's hourly purge.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_UPLOAD_BYTES, saveAgentUpload, uploadFolderMissing, type UploadTarget } from "../../agents/upload.js";
import { sniffImage, type ImageExt } from "./media.js";
import { DRAFT_RE } from "./schema.js";
// The check of the names that an answer gives (no I/O) lives with the answer's other checks.
export { ANSWER_IMAGES_MAX, DRAFT_RE, checkNames } from "./schema.js";
import type { AnswerImage } from "./types.js";

export const DRAFTS_MAX = 12; // for one ticket, until they are sent or a day old
export const DRAFT_MAX_AGE_MS = 86_400_000;
// The names an answer keeps: the only answer names the media route serves.
export const ANSWER_IMAGE_RE = /^a[1-9]\d{0,5}-[1-4]\.(png|jpg|gif|webp)$/;

export type ImagesRefusal = { ok: false; code: 400 | 409 | 413 | 415; error: string };
const refuse = (code: ImagesRefusal["code"], error: string): ImagesRefusal => ({ ok: false, code, error });

const extOf = (name: string): ImageExt => name.slice(name.lastIndexOf(".") + 1) as ImageExt;
const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

async function drafts(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => DRAFT_RE.test(n));
  } catch (e) {
    if (code(e) === "ENOENT") return [];
    throw e;
  }
}

// Removes the drafts of one ticket's folder older than a day (all of them with `all`). Returns
// the drafts that stay.
export async function pruneDrafts(dir: string, now: number, all = false): Promise<string[]> {
  const left: string[] = [];
  for (const n of await drafts(dir)) {
    const st = await stat(join(dir, n)).catch(() => null);
    if (st && !all && now - st.mtimeMs < DRAFT_MAX_AGE_MS) left.push(n);
    else await rm(join(dir, n), { force: true });
  }
  return left;
}

// One uploaded image, as a draft of the ticket whose media folder is `dir`. Call inside the
// item lock (the count of drafts).
export async function saveDraft(dir: string, buf: Buffer, now: number): Promise<{ ok: true; name: string } | ImagesRefusal> {
  if (buf.length === 0) return refuse(400, "the file is empty");
  if (buf.length > MAX_UPLOAD_BYTES) return refuse(413, `too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
  const ext = sniffImage(buf);
  if (!ext) return refuse(415, "not a PNG, JPEG, GIF or WebP image");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await pruneDrafts(dir, now)).length >= DRAFTS_MAX) {
    return refuse(409, `too many images wait for this ticket (max ${DRAFTS_MAX}): send the answer first, or try again tomorrow`);
  }
  const name = `d-${randomBytes(8).toString("hex")}.${ext}`;
  await writeFile(join(dir, name), buf, { mode: 0o600, flag: "wx" });
  return { ok: true, name };
}

// The bytes of one draft: a regular file of the console's own folder (no link), still an image
// of the type its name says.
async function readDraft(dir: string, name: string): Promise<Buffer | null> {
  let fh;
  try {
    fh = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size === 0 || st.size > MAX_UPLOAD_BYTES) return null;
    const buf = await fh.readFile();
    return sniffImage(buf) === extOf(name) ? buf : null;
  } finally {
    await fh.close();
  }
}

export type TakeDeps = { save?: (rec: UploadTarget, buf: Buffer, ext: string) => Promise<string> };

// The answer's images (call inside the item lock, before the answer is written): every draft is
// read first, so a name that is not a draft of THIS ticket touches no file. Then each is copied to
// the agent (`path`: what the agent opens) and kept as a<seq>-<n>.<ext>. The caller removes the
// other drafts once the answer is written, and calls `undo` when that write fails: the drafts are
// back, so the same answer can be sent again.
// A copy that fails after some images were copied leaves those copies in the agent's folder, and
// a send again copies them once more. That is fine: such a copy is never named to the agent (only
// the paths of the answer that is written are), it is the user's own image, and it goes as the
// composer's uploads go (with the worktree; with removeCloneFiles at the agent's delete). The
// console never removes a file by its path in a folder that an agent can write.
export async function takeDrafts(
  dir: string, names: string[], seq: number, rec: UploadTarget | null, d: TakeDeps = {},
): Promise<{ ok: true; images: AnswerImage[]; undo(): Promise<void> } | ImagesRefusal> {
  if (names.length === 0) return { ok: true, images: [], undo: async () => {} };
  const bufs: Buffer[] = [];
  for (const n of names) {
    const buf = await readDraft(dir, n);
    if (!buf) return refuse(409, "an image is not there any more: add it again");
    bufs.push(buf);
  }
  if (!rec || uploadFolderMissing(rec)) return refuse(409, "the agent has no folder to put the images in: send the answer without them");
  const save = d.save ?? saveAgentUpload;
  const paths: string[] = [];
  try {
    for (const [i, buf] of bufs.entries()) paths.push(await save(rec, buf, extOf(names[i]!)));
  } catch (e) {
    return refuse(409, `the images could not be given to the agent (${code(e) ?? "error"})`);
  }
  const images: AnswerImage[] = [];
  const undo = async (): Promise<void> => {
    for (const [i, x] of images.entries()) await rename(join(dir, x.name), join(dir, names[i]!));
  };
  try {
    for (const [i, n] of names.entries()) {
      const name = `a${seq}-${i + 1}.${extOf(n)}`;
      await rename(join(dir, n), join(dir, name));
      images.push({ name, path: paths[i]! });
    }
  } catch (e) {
    await undo().catch(() => {});
    return refuse(409, `the images could not be kept with the ticket (${code(e) ?? "error"})`);
  }
  return { ok: true, images, undo };
}

// True for a name that one of the item's answers (the current one or one in its history) keeps.
export const answerKeeps = (item: { answer?: { images?: AnswerImage[] }; history: { images?: AnswerImage[] }[] }, name: string): boolean =>
  ANSWER_IMAGE_RE.test(name) && [item.answer, ...item.history].some((a) => a?.images?.some((x) => x.name === name));
