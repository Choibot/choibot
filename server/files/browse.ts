// server/files/browse.ts — the file browser of the Server page: every folder and file of the
// server that the console's user can read, from "/" down. READ ONLY: no route here writes,
// renames, removes or uploads.
//   GET  /api/server/files/list?path=     one folder: name, kind, size, changed (the home folder
//                                         when no path is given)
//   GET  /api/server/files/content?path=  one text file (up to 1 MB), else its facts only
//   POST /api/server/files/sizes          measure the folders of one folder (in the background)
//   GET  /api/server/files/private        the private places that the user added
//   POST /api/server/files/private        set that list ({ places }): a place in it is refused
//                                         at once, and the list is kept in the console's .env
//
// WHO: the paired user only (gateUser). An agent, a lead and the fleet master are refused. A
// console with no device pairing has no user to tell from an agent: every route answers 403
// there. The code explorer's routes (./api.ts) are not changed.
//
// The one thing a route here writes is that list of private places, through the one writer of
// the console's .env (settings/envfile.ts, the key FILES_REFUSED_EXTRA).
//
// SECRETS: ./wide.ts by the path, and ./keylike.ts by the content of a text file (a private key
// block, a keypair, a seed phrase, a named token). A refused entry is in the list as a locked row (its name, its kind and the
// reason). Its size, its date, its content and its children are never served.
//
// A PATH comes from the browser, so each route: takes an absolute path of limited length with no
// NUL, resolves it (".." is gone), takes its REAL path (a link is followed), checks the real path
// against the refusal list, opens it, and checks again what was really opened (/proc/self/fd):
// a folder or a file swapped for a link after the first check reaches nothing. Each entry that is
// a link is checked on its real target. Only fs calls touch a request's path: no shell. No file
// content and no path goes to a log.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { gateUser, type ChiefGate } from "../chief/gate.js";
import { systemDu, type Du } from "../health/places.js";
import { EnvWriteError, writeEnvFile } from "../settings/envfile.js";
import { looksLikeKey } from "./keylike.js";
import { WHY, whyRefused, type WhyId, type Wide } from "./wide.js";

export const MAX_PATH = 4096;
export const MAX_ENTRIES = 2000;
export const MAX_BYTES = 1024 * 1024;
// The sizes of the folders of one folder are kept this long, for this many folders.
const SIZES_KEEP_MS = 60 * 60_000;
const SIZES_MAX = 40;

export const MAX_PRIVATE = 50;
// A private place is kept in one line of the .env: these characters only.
const SAFE_PATH = /^\/[A-Za-z0-9._\/-]*$/;

export const NO_PAIRING = { error: "needs-pairing", text: "Pair a device first. The files of your server are shown to a paired device only." };

export type Entry = {
  name: string;
  // "link": a link whose target is not there. "other": a socket, a device, a pipe.
  kind: "dir" | "file" | "link" | "other";
  // The entry is a link (kind is the kind of its target).
  link?: true;
  size?: number;
  mtime?: number;
  // Refused: the reason (./wide.ts WHY). No size and no date then.
  locked?: WhyId;
  // kind "dir": its whole size, when the folders of this folder were measured.
  bytes?: number;
};

export type ListAnswer = {
  path: string;
  parent: string | null;
  home: string;
  items: Entry[];
  // The folder holds more entries than the list shows (`total`).
  truncated: boolean;
  total: number;
  // The sizes of the folders in this folder: not measured, in progress, measured (with its
  // time), or it took too long.
  sizes: { state: "none" | "measuring" | "done" | "slow"; checkedAt?: number };
  why: Record<WhyId, string>;
};

export type ContentAnswer = {
  path: string;
  size: number;
  mtime: number;
  // text: `content` is there. large: over the size limit. binary: not a text. other: not a file.
  kind: "text" | "large" | "binary" | "other";
  content?: string;
  // The folder to open in the code explorer, when the file is in the agents' work folder.
  explorer?: string;
};

type Sizes = { state: "measuring" | "done" | "slow"; checkedAt?: number; bytes: Map<string, number> };

// A request's path, or null: a text that is an absolute path of a sane length with no NUL.
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH || raw.includes("\0") || !isAbsolute(raw)) return null;
  return resolve(raw);
}

const insideOf = (p: string, dir: string): boolean => p === dir || p.startsWith(dir === sep ? sep : dir + sep);

export function registerBrowseApi(app: FastifyInstance, d: {
  // The gate of the chief of staff. Absent: this console has no device pairing, every route answers 403.
  gate?: ChiefGate;
  wide: Wide;
  // The agents' work folder: a file in it can open in the code explorer.
  workDir: string;
  du?: Du;
  now?: () => number;
  // The console's .env: the list of private places is kept in it. Absent: the list cannot change.
  envFile?: string;
}): void {
  const now = d.now ?? Date.now;
  const sizes = new Map<string, Sizes>();
  let measuring = false;

  const user = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!d.gate) { reply.code(403).send(NO_PAIRING); return false; }
    return (await gateUser(d.gate, req, reply)) !== null;
  };

  // The real path of a request's path when it may be served, else null after the answer was sent.
  async function realOr(reply: FastifyReply, raw: unknown): Promise<string | null> {
    const p = cleanPath(raw);
    if (p === null) { reply.code(400).send({ error: "bad-path", text: "This is not a path of a file or folder." }); return null; }
    let real: string;
    try { real = await realpath(p); } catch { reply.code(404).send({ error: "not-found", text: "This file or folder is not there." }); return null; }
    const why = whyRefused(real, d.wide);
    if (why) { reply.code(403).send({ error: "refused", why, text: WHY[why] }); return null; }
    return real;
  }

  // Opens a checked real path and checks what was really opened. Null after the answer was sent.
  async function openChecked(reply: FastifyReply, real: string, flags: number): Promise<{ fh: FileHandle; path: string } | null> {
    let fh: FileHandle;
    try {
      fh = await open(real, flags | constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") reply.code(403).send({ error: "no-access", text: "The user of your server may not open this." });
      else if (code === "ENOTDIR") reply.code(400).send({ error: "not-a-folder", text: "This is not a folder." });
      else reply.code(404).send({ error: "not-found", text: "This file or folder is not there." });
      return null;
    }
    const opened = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
    const why = opened === null || !isAbsolute(opened) ? "system" : whyRefused(opened, d.wide);
    if (why || opened === null) {
      await fh.close().catch(() => {});
      reply.code(403).send({ error: "refused", why, text: WHY[why as WhyId] });
      return null;
    }
    return { fh, path: opened };
  }

  // One entry of an open folder (`at`: the folder's real path; `via`: the open folder itself).
  async function entryOf(at: string, via: string, e: Dirent): Promise<Entry> {
    const lexical = join(at, e.name);
    const own = whyRefused(lexical, d.wide);
    const kindOf = (x: { isDirectory(): boolean; isFile(): boolean }): Entry["kind"] => (x.isDirectory() ? "dir" : x.isFile() ? "file" : "other");
    if (!e.isSymbolicLink()) {
      if (own) return { name: e.name, kind: kindOf(e), locked: own };
      try {
        const st = await lstat(join(via, e.name));
        return { name: e.name, kind: kindOf(st), size: st.isFile() ? st.size : undefined, mtime: Math.round(st.mtimeMs) };
      } catch { return { name: e.name, kind: kindOf(e) }; }
    }
    // A link: its real target decides. A link to a refused place is a locked row too.
    let target: string;
    try { target = await realpath(lexical); } catch { return own ? { name: e.name, kind: "link", link: true, locked: own } : { name: e.name, kind: "link", link: true }; }
    const why = own ?? whyRefused(target, d.wide);
    try {
      const st = await stat(target);
      if (why) return { name: e.name, kind: kindOf(st), link: true, locked: why };
      return { name: e.name, kind: kindOf(st), link: true, size: st.isFile() ? st.size : undefined, mtime: Math.round(st.mtimeMs) };
    } catch { return why ? { name: e.name, kind: "link", link: true, locked: why } : { name: e.name, kind: "link", link: true }; }
  }

  const sizesOf = (path: string): Sizes | undefined => {
    const s = sizes.get(path);
    if (s && s.state !== "measuring" && s.checkedAt !== undefined && now() - s.checkedAt > SIZES_KEEP_MS) { sizes.delete(path); return undefined; }
    return s;
  };

  app.get("/api/server/files/list", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const q = (req.query as { path?: unknown } | undefined)?.path;
    const real = await realOr(reply, q === undefined || q === "" ? d.wide.home : q);
    if (!real) return reply;
    const o = await openChecked(reply, real, constants.O_DIRECTORY);
    if (!o) return reply;
    try {
      const via = `/proc/self/fd/${o.fh.fd}`;
      let all: Dirent[];
      try { all = await readdir(via, { withFileTypes: true }); } catch { return reply.code(403).send({ error: "no-access", text: "The user of your server may not open this folder." }); }
      all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const shown = all.slice(0, MAX_ENTRIES);
      const items: Entry[] = [];
      // In steps: a folder of 2000 entries does not open 2000 files at one time.
      for (let i = 0; i < shown.length; i += 64) items.push(...(await Promise.all(shown.slice(i, i + 64).map((e) => entryOf(o.path, via, e)))));
      const s = sizesOf(o.path);
      if (s) for (const it of items) if (it.kind === "dir" && !it.locked && !it.link && s.bytes.has(it.name)) it.bytes = s.bytes.get(it.name);
      const answer: ListAnswer = {
        path: o.path, parent: o.path === sep ? null : dirname(o.path), home: d.wide.home, items,
        truncated: all.length > shown.length, total: all.length,
        sizes: s ? { state: s.state, ...(s.checkedAt !== undefined ? { checkedAt: s.checkedAt } : {}) } : { state: "none" },
        why: WHY,
      };
      return answer;
    } finally {
      await o.fh.close().catch(() => {});
    }
  });

  app.get("/api/server/files/content", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const real = await realOr(reply, (req.query as { path?: unknown } | undefined)?.path);
    if (!real) return reply;
    const o = await openChecked(reply, real, 0);
    if (!o) return reply;
    try {
      const st = await o.fh.stat();
      const facts = { path: o.path, size: st.size, mtime: Math.round(st.mtimeMs) };
      if (st.isDirectory()) return reply.code(400).send({ error: "is-a-folder", text: "This is a folder." });
      if (!st.isFile()) return { ...facts, kind: "other" } satisfies ContentAnswer;
      const explorer = await explorerRoot(o.path);
      if (st.size > MAX_BYTES) return { ...facts, kind: "large", ...(explorer ? { explorer } : {}) } satisfies ContentAnswer;
      // At most the limit is read, also when the file grows while it is read.
      const buf = Buffer.alloc(Math.min(st.size, MAX_BYTES));
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await o.fh.read(buf, got, buf.length - got, got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      const data = buf.subarray(0, got);
      if (data.includes(0)) return { ...facts, kind: "binary" } satisfies ContentAnswer;
      const text = data.toString("utf8");
      // A key in a file with a plain name: known by its content only (./keylike.ts).
      if (looksLikeKey(text)) return reply.code(403).send({ error: "refused", why: "content", text: WHY.content });
      return { ...facts, kind: "text", content: text, ...(explorer ? { explorer } : {}) } satisfies ContentAnswer;
    } catch {
      return reply.code(404).send({ error: "not-found", text: "This file could not be read." });
    } finally {
      await o.fh.close().catch(() => {});
    }
  });

  // The folder that the code explorer opens for a file of the work folder: the agent's own copy
  // when the file is in one, else the repo (the first folder under the work folder).
  let workReal: Promise<string | null> | null = null;
  async function explorerRoot(file: string): Promise<string | undefined> {
    const work = await (workReal ??= realpath(resolve(d.workDir)).catch(() => null));
    if (!work || !insideOf(file, work) || file === work) return undefined;
    const parts = file.slice(work.length + 1).split(sep);
    if (parts.length < 2) return undefined;
    const at = parts.indexOf(d.wide.worktreeName);
    if (at >= 0 && parts.length > at + 2) return join(work, ...parts.slice(0, at + 2));
    return join(work, parts[0]);
  }

  // Measures the folders of one folder: one `du` at the lowest priority with a time limit
  // (health/places.ts), in the background, one at a time. The answer of the list holds the sizes.
  app.post("/api/server/files/sizes", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const real = await realOr(reply, (req.body as { path?: unknown } | undefined)?.path);
    if (!real) return reply;
    const o = await openChecked(reply, real, constants.O_DIRECTORY);
    if (!o) return reply;
    await o.fh.close().catch(() => {});
    const path = o.path;
    if (measuring) return reply.code(409).send({ error: "busy", text: "Another folder is measured now. Try again in a moment." });
    measuring = true;
    sizes.delete(path);
    sizes.set(path, { state: "measuring", bytes: new Map() });
    while (sizes.size > SIZES_MAX) sizes.delete(sizes.keys().next().value as string);
    void (d.du ?? systemDu())({ path, depth: 1 })
      .then((out) => {
        const bytes = new Map<string, number>();
        // A refused folder gets no size: its row stays a locked row with no detail.
        for (const [p, n] of out ?? []) if (dirname(p) === path && !whyRefused(p, d.wide)) bytes.set(basename(p), n);
        sizes.set(path, { state: out ? "done" : "slow", checkedAt: now(), bytes });
      })
      .catch(() => { sizes.set(path, { state: "slow", checkedAt: now(), bytes: new Map() }); })
      .finally(() => { measuring = false; });
    return reply.code(202).send({ measuring: true });
  });

  // The private places as the user gave them (not the real paths behind a link).
  let places = [...d.wide.extraGiven];

  app.get("/api/server/files/private", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    return { places, canChange: d.envFile !== undefined };
  });

  app.post("/api/server/files/private", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const bad = (text: string) => reply.code(400).send({ error: "bad-place", text });
    const raw = (req.body as { places?: unknown } | undefined)?.places;
    if (!Array.isArray(raw) || raw.length > MAX_PRIVATE) return bad(`Give a list of at most ${MAX_PRIVATE} places.`);
    const next: string[] = [];
    for (const r of raw) {
      const p = cleanPath(r);
      if (p === null) return bad("A private place is the full path of a folder or a file. It starts with \"/\".");
      if (p === sep) return bad("\"/\" cannot be private: it would hide every file of your server.");
      if (!SAFE_PATH.test(p)) return bad("This path has a character that the list cannot keep. A path with letters, digits, \".\", \"_\" and \"-\" can be kept.");
      if (!next.includes(p)) next.push(p);
    }
    if (d.envFile === undefined) return reply.code(409).send({ error: "no-settings-file", text: "The list cannot change on this server: it has no settings file." });
    try {
      await writeEnvFile(d.envFile, { FILES_REFUSED_EXTRA: next.length ? next.join(":") : null });
    } catch (e) {
      // The error names the file or the step, never a value (settings/envfile.ts).
      console.warn(`[server] the private places were not saved: ${e instanceof EnvWriteError ? "the settings file could not be written" : "an error"}`);
      return reply.code(500).send({ error: "not-saved", text: "The list did not change: the settings file of your server could not be written." });
    }
    // At once, with no restart: a place and its real path (when the place is a link).
    places = next;
    const reals = await Promise.all(next.map((p) => realpath(p).catch(() => p)));
    d.wide.extraGiven = next;
    d.wide.extraDirs = [...new Set([...next, ...reals])];
    sizes.clear();
    return { places, canChange: true };
  });
}
