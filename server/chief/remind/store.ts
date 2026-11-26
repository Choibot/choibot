// server/chief/remind/store.ts — the reminders agents set for themselves, in
// one file, <chief data dir>/reminders.json = {"reminders": [...]}. Every
// write is an atomic tmp + rename under one lock (onChain on the path), so the
// file survives restarts and two writers never interleave. A file that is not
// JSON is never overwritten (every call throws until it is fixed); an entry
// with a broken shape is skipped by readers and kept as it is on writes.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWrite, onChain } from "../files.js";
import { MAX_OPEN_PER_AGENT, newReminderId, REMINDER_ID_RE } from "./schema.js";

// open: waits for dueAt (or, once due, for its agent); delivering: a line is
// out (a paste in progress or a message in a MasterInbox); the other three
// are final.
export type ReminderState = "open" | "delivering" | "delivered" | "cancelled" | "failed";

export type Reminder = {
  id: string;
  /** The agent the line is typed into. */
  agentId: string;
  /** Its label when the reminder was set: names a deleted agent in the master's line. */
  agentLabel: string;
  /** The agent that set it (the target itself, its lead, or the fleet master). */
  setBy: string;
  createdAt: number;
  dueAt: number;
  /** Agent-written, trimmed and redacted: never a user order. */
  text: string;
  state: ReminderState;
  /** Lines sent (each `delivering`). */
  attempts: number;
  updatedAt: number;
  deliveredAt?: number;
  /** The fleet master when the target was deleted. */
  deliveredTo?: string;
  cancelledAt?: number;
  /** "user" or an agent id ("agent-closed" in older files: closing an agent cancelled them then). */
  cancelledBy?: string;
  lastError?: string;
  /** Failed resumes of the target in a row. */
  resumeFailures?: number;
};

export type NewReminder = Pick<Reminder, "agentId" | "agentLabel" | "setBy" | "dueAt" | "text">;
export type AddResult = { ok: true; reminder: Reminder } | { ok: false; error: "too-many" };

// Not yet delivered, cancelled or failed: counts for the limit and the badge.
export const isOpenReminder = (r: Pick<Reminder, "state">): boolean => r.state === "open" || r.state === "delivering";

const STATES = ["open", "delivering", "delivered", "cancelled", "failed"] as const satisfies readonly ReminderState[];
const stored = z.object({
  id: z.string().regex(REMINDER_ID_RE), agentId: z.string(), agentLabel: z.string(), setBy: z.string(),
  createdAt: z.number(), dueAt: z.number(), text: z.string(), state: z.enum(STATES), attempts: z.number(), updatedAt: z.number(),
}).passthrough();

type Opts = { onChange?: () => void; now?: () => number; newId?: () => string; log?: (s: string) => void };
type Split = { valid: Reminder[]; broken: unknown[] };

const NEW_ID_TRIES = 10;

export class ReminderStore {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (s: string) => void;
  private readonly badLogged = new Set<string>();

  constructor(readonly path: string, private readonly opts: Opts = {}) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? newReminderId;
    this.log = opts.log ?? ((s) => console.warn(s));
  }

  // Every readable reminder, by dueAt.
  async list(): Promise<Reminder[]> {
    return (await this.read()).valid.sort((a, b) => a.dueAt - b.dueAt);
  }

  async get(id: string): Promise<Reminder | null> {
    if (!REMINDER_ID_RE.test(id)) return null;
    return (await this.read()).valid.find((r) => r.id === id) ?? null;
  }

  // A new open reminder, unless its agent already has MAX_OPEN_PER_AGENT.
  add(input: NewReminder): Promise<AddResult> {
    return this.locked(async (s): Promise<[Split | null, AddResult]> => {
      if (s.valid.filter((r) => r.agentId === input.agentId && isOpenReminder(r)).length >= MAX_OPEN_PER_AGENT) {
        return [null, { ok: false, error: "too-many" }];
      }
      const taken = new Set(s.valid.map((r) => r.id));
      let id = this.newId();
      for (let i = 1; taken.has(id); i++) {
        if (i >= NEW_ID_TRIES) throw new Error("reminders: no free id");
        id = this.newId();
      }
      const now = this.now();
      const reminder: Reminder = { id, ...input, state: "open", attempts: 0, createdAt: now, updatedAt: now };
      return [{ ...s, valid: [...s.valid, reminder] }, { ok: true, reminder }];
    });
  }

  // fn on one reminder under the lock: its result is written with a new
  // updatedAt; null (or a missing id) writes nothing. Returns what was written.
  update(id: string, fn: (r: Reminder) => Reminder | null): Promise<Reminder | null> {
    return this.locked(async (s): Promise<[Split | null, Reminder | null]> => {
      const i = s.valid.findIndex((r) => r.id === id);
      if (i < 0) return [null, null];
      const next = fn(s.valid[i]);
      if (!next) return [null, null];
      const written = { ...next, updatedAt: this.now() };
      const valid = s.valid.slice();
      valid[i] = written;
      return [{ ...s, valid }, written];
    });
  }

  // fn on the whole list under the lock; null writes nothing. The caller sets
  // updatedAt on the entries it changes.
  async mutateAll(fn: (list: Reminder[]) => Reminder[] | null): Promise<void> {
    await this.locked(async (s): Promise<[Split | null, void]> => {
      const next = fn(s.valid);
      return [next ? { ...s, valid: next } : null, undefined];
    });
  }

  // What each agent's reminders say to the closed-agent purge
  // (agents/closed.ts PurgeDeps.reminderHolds): "open" while one is open or
  // delivering, else the updatedAt of its last final one (a final reminder
  // never changes again). Agents with no reminder are absent.
  async purgeHolds(): Promise<Map<string, "open" | number>> {
    const out = new Map<string, "open" | number>();
    for (const r of await this.list()) {
      const cur = out.get(r.agentId);
      if (cur === "open") continue;
      out.set(r.agentId, isOpenReminder(r) ? "open" : Math.max(cur ?? r.updatedAt, r.updatedAt));
    }
    return out;
  }

  // One read-modify-write under the path's lock; onChange once the file is written.
  private async locked<T>(fn: (s: Split) => Promise<[Split | null, T]>): Promise<T> {
    let changed = false;
    const out = await onChain(this.path, async () => {
      const [next, result] = await fn(await this.read());
      if (next) {
        await atomicWrite(this.path, JSON.stringify({ reminders: [...next.valid, ...next.broken] }, null, 2));
        changed = true;
      }
      return result;
    });
    if (changed) {
      try { this.opts.onChange?.(); } catch (e) { this.log(`reminders: onChange failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return out;
  }

  private async read(): Promise<Split> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { valid: [], broken: [] };
      throw e;
    }
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Error(`${this.path} is not JSON; fix or remove it (reminders are off until then)`); }
    const all = v && typeof v === "object" && Array.isArray((v as { reminders?: unknown }).reminders)
      ? (v as { reminders: unknown[] }).reminders : null;
    if (!all) throw new Error(`${this.path} has no "reminders" array; fix or remove it`);
    const valid: Reminder[] = [];
    const broken: unknown[] = [];
    for (const e of all) {
      if (stored.safeParse(e).success) { valid.push(e as Reminder); continue; }
      broken.push(e);
      const key = JSON.stringify(e).slice(0, 200);
      if (!this.badLogged.has(key)) { this.badLogged.add(key); this.log(`reminders: skipped a broken entry: ${key}`); }
    }
    return { valid, broken };
  }
}
