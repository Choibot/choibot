// server/gh/appstore.ts — the one file that holds the ChoiBot GitHub app's tokens:
// <the console's data dir>/github-app/token.json, folder 0700 and file 0600, owned by the console
// user. Written to a new file in the same folder (O_EXCL, 0600), then renamed over the old one, so
// a reader sees the old pair or the new pair, never half of one. Read through O_NOFOLLOW, and only
// a regular file of the console user with no right for group or others.
//
// Who can read it:
// - Basic protection: the agents run as the console's own Linux user, so an agent can read this
//   file (and the env of a console child that holds GH_TOKEN). The tokens reach only the repos
//   where the person installed the app.
// - Strong protection: the agents run as another user (choibot-agent). They cannot read this
//   file, and they cannot read /proc/<pid>/environ of the console's children.
// - root can read it (in the test phase of a hosted server, ops has root).
// No token goes into a log, an error text or an argv.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AppTokens } from "./appflow.js";

export type StoredTokens = AppTokens & { clientId: string; savedAt: number };

const FILE = "token.json";
const MAX_BYTES = 16 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_]{16,255}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{4,100}$/;

const uid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

const time = (v: unknown): number | null | undefined =>
  v === null ? null : typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;

// The stored pair in a parsed file, or null when it is not one.
export function parseStored(v: unknown): StoredTokens | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.v !== 1) return null;
  if (typeof o.clientId !== "string" || !CLIENT_ID_RE.test(o.clientId)) return null;
  if (typeof o.accessToken !== "string" || !TOKEN_RE.test(o.accessToken)) return null;
  if (o.refreshToken !== null && (typeof o.refreshToken !== "string" || !TOKEN_RE.test(o.refreshToken))) return null;
  const accessExpiresAt = time(o.accessExpiresAt);
  const refreshExpiresAt = time(o.refreshExpiresAt);
  const savedAt = time(o.savedAt);
  if (accessExpiresAt === undefined || refreshExpiresAt === undefined || !savedAt) return null;
  if ((o.refreshToken === null) !== (refreshExpiresAt === null)) return null;
  return { clientId: o.clientId, accessToken: o.accessToken, accessExpiresAt, refreshToken: o.refreshToken as string | null, refreshExpiresAt, savedAt };
}

export type TokenStore = {
  read(): Promise<StoredTokens | null>;
  write(t: StoredTokens): Promise<void>;
  remove(): Promise<void>;
};

export class TokenFile implements TokenStore {
  constructor(private readonly dir: string, private readonly log: (s: string) => void = (s) => console.warn(s)) {}

  get path(): string { return join(this.dir, FILE); }

  // The folder must be a real folder of the console user. A folder with rights for others is
  // closed to 0700 (it is ours); any other folder is refused.
  private async checkDir(make: boolean): Promise<boolean> {
    if (make) await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let st;
    try { st = await lstat(this.dir); } catch (e) { if (errCode(e) === "ENOENT") return false; throw e; }
    const me = uid();
    if (!st.isDirectory() || (me !== null && st.uid !== me)) {
      this.log("[github] the folder of the GitHub app token is not a folder of this user: it is not used");
      return false;
    }
    if ((st.mode & 0o077) !== 0) await chmod(this.dir, 0o700);
    return true;
  }

  async read(): Promise<StoredTokens | null> {
    if (!(await this.checkDir(false))) return null;
    let fh;
    try {
      fh = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      if (errCode(e) === "ENOENT") return null;
      this.log(`[github] the GitHub app token file cannot be opened (${errCode(e) ?? "error"}): it is not used`);
      return null;
    }
    try {
      const st = await fh.stat();
      const me = uid();
      if (!st.isFile() || (me !== null && st.uid !== me) || (st.mode & 0o077) !== 0 || st.size > MAX_BYTES) {
        this.log("[github] the GitHub app token file is not a 0600 file of this user: it is not used");
        return null;
      }
      let v: unknown;
      try { v = JSON.parse(await fh.readFile("utf8")); } catch { v = null; }
      const t = parseStored(v);
      if (!t) this.log("[github] the GitHub app token file holds no usable token: it is not used");
      return t;
    } finally {
      await fh.close();
    }
  }

  async write(t: StoredTokens): Promise<void> {
    if (!parseStored({ v: 1, ...t })) throw new Error("not a usable token pair");
    if (!(await this.checkDir(true))) throw new Error("the folder of the GitHub app token is not usable");
    const tmp = join(this.dir, `.${FILE}.${process.pid}.${randomBytes(6).toString("hex")}`);
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await fh.writeFile(`${JSON.stringify({ v: 1, ...t })}\n`, "utf8");
      await fh.sync();
    } catch (e) {
      await fh.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw e;
    }
    await fh.close();
    try { await rename(tmp, this.path); } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
  }

  async remove(): Promise<void> {
    try { await unlink(this.path); } catch (e) { if (errCode(e) !== "ENOENT") throw e; }
  }
}
