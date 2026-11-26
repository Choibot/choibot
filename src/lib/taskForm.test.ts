// src/lib/taskForm.test.ts — the "When" of the task form and the model that the server takes.
import { describe, expect, it } from "vitest";
import { buildSchedule, readSchedule, validSchedule } from "../../server/cron/schedule";
import { HOUR_STEPS, NEW_WHEN, WHEN_KINDS, whenModel, whenOf, whenReady, type WhenState } from "./taskForm";

const w = (over: Partial<WhenState>): WhenState => ({ ...NEW_WHEN, ...over });

describe("whenModel", () => {
  it("makes the model of each kind", () => {
    expect(whenModel(w({ kind: "day", time: "08:00" }))).toEqual({ kind: "days", days: [0, 1, 2, 3, 4, 5, 6], times: ["08:00"] });
    expect(whenModel(w({ kind: "weekdays", time: "17:30" }))).toEqual({ kind: "days", days: [0, 1, 2, 3, 4], times: ["17:30"] });
    expect(whenModel(w({ kind: "week", days: [4, 0, 4], time: "09:00" }))).toEqual({ kind: "days", days: [0, 4], times: ["09:00"] });
    expect(whenModel(w({ kind: "month", monthDay: 15, time: "07:45" }))).toEqual({ kind: "month", day: 15, time: "07:45" });
    expect(whenModel(w({ kind: "hours", every: 6 }))).toEqual({ kind: "hours", every: 6, minute: 0 });
  });
  it("is not complete with no day or no time; keep sends no model and is complete", () => {
    expect(whenModel(w({ kind: "week", days: [] }))).toBeNull();
    expect(whenModel(w({ kind: "day", time: "" }))).toBeNull();
    expect(whenReady(w({ kind: "week", days: [] }))).toBe(false);
    expect(whenModel(w({ kind: "keep" }))).toBeNull();
    expect(whenReady(w({ kind: "keep" }))).toBe(true);
  });
  it("every choice of the form is a model that the server takes and can write as a timer line", () => {
    const states: WhenState[] = [
      ...WHEN_KINDS.map((k) => w({ kind: k.kind, days: [1, 3], time: "06:15", monthDay: 28 })),
      ...HOUR_STEPS.map((every) => w({ kind: "hours", every })),
    ];
    for (const st of states) {
      const m = whenModel(st)!;
      expect(validSchedule(m)).toEqual(m);
      expect(readSchedule(buildSchedule(m, "Europe/Paris"))).toEqual({ schedule: m, zone: "Europe/Paris" });
    }
  });
});

describe("whenOf", () => {
  it("shows the schedule of a task in the form, and gives the same model back", () => {
    for (const line of ["*-*-* 08:00", "Mon..Fri *-*-* 17:00", "Mon,Wed *-*-* 09:30", "Sat,Sun 10:00", "*-*-15 07:45", "*-*-* 0/6:00", "hourly"]) {
      const s = readSchedule(line)!.schedule;
      const st = whenOf(s);
      expect([line, st.kind === "keep"]).toEqual([line, false]);
      expect(whenModel(st)).toEqual(s);
    }
  });
  it("keeps a schedule that the form cannot show as it is", () => {
    expect(whenOf(null).kind).toBe("keep");
    for (const line of ["*-*-* 08,20:00", "*-*-31 09:00", "*:15", "*:0/15"]) expect([line, whenOf(readSchedule(line)!.schedule).kind]).toEqual([line, "keep"]);
  });
});
