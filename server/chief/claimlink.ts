// server/chief/claimlink.ts — the claim link: the first device of a console that nobody opens a
// terminal on (a hosted console). It is the second way to the first device; the code of the box
// (firstrun.ts) stays as it is.
//
// Who has what:
//   - The owner's browser makes a secret of 32 random bytes, written as base64url with no padding
//     (43 characters), and keeps it. The control plane and the server get only its SHA-256 (the
//     server in the first-start file). So the user data of the cloud (which any process on the
//     server can read through the metadata address) holds no secret.
//   - The image's first-boot step puts the first-start file into the console's data dir (owner
//     the console's user, mode 0600). The console reads it once, keeps the hash in its own file
//     (claim-link.json, 0600) and removes the first-start file.
//   - The owner opens https://<address>/first-run#k=<secret>. The part after "#" stays in the
//     browser: no server, proxy or door log gets it. The pairing screen sends it in a POST body.
//
// The rules: one use; the claim ends when a device is paired in any way; it ends at its end time
// (the first-start file sets it, default 24 hours); 10 wrong tries end it; the compare is of two
// hashes of equal length, in constant time; no part of the secret or of its hash goes into a log
// line or an answer. The lock (firstrun.ts) refuses a claim with an agent header.
import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { atomicWrite, onChain, readJson } from "./files.js";

// The secret as the owner's browser makes it: 43 characters of base64url (256 bits).
export const CLAIM_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
// Wrong tries one claim takes. The last one ends the claim.
export const CLAIM_TRIES = 10;
// The life of a claim when the first-start file gives no end time, and the longest it may give.
export const CLAIM_LIFE_MS = 24 * 3_600_000;
export const CLAIM_MAX_LIFE_MS = 7 * 24 * 3_600_000;
// A first-start file is small: a larger one is refused unread.
const FIRST_START_MAX_BYTES = 64 * 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SERVER_ID_RE = /^[a-z0-9]{1,40}$/;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

// ------------------------------------------------------------ the first-start file

// Version 1 (one JSON object; keys that it does not name are for later versions and stay unread):
//   {"v":1,"server":"<the id the control plane gives the server>","claim":{"sha256":"<64 lower-case hex>","expiresAt":<epoch ms>}}
// `server` is optional: with it, the console is a hosted one, and the pairing screen sends the
// owner to the dashboard of the service for a new link. `claim.expiresAt` is optional.
export type FirstStart = { server: string | null; sha256: string; expiresAt: number };

// The reason of a refusal names a field, never a value of it.
export function parseFirstStart(text: string, now: number): FirstStart | { refused: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { refused: "not JSON" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { refused: "not an object" };
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return { refused: "v is not 1" };
  if (o.server !== undefined && (typeof o.server !== "string" || !SERVER_ID_RE.test(o.server))) return { refused: "server" };
  const c = o.claim;
  if (!c || typeof c !== "object" || Array.isArray(c)) return { refused: "claim" };
  const { sha256: hash, expiresAt } = c as Record<string, unknown>;
  if (typeof hash !== "string" || !SHA256_HEX_RE.test(hash)) return { refused: "claim.sha256" };
  let end = now + CLAIM_LIFE_MS;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return { refused: "claim.expiresAt" };
    if (expiresAt > now + CLAIM_MAX_LIFE_MS) return { refused: "claim.expiresAt is more than 7 days away" };
    end = expiresAt;
  }
  return { server: typeof o.server === "string" ? o.server : null, sha256: hash, expiresAt: end };
}

// ------------------------------------------------------------------ the claim

// What the console keeps. An ended claim keeps no hash: only why it ended, and whether the
// console is a hosted one (for the words of the pairing screen).
type Open = { sha256: string; expiresAt: number; tries: number; hosted: boolean };
type Ended = { ended: "used" | "expired" | "spent"; hosted: boolean };
type State = Open | Ended;

function asState(raw: unknown): State | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const hosted = r.hosted === true;
  if (r.ended === "used" || r.ended === "expired" || r.ended === "spent") return { ended: r.ended, hosted };
  if (typeof r.sha256 !== "string" || !SHA256_HEX_RE.test(r.sha256)) return null;
  if (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) return null;
  const tries = typeof r.tries === "number" && r.tries >= 0 ? Math.floor(r.tries) : 0;
  return { sha256: r.sha256, expiresAt: r.expiresAt, tries, hosted };
}

const isOpen = (s: State | null): s is Open => s !== null && "sha256" in s;

// none: this console never had a claim link. open: a link works now. ended: the link of this
// console was used, is too old, or took too many wrong tries.
export type LinkState = "none" | "open" | "ended";
export type LinkView = { link: LinkState; hosted: boolean };
// As the code of the box (firstrun.ts ClaimResult): ok (and the claim is gone now), wrong (a try
// is counted), spent (the last wrong try), gone (no claim that works).
export type LinkClaim = "ok" | "wrong" | "spent" | "gone";

export type ClaimLinkFiles = { firstStart: string; state: string };

export class ClaimLinks {
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  // False when the state file surely holds no open claim, so end() costs nothing.
  private open = true;

  constructor(private readonly files: ClaimLinkFiles, o: { now?: () => number; log?: (s: string) => void } = {}) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((s) => console.warn(s));
  }

  // For the lock and the pairing screen, while no device is paired: a first-start file that came
  // in is taken first.
  view(): Promise<LinkView> {
    return onChain(this.files.state, async () => {
      await this.intake();
      const s = await this.current();
      return { link: s === null ? "none" : isOpen(s) ? "open" : "ended", hosted: s?.hosted === true };
    });
  }

  // One claim at a time. The claim ends in the file before the caller gets "ok", so a crash after
  // this point cannot leave a link that works a second time.
  claim(secret: string): Promise<LinkClaim> {
    return onChain(this.files.state, async () => {
      await this.intake();
      const s = await this.current();
      if (!isOpen(s)) return "gone";
      // A text of another shape is a wrong try too, and it is never hashed.
      if (CLAIM_SECRET_RE.test(secret) && timingSafeEqual(Buffer.from(s.sha256, "hex"), sha256(secret))) {
        await this.closeAs(s, "used");
        return "ok";
      }
      if (s.tries + 1 >= CLAIM_TRIES) {
        await this.closeAs(s, "spent");
        this.log("[chief] claim link: too many wrong tries; the link does not work any more");
        return "spent";
      }
      await atomicWrite(this.files.state, JSON.stringify({ ...s, tries: s.tries + 1 }));
      return "wrong";
    });
  }

  // A device is paired (in any way): the claim ends, and a first-start file that waits is removed
  // unread (a new link is only for a console with no paired device).
  mayBeOpen(): boolean { return this.open; }
  end(): Promise<void> {
    return onChain(this.files.state, async () => {
      await rm(this.files.firstStart, { force: true });
      const s = asState(await readJson<unknown>(this.files.state));
      if (isOpen(s)) await this.closeAs(s, "used");
      this.open = false;
    });
  }

  // The claim, with its end time applied.
  private async current(): Promise<State | null> {
    const s = asState(await readJson<unknown>(this.files.state));
    if (isOpen(s) && this.now() >= s.expiresAt) {
      await this.closeAs(s, "expired");
      return { ended: "expired", hosted: s.hosted };
    }
    return s;
  }

  private async closeAs(s: Open, why: Ended["ended"]): Promise<void> {
    await atomicWrite(this.files.state, JSON.stringify({ ended: why, hosted: s.hosted } satisfies Ended));
  }

  // Read the first-start file once, keep its claim (it replaces the one before), remove the file.
  // A refused file is removed too: it cannot work later, and the reason goes to the log.
  private async intake(): Promise<void> {
    let st;
    try { st = await lstat(this.files.firstStart); } catch { return; }
    let text: string | null = null;
    if (st.isFile() && st.size <= FIRST_START_MAX_BYTES) {
      try { text = await readFile(this.files.firstStart, "utf8"); } catch { text = null; }
    }
    await rm(this.files.firstStart, { force: true });
    const now = this.now();
    const r = text === null ? { refused: st.isFile() ? "unreadable or too large" : "not a plain file" } : parseFirstStart(text, now);
    if ("refused" in r) {
      this.log(`[chief] first-start file refused (${r.refused}); it is removed`);
      return;
    }
    const hosted = r.server !== null;
    if (now >= r.expiresAt) {
      await atomicWrite(this.files.state, JSON.stringify({ ended: "expired", hosted } satisfies Ended));
      this.log("[chief] first-start file read: its claim link is too old already");
      return;
    }
    await atomicWrite(this.files.state, JSON.stringify({ sha256: r.sha256, expiresAt: r.expiresAt, tries: 0, hosted } satisfies Open));
    this.open = true;
    this.log(`[chief] first-start file read: a claim link works until ${new Date(r.expiresAt).toISOString()}`);
  }
}
