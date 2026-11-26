// src/lib/cron.test.ts — the Recurring section's client: the spool (Task 2c-8) and the list's words.
import { describe, expect, it, vi } from "vitest";
import {
  SPOOL_FRESH_MS, askedBy, draftTask, fetchTaskForm, saveTask, taskAction, changeWords, decideCronSpool, fetchCronJobs, fetchCronSpool, fullWhen, lastWords, nextWords, runState, runWhen, runsLine, tellWords, tookWords, recurringHeadline, recurringLevel, sortTasks, spoolRowState, spoolSectionShown,
  spoolWaiting, stateWord, taskCounts, taskSentence, taskState, taskTitle, tasksLine, trackSpool, visibleText,
} from "./cron";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const REQ = { id: "1000-0123456789ab", at: 1000, op: "add", name: "daily", spec: { name: "daily" }, by: "cron-master", sha256: "ab".repeat(32) };

describe("fetchCronSpool", () => {
  it("not hardened (404): off, and the page shows no spool section", async () => {
    const f = vi.fn(async (_u: string) => json(404, {}));
    const v = await fetchCronSpool({ fetch: f as unknown as typeof fetch });
    expect(v).toEqual({ state: "off" });
    expect(f.mock.calls[0][0]).toBe("/api/cron/spool");
    expect(spoolSectionShown(v)).toBe(false);
    expect(spoolWaiting(v)).toBe(0);
  });
  it("200: the waiting requests; the section shows only when there is one", async () => {
    const v = await fetchCronSpool({ fetch: (async () => json(200, { requests: [REQ] })) as unknown as typeof fetch });
    expect(v).toEqual({ state: "on", requests: [REQ] });
    expect(spoolSectionShown(v)).toBe(true);
    expect(spoolWaiting(v)).toBe(1);
    expect(spoolSectionShown({ state: "on", requests: [] })).toBe(false);
    expect(spoolWaiting({ state: "on", requests: [] })).toBe(0);
    expect(spoolWaiting(null)).toBe(0);
  });
  it("another status, a bad body or a network error: error (the pane keeps its last view)", async () => {
    for (const f of [async () => json(500, {}), async () => json(200, { requests: "x" }), async () => { throw new Error("x"); }]) {
      const v = await fetchCronSpool({ fetch: f as unknown as typeof fetch });
      expect(v).toEqual({ state: "error" });
      expect(spoolSectionShown(v)).toBe(false);
    }
  });
});

describe("decideCronSpool", () => {
  it("apply posts the sha256 of the request the user saw", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { ok: true }));
    expect(await decideCronSpool(REQ, "apply", { fetch: f as unknown as typeof fetch })).toEqual({ ok: true });
    expect(f.mock.calls[0][0]).toBe(`/api/cron/spool/${REQ.id}/apply`);
    expect(f.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ sha256: REQ.sha256 });
  });
  it("reject posts to /reject", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { ok: true }));
    expect(await decideCronSpool(REQ, "reject", { fetch: f as unknown as typeof fetch })).toEqual({ ok: true });
    expect(f.mock.calls[0][0]).toBe(`/api/cron/spool/${REQ.id}/reject`);
  });
  it("a refusal or a failed apply: the reason as plain text", async () => {
    const pair = await decideCronSpool(REQ, "apply", { fetch: (async () => json(403, { error: "pair-required", userAuth: "log" })) as unknown as typeof fetch });
    // A neutral sentence, not the merge one (finding 7).
    expect(pair).toEqual({ ok: false, error: "Apply needs a paired device. On a paired device: Settings, Devices, “Add a device”. With no paired device: run `pnpm choibot brain pair <label>` on your server" });
    const tgPair = await decideCronSpool(REQ, "reject", { fetch: (async () => json(403, { error: "pair-required", userAuth: "telegram" })) as unknown as typeof fetch });
    expect(tgPair).toEqual({ ok: false, error: "Reject needs a paired device — send /pair <label> in the Master topic" });
    const bad = await decideCronSpool(REQ, "apply", { fetch: (async () => json(422, { ok: false, error: "invalid spec: x" })) as unknown as typeof fetch });
    expect(bad).toEqual({ ok: false, error: "invalid spec: x" });
    const changed = await decideCronSpool(REQ, "apply", { fetch: (async () => json(409, { error: "changed" })) as unknown as typeof fetch });
    expect(changed).toEqual({ ok: false, error: "changed" });
    const down = await decideCronSpool(REQ, "apply", { fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(down).toEqual({ ok: false, error: "offline" });
  });
});

// Finding 1, UI side: a row that appeared or changed since the previous poll
// is "new" (Apply off for SPOOL_FRESH_MS); one the server saw change is
// "changed" (Apply off for good).
describe("spool rows", () => {
  const A = { ...REQ, sha256: "a".repeat(64) };
  const B = { ...REQ, sha256: "b".repeat(64), spec: { name: "daily", prompt: "else" } };
  it("a rewrite between two polls is new again for 5 s; an unchanged row becomes ready", () => {
    expect(SPOOL_FRESH_MS).toBe(5000);
    const t1 = trackSpool(new Map(), [A], 1_000);
    expect(spoolRowState(A, t1, 1_000)).toBe("new");
    const t2 = trackSpool(t1, [A], 6_000);
    expect(spoolRowState(A, t2, 6_000)).toBe("ready");
    const t3 = trackSpool(t2, [B], 7_000);
    expect(spoolRowState(B, t3, 7_000)).toBe("new");
    expect(spoolRowState(B, t3, 11_999)).toBe("new");
    expect(spoolRowState(B, t3, 12_000)).toBe("ready");
  });
  it("a row the server marks changed is never ready", () => {
    const c = { ...B, changed: true as const };
    const t = trackSpool(new Map(), [c], 0);
    expect(spoolRowState(c, t, 60_000)).toBe("changed");
  });
  it("a deleted row is forgotten: the same id back is new", () => {
    const t1 = trackSpool(new Map(), [A], 0);
    const t2 = trackSpool(t1, [], 10_000);
    const t3 = trackSpool(t2, [A], 20_000);
    expect(spoolRowState(A, t3, 20_000)).toBe("new");
  });
});

describe("visibleText (finding 6)", () => {
  it("escapes format (Cf) and C1 control characters, keeps the rest", () => {
    expect(visibleText("run\u202Eevil\u200Bx\u0085y\u009Fz")).toBe("run\\u202eevil\\u200bx\\u0085y\\u009fz");
    expect(visibleText('{"prompt": "plain ünïcode — ok"}')).toBe('{"prompt": "plain ünïcode — ok"}');
    expect(visibleText("a\u{E0041}b\uFEFF")).toBe("a\\u{e0041}b\\ufeff"); // a tag character, a BOM
  });
});

describe("askedBy (finding 8)", () => {
  it("labels the agent-claimed id as unverified", () => {
    expect(askedBy("cron-master")).toBe("asked by (unverified) cron-master");
    expect(askedBy("a\u202Eb")).toBe("asked by (unverified) a\\u202eb");
    expect(askedBy(undefined)).toBe("");
  });
});

const run = (ok: boolean, sentence: string | null = null, finishedAt = 0) => ({ finishedAt, ok, summary: "", sentence });

describe("the state and the words of a task", () => {
  it("paused wins; then no run, did not finish, finished", () => {
    expect(taskState({ enabled: false, lastRun: run(false) })).toBe("paused");
    expect(taskState({ enabled: true, lastRun: null })).toBe("none");
    expect(taskState({ enabled: true, lastRun: run(false) })).toBe("failed");
    expect(taskState({ enabled: true, lastRun: run(true) })).toBe("done");
  });
  it("says the run's own first line, else a neutral sentence", () => {
    expect(taskSentence({ enabled: true, lastRun: run(true, "No new error") })).toBe("No new error");
    expect(taskSentence({ enabled: true, lastRun: run(true) })).toBe("The last run finished.");
    expect(taskSentence({ enabled: true, lastRun: { finishedAt: 0, ok: true, summary: "" } })).toBe("The last run finished.");
    expect(taskSentence({ enabled: true, lastRun: run(false) })).toBe("The last run did not finish.");
    expect(taskSentence({ enabled: true, lastRun: run(false, "It stopped with an error.") })).toBe("Did not finish. It stopped with an error.");
    expect(taskSentence({ enabled: true, lastRun: { ...run(true, "2 new errors."), state: "needs" } })).toBe("2 new errors.");
    expect(taskSentence({ enabled: true, lastRun: { ...run(true), state: "needs" } })).toBe("The last run found something for you.");
    expect(taskSentence({ enabled: true, lastRun: { ...run(true), state: "clear" } })).toBe("All clear.");
    expect(taskSentence({ enabled: true, lastRun: null })).toBe("No run yet.");
    expect(taskSentence({ enabled: false, lastRun: run(true, "x") })).toBe("Paused.");
  });
  it("takes the state that the server gives for a run that finished; a run that did not finish is failed whatever it says", () => {
    expect(taskState({ enabled: true, lastRun: { ...run(true), state: "clear" } })).toBe("clear");
    expect(taskState({ enabled: true, lastRun: { ...run(true), state: "needs" } })).toBe("needs");
    expect(taskState({ enabled: true, lastRun: { ...run(false), state: "clear" } })).toBe("failed");
    expect(runState({ ok: true, state: "failed" })).toBe("done");
    expect(runState({ ok: true, state: "nonsense" as never })).toBe("done");
    expect(runState({ ok: true })).toBe("done");
  });
  it("puts what needs you first, then what did not finish", () => {
    const jobs = [
      { name: "a", enabled: true, lastRun: { ...run(true), state: "clear" as const } }, { name: "b", enabled: true, lastRun: run(false) },
      { name: "c", enabled: true, lastRun: { ...run(true), state: "needs" as const } }, { name: "d", enabled: true, lastRun: { ...run(true), state: "needs" as const } },
    ];
    expect(sortTasks(jobs).map((j) => j.name)).toEqual(["c", "d", "b", "a"]);
    expect(recurringHeadline(jobs)).toBe("4 tasks · 2 need you · 1 did not finish");
    expect(recurringHeadline(jobs.slice(0, 3))).toBe("3 tasks · 1 needs you · 1 did not finish");
    // The sidebar dot stays for a failure only: a run that needs you has its ticket in the Queue.
    expect(recurringLevel([jobs[2]], 0)).toBeNull();
  });
  it("makes a title of the task's slug", () => {
    expect(taskTitle("morning-error-digest")).toBe("Morning error digest");
    expect(taskTitle("costs")).toBe("Costs");
    expect(taskTitle("7-day--sweep")).toBe("7 day sweep");
  });
  it("sorts what did not finish first and the paused tasks last, by name in a group", () => {
    const jobs = [
      { name: "d", enabled: false, lastRun: run(false) }, { name: "c", enabled: true, lastRun: run(true) },
      { name: "b", enabled: true, lastRun: run(false) }, { name: "a", enabled: true, lastRun: null },
    ];
    expect(sortTasks(jobs).map((j) => j.name)).toEqual(["b", "a", "c", "d"]);
    expect(taskCounts(jobs)).toEqual({ needs: 0, failed: 1, clear: 0, done: 1, none: 1, paused: 1 });
    expect(tasksLine(jobs)).toBe("4 tasks");
    expect(tasksLine(jobs.slice(0, 1))).toBe("1 task");
    expect(tasksLine([])).toBe("");
    expect(tasksLine(null)).toBe("");
  });
  it("the sidebar dot: red for a task that did not finish, amber for a change that waits, else none", () => {
    const ok = { enabled: true, lastRun: run(true) }, bad = { enabled: true, lastRun: run(false) };
    expect(recurringLevel([ok], 0)).toBeNull();
    expect(recurringLevel(null, 0)).toBeNull();
    expect(recurringLevel([ok, bad], 2)).toEqual({ level: "error", why: "1 task did not finish" });
    expect(recurringLevel([bad, bad], 0)).toEqual({ level: "error", why: "2 tasks did not finish" });
    expect(recurringLevel([ok], 1)).toEqual({ level: "warn", why: "1 change waits for you" });
    expect(recurringLevel([{ enabled: false, lastRun: run(false) }], 0)).toBeNull();
  });
});

describe("the time words", () => {
  const PARIS = "Europe/Paris";
  const at = (iso: string) => new Date(iso).getTime();
  const now = at("2026-11-20T10:00:00+01:00"); // a Friday
  it("the last run", () => {
    expect(lastWords(now - 20_000, now, PARIS)).toBe("Now");
    expect(lastWords(now - 14 * 60_000, now, PARIS)).toBe("14 min ago");
    expect(lastWords(at("2026-11-20T08:00:00+01:00"), now, PARIS)).toBe("2 h ago");
    expect(lastWords(at("2026-11-19T17:00:00+01:00"), now, PARIS)).toBe("17 h ago");
    expect(lastWords(at("2026-11-19T08:00:00+01:00"), now, PARIS)).toBe("Yesterday");
    expect(lastWords(at("2026-11-16T09:00:00+01:00"), now, PARIS)).toBe("Mon 16 Nov");
    expect(lastWords(now + 5000, now, PARIS)).toBe("Now");
  });
  it("the next run, in the viewer's zone", () => {
    expect(nextWords("2026-11-20T17:00:00+01:00", now, PARIS)).toBe("Today 17:00");
    expect(nextWords("2026-11-21T08:00:00+01:00", now, PARIS)).toBe("Tomorrow 08:00");
    expect(nextWords("2026-11-23T09:00:00+01:00", now, PARIS)).toBe("Mon 23 Nov 09:00");
    // 23:30 UTC on Friday is Saturday 00:30 in Paris and Friday 18:30 in New York.
    expect(nextWords("2026-11-20T23:30:00Z", now, PARIS)).toBe("Tomorrow 00:30");
    expect(nextWords("2026-11-20T23:30:00Z", now, "America/New_York")).toBe("Today 18:30");
    expect(nextWords(null, now, PARIS)).toBeNull();
    expect(nextWords("not a date", now, PARIS)).toBeNull();
  });
  it("a summer-time change: the day after is still tomorrow", () => {
    // Paris goes to summer time on 2027-03-28: that day has 23 hours.
    const sat = at("2027-03-27T12:00:00+01:00");
    expect(nextWords("2027-03-28T09:00:00+02:00", sat, PARIS)).toBe("Tomorrow 09:00");
    expect(nextWords("2027-03-29T09:00:00+02:00", sat, PARIS)).toBe("Mon 29 Mar 09:00");
    expect(lastWords(at("2027-03-27T09:00:00+01:00"), at("2027-03-28T12:00:00+02:00"), PARIS)).toBe("Yesterday");
  });
  it("the full date of a tooltip names the zone", () => {
    expect(fullWhen(at("2026-11-23T09:00:00+01:00"), PARIS)).toBe("Monday 23 November 2026, 09:00 (Europe/Paris)");
    expect(fullWhen(NaN, PARIS)).toBe("");
  });
});

describe("fetchCronJobs", () => {
  it("reads the tasks and the server's zone; an older server sends no zone", async () => {
    const real = globalThis.fetch;
    try {
      globalThis.fetch = (async () => json(200, { jobs: [], timeZone: "UTC" })) as unknown as typeof fetch;
      expect(await fetchCronJobs()).toEqual({ jobs: [], timeZone: "UTC" });
      globalThis.fetch = (async () => json(200, { jobs: [] })) as unknown as typeof fetch;
      expect(await fetchCronJobs()).toEqual({ jobs: [], timeZone: null });
    } finally { globalThis.fetch = real; }
  });
});

describe("the words of the page", () => {
  const run = (ok: boolean) => ({ finishedAt: 1, ok, summary: "" });
  it("says a state in words", () => {
    expect((["needs", "failed", "clear", "done", "none", "paused"] as const).map(stateWord)).toEqual(["Needs you", "Did not finish", "All clear", "Finished", "No run yet", "Paused"]);
  });
  it("the headline counts the tasks, then what did not finish and what is paused", () => {
    expect(recurringHeadline(null)).toBe("");
    expect(recurringHeadline([])).toBe("");
    expect(recurringHeadline([{ enabled: true, lastRun: run(true) }])).toBe("1 task");
    expect(recurringHeadline([
      { enabled: true, lastRun: run(true) }, { enabled: true, lastRun: run(false) }, { enabled: false, lastRun: run(false) }, { enabled: true, lastRun: null },
    ])).toBe("4 tasks · 1 did not finish · 1 paused");
  });
  it("says a change in the page's words", () => {
    expect((["add", "edit", "rm", "enable", "disable", "run"] as const).map(changeWords)).toEqual(["New task", "Change", "Delete", "Resume", "Pause", "Run now"]);
    // The op is what an agent wrote: an unknown one shows as it is.
    expect(changeWords("format" as never)).toBe("format");
  });
});

describe("the words of a run", () => {
  const NOW = Date.UTC(2026, 10, 20, 18, 0);
  it("says when a run started", () => {
    expect(runWhen(Date.UTC(2026, 10, 20, 8, 0), NOW, "UTC")).toBe("Today 08:00");
    expect(runWhen(Date.UTC(2026, 10, 19, 8, 0), NOW, "UTC")).toBe("Yesterday 08:00");
    expect(runWhen(Date.UTC(2026, 10, 16, 8, 5), NOW, "UTC")).toBe("Mon 16 Nov 08:05");
    // 23:30 UTC is the next day in Paris.
    expect(runWhen(Date.UTC(2026, 10, 19, 23, 30), NOW, "Europe/Paris")).toBe("Today 00:30");
  });
  it("says how long a run took", () => {
    expect(tookWords({ startedAt: 0, finishedAt: 40_400 })).toBe("40 s");
    expect(tookWords({ startedAt: 0, finishedAt: 172_000 })).toBe("3 min");
    expect(tookWords({ startedAt: 0, finishedAt: 65 * 60_000 })).toBe("1 h 5 min");
    expect(tookWords({ startedAt: 5, finishedAt: 0 })).toBe("0 s");
  });
  it("counts the runs of the strip", () => {
    const r = (ok: boolean, state?: "clear" | "needs") => ({ ok, state });
    expect(runsLine([])).toBe("");
    expect(runsLine([r(true, "clear")])).toBe("1 run · 1 all clear");
    expect(runsLine([r(true, "clear"), r(true, "clear"), r(true, "needs"), r(false, "clear"), r(true)])).toBe("Last 5 runs · 2 all clear · 1 needed you · 1 did not finish");
    expect(runsLine([r(true), r(true)])).toBe("Last 2 runs");
  });
  it("says who a task tells", () => {
    expect(tellWords("always")).toBe("After every run");
    expect(tellWords("on-failure")).toBe("When it needs me");
  });
});

describe("taskAction", () => {
  const call = async (status: number, body: unknown) => {
    const f = vi.fn(async (_u: string, _o?: RequestInit) => json(status, body));
    return { r: await taskAction("morning-digest", "run", { fetch: f as never }), f };
  };
  it("sends the name of the task and one fixed word, and no body", async () => {
    const { r, f } = await call(200, { ok: true });
    expect(r).toEqual({ ok: true });
    expect(f.mock.calls[0][0]).toBe("/api/cron/jobs/morning-digest/run");
    expect(f.mock.calls[0][1]?.method).toBe("POST");
    expect(f.mock.calls[0][1]?.body).toBeUndefined();
  });
  it("gives the server's sentence for a task that is paused, gone, or that the server could not change", async () => {
    expect((await call(409, { error: "This task is paused. Resume it first." })).r).toEqual({ ok: false, error: "This task is paused. Resume it first." });
    expect((await call(404, { error: "This task is not in the list now." })).r).toEqual({ ok: false, error: "This task is not in the list now." });
    expect((await call(422, { error: "Your server could not do this. Try again." })).r).toEqual({ ok: false, error: "Your server could not do this. Try again." });
  });
  it("says to pair for a device that is not paired, and one plain sentence for any other answer", async () => {
    const refused = (await call(403, { error: "pair-required", userAuth: "log" })).r;
    expect(refused.ok).toBe(false);
    expect((refused as { error: string }).error).toMatch(/pair/i);
    expect((await call(500, { error: "stack trace at /srv/x.ts" })).r).toEqual({ ok: false, error: "Your server could not do this. Try again." });
    expect((await call(400, { error: "bad name" })).r).toEqual({ ok: false, error: "Your server could not do this. Try again." });
    const down = await taskAction("a", "pause", { fetch: (async () => { throw new Error("net"); }) as never });
    expect(down).toEqual({ ok: false, error: "Your server did not answer. Try again." });
  });
});

describe("the form's calls", () => {
  const FORM = { name: "digest", repo: "web", what: "Do it.", when: { kind: "hours" as const, every: 6, minute: 0 }, zone: "UTC", tell: "needs" as const };
  const f = (status: number, body: unknown) => vi.fn(async (_u: string, _o?: RequestInit) => json(status, body));

  it("a console with no pairing: the action says the server's own line", async () => {
    const r = await taskAction("a", "run", { fetch: f(403, { error: "needs-pairing", text: "Pair a device first. Only a paired device can change a recurring task." }) as never });
    expect(r).toEqual({ ok: false, error: "Pair a device first. Only a paired device can change a recurring task." });
  });
  it("saveTask sends the fields of the form to the route of a new task, or of the task to change", async () => {
    const add = f(200, { ok: true, name: "digest" });
    expect(await saveTask(FORM, null, { fetch: add as never })).toEqual({ ok: true, name: "digest" });
    expect(add.mock.calls[0][0]).toBe("/api/cron/tasks");
    expect(JSON.parse(String(add.mock.calls[0][1]?.body))).toEqual(FORM);
    const change = f(200, { ok: true, name: "digest" });
    await saveTask(FORM, "digest", { fetch: change as never });
    expect(change.mock.calls[0][0]).toBe("/api/cron/tasks/digest");
  });
  it("saveTask gives the server's sentence with its field, the pairing sentence, or one plain sentence", async () => {
    expect(await saveTask(FORM, null, { fetch: f(409, { field: "name", error: "A task with this name exists. Choose another name." }) as never }))
      .toEqual({ ok: false, field: "name", error: "A task with this name exists. Choose another name." });
    expect(await saveTask(FORM, null, { fetch: f(400, { field: "bogus", error: "Say when the task runs." }) as never })).toEqual({ ok: false, error: "Say when the task runs." });
    expect((await saveTask(FORM, null, { fetch: f(403, { error: "pair-required", userAuth: "log" }) as never }) as { error: string }).error).toMatch(/pair/i);
    expect(await saveTask(FORM, null, { fetch: f(500, { error: "stack at /srv" }) as never })).toEqual({ ok: false, error: "Your server could not save the task. Try again." });
    expect(await saveTask(FORM, null, { fetch: (async () => { throw new Error("net"); }) as never })).toEqual({ ok: false, error: "Your server did not answer. Try again." });
  });
  it("fetchTaskForm gives the repo names and if Fill in is there; null when refused", async () => {
    expect(await fetchTaskForm({ fetch: f(200, { repos: ["a", 7, "b"], fillIn: true }) as never })).toEqual({ repos: ["a", "b"], fillIn: true });
    expect(await fetchTaskForm({ fetch: f(403, { error: "pair-required" }) as never })).toBeNull();
  });
  it("draftTask gives the draft, or one line that says why and that the form works by hand", async () => {
    const draft = { title: "A", name: "a", what: "Do it.", when: null, repo: null, tell: "needs" };
    expect(await draftTask("x", { fetch: f(200, { ok: true, draft }) as never })).toEqual({ ok: true, draft });
    const now = () => Date.UTC(2026, 10, 20, 18, 0);
    const limit = await draftTask("x", { fetch: f(200, { ok: false, why: "limit", until: Date.UTC(2026, 10, 20, 21, 0) }) as never, now });
    expect(limit).toEqual({ ok: false, error: expect.stringMatching(/^Your Claude plan is at its limit\. It comes back today \d\d:00\. Fill in the form by hand\.$/) });
    expect(await draftTask("x", { fetch: f(200, { ok: false, why: "limit" }) as never })).toEqual({ ok: false, error: "Your Claude plan is at its limit. Fill in the form by hand." });
    expect((await draftTask("x", { fetch: f(200, { ok: false, why: "login" }) as never }) as { error: string }).error).toBe("Claude is not logged in on your server. Fill in the form by hand.");
    expect((await draftTask("x", { fetch: f(200, { ok: false, why: "unclear" }) as never }) as { error: string }).error).toMatch(/by hand/);
    expect((await draftTask("x", { fetch: f(200, { ok: false, why: "down" }) as never }) as { error: string }).error).toBe("\"Fill in\" did not work this time. Fill in the form by hand.");
    expect((await draftTask("x", { fetch: f(429, { error: "Wait for the answer of the first press." }) as never }) as { error: string }).error).toBe("Wait for the answer of the first press.");
  });
});
