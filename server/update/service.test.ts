// server/update/service.test.ts — the Update ticket of a hosted console (server/update/service.ts),
// on a real queue store, with root's status file as the test writes it.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueueStore } from "../chief/queue/store.js";
import type { QueueItem } from "../chief/queue/types.js";
import { DEPLOY_CLOSED, type UpdateRun } from "../chief/deploy/ticket.js";
import { UPDATE_RESULTS, updatePaths, type UpdateResult, type UpdateStatus } from "./status.js";
import { ASK_WAIT_MS, RUN_MAX_MS, UpdateService, nextRun, type Next } from "./service.js";

const A848 = "a".repeat(40), B849 = "b".repeat(40), C850 = "c".repeat(40);
const T0 = Date.parse("2026-11-26T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const offer = (version: number, commit: string, notes: string[] = ["#153 feat: one"]) => ({ version, commit, builtAt: "2026-11-26T13:00:00Z", security: false, notes });

describe("the Update ticket", () => {
  let dir: string;
  let store: QueueStore;
  let now: number;
  let logs: string[];
  const paths = () => updatePaths("checkout", join(dir, "update"));
  const status = (s: Record<string, unknown>) => writeFileSync(join(dir, "update", "status.json"), JSON.stringify({ v: 1, at: iso(now), checkedAt: iso(now), step: null, tried: null, ...s }));
  const service = (running = 848, commit = A848) => new UpdateService({ store, paths: paths(), running: { version: running, commit }, now: () => now, log: (s) => logs.push(s) });
  const items = async (): Promise<QueueItem[]> => store.list();
  const open = async () => (await items()).filter((i) => i.status === "open" || i.status === "snoozed");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "update-svc-"));
    mkdirSync(join(dir, "update"));
    store = new QueueStore(join(dir, "queue"), { log: () => {} });
    now = T0;
    logs = [];
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("makes no ticket with no status file, and none for a release that is not newer", async () => {
    const svc = service();
    await svc.check();
    expect(await items()).toEqual([]);
    status({ mode: "check", result: "current", installed: { version: 848, commit: A848 }, available: null });
    await svc.check();
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(848, A848) });
    await svc.check();
    expect(await items()).toEqual([]);
  });

  it("offers a newer release: ONE ticket, its notes as plain text, at most 12", async () => {
    const notes = ["one\u0007\nline", ...Array.from({ length: 14 }, (_, n) => `note ${n}`), "x".repeat(300)];
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(849, B849, notes) });
    const svc = service();
    await svc.check();
    await svc.check();
    const [t, ...rest] = await open();
    expect(rest).toEqual([]);
    expect(t.title).toBe("ChoiBot 849 is ready");
    expect(t.kind).toBe("deploy");
    expect(t.deploy?.release).toMatchObject({ version: 849, commit: B849, running: { version: 848, commit: A848 }, more: 4 });
    expect(t.deploy?.release?.notes).toHaveLength(12);
    expect(t.body.split("\n")[0]).toBe("one line");
    expect(t.body.split("\n").at(-1)).toBe("and 4 more");
    expect(t.body).not.toContain("Version 848");
    expect(Math.max(...t.body.split("\n").map((l) => l.length))).toBeLessThanOrEqual(200);
  });

  it("takes the running version from its own record, never from the status file", async () => {
    status({ mode: "check", result: "available", installed: { version: 900, commit: C850 }, available: offer(849, B849) });
    await service(848).check();
    expect((await open()).map((i) => i.title)).toEqual(["ChoiBot 849 is ready"]);
  });

  it("the press makes the empty ask file only, then follows root: asked, running, failed-back closes it", async () => {
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    const svc = service();
    await svc.check();
    const r = await svc.start("tab");
    expect(r.code).toBe(200);
    expect(existsSync(join(dir, "update", "ask"))).toBe(true);
    expect((await open())[0].deploy?.update).toMatchObject({ state: "asked", from: 848, to: 849, via: "tab" });
    expect((await svc.start("tab")).code).toBe(409); // a second press does nothing
    rmSync(join(dir, "update", "ask")); // root took it
    now += 5_000;
    status({ mode: "ask", result: "running", step: "download", tried: { version: 849, commit: B849 }, installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    await svc.check();
    expect((await open())[0].deploy?.update).toMatchObject({ state: "running", step: "download" });
    now += 60_000;
    status({ mode: "ask", result: "failed-back", step: "health", tried: { version: 849, commit: B849 }, installed: { version: 848, commit: A848 }, available: null });
    await svc.check();
    expect(await open()).toEqual([]);
    const [t] = await items();
    expect(t.lastError).toBe(DEPLOY_CLOSED.updateFailed);
    expect(t.deploy?.update).toMatchObject({ state: "failed-back", step: "health" });
  });

  it("GET /api/deploy carries the last press, also after its ticket closed (the page follows it)", async () => {
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    const svc = service();
    await svc.check();
    expect((await svc.statusNow()).press).toBeNull();
    await svc.start("tab");
    expect((await svc.statusNow()).press).toMatchObject({ state: "asked", from: 848, to: 849 });
    rmSync(join(dir, "update", "ask"));
    now += 5_000;
    status({ mode: "ask", result: "running", step: "stage", tried: { version: 849, commit: B849 }, installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    expect((await svc.statusNow()).press).toMatchObject({ state: "running", step: "stage" });
    now += 60_000;
    status({ mode: "ask", result: "failed-back", step: "health", tried: { version: 849, commit: B849 }, installed: { version: 848, commit: A848 }, available: null });
    const s = await svc.statusNow();
    expect(s.ticketId).toBeNull();
    expect(s.press).toMatchObject({ state: "failed-back", step: "health", from: 848, to: 849 });
  });

  it("after a failure: no ticket again for that version; a higher one makes a new ticket", async () => {
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    const svc = service();
    await svc.check();
    await svc.start("tab");
    rmSync(join(dir, "update", "ask")); // root took it
    now += 10_000;
    status({ mode: "ask", result: "failed-stuck", step: "swap", tried: { version: 849, commit: B849 }, installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    await svc.check();
    await svc.check();
    expect(await open()).toEqual([]);
    expect((await items())[0].deploy?.update?.state).toBe("failed-stuck");
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(850, C850) });
    await svc.check();
    expect((await open()).map((i) => i.title)).toEqual(["ChoiBot 850 is ready"]);
  });

  it("closes the ticket as updated at the boot after the update, when root's installed is its own version", async () => {
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    await service().check();
    await service().start("telegram");
    now += 50_000;
    status({ mode: "ask", result: "updated", step: null, tried: { version: 849, commit: B849 }, installed: { version: 849, commit: B849 }, available: null });
    // The old console, before its stop: no close (it does not run 849).
    await service(848).check();
    expect((await open()).length).toBe(1);
    // The new console.
    await service(849, B849).afterBoot();
    expect(await open()).toEqual([]);
    const [t] = await items();
    expect([t.lastError, t.deploy?.update?.state]).toEqual([DEPLOY_CLOSED.updated, "updated"]);
  });

  it("a refusal before any change keeps the ticket, and the same release can be asked again", async () => {
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    const svc = service();
    await svc.check();
    await svc.start("tab");
    rmSync(join(dir, "update", "ask")); // root took it
    now += 5_000;
    status({ mode: "ask", result: "refused", step: "disk", tried: { version: 849, commit: B849 }, installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    await svc.check();
    expect((await open())[0].deploy?.update).toMatchObject({ state: "refused", step: "disk" });
    expect((await svc.start("tab")).code).toBe(200);
    expect((await open())[0].deploy?.update?.state).toBe("asked");
  });

  it("says when root did not take the press", async () => {
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    const svc = service();
    await svc.check();
    await svc.start("tab");
    now += ASK_WAIT_MS + 1;
    await svc.check();
    expect((await open())[0].deploy?.update?.state).toBe("not-started");
  });

  it("makes no ticket again for a version that the user withdrew, and closes one that is no longer newer", async () => {
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    const svc = service();
    await svc.check();
    const [t] = await open();
    await store.withItem(t.id, async () => { await store.write({ ...(await store.get(t.id))!, status: "withdrawn", closedAt: now }); });
    await svc.check();
    expect(await open()).toEqual([]);
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(850, C850) });
    await svc.check();
    expect((await open()).length).toBe(1);
    status({ mode: "check", result: "current", installed: { version: 850, commit: C850 }, available: null });
    await service(850, C850).check();
    expect(await open()).toEqual([]);
    expect((await items()).at(-1)?.lastError).toBe(DEPLOY_CLOSED.live);
  });

  it("refuses a card press of another ticket, and a press with nothing offered", async () => {
    const svc = service();
    status({ mode: "check", result: "current", installed: { version: 848, commit: A848 }, available: null });
    expect(await svc.start("tab")).toEqual({ code: 409, error: "no release is offered: this console runs the newest" });
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    await svc.check();
    expect((await svc.startFromCard("q-not-it")).code).toBe(409);
    const [t] = await open();
    expect((await svc.startFromCard(t.id)).code).toBe(200);
    expect((await open())[0].deploy?.update?.via).toBe("telegram");
  });
});

// ---- the table (nextRun): each result of root's list × each state of a press under way ----

describe("nextRun: one rule for each result, each mode of root's run and each press state", () => {
  const T = Date.parse("2026-11-26T15:00:00Z");
  const ASKED = T + 200; // the press: 200 ms into its second
  const pressed = (state: "asked" | "running" | "not-started"): UpdateRun => ({ state, via: "tab", askedAt: ASKED, from: 848, to: 849, ...(state === "running" ? { step: "download" } : {}) });
  const st = (result: UpdateResult, o: Partial<UpdateStatus> = {}): UpdateStatus => ({
    v: 1, at: iso(T + 10_000), checkedAt: iso(T), mode: "ask", result, step: "health",
    installed: { version: 848, commit: A848 }, tried: { version: 849, commit: B849 }, available: null, ...o,
  });
  const ctx = { now: T + 10_000, running: 848, pending: false };
  const show = (n: Next, u: UpdateRun) => (n.t === "keep" ? `keep ${u.state}` : `${n.t} ${n.run.state}`);

  // What root's answer does. A result word with no row here does not compile (Record over UpdateResult).
  const ANSWER: Record<UpdateResult, string> = {
    none: "set not-finished", current: "set not-finished", available: "set not-finished", repaired: "set not-finished",
    running: "set running", updated: "keep", "failed-back": "close failed-back", "failed-stuck": "close failed-stuck",
    refused: "set refused", unreachable: "set unreachable",
  };
  const MODES = ["ask", "repair", "check", "local", null] as const;
  // Is the status root's answer to the press? (the press's state, the mode, the ask file)
  const answers = (state: "asked" | "running" | "not-started", mode: (typeof MODES)[number], pending: boolean, result: UpdateResult): boolean => {
    const run = mode === "ask" || mode === "repair";
    if (state === "running") return result !== "running" || run;
    return !pending && run;
  };

  it("covers every result × mode × state × ask file", () => {
    expect(Object.keys(ANSWER).sort()).toEqual([...UPDATE_RESULTS].sort());
    let pairs = 0;
    for (const state of ["asked", "running", "not-started"] as const) {
      for (const mode of MODES) {
        for (const pending of [false, true]) {
          for (const result of UPDATE_RESULTS) {
            const u = pressed(state);
            const s = st(result, { mode, ...(result === "running" && state === "running" ? { step: "download" } : {}) });
            const got = show(nextRun(u, s, { ...ctx, pending }), u);
            let want = answers(state, mode, pending, result) ? ANSWER[result] : "keep";
            if (want === "keep" || (want === "set running" && state === "running")) want = `keep ${state}`;
            expect([state, mode, pending, result, got]).toEqual([state, mode, pending, result, want]);
            pairs++;
          }
        }
      }
    }
    expect(pairs).toBe(3 * 5 * 2 * 10);
  });

  it("the review's case: root answers inside the press's own second (the console saw running)", () => {
    for (const result of ["unreachable", "refused", "current"] as const) {
      const n = nextRun(pressed("running"), st(result, { at: iso(T), mode: null }), { ...ctx, now: T + 2_000 });
      expect([result, n.t]).toEqual([result, "set"]);
    }
  });

  it("a daily check of the press's own second never ends it (the ask file is still there, or it is a check)", () => {
    for (const result of ["available", "current", "none", "unreachable"] as const) {
      expect(nextRun(pressed("asked"), st(result, { at: iso(T), mode: "check" }), ctx).t).toBe("keep");
      expect(nextRun(pressed("asked"), st(result, { at: iso(T), mode: "ask" }), { ...ctx, pending: true }).t).toBe("keep");
    }
    // root's ask run in the same second, the ask file gone: it is the answer.
    expect(nextRun(pressed("asked"), st("unreachable", { at: iso(T), mode: "ask" }), ctx)).toMatchObject({ t: "set", run: { state: "unreachable" } });
  });

  it("takes nothing from a status of a second before the press, or with no time", () => {
    for (const result of UPDATE_RESULTS) {
      for (const state of ["asked", "running"] as const) {
        expect([state, result, nextRun(pressed(state), st(result, { at: iso(T - 1_000) }), ctx).t]).toEqual([state, result, "keep"]);
        expect([state, result, nextRun(pressed(state), st(result, { at: null }), ctx).t]).toEqual([state, result, "keep"]);
      }
    }
  });

  it("ends well on the version that runs: also a newer one than the ticket's, also after a later check", () => {
    for (const result of ["updated", "current", "available", "none", "repaired", "unreachable", "refused"] as const) {
      const n = nextRun(pressed("asked"), st(result, { mode: "check", installed: { version: 850, commit: C850 }, tried: { version: 850, commit: C850 } }), { ...ctx, running: 850 });
      expect([result, n.t, n.t === "close" && n.why, n.t !== "keep" && n.run.to]).toEqual([result, "close", DEPLOY_CLOSED.updated, 850]);
    }
    expect(nextRun(pressed("running"), st("running", { installed: { version: 849, commit: B849 } }), { ...ctx, running: 849 }).t).not.toBe("close");
    // The old console (it runs the version of the press) never ends it well.
    expect(nextRun(pressed("asked"), st("updated", { installed: { version: 849, commit: B849 } }), ctx).t).toBe("keep");
  });

  it("counts a failure only for the ticket's release or a newer one", () => {
    expect(nextRun(pressed("running"), st("failed-back", { tried: { version: 850, commit: C850 } }), ctx)).toMatchObject({ t: "close", why: DEPLOY_CLOSED.updateFailed });
    expect(nextRun(pressed("running"), st("failed-back", { tried: null }), ctx)).toMatchObject({ t: "close", why: DEPLOY_CLOSED.updateFailed });
    expect(nextRun(pressed("running"), st("failed-back", { tried: { version: 848, commit: A848 } }), ctx).t).toBe("keep");
  });

  it("shows Updating while root has not read the index yet (tried null)", () => {
    expect(nextRun(pressed("asked"), st("running", { tried: null, step: "download" }), ctx)).toMatchObject({ t: "set", run: { state: "running", step: "download" } });
  });

  it("the two guards: an ask that root never took (3 min), a run that never ended (60 min)", () => {
    const old = st("available", { at: iso(T - 60_000), mode: "check" });
    expect(RUN_MAX_MS).toBe(60 * 60_000);
    expect(nextRun(pressed("asked"), old, { ...ctx, now: ASKED + ASK_WAIT_MS + 1, pending: true })).toMatchObject({ t: "set", run: { state: "not-started" } });
    expect(nextRun(pressed("asked"), old, { ...ctx, now: ASKED + ASK_WAIT_MS + 1, pending: false }).t).toBe("keep");
    expect(nextRun(pressed("running"), old, { ...ctx, now: ASKED + RUN_MAX_MS + 1, pending: false })).toMatchObject({ t: "set", run: { state: "not-finished" } });
    expect(nextRun(pressed("running"), old, { ...ctx, now: ASKED + RUN_MAX_MS - 1, pending: false }).t).toBe("keep");
  });

  it("an ask that root took late moves on; an end with no update waits for nothing more", () => {
    const late: UpdateRun = { ...pressed("asked"), state: "not-started", endedAt: ASKED + ASK_WAIT_MS };
    expect(nextRun(late, st("running", { step: "download" }), ctx)).toMatchObject({ t: "set", run: { state: "running" } });
    for (const state of ["refused", "unreachable", "not-finished"] as const) {
      const ended: UpdateRun = { ...pressed("asked"), state, endedAt: ASKED + 1 };
      expect(nextRun(ended, st("running", { step: "stage" }), ctx).t).toBe("keep");
      expect(nextRun(ended, st("available", { at: iso(T - 60_000) }), { ...ctx, now: ASKED + RUN_MAX_MS * 2 }).t).toBe("keep");
      expect(nextRun(ended, st("updated", { installed: { version: 849, commit: B849 } }), { ...ctx, running: 849 })).toMatchObject({ t: "close", why: DEPLOY_CLOSED.updated });
    }
  });
});

// ---- the lead's three proofs of the review of #153 (each failed on 84ad111) ----

describe("the review's three cases", () => {
  let dir: string; let store: QueueStore; let now: number;
  const paths = () => updatePaths("checkout", join(dir, "update"));
  const status = (s: Record<string, unknown>) => writeFileSync(join(dir, "update", "status.json"), JSON.stringify({ v: 1, at: iso(now), checkedAt: iso(now), step: null, tried: null, ...s }));
  const service = (running: number, commit: string) => new UpdateService({ store, paths: paths(), running: { version: running, commit }, now: () => now, log: () => {} });
  const live = async () => (await store.list()).filter((i) => i.status === "open" || i.status === "snoozed");
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lead-")); mkdirSync(join(dir, "update")); store = new QueueStore(join(dir, "queue"), { log: () => {} }); now = T0; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const press = async () => {
    status({ mode: "check", result: "available", installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    const svc = service(848, A848);
    await svc.check();
    const r = await svc.start("tab");
    expect(r.code).toBe(200);
    expect(svc.busy).toBe(true);
    rmSync(join(dir, "update", "ask")); // root took the ask
    return svc;
  };

  it("1: the download fails (unreachable): one line, the button back, the fast check stops", async () => {
    const svc = await press();
    now += 20_000;
    status({ mode: "ask", result: "unreachable", installed: { version: 848, commit: A848 }, available: offer(849, B849) });
    await svc.check();
    now += 30 * 60_000;
    await svc.check();
    const [t] = await live();
    expect(t.deploy?.update?.state).toBe("unreachable");
    expect(svc.busy).toBe(false);
    expect((await svc.start("tab")).code).toBe(200); // the button works again
    svc.startWatch()(); // stops the timers of this test
  });

  it("2: root installed a NEWER release than the ticket's: the ticket ends, on the version that runs", async () => {
    await press();
    now += 60_000;
    status({ mode: "ask", result: "updated", installed: { version: 850, commit: C850 }, tried: { version: 850, commit: C850 }, available: null });
    const after = service(850, C850); // the console after the restart
    await after.afterBoot();
    expect(await live()).toEqual([]);
    const [t] = await store.list();
    expect([t.lastError, t.deploy?.update?.state, t.deploy?.update?.to]).toEqual([DEPLOY_CLOSED.updated, "updated", 850]);
  });

  it("3: a later check wrote 'current' over 'updated': the ticket ends", async () => {
    await press();
    now += 60_000;
    status({ mode: "check", result: "current", installed: { version: 849, commit: B849 }, available: null });
    const after = service(849, B849);
    await after.afterBoot();
    expect(await live()).toEqual([]);
  });
});

describe("an install with no updater", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "no-updater-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it("says so at the press; a status file that is refused says that", async () => {
    const store = new QueueStore(join(dir, "queue"), { log: () => {} });
    const logs: string[] = [];
    const svc = new UpdateService({ store, paths: updatePaths("checkout", join(dir, "update")), running: { version: 848, commit: A848 }, log: (s) => logs.push(s) });
    expect(await svc.start("tab")).toEqual({ code: 503, error: "this install has no updater: it cannot update itself" });
    mkdirSync(join(dir, "update"));
    writeFileSync(join(dir, "update", "status.json"), "{nope");
    expect(await svc.start("tab")).toEqual({ code: 503, error: "the updater's status cannot be read: the status file is not JSON" });
    writeFileSync(join(dir, "update", "status.json"), JSON.stringify({ v: 1, result: "current" }));
    await svc.check();
    expect(logs).toContain("[update] on: root's status file is read");
  });
});
