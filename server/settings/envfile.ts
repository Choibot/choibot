// server/settings/envfile.ts — the one writer of the console's .env from the server (the Telegram
// set-up form of the Settings page). It changes only the keys it is given, from a fixed allow-list,
// and keeps every other line and comment byte for byte.
//
// The write: lstat (a regular file of this user, never a symlink), read, patch, then a temp file
// in the same directory (O_EXCL | O_NOFOLLOW, the old mode), fsync, the same for the one backup
// .env.bak, rename over .env, fsync the directory. One write at a time (a process-wide lock).
// No value goes to a log line or an error text: errors name the file or the step, never a value.
// `choibot setup` (bin/lib/env.ts writeEnvFile) stays the writer a human runs on the box.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SHARE_TOOL_RE } from "../chief/queue/shareTool.js";

// The only keys the server may write.
export const WRITABLE_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ISSUES_USER_ID",
  "TELEGRAM_MASTER_CHAT_ID",
  "TELEGRAM_MASTER_THREAD_ID",
  "TELEGRAM_CRON_CHAT_ID",
  "TELEGRAM_CRON_THREAD_ID",
  // The private places of the Files tab (server/files/browse.ts): absolute paths with ":" between them.
  "FILES_REFUSED_EXTRA",
  // The share tool of "Share outside" (server/settings/share.ts): the absolute path of one program.
  "SHARE_TOOL",
] as const;
export type WritableKey = (typeof WRITABLE_KEYS)[number];

// A key's new value, or null to remove it. A value is one line of safe characters only.
export type EnvChanges = Partial<Record<WritableKey, string | null>>;

const VALUE_RE = /^[A-Za-z0-9:_-]{1,200}$/;
// A key whose value is not a token or an id: its own rule. Still one line of safe characters
// (no space, no quote, no "#", no "$").
const VALUE_RE_OF: Partial<Record<WritableKey, RegExp>> = {
  FILES_REFUSED_EXTRA: /^(?=.{1,4000}$)\/[A-Za-z0-9._\/-]*(:\/[A-Za-z0-9._\/-]*)*$/,
  // One absolute path: letters, digits, ".", "_", "-" and "/", no empty, "." or ".." part, max 500.
  SHARE_TOOL: SHARE_TOOL_RE,
};
const validValue = (k: string, v: string): boolean => (VALUE_RE_OF[k as WritableKey] ?? VALUE_RE).test(v);

export class EnvWriteError extends Error {}

// The active line of `key` (KEY=…, with optional spaces before it). A comment is never one.
const lineKey = (line: string): string | null => {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return m ? m[1] : null;
};

// Pure: the text with `changes` applied. A set key replaces its first active line and drops its
// other active lines; a new key goes at the end; a removed key loses every active line. Every
// other line (comments, blank lines, other keys, the line ends) stays as it was.
export function patchEnvText(text: string, changes: EnvChanges): string {
  for (const [k, v] of Object.entries(changes)) {
    if (!(WRITABLE_KEYS as readonly string[]).includes(k)) throw new EnvWriteError(`not a writable key: ${k}`);
    if (v !== null && v !== undefined && !validValue(k, v)) throw new EnvWriteError(`not a valid value for ${k}`);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // Split keeping each line's own end, so an untouched line comes back byte for byte.
  const parts = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const done = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const key = lineKey(part.replace(/\r?\n$/, ""));
    if (!key || !Object.hasOwn(changes, key)) { out.push(part); continue; }
    const v = changes[key as WritableKey];
    if (v === null || v === undefined || done.has(key)) continue;
    done.add(key);
    out.push(`${key}=${v}${part.endsWith("\n") ? (part.endsWith("\r\n") ? "\r\n" : "\n") : ""}`);
  }
  let result = out.join("");
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined || done.has(k)) continue;
    if (result.length && !result.endsWith("\n")) result += eol;
    result += `${k}=${v}${eol}`;
  }
  return result;
}

// The active value of each writable key in `text` (the last line wins, as systemd reads it).
export function readEnvKeys(text: string): Partial<Record<WritableKey, string>> {
  const out: Partial<Record<WritableKey, string>> = {};
  for (const raw of text.split(/\r?\n/)) {
    const key = lineKey(raw);
    if (key && (WRITABLE_KEYS as readonly string[]).includes(key)) out[key as WritableKey] = raw.slice(raw.indexOf("=") + 1).trim();
  }
  return out;
}

let chain: Promise<unknown> = Promise.resolve();
let pending = 0;

// True from the call until the write ends (the route answers 409 then instead of waiting).
export const envWriteBusy = (): boolean => pending > 0;

type Deps = { uid?: number };

// Writes `data` as a temp file next to the .env with `mode`, then renames it over `target`. The
// temp name starts with ".env.bak": the file routes refuse every ".env*" name of the checkout
// (server/files/refused.ts) and .gitignore keeps ".env.bak*" out of git.
async function replaceFile(envPath: string, target: string, data: string, mode: number): Promise<void> {
  const tmp = join(dirname(envPath), `${basename(envPath)}.bak.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await fh.writeFile(data, "utf8");
    await fh.chmod(mode); // the umask must not loosen it
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  }
  await fh.close();
  try {
    await rename(tmp, target); // rename replaces a symlink itself, never its target
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

async function syncDir(dir: string): Promise<void> {
  const fh = await open(dir, constants.O_RDONLY).catch(() => null);
  if (!fh) return;
  try { await fh.sync(); } catch { /* not every filesystem syncs a directory */ } finally { await fh.close(); }
}

// Applies `changes` to the .env at `path`, with one backup at `path`.bak. Throws EnvWriteError
// with a text that names no value.
export async function writeEnvFile(path: string, changes: EnvChanges, d: Deps = {}): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      let st;
      try { st = await lstat(path); } catch { throw new EnvWriteError(`there is no .env file at ${path}`); }
      if (st.isSymbolicLink()) throw new EnvWriteError(`${path} is a symlink: the console does not write through it`);
      if (!st.isFile()) throw new EnvWriteError(`${path} is not a regular file`);
      const uid = d.uid ?? process.getuid?.() ?? st.uid;
      if (st.uid !== uid) throw new EnvWriteError(`${path} belongs to another user: the console cannot keep its owner`);
      const mode = st.mode & 0o777;
      // O_NOFOLLOW: a symlink swapped in after the lstat is refused, not followed.
      const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new EnvWriteError(`cannot read ${path}`); });
      let text: string;
      try { text = await fh.readFile("utf8"); } finally { await fh.close(); }
      const next = patchEnvText(text, changes);
      try {
        await replaceFile(path, `${path}.bak`, text, mode);
        await replaceFile(path, path, next, mode);
      } catch {
        throw new EnvWriteError(`could not write ${path}: nothing was changed`);
      }
      await syncDir(dirname(path));
    } finally {
      pending--;
    }
  };
  pending++;
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// For the status: the file exists, is a regular file of this user (so a save can work).
export async function envFileWritable(path: string, d: Deps = {}): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return { ok: false, why: "the settings file is a symlink" };
    if (!st.isFile()) return { ok: false, why: "the settings file is not a regular file" };
    if (st.uid !== (d.uid ?? process.getuid?.() ?? st.uid)) return { ok: false, why: "the settings file belongs to another user" };
    return { ok: true };
  } catch {
    return { ok: false, why: "the console has no settings file (.env)" };
  }
}

// Read-only helper for the route's checks: the writable keys of the file now.
export async function readEnvFileKeys(path: string): Promise<Partial<Record<WritableKey, string>>> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readEnvKeys(await fh.readFile("utf8")); } finally { await fh.close(); }
}

// Kept for the tests: the raw text (never sent anywhere).
export const readEnvText = (path: string): Promise<string> => readFile(path, "utf8");

// The console's .env: the unit's EnvironmentFile in the directory the console runs from. A
// CHIEF_TEST=1 instance gives its own file (CHIEF_TEST_ENV_FILE, an absolute path), which it also
// reads at start for the writable keys only, as systemd reads the live one (loadTestEnvFile).
export function envFilePath(env: Record<string, string | undefined>, cwd: string): string {
  const t = env.CHIEF_TEST === "1" ? (env.CHIEF_TEST_ENV_FILE ?? "").trim() : "";
  return t.startsWith("/") ? t : join(cwd, ".env");
}

export async function loadTestEnvFile(env: Record<string, string | undefined>): Promise<void> {
  const t = env.CHIEF_TEST === "1" ? (env.CHIEF_TEST_ENV_FILE ?? "").trim() : "";
  if (!t.startsWith("/")) return;
  const keys = await readEnvFileKeys(t).catch(() => null);
  if (!keys) return;
  for (const k of WRITABLE_KEYS) {
    if (keys[k] !== undefined) env[k] = keys[k];
    else delete env[k];
  }
}
