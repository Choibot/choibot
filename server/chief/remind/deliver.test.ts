// server/chief/remind/deliver.test.ts — due reminders reach their agent the
// way queue answers do: a worker through ComposerGate.inputInternal (typing
// lock, dedup, readiness) once it is idle and quiet; a persistent kind
// through its MasterInbox; a deleted agent's to the fleet master's inbox.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputResult, InternalOpts } from "../../agents/composer.js";
import type { AgentRecord } from "../../agents/store.js";
import { EventHub } from "../../events.js";
import { InputTracker } from "../../master/draft.js";
import { BUSY_TIMEOUT_MS, InboxError, MasterInbox, type Surface } from "../../master/inbox.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import {
  IDLE_KICK_MS, MAX_OVERDUE_MS, MAX_RESUME_FAILURES, ReminderDeliverer, RETENTION_MS, resumeClosedFor, resumeFor, WORKER_INPUT_QUIET_MS, type ReminderDelivererDeps,
} from "./deliver.js";
import { withTypingLock } from "../../issues/reply.js";
import { ReminderStore, type NewReminder, type Reminder } from "./store.js";
import { SessionStore } from "../../agents/store.js";

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-remind-deliver-"));
  clock = Date.parse("2026-11-13T15:40:00Z");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const CREATED = Date.parse("2026-11-10T15:40:00Z");
const record = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: `label-${id}`, repo: "/r", worktree: "/w", branch: "b", baseBranch: "main",
  sessionId: "s", hookToken: "t", status: "idle", createdAt: 1, ...o,
});
const OK: InputResult = { code: 200, body: { delivered: true } };
type Push = { agentId: string; text: string; surface: Surface | null; opts: { msgId?: string; timeoutMs?: number; since?: number }; resolve: () => void; reject: (e: Error) => void };

function setup(o: {
  records?: AgentRecord[];
  input?: (agentId: string, m: { msgId: string; text: string }, opts: InternalOpts) => Promise<InputResult>;
  live?: Set<string>;
  exists?: (id: string) => boolean;
  resume?: (rec: AgentRecord) => Promise<unknown>;
  // A closed worker's resume with the line as its first turn; the default
  // reopens it (closedAt gone), makes it live and answers true.
  resumeClosed?: (agentId: string, line: string) => Promise<boolean>;
  noInbox?: boolean;
  orphansTo?: string;
  // A real inbox for every persistent agent (the surface test).
  inbox?: Pick<MasterInbox, "pushConsole">;
  io?: { input?: number; output?: number };
} = {}) {
  let ids = 0;
  const store = new ReminderStore(join(root, "reminders.json"), {
    now: () => clock, log: () => {}, newId: () => `r_${String(++ids).padStart(8, "0")}`,
  });
  const records = new Map((o.records ?? [
    record("a1"), record(FLEET_MASTER_ID, { kind: "fleet-master", repo: "" }), record("lead-app", { kind: "lead", area: "app", repo: "" }),
  ]).map((r) => [r.id, r]));
  const live = o.live ?? new Set(["a1", FLEET_MASTER_ID, "lead-app"]);
  const inputs: { agentId: string; msgId: string; text: string; opts: InternalOpts }[] = [];
  const pushes: Push[] = [];
  const resumed: string[] = [];
  // Each resumeClosed call with the reminder states on disk at that moment.
  const closedResumes: { agentId: string; line: string; states: string[] }[] = [];
  const reopened: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const logs: string[] = [];
  const hub = new EventHub();
  const deps: ReminderDelivererDeps = {
    store,
    agents: { load: async (id) => records.get(id) ?? null, exists: async (id) => (o.exists ? o.exists(id) : records.has(id)) },
    composer: {
      inputInternal: async (agentId, m, opts = {}) => {
        if (opts.hold && (await opts.hold())) return { code: 409, body: { reason: "busy" } };
        inputs.push({ agentId, ...m, opts });
        return o.input ? o.input(agentId, m, opts) : OK;
      },
    },
    inboxFor: (agentId) => (o.noInbox ? undefined : o.inbox ?? {
      pushConsole: (text, surface, opts = {}) =>
        new Promise<void>((resolve, reject) => { pushes.push({ agentId, text, surface, opts, resolve, reject }); }),
    }),
    isLive: async (id) => live.has(id),
    ...(o.orphansTo ? { orphansTo: o.orphansTo } : {}),
    resume: async (rec) => {
      resumed.push(rec.id);
      if (o.resume) return o.resume(rec);
      live.add(rec.id);
      return "resumed";
    },
    resumeClosed: async (agentId, line) => {
      closedResumes.push({ agentId, line, states: (await store.list()).map((r) => r.state) });
      if (o.resumeClosed) return o.resumeClosed(agentId, line);
      const cur = records.get(agentId);
      if (cur) records.set(agentId, { ...cur, closedAt: undefined, status: "idle" });
      live.add(agentId);
      return true;
    },
    reopen: async (agentId) => {
      reopened.push(agentId);
      const cur = records.get(agentId);
      if (cur) records.set(agentId, { ...cur, closedAt: undefined });
    },
    io: { lastInputAt: () => o.io?.input, lastOutputAt: () => o.io?.output },
    hub,
    now: () => clock,
    delay: (fn, ms) => { timers.push({ fn, ms }); },
    log: (s) => logs.push(s),
  };
  // Set at CREATED (the line names that date), due just before the clock.
  const add = async (x: Partial<NewReminder> = {}): Promise<Reminder> => {
    const at = clock;
    clock = Math.min(CREATED, at);
    try {
      const r = await store.add({ agentId: "a1", agentLabel: "label-a1", setBy: "a1", dueAt: at - 1, text: "check the canary", ...x });
      if (!r.ok) throw new Error(r.error);
      return r.reminder;
    } finally {
      clock = at;
    }
  };
  return { store, records, live, inputs, pushes, resumed, closedResumes, reopened, timers, logs, hub, add, deliverer: new ReminderDeliverer(deps) };
}

const LINE = "[reminder r_00000001] (set by you on 2026-11-10 15:40 UTC) check the canary";

describe("a worker's reminder", () => {
  it("is typed through inputInternal once due: msgId = its id, noResume (the deliverer resumes a closed agent itself); then delivered", async () => {
    const t = setup();
    clock = CREATED;
    await t.add({ dueAt: CREATED + 3 * 86_400_000 });
    await t.deliverer.tick();
    expect(t.inputs).toEqual([]);
    clock = CREATED + 3 * 86_400_000;
    await t.deliverer.tick();
    expect(t.inputs).toEqual([{ agentId: "a1", msgId: "r_00000001", text: LINE, opts: { noResume: true, hold: expect.any(Function) } }]);
    expect(await t.store.get("r_00000001")).toMatchObject({ state: "delivered", attempts: 1, deliveredAt: clock });
    await t.deliverer.tick();
    expect(t.inputs).toHaveLength(1);
  });

  it("waits while the agent is running, typing or printing; no write, no attempt", async () => {
    for (const o of [{ records: [record("a1", { status: "running" })] }, { io: { input: clock - 1_000 } }, { io: { output: clock - 5_000 } }]) {
      const t = setup(o);
      const r = await t.add();
      await t.deliverer.tick();
      expect(t.inputs).toEqual([]);
      expect(await t.store.get(r.id)).toEqual(r);
    }
  });

  it("goes back to open on 409 starting / busy / not-live and on a throw; failed on 400", async () => {
    const cases: [() => Promise<InputResult>, string][] = [
      [async () => ({ code: 409, body: { reason: "starting" } }), "open"],
      [async () => ({ code: 409, body: { reason: "busy" } }), "open"],
      [async () => ({ code: 409, body: { reason: "not-live" } }), "open"],
      [async () => { throw new Error("pty gone"); }, "open"],
      [async () => ({ code: 400, body: { error: "bad msgId" } }), "failed"],
    ];
    for (const [input, state] of cases) {
      const t = setup({ input });
      await t.add();
      await t.deliverer.tick();
      expect((await t.store.get("r_00000001"))?.state).toBe(state);
    }
  });

  it("a 404 from the gate leaves it open: the next tick sends it to the master", async () => {
    let gone = false;
    const t = setup({ input: async () => { gone = true; return { code: 404, body: { reason: "agent-gone" } }; } });
    await t.add();
    await t.deliverer.tick();
    expect((await t.store.get("r_00000001"))?.state).toBe("open");
    expect(gone).toBe(true);
  });

  it("an ended session (done, not closed) is resumed first, then typed after its SessionStart", async () => {
    const t = setup({ records: [record("a1", { status: "done" }), record(FLEET_MASTER_ID, { kind: "fleet-master" })], live: new Set([FLEET_MASTER_ID]) });
    await t.add();
    await t.deliverer.tick();
    expect(t.resumed).toEqual(["a1"]);
    expect(t.inputs).toEqual([]);
    // Live now, but no SessionStart yet: still held.
    await t.deliverer.tick();
    expect(t.resumed).toEqual(["a1"]);
    expect(t.inputs).toEqual([]);
    t.deliverer.start();
    t.hub.emitEvent({ type: "agent-hook", agentId: "a1", event: "SessionStart", source: "resume" });
    expect(t.timers.map((x) => x.ms)).toEqual([IDLE_KICK_MS]);
    t.timers[0].fn();
    await vi.waitFor(async () => expect((await t.store.get("r_00000001"))?.state).toBe("delivered"));
    expect(t.inputs.map((i) => i.text)).toEqual([LINE]);
    t.deliverer.stop();
  });

  it("the start hold ends after 3 min even with no SessionStart", async () => {
    const t = setup({ live: new Set([FLEET_MASTER_ID]) });
    await t.add();
    await t.deliverer.tick();
    expect(t.resumed).toEqual(["a1"]);
    clock += BUSY_TIMEOUT_MS;
    await t.deliverer.tick();
    expect(t.inputs).toHaveLength(1);
  });

  it(`a resume that keeps failing gives up after ${MAX_RESUME_FAILURES} tries (failed)`, async () => {
    const t = setup({ live: new Set(), resume: async () => { throw new Error("worktree gone"); } });
    await t.add();
    for (let i = 0; i < MAX_RESUME_FAILURES; i++) await t.deliverer.tick();
    expect(await t.store.get("r_00000001")).toMatchObject({ state: "failed", resumeFailures: MAX_RESUME_FAILURES, lastError: "resume failed: worktree gone" });
    await t.deliverer.tick();
    expect(t.resumed).toHaveLength(MAX_RESUME_FAILURES);
  });

  it("a half-written record (load null, file present) waits", async () => {
    const t = setup({ records: [record(FLEET_MASTER_ID, { kind: "fleet-master" })], exists: () => true });
    const r = await t.add();
    await t.deliverer.tick();
    expect(t.inputs).toEqual([]);
    expect(t.pushes).toEqual([]);
    expect(await t.store.get(r.id)).toEqual(r);
  });

  it("an idle event kicks the agent's due reminders after the output window", async () => {
    const t = setup({ records: [record("a1", { status: "running" }), record(FLEET_MASTER_ID, { kind: "fleet-master" })] });
    await t.add();
    t.deliverer.start();
    await t.deliverer.tick();
    expect(t.inputs).toEqual([]);
    t.records.set("a1", record("a1", { status: "idle" }));
    t.hub.emitEvent({ type: "agent-status", agentId: "a1", status: "idle" });
    t.hub.emitEvent({ type: "agent-status", agentId: "a1", status: "idle" });
    expect(t.timers.map((x) => x.ms)).toEqual([IDLE_KICK_MS]);
    t.timers[0].fn();
    await vi.waitFor(() => expect(t.inputs).toHaveLength(1));
    t.deliverer.stop();
  });
});

describe("review fixes", () => {
  it("a resume that resolves but never reaches SessionStart counts as failed: 20 ticks, at most MAX resumes, then failed", async () => {
    const t = setup({ live: new Set([FLEET_MASTER_ID]), resume: async () => "resumed" });
    await t.add();
    for (let i = 0; i < 20; i++) {
      clock += 60_000;
      await t.deliverer.tick();
    }
    expect(t.resumed.length).toBeLessThanOrEqual(MAX_RESUME_FAILURES);
    expect(t.resumed.length).toBeGreaterThan(0);
    expect(await t.store.get("r_00000001")).toMatchObject({ state: "failed", lastError: expect.stringMatching(/SessionStart/) });
    expect(t.inputs).toEqual([]);
  });

  it("a SessionStart of the resumed agent resets its failure count", async () => {
    const t = setup({ live: new Set([FLEET_MASTER_ID]), resume: async () => "resumed" });
    await t.add();
    t.deliverer.start();
    await t.deliverer.tick();
    clock += 60_000;
    await t.deliverer.tick();
    expect((await t.store.get("r_00000001"))?.resumeFailures).toBe(1);
    t.hub.emitEvent({ type: "agent-hook", agentId: "a1", event: "SessionStart", source: "resume" });
    await vi.waitFor(async () => expect((await t.store.get("r_00000001"))?.resumeFailures).toBeUndefined());
    expect((await t.store.get("r_00000001"))?.state).toBe("open");
    t.deliverer.stop();
  });

  it(`an ended session is not resumed for a reminder overdue by more than ${MAX_OVERDUE_MS / 3_600_000} h: failed`, async () => {
    const t = setup({ live: new Set([FLEET_MASTER_ID]) });
    await t.add({ dueAt: clock - MAX_OVERDUE_MS - 1 });
    await t.deliverer.tick();
    expect(t.resumed).toEqual([]);
    expect(await t.store.get("r_00000001")).toMatchObject({ state: "failed", lastError: expect.stringMatching(/24 h/) });
  });

  it("a live agent still gets a reminder overdue by more than 24 h", async () => {
    const t = setup();
    await t.add({ dueAt: clock - MAX_OVERDUE_MS - 1 });
    await t.deliverer.tick();
    expect(t.inputs).toHaveLength(1);
  });

  it(`a worker gets its line only after ${WORKER_INPUT_QUIET_MS / 1000} s with no input (workers have no draft tracker)`, async () => {
    expect(WORKER_INPUT_QUIET_MS).toBe(60_000);
    const io = { input: clock - 30_000 };
    const t = setup({ io });
    await t.add();
    await t.deliverer.tick();
    expect(t.inputs).toEqual([]);
    io.input = clock - 61_000;
    await t.deliverer.tick();
    expect(t.inputs).toHaveLength(1);
  });

  it("a reminder to the fleet master keeps the inbox surface (telegram stays telegram)", async () => {
    const sent: string[] = [];
    const inbox = new MasterInbox({
      hub: new EventHub(), tracker: new InputTracker(), events: { size: () => 0, digest: () => null, clear: () => {} },
      send: async (text) => { sent.push(text); return true; },
    });
    inbox.start("idle", { tickMs: 0 });
    inbox.surface = "telegram";
    const t = setup({ inbox });
    await t.add({ agentId: FLEET_MASTER_ID, setBy: FLEET_MASTER_ID });
    await t.deliverer.tick();
    expect(inbox.surface).toBe("telegram");
    await inbox.tick();
    await vi.waitFor(async () => expect((await t.store.get("r_00000001"))?.state).toBe("delivered"));
    expect(sent).toEqual([LINE]);
    expect(inbox.surface).toBe("telegram");
    inbox.stop();
  });
});

describe("a closed worker's reminder (closing keeps reminders)", () => {
  const closedA1 = () => [record("a1", { closedAt: 5, status: "done" }), record(FLEET_MASTER_ID, { kind: "fleet-master" })];

  it("reopens it and resumes the same session with the exact line as its first turn; delivered after, never pasted", async () => {
    const t = setup({ records: closedA1(), live: new Set([FLEET_MASTER_ID]) });
    clock = CREATED;
    await t.add({ dueAt: CREATED + 3 * 86_400_000 });
    await t.deliverer.tick();
    expect(t.closedResumes).toEqual([]);
    clock = CREATED + 3 * 86_400_000;
    await t.deliverer.tick();
    // `delivering` is on disk before the line goes out (at least once).
    expect(t.closedResumes).toEqual([{ agentId: "a1", line: LINE, states: ["delivering"] }]);
    expect(await t.store.get("r_00000001")).toMatchObject({ state: "delivered", attempts: 1, deliveredAt: clock });
    expect(t.inputs).toEqual([]);
    expect(t.resumed).toEqual([]);
    // The usual path never types it again, on a tick or on the resumed session's SessionStart.
    t.deliverer.start();
    t.hub.emitEvent({ type: "agent-hook", agentId: "a1", event: "SessionStart", source: "resume" });
    for (const k of t.timers) k.fn();
    await t.deliverer.tick();
    await new Promise((r) => setImmediate(r));
    expect(t.inputs).toEqual([]);
    expect(t.closedResumes).toHaveLength(1);
    t.deliverer.stop();
  });

  it("a closed agent whose session is still up is reopened, then typed the usual way (once)", async () => {
    const t = setup({ records: closedA1() });
    await t.add();
    await t.deliverer.tick();
    expect(t.reopened).toEqual(["a1"]);
    expect(t.closedResumes).toEqual([]);
    expect(t.inputs.map((i) => [i.text, i.opts.noResume])).toEqual([[LINE, true]]);
    expect((await t.store.get("r_00000001"))?.state).toBe("delivered");
    await t.deliverer.tick();
    expect(t.inputs).toHaveLength(1);
  });

  it(`a resume that throws counts toward ${MAX_RESUME_FAILURES} failures in a row (open in between), then failed`, async () => {
    const t = setup({ records: closedA1(), live: new Set([FLEET_MASTER_ID]), resumeClosed: async () => { throw new Error("worktree gone"); } });
    await t.add();
    await t.deliverer.tick();
    expect(await t.store.get("r_00000001")).toMatchObject({ state: "open", resumeFailures: 1, lastError: "resume failed: worktree gone" });
    for (let i = 1; i < MAX_RESUME_FAILURES; i++) await t.deliverer.tick();
    expect(await t.store.get("r_00000001")).toMatchObject({ state: "failed", resumeFailures: MAX_RESUME_FAILURES, lastError: "resume failed: worktree gone" });
    await t.deliverer.tick();
    expect(t.closedResumes).toHaveLength(MAX_RESUME_FAILURES);
    expect(t.inputs).toEqual([]);
  });

  it("a resume that did not send the line (reopened or live again meanwhile) puts it back to open for the usual path", async () => {
    const t = setup({ records: closedA1(), live: new Set([FLEET_MASTER_ID]), resumeClosed: async () => false });
    await t.add();
    await t.deliverer.tick();
    expect(await t.store.get("r_00000001")).toMatchObject({ state: "open", lastError: expect.any(String) });
    expect((await t.store.get("r_00000001"))?.resumeFailures).toBeUndefined();
    expect(t.inputs).toEqual([]);
  });

  it(`a reminder overdue by more than ${MAX_OVERDUE_MS / 3_600_000} h still reopens a closed agent (once: it is open after)`, async () => {
    const t = setup({ records: closedA1(), live: new Set([FLEET_MASTER_ID]) });
    await t.add({ dueAt: clock - MAX_OVERDUE_MS - 1 });
    await t.deliverer.tick();
    expect(t.closedResumes.map((c) => c.agentId)).toEqual(["a1"]);
    expect((await t.store.get("r_00000001"))?.state).toBe("delivered");
  });

  it("a second due reminder of the agent waits for the resumed session's SessionStart, then is pasted; one resume only", async () => {
    const t = setup({ records: closedA1(), live: new Set([FLEET_MASTER_ID]) });
    await t.add();
    await t.add({ text: "second" });
    await t.deliverer.tick();
    expect(t.closedResumes.map((c) => c.line)).toEqual([LINE]);
    expect(t.inputs).toEqual([]);
    expect((await t.store.get("r_00000002"))?.state).toBe("open");
    t.deliverer.start();
    t.hub.emitEvent({ type: "agent-hook", agentId: "a1", event: "SessionStart", source: "resume" });
    expect(t.timers.map((x) => x.ms)).toEqual([IDLE_KICK_MS]);
    t.timers[0].fn();
    await vi.waitFor(async () => expect((await t.store.get("r_00000002"))?.state).toBe("delivered"));
    expect(t.inputs.map((i) => i.msgId)).toEqual(["r_00000002"]);
    expect(t.closedResumes).toHaveLength(1);
    expect(t.resumed).toEqual([]);
    t.deliverer.stop();
  });
});

describe("a persistent agent's reminder", () => {
  it("goes to the fleet master's inbox (surface-neutral, its id as msgId, the busy timeout); delivered on resolve", async () => {
    const t = setup();
    await t.add({ agentId: FLEET_MASTER_ID, setBy: FLEET_MASTER_ID, agentLabel: "Fleet master" });
    await t.deliverer.tick();
    expect(t.inputs).toEqual([]);
    expect(t.pushes).toHaveLength(1);
    expect(t.pushes[0]).toMatchObject({ agentId: FLEET_MASTER_ID, text: LINE, surface: null, opts: { msgId: "r_00000001", timeoutMs: BUSY_TIMEOUT_MS, since: clock - 1 } });
    expect((await t.store.get("r_00000001"))?.state).toBe("delivering");
    // Delivering: the next tick does not push it again.
    await t.deliverer.tick();
    expect(t.pushes).toHaveLength(1);
    t.pushes[0].resolve();
    await vi.waitFor(async () => expect(await t.store.get("r_00000001")).toMatchObject({ state: "delivered", deliveredAt: clock }));
  });

  it("a timeout (the master stayed busy) puts it back to open for the next tick", async () => {
    const t = setup();
    await t.add({ agentId: "lead-app", setBy: "lead-app" });
    await t.deliverer.tick();
    expect(t.pushes[0].agentId).toBe("lead-app");
    t.pushes[0].reject(new InboxError("timeout"));
    await vi.waitFor(async () => expect((await t.store.get("r_00000001"))?.state).toBe("open"));
    await t.deliverer.tick();
    expect(t.pushes).toHaveLength(2);
  });

  it("a lead whose session ended is resumed first (its inbox holds until SessionStart)", async () => {
    const t = setup({ live: new Set([FLEET_MASTER_ID]) });
    await t.add({ agentId: "lead-app", setBy: "lead-app" });
    await t.deliverer.tick();
    expect(t.resumed).toEqual(["lead-app"]);
    expect(t.pushes.map((p) => p.agentId)).toEqual(["lead-app"]);
  });

  it("no inbox yet (a lead runtime not started): waits", async () => {
    const t = setup({ noInbox: true });
    const r = await t.add({ agentId: "lead-app" });
    await t.deliverer.tick();
    expect(await t.store.get(r.id)).toEqual(r);
  });
});

describe("a deleted agent's reminder", () => {
  it("lands in the fleet master's inbox, prefixed with the deleted agent's id and label", async () => {
    const t = setup({ records: [record(FLEET_MASTER_ID, { kind: "fleet-master" })] });
    await t.add();
    await t.deliverer.tick();
    expect(t.inputs).toEqual([]);
    expect(t.pushes.map((p) => [p.agentId, p.text])).toEqual([[FLEET_MASTER_ID,
      '[reminder r_00000001] (for deleted agent a1 "label-a1"; set by a1 on 2026-11-10 15:40 UTC) check the canary']]);
    t.pushes[0].resolve();
    await vi.waitFor(async () => expect(await t.store.get("r_00000001")).toMatchObject({ state: "delivered", deliveredTo: FLEET_MASTER_ID }));
  });

  it("with no fleet master it waits (lastError no-master) and goes once a master exists", async () => {
    const t = setup({ records: [] });
    await t.add();
    await t.deliverer.tick();
    expect(t.pushes).toEqual([]);
    expect(await t.store.get("r_00000001")).toMatchObject({ state: "open", lastError: "no-master" });
    t.records.set(FLEET_MASTER_ID, record(FLEET_MASTER_ID, { kind: "fleet-master" }));
    await t.deliverer.tick();
    expect(t.pushes).toHaveLength(1);
  });
});

describe("a deleted agent's reminder with a Coordinator", () => {
  const coordinator = record("coordinator", { kind: "coordinator", repo: "" });
  it("goes to the Coordinator, never to the fleet master's chat", async () => {
    const t = setup({ records: [record(FLEET_MASTER_ID, { kind: "fleet-master" }), coordinator], orphansTo: "coordinator", live: new Set([FLEET_MASTER_ID, "coordinator"]) });
    await t.add();
    await t.deliverer.tick();
    expect(t.pushes.map((p) => [p.agentId, p.text])).toEqual([["coordinator",
      '[reminder r_00000001] (for deleted agent a1 "label-a1"; set by a1 on 2026-11-10 15:40 UTC) check the canary']]);
  });

  it("waits while the Coordinator has no record, and starts a Coordinator that is down", async () => {
    const t = setup({ records: [record(FLEET_MASTER_ID, { kind: "fleet-master" })], orphansTo: "coordinator", live: new Set([FLEET_MASTER_ID]) });
    await t.add();
    await t.deliverer.tick();
    expect(t.pushes).toEqual([]);
    expect(await t.store.get("r_00000001")).toMatchObject({ state: "open", lastError: "no-coordinator" });
    t.records.set("coordinator", coordinator);
    await t.deliverer.tick();
    expect(t.resumed).toEqual(["coordinator"]);
  });
});

describe("boot and retention", () => {
  it("bootScan sends a reminder a restart left delivering again, never a delivered one", async () => {
    const t = setup();
    const a = await t.add();
    const b = await t.add({ text: "second" });
    await t.store.update(a.id, (r) => ({ ...r, state: "delivering", attempts: 1 }));
    await t.store.update(b.id, (r) => ({ ...r, state: "delivered" }));
    await t.deliverer.bootScan();
    expect(t.inputs.map((i) => i.msgId)).toEqual([a.id]);
    expect(await t.store.get(a.id)).toMatchObject({ state: "delivered", attempts: 2 });
  });

  it("drops final reminders 30 days after their last change, once an hour", async () => {
    const t = setup();
    const a = await t.add({ dueAt: clock + 3_600_000 });
    const b = await t.add({ dueAt: clock + 3_600_000 });
    await t.store.update(b.id, (r) => ({ ...r, state: "cancelled" }));
    clock += RETENTION_MS + 1;
    await t.store.update(a.id, (r) => ({ ...r, dueAt: clock + 3_600_000 }));
    await t.deliverer.tick();
    expect((await t.store.list()).map((r) => r.id)).toEqual([a.id]);
  });

  it("start runs a tick on its timer and stop ends it", async () => {
    const t = setup();
    const stop = t.deliverer.start();
    expect(typeof stop).toBe("function");
    stop();
    t.hub.emitEvent({ type: "agent-status", agentId: "a1", status: "idle" });
    expect(t.timers).toEqual([]);
  });
});

describe("resumeFor (index.ts's resume dep)", () => {
  const deps = (o: { live?: boolean; recs?: AgentRecord[] } = {}) => {
    const calls: string[] = [];
    const recs = new Map((o.recs ?? [record("a1", { status: "done" })]).map((r) => [r.id, r]));
    const resume = resumeFor({
      agents: { load: async (id) => recs.get(id) ?? null },
      isLive: async () => o.live ?? false,
      ensureFleet: async () => { calls.push("ensureFleet"); },
      ensureLead: async (area) => { calls.push(`ensureLead ${area}`); },
      resumeAgent: async (rec) => { calls.push(`resumeAgent ${rec.id} ${rec.status}`); return "resumed"; },
    });
    return { calls, resume };
  };

  it("the Coordinator through its own start", async () => {
    const calls: string[] = [];
    const resume = resumeFor({
      agents: { load: async () => null }, isLive: async () => false,
      ensureFleet: async () => { calls.push("ensureFleet"); }, ensureLead: async () => { calls.push("ensureLead"); },
      ensureCoordinator: async () => { calls.push("ensureCoordinator"); },
      resumeAgent: async () => { calls.push("resumeAgent"); },
    });
    await resume(record("coordinator", { kind: "coordinator" }));
    expect(calls).toEqual(["ensureCoordinator"]);
  });

  it("the fleet master through ensureFleet, a lead through ensureLead(area)", async () => {
    const t = deps();
    await t.resume(record(FLEET_MASTER_ID, { kind: "fleet-master" }));
    await t.resume(record("lead-app", { kind: "lead", area: "app" }));
    expect(t.calls).toEqual(["ensureFleet", "ensureLead app"]);
    await expect(t.resume(record("lead-x", { kind: "lead" }))).rejects.toThrow(/area/);
  });

  it("a worker: resumeAgent on the record re-read under its typing lock", async () => {
    const t = deps();
    let release!: () => void;
    const held = withTypingLock("a1", () => new Promise<void>((r) => { release = r; }));
    const p = t.resume(record("a1"));
    await new Promise((r) => setImmediate(r));
    expect(t.calls).toEqual([]);
    release();
    await held;
    await p;
    expect(t.calls).toEqual(["resumeAgent a1 done"]);
  });

  it("leaves a live, closed or deleted worker alone", async () => {
    const live = deps({ live: true });
    await live.resume(record("a1"));
    const closed = deps({ recs: [record("a1", { closedAt: 5 })] });
    await closed.resume(record("a1"));
    const gone = deps({ recs: [] });
    await gone.resume(record("a1"));
    expect([...live.calls, ...closed.calls, ...gone.calls]).toEqual([]);
  });
});

describe("resumeClosedFor (index.ts's resumeClosed dep)", () => {
  const deps = async (o: { live?: boolean; outcome?: "resumed" | "cold" | "alive"; rec?: Partial<AgentRecord> } = {}) => {
    const store = new SessionStore(mkdtempSync(join(root, "agents-")));
    await store.save(record("a1", { closedAt: 5, status: "done", sessionId: "sess-a1", ...o.rec }));
    const calls: { id: string; sessionId: string | null; prompt?: string }[] = [];
    const events: unknown[] = [];
    const resumeClosed = resumeClosedFor({
      store, emit: (e) => events.push(e), isLive: async () => o.live ?? false,
      resume: async (rec, opts) => { calls.push({ id: rec.id, sessionId: rec.sessionId, prompt: opts.prompt }); return o.outcome ?? "resumed"; },
    });
    return { store, calls, events, resumeClosed };
  };

  it("resumes the same session with the line as its first turn, reopens the agent (agent-reopened) and answers true", async () => {
    const t = await deps();
    expect(await t.resumeClosed("a1", LINE)).toBe(true);
    expect(t.calls).toEqual([{ id: "a1", sessionId: "sess-a1", prompt: LINE }]);
    expect((await t.store.load("a1"))?.closedAt).toBeUndefined();
    expect(t.events).toContainEqual({ type: "agent-reopened", agentId: "a1" });
  });

  it("a cold start (transcript gone) also took the line as its first turn: true", async () => {
    const t = await deps({ outcome: "cold" });
    expect(await t.resumeClosed("a1", LINE)).toBe(true);
  });

  it("false when no line went out: a session found alive, a live session, an open agent", async () => {
    expect(await (await deps({ outcome: "alive" })).resumeClosed("a1", LINE)).toBe(false);
    const live = await deps({ live: true });
    expect(await live.resumeClosed("a1", LINE)).toBe(false);
    const open = await deps({ rec: { closedAt: undefined } });
    expect(await open.resumeClosed("a1", LINE)).toBe(false);
    expect([...live.calls, ...open.calls]).toEqual([]);
  });

  it("runs under the agent's typing lock", async () => {
    const t = await deps();
    let release!: () => void;
    const held = withTypingLock("a1", () => new Promise<void>((r) => { release = r; }));
    const p = t.resumeClosed("a1", LINE);
    await new Promise((r) => setImmediate(r));
    expect(t.calls).toEqual([]);
    release();
    await held;
    expect(await p).toBe(true);
    expect(t.calls).toHaveLength(1);
  });
});
