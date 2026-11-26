// server/cron/form.test.ts — the form of a task: the name rule and the task definition.
// (The checks of readForm field by field are in api.test.ts, through the routes.)
import { describe, expect, it } from "vitest";
import { NAME_RE as ENGINE_NAME_RE, RESERVED_NAMES as ENGINE_RESERVED, validateSpec } from "../../bin/lib/cronspec.js";
import { readDraft } from "./draft.js";
import { NAME_RE, RESERVED_NAMES, nameOfTitle, nameProblem, readForm, specOfForm, type TaskForm } from "./form.js";

describe("the name of a task", () => {
  it("has the same rule as the engine", () => {
    expect(NAME_RE.source).toBe(ENGINE_NAME_RE.source);
    expect([...RESERVED_NAMES]).toEqual([...ENGINE_RESERVED]);
  });
  it.each([
    ["Morning error digest", "morning-error-digest"], ["  Coûts d'infra — hebdo!  ", "couts-d-infra-hebdo"], ["7 day sweep", "7-day-sweep"],
    ["../../etc/passwd", "etc-passwd"], ["a.timer --now", "a-timer-now"], ["日本語", ""], ["---", ""],
    ["x".repeat(80), "x".repeat(41)], [`${"ab-".repeat(13)}ab-cd`, `${"ab-".repeat(13)}ab`],
  ])("the title %j is the name %j", (title, name) => {
    expect(nameOfTitle(title)).toBe(name);
    if (name) expect(nameProblem(name)).toBeNull();
  });
  it("says why a name is not good", () => {
    expect(nameProblem("")).toBe("Give the task a name with letters or numbers.");
    expect(nameProblem("Bad Name")).not.toBeNull();
    expect(nameProblem("gate")).toBe("This name is taken by your server. Choose another name.");
  });
});

describe("specOfForm", () => {
  const form: TaskForm = { name: "digest", repo: "shop-api", what: "Read the errors.", when: { kind: "days", days: [0], times: ["09:00"] }, zone: "Europe/Paris", tell: "needs" };
  it("makes a definition that the engine takes", () => {
    const spec = specOfForm(form, "/srv/work/shop-api");
    expect(spec).toEqual({ name: "digest", schedule: "Mon *-*-* 09:00 Europe/Paris", prompt: "Read the errors.", workdir: "/srv/work/shop-api", notify: "on-failure", enabled: true });
    expect(validateSpec(spec, { workdirExists: () => true, now: 1 }).ok).toBe(true);
  });
  it("a form that the reader took always gives a definition that the engine takes", () => {
    const r = readForm({ name: "digest", repo: null, what: "  Do it.\n\nThen report.  ", when: { kind: "hours", every: 12, minute: 0 }, zone: null, tell: "always" }, "new");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateSpec(specOfForm(r.form, undefined), { workdirExists: () => true, now: 1 });
    expect(v.ok && [v.spec.schedule, v.spec.prompt, v.spec.notify, v.spec.workdir]).toEqual(["*-*-* 0/12:00", "Do it.\n\nThen report.", "always", undefined]);
  });
});

describe("readDraft", () => {
  it("reads the form of a model's answer, each field checked", () => {
    expect(readDraft('{"title":"# Costs\\u202e report","what":"Line one.\\nLine\\u0000 two.","when":{"kind":"month","day":1,"time":"09:00"},"repo":"web","tell":"always"}', ["web"])).toEqual({
      title: "Costs report", name: "costs-report", what: "Line one.\nLine two.", when: { kind: "month", day: 1, time: "09:00" }, repo: "web", tell: "always",
    });
  });
  it("an instruction text cannot start with a dash; a title has a length limit", () => {
    const d = readDraft(`{"title":"${"T".repeat(200)}","what":"--model x do it"}`, [])!;
    expect(d.what).toBe("model x do it");
    expect(d.title!.length).toBeLessThanOrEqual(60);
  });
  it.each(["", "no json", "[1,2]", "{broken", '{"other":1}', '{"title":7,"what":null,"when":"daily"}'])("%j is not the form", (text) => {
    expect(readDraft(text, [])).toBeNull();
  });
});
