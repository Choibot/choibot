// src/components/recurring/RecurringPage.test.ts — what the Recurring page shows: the list in
// the page's words, the changes that wait for the user on top, and the text of an agent as
// plain text only.
import * as React from "react";
import { createElement } from "react";
// @ts-expect-error The repo has no types for react-dom/server. The one function used is typed below.
import { renderToStaticMarkup as toMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CronJob, CronRun, CronSpoolRequest } from "../../lib/cron";
import type { Recurring } from "../../lib/useRecurring";
import type { CronSpoolState } from "./Changes";
import { RecurringPage } from "./RecurringPage";
import { About, RunList } from "./RecurringTask";
import { TaskActions } from "./TaskActions";
import { RecurringForm } from "./RecurringForm";

const renderToStaticMarkup = toMarkup as (el: React.ReactElement) => string;
// The test runner compiles JSX to React.createElement (the app's bundler does not need the name).
(globalThis as { React?: unknown }).React = React;

const NOW = Date.now();
const job = (name: string, over: Partial<CronJob> = {}): CronJob => ({
  name, schedule: "*-*-* 08:00", enabled: true, notify: "always", nextRun: new Date(NOW + 3600_000).toISOString(),
  prompt: "Read the errors of the last day.", repo: "shop-api", createdAt: Date.UTC(2026, 10, 12),
  lastRun: { finishedAt: NOW - 120_000, ok: true, summary: "", sentence: "No new error." }, ...over,
});
const data = (jobs: CronJob[] | null): Recurring => ({ jobs, timeZone: "UTC", refresh: async () => {} });
const spool = (requests: CronSpoolRequest[] | null = null): CronSpoolState => ({
  view: requests ? { state: "on", requests } : { state: "off" },
  track: new Map((requests ?? []).map((r) => [r.id, { sha256: r.sha256, since: NOW - 60_000 }])),
  now: NOW, load: async () => ({ state: "off" }),
});
const page = (p: { jobs: CronJob[] | null; requests?: CronSpoolRequest[]; task?: string | null; phone?: boolean }): string =>
  renderToStaticMarkup(createElement(RecurringPage, {
    data: data(p.jobs), spool: spool(p.requests ?? null), task: p.task ?? null, onTask: () => {}, ...(p.phone ? { onBack: () => {} } : {}),
  }));
const text = (html: string): string => html.replace(/<[^>]+>/g, "|");

describe("the list", () => {
  it("says each task in the page's words, what did not finish first and the paused tasks last", () => {
    const html = page({ jobs: [
      job("paused-one", { enabled: false }), job("morning-error-digest"),
      job("backup-check", { lastRun: { finishedAt: NOW - 120_000, ok: false, summary: "boom", sentence: null } }),
    ] });
    const order = [...html.matchAll(/data-task="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["backup-check", "morning-error-digest", "paused-one"]);
    const t = text(html);
    expect(t).toContain("Recurring");
    expect(t).toContain("3 tasks · 1 did not finish · 1 paused");
    expect(t).toContain("Morning error digest");
    expect(t).toContain("No new error.");
    expect(t).toContain("Every day at 08:00");
    expect(t).toContain("The last run did not finish.");
    expect(t).toContain("Paused.");
    // The words of the engine stay out of the page.
    expect(t).not.toMatch(/cron|job|\*-\*-\*/i);
  });

  it("shows the timer line of a schedule that the page cannot say only in a tooltip", () => {
    const html = page({ jobs: [job("odd", { schedule: "*-12-25 09:00" })] });
    expect(text(html)).toContain("Custom schedule");
    expect(html).toContain('title="*-12-25 09:00"');
  });

  it("says that no task exists yet", () => {
    const html = page({ jobs: [] });
    expect(text(html)).toContain("No recurring tasks yet. Press “New task” to make the first one.");
    expect(text(html)).toContain("New task");
  });

  it("the phone has the same list under its own header", () => {
    const t = text(page({ jobs: [job("morning-error-digest")], phone: true }));
    expect(t).toContain("Recurring");
    expect(t).toContain("1 task");
    expect(t).toContain("Morning error digest");
  });
});

describe("the text of an agent", () => {
  it("shows a run's sentence as plain text", () => {
    const html = page({ jobs: [job("a", { lastRun: { finishedAt: NOW, ok: true, summary: "", sentence: '<img src=x onerror="alert(1)"> done' } })] });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("changes that wait for you (a protected install)", () => {
  const REQ: CronSpoolRequest = { id: "1000-0123456789ab", at: NOW - 60_000, op: "add", name: "daily", spec: { name: "daily", prompt: "<b>x</b>" }, by: "worker-1", sha256: "ab".repeat(32) };

  it("shows nothing while nothing waits", () => {
    expect(text(page({ jobs: [job("a")] }))).not.toContain("Changes that wait for you");
    expect(text(page({ jobs: [job("a")], requests: [] }))).not.toContain("Changes that wait for you");
  });

  it("is the first thing of the list, in the page's words, with Apply and Reject", () => {
    const html = page({ jobs: [job("a")], requests: [REQ] });
    const t = text(html);
    expect(html.indexOf("Changes that wait for you")).toBeLessThan(html.indexOf('data-task="a"'));
    expect(t).toContain("New task");
    expect(t).toContain("daily");
    expect(t).toContain("asked by (unverified) worker-1");
    expect(t).toContain("Apply");
    expect(t).toContain("Reject");
    expect(html).not.toContain("<b>x</b>");
  });

  it("keeps Apply off for a request that changed after it was shown", () => {
    const html = page({ jobs: [], requests: [{ ...REQ, changed: true }] });
    expect(text(html)).toContain("Changed after it was shown. Reject it.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Apply<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Reject<\/button>/);
  });
});

describe("a task", () => {
  it("has the task's title, when it runs, its next run and what the last run said", () => {
    const html = page({ jobs: [job("morning-error-digest")], task: "morning-error-digest" });
    const t = text(html);
    expect(html).toContain('aria-label="Back to the tasks"');
    expect(t).toContain("Morning error digest");
    expect(t).toContain("Every day at 08:00");
    expect(t).toMatch(/Next run: (Today|Tomorrow) \d\d:\d\d/);
    // The "About" rail: what the task is.
    expect(t).toContain("What it does");
    expect(t).toContain("Read the errors of the last day.");
    expect(t).toContain("shop-api");
    expect(t).toContain("After every run");
  });

  it("says Paused in place of a next run, and says when a task is gone", () => {
    expect(text(page({ jobs: [job("a", { enabled: false })], task: "a" }))).toContain("Paused");
    expect(text(page({ jobs: [], task: "gone" }))).toContain("This task is not in the list now.");
  });
});

describe("the states of the list", () => {
  it("shows needs you first, with the state as the label of its dot", () => {
    const html = page({ jobs: [
      job("a-clear", { lastRun: { finishedAt: NOW, ok: true, summary: "", state: "clear", sentence: "No new error." } }),
      job("b-needs", { lastRun: { finishedAt: NOW, ok: true, summary: "", state: "needs", sentence: "2 new errors." } }),
      job("c-failed", { lastRun: { finishedAt: NOW, ok: false, summary: "", state: "failed", sentence: "It stopped with an error." } }),
    ] });
    expect([...html.matchAll(/data-task="([^"]+)" data-state="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual(["b-needs:needs", "c-failed:failed", "a-clear:clear"]);
    const t = text(html);
    expect(t).toContain("3 tasks · 1 needs you · 1 did not finish");
    expect(t).toContain("Did not finish. It stopped with an error.");
    for (const w of ["Needs you", "Did not finish", "All clear"]) expect(html).toContain(`aria-label="${w}"`);
  });
});

describe("the runs of a task", () => {
  const run = (startedAt: number, over: Partial<CronRun> = {}): CronRun => ({ startedAt, finishedAt: startedAt + 120_000, exitCode: 0, ok: true, outputTail: "the full text", ...over });
  const runs: CronRun[] = [
    run(NOW - 3600_000, { state: "needs", sentence: "2 new errors.", links: [
      { kind: "ticket", id: "qab12cd34", title: "Checkout timeout", open: true }, { kind: "pr", url: "https://github.com/acme/shop/pull/12", label: "PR #12 · acme/shop" },
    ] }),
    run(NOW - 90_000_000, { state: "clear", sentence: "No new error." }),
    run(NOW - 180_000_000, { ok: false, exitCode: 1, state: "failed", sentence: "It stopped with an error.", outputTail: "Error: <b>boom</b>" }),
    run(NOW - 270_000_000, { outputTail: "an old run" }),
  ];
  const list = (open: number[], full: number[] = [], ticket = true): string => renderToStaticMarkup(createElement(RunList, {
    runs, open: new Set(open), full: new Set(full), now: NOW, onToggle: () => {}, onFull: () => {}, ...(ticket ? { onOpenTicket: () => {} } : {}),
  }));

  it("a closed row says the state by its dot and the sentence of the run", () => {
    const html = list([]);
    const t = text(html);
    expect([...html.matchAll(/data-run="\d+" data-state="([a-z]+)"/g)].map((m) => m[1])).toEqual(["needs", "clear", "failed", "done"]);
    expect(t).toContain("2 new errors.");
    expect(t).toContain("No new error.");
    expect(t).toContain("Did not finish. It stopped with an error.");
    expect(t).toContain("Last 4 runs · 1 all clear · 1 needed you · 1 did not finish");
    expect(t).toContain("2 min");
    expect(t).not.toContain("the full text");
  });

  it("an open row shows the result and its links; the full text only on a press", () => {
    const html = list([runs[0].startedAt]);
    const t = text(html);
    expect(t).toContain("Needs you");
    expect(t).toContain("Ticket · Checkout timeout");
    expect(t).toContain("waits for you");
    expect(html).toContain('href="https://github.com/acme/shop/pull/12"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(t).toContain("See the full text of the run");
    expect(t).not.toContain("the full text|");
    expect(text(list([runs[0].startedAt], [runs[0].startedAt]))).toContain("the full text");
  });

  it("a run that did not finish, and a run with no result line, show their text at once, as plain text", () => {
    const html = list([runs[2].startedAt, runs[3].startedAt]);
    expect(html).toContain("Error: &lt;b&gt;boom&lt;/b&gt;");
    expect(html).not.toContain("<b>boom</b>");
    expect(text(html)).toContain("an old run");
    expect(text(html)).not.toContain("See the full text of the run");
  });

  it("with no queue a ticket is text, not a button", () => {
    expect(list([runs[0].startedAt], [], false)).not.toMatch(/<button[^>]*title="Open the Queue"/);
    expect(list([runs[0].startedAt])).toMatch(/<button[^>]*title="Open the Queue"/);
  });
});

describe("about a task", () => {
  const about = (over: Partial<CronJob>): string => text(renderToStaticMarkup(createElement(About, { j: job("a", over), zone: "UTC", viewerZone: "UTC", now: NOW })));
  it("says what it does, when, the repo and who it tells; never a path or a timer line", () => {
    const t = about({ notify: "on-failure" });
    for (const w of ["What it does", "Read the errors of the last day.", "When", "Every day at 08:00", "Repo", "shop-api", "Tell me", "When it needs me", "Made", "12 Nov 2026"]) expect(t).toContain(w);
    expect(t).not.toContain("*-*-*");
  });
  it("a task with no repo runs in the work folder; a paused task says so; the instructions are plain text", () => {
    expect(about({ repo: null })).toContain("The work folder");
    expect(about({ enabled: false })).toContain("Paused");
    const html = renderToStaticMarkup(createElement(About, { j: job("a", { prompt: "<script>x</script>" }), zone: "UTC", viewerZone: "UTC", now: NOW }));
    expect(html).not.toContain("<script>");
  });
});

describe("the actions of a task", () => {
  const actions = (over: Partial<CronJob> = {}, phone = false): string =>
    renderToStaticMarkup(createElement(TaskActions, { j: job("a", over), onChanged: () => {}, onDeleted: () => {}, phone }));
  const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => `${m[2]}${m[1].includes('disabled=""') ? " (off)" : ""}`);

  it("a task that is on: Run now, Pause, Delete", () => {
    expect(buttons(actions())).toEqual(["Run now", "Pause", "Delete"]);
    expect(buttons(actions({}, true))).toEqual(["Run now", "Pause", "Delete"]);
    // The task page gives the form to open: then "Change" is there.
    expect(buttons(renderToStaticMarkup(createElement(TaskActions, { j: job("a"), onChanged: () => {}, onDeleted: () => {}, onChange: () => {} })))).toEqual(["Run now", "Pause", "Change", "Delete"]);
  });
  it("a paused task: Resume, and Run now is off with the reason", () => {
    const html = actions({ enabled: false });
    expect(buttons(html)).toEqual(["Run now (off)", "Resume", "Delete"]);
    expect(html).toContain('title="This task is paused. Resume it first."');
  });
  it("a task that runs now says so, and cannot start again", () => {
    expect(buttons(actions({ running: true }))).toEqual(["Runs now… (off)", "Pause", "Delete"]);
  });
  it("the task page has the actions; the list says that a task runs now", () => {
    const html = page({ jobs: [job("a", { running: true })], task: "a" });
    expect(html).toContain("data-task-actions");
    expect(text(html)).toContain("Runs now");
    expect(text(page({ jobs: [job("a", { running: true })] }))).toContain("Runs now");
    // A task that is gone has no action.
    expect(page({ jobs: [], task: "gone" })).not.toContain("data-task-actions");
  });
});

describe("the form of a task", () => {
  const form = (task: CronJob | null, start = { repos: ["shop-api", "web"], fillIn: true }, phone = false): string =>
    renderToStaticMarkup(createElement(RecurringForm, { task, serverZone: "UTC", viewerZone: "Europe/Paris", onSaved: () => {}, onCancel: () => {}, phone, start }));
  const pressed = (html: string) => [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

  it("a new task: Describe it with Fill in, then every field; Save is off until the form is complete", () => {
    const html = form(null);
    const t = text(html);
    for (const w of ["New recurring task", "Describe it", "Fill in", "Name", "Repo", "What to do", "When", "Tell me", "Save the task", "Cancel"]) expect(t).toContain(w);
    expect(pressed(html)).toEqual(["Every day", "When it needs me"]);
    // The times of a new task are in the zone of this browser.
    expect(t).toContain("Every day at 09:00, Paris time.");
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(html).toMatch(/<option value="shop-api"[^>]*>shop-api<\/option>/);
    expect(t).not.toMatch(/cron|\*-\*-\*|systemd/i);
  });
  it("with no Fill in on the server the form has all its fields", () => {
    const t = text(form(null, { repos: [], fillIn: false }));
    expect(t).not.toContain("Describe it");
    for (const w of ["Name", "Repo", "What to do", "When", "Tell me"]) expect(t).toContain(w);
  });
  it("Change shows the task as it is, keeps its zone, and has no name field", () => {
    const html = form(job("morning-error-digest", { schedule: "Mon *-*-* 09:00 Europe/Paris", notify: "always", repo: "old-repo" }));
    const t = text(html);
    expect(t).toContain("Change · Morning error digest");
    expect(t).not.toContain("Describe it");
    expect(html).not.toContain('placeholder="Morning error digest"');
    expect(pressed(html)).toEqual(["Every week", "M", "After every run"]);
    expect(t).toContain("Every Monday at 09:00, Paris time.");
    expect(html).toContain("Read the errors of the last day.");
    // The repo of the task stays a choice when the list does not have it.
    expect(html).toMatch(/<option value="old-repo" selected="">old-repo<\/option>/);
    expect(html).not.toMatch(/<button type="submit"[^>]*disabled=""/);
  });
  it("Change of a task with a custom schedule keeps the schedule unless the user picks another", () => {
    const html = form(job("a", { schedule: "*-12-25 09:00" }));
    expect(pressed(html)).toContain("Keep as it is");
    expect(text(html)).toContain("The schedule of the task stays as it is.");
    expect(pressed(form(job("a")))).not.toContain("Keep as it is");
  });
  it("the list has New task, and the phone form has its own header", () => {
    expect(text(page({ jobs: [job("a")] }))).toContain("New task");
    expect(page({ jobs: [job("a")], phone: true })).toContain('aria-label="New task"');
    expect(text(form(null, undefined, true))).toContain("New recurring task");
  });
});
