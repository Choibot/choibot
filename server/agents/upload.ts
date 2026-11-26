import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { runGit } from "./git.js";
import { openDirBelow, writeNew } from "./nofollow.js";
import { hardenedDeployment } from "../chief/hardened.js";
import { names } from "../names.mjs";
import { cloneFolders, isClone, ownSubfolder } from "./agentclone.js";
import type { AgentRecord } from "./store.js";

export const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Other files go by the extension of their name: the client sends them as
// application/octet-stream with ?ext=. The list is fixed and has no type a
// browser runs (html, svg). The extension only picks an entry of this list:
// the server makes the file name, the client gives no path.
export const FILE_EXTS: ReadonlySet<string> = new Set(["pdf", "txt", "md", "csv", "tsv", "json", "log", "yaml", "yml"]);
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// The extension to save an upload under, or null for a type that is not allowed.
export function uploadExt(contentType: string | undefined, ext: unknown): string | null {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type];
  const named = typeof ext === "string" ? ext.toLowerCase() : "";
  return type === "application/octet-stream" && FILE_EXTS.has(named) ? named : null;
}

export const ALLOWED_TEXT = [...new Set(Object.values(EXT_BY_TYPE)), ...FILE_EXTS].join(", ");

// An image keeps the old name (screenshot-…); another file is file-….
const stem = (ext: string): string => (FILE_EXTS.has(ext) ? "file" : "screenshot");

// The per-repo folder and the hook settings file (.choibot and .choibot-hooks.json on an install
// with the old names). The hook file holds the agent pass when the chief flag is on: never
// committable.
const UPLOAD_DIR = `${names().repoFolder}/uploads`;
const EXCLUDES = [`${names().repoFolder}/`, names().hooksFile];
let counter = 0;

// Make the worktree ignore our upload dir so screenshots never show up in the
// Changes rail / review diff. A linked worktree has no literal .git/info/exclude
// (its real exclude lives under .git/worktrees/<name>/info/), so resolve the
// path via git rather than hard-coding it.
// A non-git dir (the workspace agent runs in the bare workspace root) has no
// Changes rail to keep clean, so there is nothing to exclude — skip it.
// main: the agent's main repo, pinned as the common dir in a hardened
// deployment (ruling 2c-6-d), so info/exclude is the main repo's own.
export async function ensureChoiBotExcluded(worktree: string, main?: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await runGit(worktree, ["-C", worktree, "rev-parse", "--git-path", "info/exclude"], undefined, main));
  } catch { return; }
  const out = stdout.trim();
  const excludePath = isAbsolute(out) ? out : join(worktree, out);
  let cur = "";
  try { cur = await readFile(excludePath, "utf8"); } catch { /* no exclude file yet */ }
  const have = new Set(cur.split("\n").map((l) => l.trim()));
  const missing = EXCLUDES.filter((e) => !have.has(e));
  if (missing.length === 0) return;
  await appendFile(excludePath, (cur === "" || cur.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n");
}

export async function saveUpload(worktree: string, buf: Buffer, ext: string, main?: string): Promise<string> {
  if (hardenedDeployment()) return saveUploadNoFollow(worktree, buf, ext, main);
  await mkdir(join(worktree, UPLOAD_DIR), { recursive: true });
  await ensureChoiBotExcluded(worktree, main);
  const rel = `${UPLOAD_DIR}/${stem(ext)}-${Date.now()}-${counter++}.${ext}`;
  await writeFile(join(worktree, rel), buf);
  return rel;
}

// Hardened (ruling 2c-7-a): the worktree is agent-writable, so .choibot/uploads
// is opened (made when missing) without following a symlink and the file is
// a new one (O_EXCL). Same steps and path as saveUpload otherwise.
async function saveUploadNoFollow(worktree: string, buf: Buffer, ext: string, main?: string): Promise<string> {
  const dir = await openDirBelow(worktree, UPLOAD_DIR.split("/"));
  try {
    await ensureChoiBotExcluded(worktree, main);
    const name = `${stem(ext)}-${Date.now()}-${counter++}.${ext}`;
    await writeNew(dir, name, buf);
    return `${UPLOAD_DIR}/${name}`;
  } finally {
    await dir.close();
  }
}

// Strong protection (design B, agentclone.ts): the upload of an agent with its own clone goes to
// AGENT_HOME_ROOT/uploads/<id>/ (the console's, the agents may read), never into the clone. A new
// file (O_EXCL). Returns its full path.
export async function saveCloneUpload(id: string, buf: Buffer, ext: string): Promise<string> {
  const f = cloneFolders();
  if (!f) throw new Error("no uploads folder");
  const dir = await ownSubfolder(f.uploads, id);
  const path = join(dir, `${stem(ext)}-${Date.now()}-${counter++}.${ext}`);
  await writeFile(path, buf, { flag: "wx", mode: 0o640 });
  return path;
}

// Where a file that the user gives an agent goes, and the path that the agent reads: the
// composer's upload and an image of a ticket answer (chief/queue/answerImages.ts) take this one
// way. Strong protection with a clone: AGENT_HOME_ROOT/uploads/<id>/ (a full path). Else the
// agent's worktree (a lead or a master: its home), .choibot/uploads (a path relative to it).
export type UploadTarget = Pick<AgentRecord, "id" | "worktree" | "repo" | "clone">;
export const NO_UPLOAD_FOLDER = "the agent has no worktree to put the file in";
export const uploadFolderMissing = (rec: UploadTarget): boolean => !isClone(rec) && (!rec.worktree || !existsSync(rec.worktree));
export function saveAgentUpload(rec: UploadTarget, buf: Buffer, ext: string): Promise<string> {
  if (uploadFolderMissing(rec)) return Promise.reject(new Error(NO_UPLOAD_FOLDER));
  return isClone(rec) ? saveCloneUpload(rec.id, buf, ext) : saveUpload(rec.worktree, buf, ext, rec.repo);
}
