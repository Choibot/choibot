// server/chief/firstrun.ts — the first device of a new install, paired with no Telegram.
//
// A NEW install (server/names.mjs: no trace of the old names on the box) that pairs devices
// "from the box" and has no paired device is LOCKED: it serves the pairing screen and nothing
// else. The key is a code that only the box can make: `setup --auto` prints one at its end,
// and the `pair` command of the CLI prints a new one. The CLI writes the code's hash to a file
// in the console's data dir; no HTTP route makes a code, so a stranger on the network cannot
// get one. After the claim the device is a normal paired device (DeviceStore), and the lock is
// off for as long as one device is paired.
//
// A console that nobody opens a terminal on (a hosted one) has a second key: the claim link of
// its first-start file (claimlink.ts). Both keys open the same lock, and the first device that
// pairs (with either key) ends the claim link.
//
// An install with the old names, a console that pairs through Telegram and a console with the
// Queue off never get any of this: firstRunOn is false, and index.ts registers nothing.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { names } from "../names.mjs";
import { VERSION_ROUTE } from "../release.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DEVICE_LABEL_RE, type Caller, type DeviceStore } from "./auth.js";
import type { ClaimLinks } from "./claimlink.js";
import { atomicWrite, onChain, readJson } from "./files.js";
import { CHIEF_ERR } from "./gate.js";

// ---------------------------------------------------------------- the marker

// A new install: no marker of an install with the old names (names.mjs decides, once per
// process). The owner's console has the old data dir and the old unit, so it is never new.
export const newInstall = (n: { legacy: boolean } = names()): boolean => !n.legacy;

// The first-run rules apply: a new install, the Queue runs, devices pair from the box.
export function firstRunOn(
  core: { active: boolean; userAuth: "telegram" | "log" },
  n: { legacy: boolean } = names(),
): boolean {
  return newInstall(n) && core.active && core.userAuth === "log";
}

// ------------------------------------------------------------- the box code

export const BOX_CODE_TTL_MS = 600_000;
// Wrong tries one code takes. The last one ends the code.
export const BOX_CODE_TRIES = 5;
// 8 characters of 32: 40 bits. With 5 tries a guess hits 1 time in 2^37.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

type Stored = { sha256: string; expiresAt: number; tries: number };

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

// What a person types, as the code was made: no space, no hyphen, upper case, and the letters
// that the alphabet leaves out read as the digits they look like.
export function normalizeCode(typed: string): string {
  return typed.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

function asStored(raw: unknown): Stored | null {
  if (!raw || typeof raw !== "object") return null;
  const { sha256: hash, expiresAt, tries } = raw as Record<string, unknown>;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return { sha256: hash, expiresAt, tries: typeof tries === "number" && tries >= 0 ? Math.floor(tries) : 0 };
}

// A new code, by the CLI on the box. It replaces the code before it. The file holds the hash
// only (0600, the dir 0700); the code itself goes to the caller's terminal and nowhere else.
export async function mintBoxCode(file: string, o: { now?: () => number; ttlMs?: number } = {}): Promise<{ code: string; expiresAt: number }> {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  const expiresAt = (o.now ?? Date.now)() + (o.ttlMs ?? BOX_CODE_TTL_MS);
  const stored: Stored = { sha256: sha256(raw).toString("hex"), expiresAt, tries: 0 };
  await onChain(file, () => atomicWrite(file, JSON.stringify(stored)));
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
}

// ok: the code is right, and it is gone now (one use). wrong: not the code; a try is counted.
// spent: the last wrong try; the code is gone. gone: no code (none made, used, or too old).
export type ClaimResult = "ok" | "wrong" | "spent" | "gone";

export class BoxCodes {
  private readonly now: () => number;
  constructor(private readonly file: string, o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
  }

  // One claim at a time. The code is removed before the caller gets "ok", so a crash after
  // this point cannot leave a code that works a second time.
  claim(typed: string): Promise<ClaimResult> {
    return onChain(this.file, async () => {
      const cur = asStored(await readJson<unknown>(this.file));
      if (!cur) return "gone";
      if (this.now() >= cur.expiresAt) {
        await rm(this.file, { force: true });
        return "gone";
      }
      // Hashes of equal length: the compare leaks neither the code nor its length.
      if (timingSafeEqual(Buffer.from(cur.sha256, "hex"), sha256(normalizeCode(typed)))) {
        await rm(this.file, { force: true });
        return "ok";
      }
      if (cur.tries + 1 >= BOX_CODE_TRIES) {
        await rm(this.file, { force: true });
        return "spent";
      }
      await atomicWrite(this.file, JSON.stringify({ ...cur, tries: cur.tries + 1 }));
      return "wrong";
    });
  }
}

// ------------------------------------------------------------------ the lock

export const FIRST_RUN_ROUTE = "/api/chief/pair/first";
// The page of the pairing screen (src/app/first-run/page.tsx).
export const FIRST_RUN_PAGE = "/first-run";
export const FIRST_RUN_ERR = {
  wrong: "wrong-code", spent: "too-many-tries", gone: "pairing code expired or used", agentHeaders: "agent headers are not allowed",
  wrongLink: "wrong-link", spentLink: "too-many-tries", goneLink: "link expired or used",
} as const;
// The label of the first device when the browser gives none that is valid.
export const FIRST_DEVICE_LABEL = "first-device";

// The hook route of an agent (agents/api.ts): it checks the agent's own secret itself.
const AGENT_HOOK_ROUTE = "/api/agents/:id/hook";
// What the pairing screen loads from the catch-all: the built files of the app and its icons.
const PAGE_ASSET = /^\/(_next\/|favicon\.ico$|icon\.svg$|apple-icon\.png$)/;

export type FirstRunDeps = {
  devices: Pick<DeviceStore, "list" | "add">;
  codes: Pick<BoxCodes, "claim">;
  // The claim link of the first-start file (claimlink.ts).
  links: Pick<ClaimLinks, "view" | "claim" | "end" | "mayBeOpen">;
  // Who calls (the gate's caller check): an agent of this console passes the lock.
  caller: (req: FastifyRequest) => Promise<Caller>;
  // The route pattern of the catch-all that serves the pages of the app (index.ts).
  pageRoute: string;
};

// Register before every route. Returns `locked`, for callers that want the state.
export function registerFirstRun(app: FastifyInstance, d: FirstRunDeps): { locked: () => Promise<boolean> } {
  // Asked on every request, so it must be cheap and never late: DeviceStore keeps the list in
  // memory and reads the file again only when one stat shows that it changed. So a revoke of
  // the last device locks the console at the next request.
  const locked = async (): Promise<boolean> => (await d.devices.list()).length === 0;

  // A device is paired: a claim link that is still open ends (once; then this costs nothing). So
  // a console that is locked again later (its last device revoked) never takes an old link.
  const settle = async (): Promise<boolean> => {
    if (await locked()) return true;
    if (d.links.mayBeOpen()) await d.links.end();
    return false;
  };
  void settle().catch((e: unknown) => console.warn("[chief] claim link check failed:", e instanceof Error ? e.message : String(e)));

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await settle())) return undefined;
    const route = req.routeOptions.url;
    if (route === FIRST_RUN_ROUTE || route === AGENT_HOOK_ROUTE) return undefined;
    // Which version runs (no secret): the updater's check after a start, before any claim.
    if (route === VERSION_ROUTE && (req.method === "GET" || req.method === "HEAD")) return undefined;
    const socket = (req.headers.upgrade ?? "").toLowerCase() === "websocket";
    // An address under /api/ that no route has is refused below, as JSON (both ways are safe).
    if (route === d.pageRoute && !socket && (req.method === "GET" || req.method === "HEAD") && !req.url.startsWith("/api/")) {
      // Every page is the pairing screen. The address in the browser stays as it is, so the
      // console opens there after the pairing.
      if (!PAGE_ASSET.test(req.url)) req.raw.url = FIRST_RUN_PAGE;
      return undefined;
    }
    // The console's own agents (the fleet master starts with the console) keep their routes:
    // the lock is for a browser that nobody paired. A request with agent headers that do not
    // authenticate is refused like any other.
    const level = (await d.caller(req)).level;
    if (level === "master" || level === "lead" || level === "coordinator" || level === "agent") return undefined;
    return reply.code(403).send({ error: CHIEF_ERR.pairRequired, userAuth: "log", locked: true });
  });

  // Any session: is this console locked to the pairing screen? While it is: the state of its
  // claim link (none, open or ended) and whether it is a hosted console, for the words of the
  // screen. Never the hash or the end time.
  app.get(FIRST_RUN_ROUTE, async () => {
    if (!(await settle())) return { locked: false };
    return { locked: true, ...(await d.links.view()) };
  });

  // The claim of the box code, for the first device only. The answers never hold the code.
  app.post(FIRST_RUN_ROUTE, async (req: FastifyRequest, reply: FastifyReply) => {
    // Key presence, as in callerOf: either agent header marks an agent's request, and an
    // agent never pairs itself as the user.
    if (Object.hasOwn(req.headers, AGENT_HEADER) || Object.hasOwn(req.headers, AGENT_TOKEN_HEADER)) {
      return reply.code(403).send({ error: FIRST_RUN_ERR.agentHeaders });
    }
    // Later devices pair as before (today's link from the box).
    if (!(await settle())) return reply.code(404).send({ error: "not found" });
    // `claim`: the secret of the claim link. `code`: the code of the box. Never both.
    const body = (req.body ?? {}) as { code?: unknown; claim?: unknown; label?: unknown };
    const link = body.claim !== undefined;
    let r: ClaimResult;
    if (link) r = typeof body.claim === "string" && body.code === undefined ? await d.links.claim(body.claim) : "wrong";
    else r = typeof body.code === "string" ? await d.codes.claim(body.code) : "gone";
    if (r === "wrong") return reply.code(403).send({ error: link ? FIRST_RUN_ERR.wrongLink : FIRST_RUN_ERR.wrong });
    if (r === "spent") return reply.code(429).send({ error: link ? FIRST_RUN_ERR.spentLink : FIRST_RUN_ERR.spent });
    if (r === "gone") return reply.code(410).send({ error: link ? FIRST_RUN_ERR.goneLink : FIRST_RUN_ERR.gone });
    const label = typeof body.label === "string" && DEVICE_LABEL_RE.test(body.label) ? body.label : FIRST_DEVICE_LABEL;
    const token = await d.devices.add(label);
    // The first device is in: the other key ends too.
    await d.links.end();
    return reply.code(200).send({ token, label });
  });

  return { locked };
}
