// server/chief/auth.ts — user and caller identity for the chief of staff (spec §3.1, §7, §10).
// Device part: paired devices live in user-devices.json as sha256 hashes of
// their tokens; the token itself is never stored.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import type { SessionStore } from "../agents/store.js";
import { isAgentId } from "../ids.js";
import { onChain, readJson, updateJson } from "./files.js";

export type Device = { label: string; sha256: string; createdAt: number; lastUsedAt: number };
export type DeviceView = Omit<Device, "sha256">;
export const DEVICE_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const DEVICE_TOKEN_BYTES = 32;
const DEVICE_FLUSH_MS = 60_000;

type SetTimer = (fn: () => void, ms: number) => { clear(): void };

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

const defaultSetTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { clear: () => clearTimeout(t) };
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Whatever the file holds (torn, hand-edited, not an array), the result is a
// clean device list: entries without a valid label or hash are dropped.
function asDevices(raw: unknown): Device[] {
  if (!Array.isArray(raw)) return [];
  const out: Device[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const { label, sha256: hash, createdAt, lastUsedAt } = e as Record<string, unknown>;
    if (typeof label !== "string" || !DEVICE_LABEL_RE.test(label)) continue;
    if (typeof hash !== "string" || !SHA256_HEX_RE.test(hash)) continue;
    out.push({ label, sha256: hash.toLowerCase(), createdAt: num(createdAt), lastUsedAt: num(lastUsedAt) });
  }
  return out;
}

export class DeviceStore {
  private readonly now: () => number;
  private readonly flushMs: number;
  private readonly setTimer: SetTimer;
  private cache: Device[] = [];
  private cacheKey: string | null = null;
  // lastUsedAt bumps not yet in the file, by label; sha256 pins the device the
  // bump belongs to, so a replaced device never inherits it.
  private used = new Map<string, { sha256: string; at: number }>();
  private timer: { clear(): void } | null = null;

  constructor(private readonly file: string, opts: { now?: () => number; flushMs?: number; setTimer?: SetTimer } = {}) {
    this.now = opts.now ?? Date.now;
    this.flushMs = opts.flushMs ?? DEVICE_FLUSH_MS;
    this.setTimer = opts.setTimer ?? defaultSetTimer;
  }

  async list(): Promise<DeviceView[]> {
    return (await this.load()).map((d) => this.view(d));
  }

  async add(label: string): Promise<string> {
    if (typeof label !== "string" || !DEVICE_LABEL_RE.test(label)) {
      throw new Error(`invalid device label ${JSON.stringify(label)}`);
    }
    // `--user-token <t>` only takes a value that does not start with "-", so never issue one that does.
    let token: string;
    do token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url"); while (token.startsWith("-"));
    const at = this.now();
    const device: Device = { label, sha256: sha256(token).toString("hex"), createdAt: at, lastUsedAt: at };
    this.used.delete(label);
    try {
      await updateJson<unknown>(this.file, [], (cur) => [...asDevices(cur).filter((d) => d.label !== label), device]);
    } finally {
      this.cacheKey = null;
    }
    return token;
  }

  async revoke(label: string): Promise<boolean> {
    let found = false;
    try {
      await updateJson<unknown>(this.file, [], (cur) => {
        const devices = asDevices(cur);
        const next = devices.filter((d) => d.label !== label);
        found = next.length !== devices.length;
        return next;
      });
    } finally {
      this.cacheKey = null;
    }
    this.used.delete(label);
    return found;
  }

  async verify(token: string): Promise<DeviceView | null> {
    if (typeof token !== "string" || token.length === 0) return null;
    const want = sha256(token);
    let match: Device | null = null;
    // Compare against every device, no early exit.
    for (const d of await this.load()) {
      const have = Buffer.from(d.sha256, "hex");
      if (have.length === want.length && timingSafeEqual(have, want) && !match) match = d;
    }
    if (!match) return null;
    this.used.set(match.label, { sha256: match.sha256, at: this.now() });
    this.timer ??= this.setTimer(() => {
      this.timer = null;
      this.flush().catch((e) => console.warn("[chief] device lastUsedAt flush failed:", e));
    }, this.flushMs);
    return this.view(match);
  }

  // Write pending lastUsedAt bumps into the current file content, by label.
  // With nothing pending it still waits for queued writes of the file.
  flush(): Promise<void> {
    this.timer?.clear();
    this.timer = null;
    if (this.used.size === 0) return onChain(this.file, async () => {});
    const batch = this.used;
    this.used = new Map();
    return updateJson<unknown>(this.file, [], (cur) => asDevices(cur).map((d) => {
      const u = batch.get(d.label);
      return u && u.sha256 === d.sha256 && u.at > d.lastUsedAt ? { ...d, lastUsedAt: u.at } : d;
    })).then(
      () => { this.cacheKey = null; },
      (e: unknown) => {
        this.cacheKey = null;
        for (const [label, u] of batch) if (!this.used.has(label)) this.used.set(label, u);
        throw e;
      },
    );
  }

  private view(d: Device): DeviceView {
    const u = this.used.get(d.label);
    const lastUsedAt = u && u.sha256 === d.sha256 ? Math.max(d.lastUsedAt, u.at) : d.lastUsedAt;
    return { label: d.label, createdAt: d.createdAt, lastUsedAt };
  }

  // Re-read the file when it changed (decision 11): a write from outside the
  // console is seen without a restart. Never throws: a missing, torn or
  // hand-broken file reads as no devices.
  private async load(): Promise<Device[]> {
    let key: string;
    try {
      const s = await stat(this.file);
      key = `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    } catch {
      key = "missing";
    }
    if (key === this.cacheKey) return this.cache;
    const devices = key === "missing" ? [] : asDevices(await readJson<unknown>(this.file));
    this.cache = devices;
    this.cacheKey = key;
    return devices;
  }
}

// Pairing part (spec §3.1 steps 1, 2, 5): a code is single-use, lives only in
// memory and expires after PAIR_TTL_MS. Unknown, used and expired codes all
// claim null (decision 10: 410). Only claim consumes a code, never a page load.
export const PAIR_TTL_MS = 600_000;
const PAIR_CODE_BYTES = 16;

export type PendingPair = { label: string; expiresAt: number; tg?: { chatId: number; messageId: number } };

export class PairingCodes {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly onExpire?: (p: PendingPair) => void;
  private readonly pending = new Map<string, { pair: PendingPair; timer: { clear(): void } }>();

  constructor(opts: { ttlMs?: number; now?: () => number; setTimer?: SetTimer; onExpire?: (p: PendingPair) => void } = {}) {
    this.ttlMs = opts.ttlMs ?? PAIR_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? defaultSetTimer;
    this.onExpire = opts.onExpire;
  }

  mint(label: string): { code: string; expiresAt: number } {
    const code = randomBytes(PAIR_CODE_BYTES).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    const timer = this.setTimer(() => this.expire(code), this.ttlMs);
    this.pending.set(code, { pair: { label, expiresAt }, timer });
    return { code, expiresAt };
  }

  // Remember the private message that holds the link, so it can be deleted on
  // claim or at TTL. False = the code is gone (claimed, dropped, expired), so
  // nothing will delete that message: the caller deletes it at once.
  attachMessage(code: string, chatId: number, messageId: number): boolean {
    const e = this.pending.get(code);
    if (!e) return false;
    e.pair.tg = { chatId, messageId };
    return true;
  }

  // Forget a code without onExpire (e.g. the private link could not be sent).
  drop(code: string): void {
    this.take(code);
  }

  claim(code: string): PendingPair | null {
    const e = this.pending.get(code);
    if (!e) return null;
    if (this.now() >= e.pair.expiresAt) {
      this.expire(code);
      return null;
    }
    return this.take(code);
  }

  private take(code: string): PendingPair | null {
    const e = this.pending.get(code);
    if (!e) return null;
    this.pending.delete(code);
    e.timer.clear();
    return e.pair;
  }

  // Runs inside a timer callback: a throw or a rejection from onExpire must not
  // reach the process (server/index.ts exits on uncaughtException).
  private expire(code: string): void {
    const pair = this.take(code);
    if (!pair || !this.onExpire) return;
    const warn = (e: unknown) => console.warn("[chief] pairing onExpire failed:", e);
    try {
      const r: unknown = this.onExpire(pair);
      if (r instanceof Promise) r.catch(warn);
    } catch (e) {
      warn(e);
    }
  }
}

// Caller part (spec §3.1 step 4, §5.2, §7). Every header is a mistake guard,
// never identity (§3). A request that carries an agent header is never USER,
// whatever else it carries; an agent header that does not authenticate gives
// level none, so `x-choibot-agent: cron:<job>` (no record) is none too.
export const USER_HEADER = "x-choibot-user", AGENT_HEADER = "x-choibot-agent", AGENT_TOKEN_HEADER = "x-choibot-agent-token";
// The console's own account (strong protection only): the token of chief/console-token, a file
// that only that account can read (server/chief/consoletoken.ts). Its tools (doctor, the set-up,
// the install agent) send it.
export const CONSOLE_HEADER = "x-choibot";
// `coordinator`: the console's background agent (server/coordinator). Its own level, so every
// check that names master, lead or agent refuses it; only the routes that name it take it.
// `console`: the console's own account, with a short list of routes (server/chief/access.ts);
// never the user: every check that names "user" refuses it.
export type CallerLevel = "user" | "master" | "lead" | "coordinator" | "agent" | "console" | "none";
export type Caller = { level: CallerLevel; agentHeaders: boolean; agentId?: string; kind?: string; device?: string };
export type CallerDeps = {
  devices: Pick<DeviceStore, "verify">;
  agents: Pick<SessionStore, "load">;
  // Strong protection only: the check of the console token. Absent: no request is "console".
  consoleToken?: { verify(token: string): boolean };
};

// The id is checked before any load (plan decision 47). SessionStore also
// refuses a non-agent id, so `../x` cannot load a planted record either way.

export function levelOfKind(kind?: string): "master" | "lead" | "coordinator" | "agent" {
  if (kind === "fleet-master") return "master";
  if (kind === "lead") return "lead";
  if (kind === "coordinator") return "coordinator";
  return "agent";
}

type Headers = Record<string, string | string[] | undefined>;

// A non-string value (repeated header, absent) counts as no value.
const str = (h: Headers, name: string): string | undefined => {
  const v = h[name];
  return typeof v === "string" ? v : undefined;
};

// Hash both sides first: equal-length buffers for timingSafeEqual, and the
// compare leaks neither length.
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

export async function callerOf(headers: Headers, deps: CallerDeps): Promise<Caller> {
  // Key presence, not value: a header sent with an unusable value still marks
  // the request as an agent's.
  const agentHeaders = Object.hasOwn(headers, AGENT_HEADER) || Object.hasOwn(headers, AGENT_TOKEN_HEADER);
  if (!agentHeaders) {
    const token = str(headers, USER_HEADER);
    const device = token ? await deps.devices.verify(token) : null;
    if (device) return { level: "user", agentHeaders: false, device: device.label };
    // The console's own account: only with no user header at all (a user token that does not
    // verify stays "none", so a wrong device token never falls back to this level).
    const own = token === undefined ? str(headers, CONSOLE_HEADER) : undefined;
    if (own && deps.consoleToken?.verify(own) === true) return { level: "console", agentHeaders: false };
    return { level: "none", agentHeaders: false };
  }
  const none: Caller = { level: "none", agentHeaders: true };
  const id = str(headers, AGENT_HEADER);
  const token = str(headers, AGENT_TOKEN_HEADER);
  if (id === undefined || !token || !isAgentId(id)) return none;
  const rec = await deps.agents.load(id);
  if (!rec || rec.id !== id || typeof rec.hookToken !== "string") return none;
  if (!sameSecret(token, rec.hookToken)) return none;
  const level = levelOfKind(rec.kind);
  // The Coordinator is one fixed record: no other record gets its level, whatever its kind says.
  if (level === "coordinator" && rec.id !== "coordinator") return none;
  return { level, agentHeaders: true, agentId: rec.id, kind: rec.kind };
}
