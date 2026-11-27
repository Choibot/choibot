// server/chief/relaunch.ts — give a live agent or a master the chief env
// identity and the current prompt (spec §5.2). Its session survives restarts
// and the prompt is fixed in the argv at launch, so the only way is the
// switchAccount primitive: kill → waitUntilGone → resume. All of it runs
// under the agent's typing lock and only when no turn is cut and no input is
// lost. It emits no agent-status event and marks no act log: the record is
// idle before and after, so there is nothing to report.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { resumeAgent, waitUntilGone, type RecoveryCtx } from "../agents/recovery.js";
import { hostOf } from "../agents/host.js";
import { pick } from "../agents/runtimes/index.js";
import { isPersistentKind, type AgentRecord, type SessionStore } from "../agents/store.js";
import type { TerminalManager } from "../agents/terminal.js";
import type { EventHub } from "../events.js";
import { withTypingLock } from "../issues/reply.js";
import { FLEET_MASTER_ID } from "../master/paths.js";
import { isAgentId } from "../widgets/paths.js";
import { gateUser, type ChiefGate } from "./gate.js";
import { CHIEF_PROMPT_REV } from "./paths.js";

export const INPUT_QUIET_MS = 5_000, OUTPUT_QUIET_MS = 10_000;

export type ChiefRelaunchCtx = RecoveryCtx & {
  terminals: RecoveryCtx["terminals"] & Pick<TerminalManager, "lastInputAt" | "lastOutputAt">;
  hub: Pick<EventHub, "subscribe">;
  relaunching: Set<string>;
  // Called for every persistent kind; index.ts: inbox.markStarting() for the
  // fleet master (Phase 3 adds leads).
  onRelaunch(rec: AgentRecord): void;
  ensureFleet(): Promise<string>;
  masterHasDraft(): boolean;
  afterRelaunch(id: string): Promise<void>;      // 1a: async () => {}; 2a: Deliverer.retryAgent
  now?: () => number;
  waitGone?: (id: string) => Promise<boolean>;   // seams; defaults are the real functions
  resume?: (rec: AgentRecord) => Promise<unknown>;
  canResume?: (rec: AgentRecord, cwd: string) => Promise<boolean>;
};

export type RelaunchOutcome = "relaunched" | "not-needed" | "cannot-resume" | "retry-on-idle" | "gone" | "failed";

export type RelaunchResult = { outcome: RelaunchOutcome; error?: string };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Recent input (a half-typed line), recent output (a turn still printing,
// e.g. one started while the console was down, so its hooks never said so)
// or an unsent Master-tab draft. These hold the relaunch even with force, and
// the sign-out of a Claude login (agents/api.ts) that would end the agent.
export function busyNow(rec: AgentRecord, ctx: Pick<ChiefRelaunchCtx, "terminals" | "now" | "masterHasDraft">): boolean {
  const now = (ctx.now ?? Date.now)();
  const within = (at: number | undefined, ms: number) => at !== undefined && now - at < ms;
  return within(ctx.terminals.lastInputAt(rec.id), INPUT_QUIET_MS)
    || within(ctx.terminals.lastOutputAt(rec.id), OUTPUT_QUIET_MS)
    || (rec.id === FLEET_MASTER_ID && ctx.masterHasDraft());
}

// A relaunch that cannot resume the conversation would cold-start and lose
// it. Same cwd and check as resumeAgent.
function canResume(rec: AgentRecord, ctx: ChiefRelaunchCtx): Promise<boolean> {
  const cwd = rec.cwd ?? (rec.repo ? rec.worktree : ctx.workspaceDir);
  return ctx.canResume ? ctx.canResume(rec, cwd) : pick(rec).canResume(rec, cwd);
}

// force skips the chiefRev, status and canResume checks, never the input,
// output and draft checks. "retry-on-idle" asks the caller to try again after
// the agent's next idle event or on the retry timer (RelaunchRetry).
export async function relaunchForChief(
  id: string, ctx: ChiefRelaunchCtx, opts: { force?: boolean } = {},
): Promise<RelaunchResult> {
  const force = opts.force === true;
  let killed = false;
  const result = await withTypingLock(id, async (): Promise<RelaunchResult> => {
    // Re-read inside the lock: the record may be gone since the caller listed
    // it, or a concurrent launch may already have given it the current rev.
    const rec = await ctx.store.load(id);
    if (!rec) return { outcome: "gone" };
    if (!force && rec.chiefRev === CHIEF_PROMPT_REV) return { outcome: "not-needed" };
    if (!force && rec.status !== "idle") return { outcome: "retry-on-idle" };
    if (busyNow(rec, ctx)) return { outcome: "retry-on-idle" };
    if (!force && !(await canResume(rec, ctx))) return { outcome: "cannot-resume" };
    // The exit handler and the sweep skip an id in this set, so the kill
    // reads as neither "done" nor "error". Kept until the respawn settles.
    ctx.relaunching.add(id);
    try {
      // Hold the inbox: the new TUI takes no paste before its SessionStart.
      if (isPersistentKind(rec.kind)) ctx.onRelaunch(rec);
      killed = true;
      const t = hostOf(id) ?? ctx.terminals;
      t.kill(id);
      const gone = await (ctx.waitGone ? ctx.waitGone(id) : waitUntilGone(t, id));
      if (!gone) return { outcome: "failed", error: "the running session did not end" };
      // removeAgent takes no typing lock: a delete during the kill must not
      // start a session that has no record.
      if (!(await ctx.store.load(id))) return { outcome: "gone" };
      // The master comes back through the single-flight ensureFleet, so a
      // Telegram revive racing this rides the same run.
      if (rec.id === FLEET_MASTER_ID) await ctx.ensureFleet();
      else await (ctx.resume ? ctx.resume(rec) : resumeAgent(rec, ctx));
      return { outcome: "relaunched" };
    } finally {
      ctx.relaunching.delete(id);
    }
  }).catch((e: unknown): RelaunchResult => ({ outcome: "failed", error: errText(e) }));
  // Never inside the lock: afterRelaunch takes item locks (2a), and an item
  // lock comes before the typing lock (spec §5.4).
  if (killed) {
    void ctx.afterRelaunch(id).catch((e: unknown) => console.warn(`[chief] afterRelaunch ${id} failed:`, errText(e)));
  }
  return result;
}

// End the session of a persistent agent and start it again, with no check that its
// conversation can be resumed: for a session that has none yet, because it sits at a dialog of
// its start (hometrust.ts). Under the agent's typing lock, with its inbox held, as a relaunch.
export function restartSession(id: string, ctx: ChiefRelaunchCtx): Promise<RelaunchResult> {
  return withTypingLock(id, async (): Promise<RelaunchResult> => {
    const rec = await ctx.store.load(id);
    if (!rec) return { outcome: "gone" };
    if (!isPersistentKind(rec.kind)) return { outcome: "not-needed" };
    ctx.relaunching.add(id);
    try {
      ctx.onRelaunch(rec);
      const t = hostOf(id) ?? ctx.terminals;
      t.kill(id);
      const gone = await (ctx.waitGone ? ctx.waitGone(id) : waitUntilGone(t, id));
      if (!gone) return { outcome: "failed", error: "the running session did not end" };
      const cur = await ctx.store.load(id);
      if (!cur) return { outcome: "gone" };
      if (cur.id === FLEET_MASTER_ID) await ctx.ensureFleet();
      else await (ctx.resume ? ctx.resume(cur) : resumeAgent(cur, ctx));
      return { outcome: "relaunched" };
    } finally {
      ctx.relaunching.delete(id);
    }
  }).catch((e: unknown): RelaunchResult => ({ outcome: "failed", error: errText(e) }));
}

export const RETRY_MS = 60_000;
// An idle event comes right after the agent's last output, so a try at once
// always meets the output guard: the idle-event try waits out that window.
export const IDLE_RETRY_MS = OUTPUT_QUIET_MS + 1_000;

type SetTimer = (fn: () => void, ms: number) => { clear(): void };
type RelaunchOpts = { force?: boolean };

const defaultSetTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { clear: () => clearTimeout(t) };
};

// Re-tries the ids whose relaunch answered "retry-on-idle": IDLE_RETRY_MS
// after the agent's latest agent-status idle event (one pending try per id, a
// newer idle event replaces it) and on every RETRY_MS tick, because xterm
// focus and device-attribute replies can trip the input guard with no later
// status event (spec §5.2). Any other outcome disarms the id. A tick tries the
// armed ids one by one, the fleet master first: at boot every try answers
// retry-on-idle (the reattach counts as output), so the first tick is the
// boot relaunch.
export class RelaunchRetry {
  private readonly ids = new Map<string, Required<RelaunchOpts>>();
  private readonly inFlight = new Set<string>();
  private readonly pending = new Map<string, { clear(): void }>();
  private readonly intervalMs: number;
  private readonly setTimer: SetTimer;

  constructor(private readonly d: {
    hub: Pick<EventHub, "subscribe">;
    relaunch: (id: string, o?: RelaunchOpts) => Promise<RelaunchResult>;
    intervalMs?: number;
    setTimer?: SetTimer;
  }) {
    this.intervalMs = d.intervalMs ?? RETRY_MS;
    this.setTimer = d.setTimer ?? defaultSetTimer;
  }

  // The retries use these options. Force is sticky, so a route call with
  // force stays forced when bootRelaunch arms the same id later without it.
  arm(id: string, o: RelaunchOpts = {}): void {
    this.ids.set(id, { force: o.force === true || this.ids.get(id)?.force === true });
  }

  armed(): string[] {
    return [...this.ids.keys()];
  }

  start(): () => void {
    let stopped = false;
    const unsubscribe = this.d.hub.subscribe((e) => {
      if (e.type !== "agent-status" || e.status !== "idle" || !this.ids.has(e.agentId)) return;
      const id = e.agentId;
      this.pending.get(id)?.clear();
      const t = this.setTimer(() => {
        if (this.pending.get(id) !== t) return;
        this.pending.delete(id);
        // retry() skips an id disarmed meanwhile.
        if (!stopped) void this.retry(id);
      }, IDLE_RETRY_MS);
      this.pending.set(id, t);
    });
    let sweeping = false;
    let timer: { clear(): void };
    const sweep = async () => {
      const ids = this.armed();
      for (const id of [...ids.filter((x) => x === FLEET_MASTER_ID), ...ids.filter((x) => x !== FLEET_MASTER_ID)]) {
        if (stopped) return;
        await this.retry(id);
      }
    };
    const schedule = () => {
      timer = this.setTimer(() => {
        if (stopped) return;
        // A run longer than the interval goes on alone: two runs at once
        // would relaunch two ids at once.
        if (!sweeping) {
          sweeping = true;
          void sweep()
            .finally(() => { sweeping = false; })
            .catch((e: unknown) => console.warn("[chief] relaunch retry tick failed:", errText(e)));
        }
        schedule();
      }, this.intervalMs);
    };
    schedule();
    return () => {
      stopped = true;
      unsubscribe();
      timer.clear();
      for (const t of this.pending.values()) t.clear();
      this.pending.clear();
    };
  }

  // An idle event and a timer tick can coincide: a try for an id that is
  // still in flight is dropped, the next trigger comes anyway. Settles (never
  // rejects) when the try is done.
  private retry(id: string): Promise<void> {
    const opts = this.ids.get(id);
    if (!opts || this.inFlight.has(id)) return Promise.resolve();
    this.inFlight.add(id);
    return this.d.relaunch(id, opts)
      .then((r) => {
        if (r.outcome === "failed") console.warn(`[chief] relaunch retry ${id} failed:`, r.error ?? "relaunch failed");
        return r.outcome;
      }, (e: unknown): RelaunchOutcome => {
        console.warn(`[chief] relaunch retry ${id} failed:`, errText(e));
        return "failed";
      })
      .then((outcome) => {
        this.inFlight.delete(id);
        // An arm that came while this try was in flight is kept.
        if (outcome !== "retry-on-idle" && this.ids.get(id) === opts) this.ids.delete(id);
      })
      .catch((e: unknown) => console.warn(`[chief] relaunch retry ${id} failed:`, errText(e)));
  }
}

// The boot relaunch (spec §5.2): of the records reconcileAgents found alive
// (a reattached session), those whose chiefRev is not the current one
// (missing, older, or newer after a rollback), the fleet master first, one by
// one. A dead record was resumed with the env and is not here; a second boot
// finds every record current and relaunches nothing. Returns the ids tried.
export async function bootRelaunch(aliveIds: string[], d: {
  store: Pick<SessionStore, "load">;
  relaunch: (id: string) => Promise<RelaunchResult>;
  retry: Pick<RelaunchRetry, "arm">;
}): Promise<string[]> {
  const stale: string[] = [];
  for (const id of aliveIds) {
    const rec = await d.store.load(id);
    if (rec && rec.chiefRev !== CHIEF_PROMPT_REV) stale.push(id);
  }
  const order = [...stale.filter((id) => id === FLEET_MASTER_ID), ...stale.filter((id) => id !== FLEET_MASTER_ID)];
  for (const id of order) {
    try {
      const r = await d.relaunch(id);
      if (r.outcome === "retry-on-idle") d.retry.arm(id);
      // relaunchForChief does not log: a kill with no resume must leave a line.
      if (r.outcome === "failed") console.warn(`[chief] boot relaunch ${id} failed:`, r.error ?? "relaunch failed");
    } catch (e) {
      console.warn(`[chief] boot relaunch ${id} failed:`, errText(e));
    }
  }
  return order;
}

const relaunchBody = z.object({ force: z.boolean().optional() });

// POST /api/agents/:id/relaunch (spec §5.2, §7), USER only. The id becomes a
// file path in SessionStore.load and Fastify decodes %2F in a param
// (`..%2Fx` arrives as `../x`), so a non-agent id is 404 before any load. A
// retry-on-idle arms the retry with the same force, so a forced call held by
// the input, output or draft guard stays forced on its retries.
export function registerRelaunchRoute(app: FastifyInstance, d: {
  gate: ChiefGate;
  ctx: ChiefRelaunchCtx;
  retry: Pick<RelaunchRetry, "arm">;
}): void {
  app.post("/api/agents/:id/relaunch", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await gateUser(d.gate, req, reply))) return reply;
    const { id } = req.params as { id: string };
    if (!isAgentId(id)) return reply.code(404).send({ error: "not found" });
    const body = relaunchBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid request" });
    const force = body.data.force === true;
    const r = await relaunchForChief(id, d.ctx, { force });
    switch (r.outcome) {
      case "relaunched":
      case "not-needed":
        return reply.code(200).send({ outcome: r.outcome });
      case "retry-on-idle":
        d.retry.arm(id, { force });
        return reply.code(409).send({ retryOnIdle: true });
      case "cannot-resume":
        return reply.code(409).send({ outcome: r.outcome });
      case "gone":
        return reply.code(404).send({ error: "not found" });
      case "failed":
        console.warn(`[chief] relaunch ${id} failed:`, r.error);
        return reply.code(500).send({ error: r.error ?? "relaunch failed" });
    }
  });
}
