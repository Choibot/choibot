// server/update/status.ts — what the console reads of the root updater of a hosted server
// (release-format.md, "the console's side"), and the one thing it writes there: the empty ask file
// of the person's press.
//
// The two paths are CONSTANTS. No setting changes them: the settings file is the console
// account's own, and a path in it would be a path that an attacker with that account chose. The
// one way around them is the test seam of an isolated instance (server/testseams.ts
// CONSOLE_UPDATE_TEST_DIR), and only on a git checkout: on a release or an archive install, so on
// every hosted console, updatePaths() gives these two constants whatever the settings say.
//
// The status file is root's (0644, in root's 0755 folder). The console reads it, at most 64 KiB,
// and refuses an unknown `v` or a field of another type; a field that it does not know is kept
// (the next ones come with a new `v`). It takes NOTHING from it as a path, an address or a
// command, and it never shows root's `why` on a page (only in its log).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { InstallKind } from "../release.js";

export const UPDATE_STATUS_FILE = "/var/lib/choibot-update/status.json";
export const UPDATE_ASK_FILE = "/run/choibot-update/ask";
export const STATUS_MAX = 64 * 1024;

export type UpdatePaths = { status: string; ask: string; test: boolean };

// The paths of this install. `testDir` is the instance seam (server/testseams.ts): honoured on a
// git checkout only. A release or an archive install reads the constants, always.
export function updatePaths(kind: InstallKind, testDir: string | null): UpdatePaths {
  if (kind === "checkout" && testDir !== null) return { status: join(testDir, "status.json"), ask: join(testDir, "ask"), test: true };
  return { status: UPDATE_STATUS_FILE, ask: UPDATE_ASK_FILE, test: false };
}

// The fixed results (choibot-update's status()).
export const UPDATE_RESULTS = [
  "none", "current", "available", "running", "updated", "failed-back", "failed-stuck", "refused", "repaired", "unreachable",
] as const;
export type UpdateResult = (typeof UPDATE_RESULTS)[number];

const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const iso = z.string().regex(ISO);
const version = z.object({ version: z.number().int().min(0).max(1_000_000_000), commit: z.string().regex(SHA).nullable().optional() }).passthrough();

export const statusShape = z.object({
  v: z.literal(1),
  at: iso.nullable().optional(),
  // Which run of root wrote it (release-format.md §10): a press's run is "ask" (or "repair" after
  // a cut one); a daily check's is "check", ops' push is "local". A check never ends a press.
  mode: z.enum(["local", "ask", "check", "repair"]).nullable().optional(),
  checkedAt: iso.nullable().optional(),
  result: z.enum(UPDATE_RESULTS),
  // Letters and "-" only (root writes "rootParts" too); the console maps the word (ticket.ts).
  step: z.string().regex(/^[A-Za-z][A-Za-z-]{0,23}$/).nullable().optional(),
  installed: version.nullable().optional(),
  tried: version.nullable().optional(),
  available: z.object({
    version: z.number().int().min(1).max(1_000_000_000), commit: z.string().regex(SHA), builtAt: iso, security: z.boolean(),
    notes: z.array(z.string()),
  }).passthrough().nullable().optional(),
}).passthrough();
export type UpdateStatus = z.infer<typeof statusShape>;

export type StatusRead = { status: UpdateStatus } | { missing: true } | { problem: string };

// One read of the status file. `rootOnly`: the file must be root's (uid 0) and written by root
// only; off for a test instance, whose files are the test's.
export function readUpdateStatus(path: string, rootOnly: boolean): StatusRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { missing: true } : { problem: `the status file cannot be opened (${code ?? "error"})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { problem: "the status file is not a file" };
    if (rootOnly && (st.uid !== 0 || (st.mode & 0o022) !== 0)) return { problem: "the status file is not root's" };
    if (st.size > STATUS_MAX) return { problem: "the status file is too large" };
    const buf = Buffer.alloc(STATUS_MAX + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > STATUS_MAX) return { problem: "the status file is too large" };
    let raw: unknown;
    try { raw = JSON.parse(buf.subarray(0, n).toString("utf8")); } catch { return { problem: "the status file is not JSON" }; }
    const r = statusShape.safeParse(raw);
    return r.success ? { status: r.data } : { problem: "the status file is not of format 1" };
  } finally {
    closeSync(fd);
  }
}

// The person's press: ONE empty file, made new (O_EXCL, no link followed), mode 0600. It is never
// written to, read or removed by the console: root's unit removes it first and reads nothing from
// it. A file that is there already is the same press ("asked").
export type AskResult = { ok: true; already: boolean } | { ok: false; why: string };
export function makeAsk(path: string): AskResult {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    return { ok: true, already: false };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { ok: true, already: true };
    if (code === "ENOENT") return { ok: false, why: "the updater of this server is not there" };
    if (code === "EACCES" || code === "EPERM") return { ok: false, why: "this console may not ask the updater" };
    return { ok: false, why: `the ask could not be made (${code ?? "error"})` };
  }
}

// The ask is still there: root did not take it yet.
// The folder (0730, root's, the console's group) lets the console stat a name it knows, not list.
export function askPending(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
