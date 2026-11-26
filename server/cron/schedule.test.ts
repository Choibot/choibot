import { describe, expect, it } from "vitest";
import { buildSchedule, describeSchedule, isZone, readSchedule, scheduleWords, validSchedule, zoneWords, type Schedule } from "./schedule.js";

const words = (line: string) => { const r = readSchedule(line); return r ? scheduleWords(r.schedule) : null; };

describe("readSchedule + scheduleWords", () => {
  it.each([
    ["*-*-* 08:00", "Every day at 08:00"],
    ["*-*-* 08:00:00", "Every day at 08:00"],
    ["*-*-* 8:5", "Every day at 08:05"],
    ["daily", "Every day at 00:00"],
    ["08:30", "Every day at 08:30"],
    ["Mon *-*-* 09:00", "Every Monday at 09:00"],
    ["Mon 09:00", "Every Monday at 09:00"],
    ["monday *-*-* 09:00", "Every Monday at 09:00"],
    ["weekly", "Every Monday at 00:00"],
    ["Mon..Fri *-*-* 17:00", "Every weekday at 17:00"],
    ["Mon-Fri 17:00", "Every weekday at 17:00"],
    ["Mon,Tue,Wed,Thu,Fri *-*-* 17:00", "Every weekday at 17:00"],
    ["Sat,Sun *-*-* 10:00", "Every Saturday and Sunday at 10:00"],
    ["Mon,Wed,Fri *-*-* 09:00", "Every Monday, Wednesday and Friday at 09:00"],
    ["Sat..Mon 07:00", "Every Monday, Saturday and Sunday at 07:00"],
    ["Mon..Sun 07:00", "Every day at 07:00"],
    ["*-*-* 08,20:00", "Every day at 08:00 and 20:00"],
    ["*-*-01 09:00", "On day 1 of every month at 09:00"],
    ["*-*-15 09:30:00", "On day 15 of every month at 09:30"],
    ["monthly", "On day 1 of every month at 00:00"],
    ["hourly", "Every hour"],
    ["*:00", "Every hour"],
    ["*-*-* *:00:00", "Every hour"],
    ["*:15", "Every hour, at minute 15"],
    ["*-*-* 0/6:00", "Every 6 hours"],
    ["*-*-* 00/6:00:00", "Every 6 hours"],
    ["*-*-* */4:30", "Every 4 hours, at minute 30"],
    ["*-*-* 00,06,12,18:00", "Every 6 hours"],
    ["*-*-* 00,12:00", "Every 12 hours"],
    ["*:0/15", "Every 15 minutes"],
    ["*-*-* *:00/30", "Every 30 minutes"],
    ["minutely", "Every minute"],
  ])("%s is %s", (line, want) => expect(words(line)).toBe(want));

  it.each([
    "", "   ", "2026-12-24 09:00", "*-12-25 09:00", "Mon *-*-01 09:00", "*-*-1,15 09:00", "*-*-* 09:00:30",
    "*-*-* 25:00", "*-*-* 09:61", "Mon..Fri 0/6:00", "*-*-* 0/5:00", "*:0/7", "*-*-* 01,02,03,04,05:00",
    "quarterly", "yearly", "Mox 09:00", "*-*-32 09:00", "*-*-* 09:00 extra words", "Mon..Wed..Fri 09:00", "*-*~1 09:00",
  ])("%j is a custom schedule", (line) => expect(readSchedule(line)).toBeNull());

  it("reads the zone name at the end of the line", () => {
    expect(readSchedule("Mon *-*-* 09:00 Europe/Paris")).toEqual({ schedule: { kind: "days", days: [0], times: ["09:00"] }, zone: "Europe/Paris" });
    expect(readSchedule("*-*-* 08:00 UTC")?.zone).toBe("UTC");
    expect(readSchedule("daily America/Argentina/Buenos_Aires")?.zone).toBe("America/Argentina/Buenos_Aires");
    expect(readSchedule("*-*-* 08:00")?.zone).toBeNull();
  });

  it("keeps the times in order and drops a repeated hour", () => {
    expect(words("*-*-* 20,08:00")).toBe("Every day at 08:00 and 20:00");
    expect(readSchedule("*-*-* 08,08:00")).toBeNull();
  });
});

describe("zoneWords", () => {
  it("says a zone as a place", () => {
    expect(zoneWords("Europe/Paris")).toBe("Paris time");
    expect(zoneWords("America/New_York")).toBe("New York time");
    expect(zoneWords("UTC")).toBe("UTC");
    expect(zoneWords("Etc/UTC")).toBe("UTC");
  });
});

describe("describeSchedule", () => {
  it("does not say the viewer's own zone", () => {
    expect(describeSchedule("Mon *-*-* 09:00 Europe/Paris", "UTC", "Europe/Paris")).toEqual({ words: "Every Monday at 09:00", zone: "Europe/Paris", custom: false });
    expect(describeSchedule("*-*-* 08:00", "Europe/Paris", "Europe/Paris").words).toBe("Every day at 08:00");
  });
  it("says another zone: the line's own, else the server's", () => {
    expect(describeSchedule("Mon *-*-* 09:00 Europe/Paris", "UTC", "America/New_York").words).toBe("Every Monday at 09:00, Paris time");
    expect(describeSchedule("*-*-* 08:00", "Etc/UTC", "Europe/Paris").words).toBe("Every day at 08:00, UTC");
    expect(describeSchedule("*-*-* 08:00", "UTC", "Etc/UTC").words).toBe("Every day at 08:00");
  });
  it("says nothing of a zone it does not know", () => {
    expect(describeSchedule("*-*-* 08:00", null, "Europe/Paris").words).toBe("Every day at 08:00");
    expect(describeSchedule("*-*-* 08:00", "UTC", null).words).toBe("Every day at 08:00");
  });
  it("a line the model cannot say is a custom schedule", () => {
    expect(describeSchedule("*-12-25 09:00", "UTC", "UTC")).toEqual({ words: "Custom schedule", zone: "UTC", custom: true });
  });
});

describe("buildSchedule", () => {
  const CASES: [Schedule, string | null, string][] = [
    [{ kind: "days", days: [0, 1, 2, 3, 4, 5, 6], times: ["08:00"] }, null, "*-*-* 08:00"],
    [{ kind: "days", days: [0, 1, 2, 3, 4], times: ["17:30"] }, "Europe/Paris", "Mon..Fri *-*-* 17:30 Europe/Paris"],
    [{ kind: "days", days: [0], times: ["09:00"] }, "Europe/Paris", "Mon *-*-* 09:00 Europe/Paris"],
    [{ kind: "days", days: [0, 2, 4], times: ["09:00"] }, "UTC", "Mon,Wed,Fri *-*-* 09:00 UTC"],
    [{ kind: "days", days: [5, 6], times: ["10:00"] }, null, "Sat,Sun *-*-* 10:00"],
    [{ kind: "days", days: [0, 1, 2, 3, 4, 5, 6], times: ["08:00", "20:00"] }, "America/New_York", "*-*-* 08,20:00 America/New_York"],
    [{ kind: "month", day: 1, time: "09:00" }, "Asia/Tokyo", "*-*-01 09:00 Asia/Tokyo"],
    [{ kind: "month", day: 15, time: "07:45" }, null, "*-*-15 07:45"],
    [{ kind: "hours", every: 6, minute: 0 }, null, "*-*-* 0/6:00"],
    [{ kind: "hours", every: 1, minute: 15 }, "UTC", "*-*-* *:15 UTC"],
    [{ kind: "hours", every: 12, minute: 30 }, "Europe/Paris", "*-*-* 0/12:30 Europe/Paris"],
    [{ kind: "minutes", every: 15 }, null, "*-*-* *:0/15"],
  ];
  it.each(CASES)("%j in %s is %s", (s, zone, line) => expect(buildSchedule(s, zone)).toBe(line));
  it.each(CASES)("the reader gives %j in %s back", (s, zone) => {
    expect(readSchedule(buildSchedule(s, zone))).toEqual({ schedule: s, zone });
  });
  it("a line has no character but those of a timer line, whatever valid model it gets", () => {
    for (const [s, zone] of CASES) expect(buildSchedule(s, zone)).toMatch(/^[A-Za-z0-9 ,.*:\/_+-]+$/);
  });
});

describe("validSchedule", () => {
  it("takes a model, with its days and times put in order", () => {
    expect(validSchedule({ kind: "days", days: [4, 0, 2], times: ["20:00", "08:00"] })).toEqual({ kind: "days", days: [0, 2, 4], times: ["08:00", "20:00"] });
    expect(validSchedule({ kind: "month", day: 28, time: "09:00" })).toEqual({ kind: "month", day: 28, time: "09:00" });
    expect(validSchedule({ kind: "hours", every: 6, minute: 0 })).toEqual({ kind: "hours", every: 6, minute: 0 });
    expect(validSchedule({ kind: "minutes", every: 15 })).toEqual({ kind: "minutes", every: 15 });
  });
  it("drops every field that is not of the model", () => {
    expect(validSchedule({ kind: "month", day: 1, time: "09:00", line: "*-*-* *:*:*", unit: "x.timer" })).toEqual({ kind: "month", day: 1, time: "09:00" });
  });
  it.each([
    null, undefined, "daily", 7, [], {}, { kind: "cron" }, { kind: "__proto__" },
    { kind: "days", days: [], times: ["08:00"] }, { kind: "days", days: [7], times: ["08:00"] }, { kind: "days", days: [0, 0], times: ["08:00"] },
    { kind: "days", days: ["0"], times: ["08:00"] }, { kind: "days", days: [0.5], times: ["08:00"] }, { kind: "days", days: [0], times: [] },
    { kind: "days", days: [0], times: ["8:00"] }, { kind: "days", days: [0], times: ["24:00"] }, { kind: "days", days: [0], times: ["08:60"] },
    { kind: "days", days: [0], times: ["08:00\nOnCalendar=*:*"] }, { kind: "days", days: [0], times: ["08:00 UTC"] },
    { kind: "days", days: [0], times: ["08:00", "20:30"] }, { kind: "days", days: [0], times: ["01:00", "02:00", "03:00", "04:00", "05:00"] },
    { kind: "days", days: "0", times: "08:00" },
    { kind: "month", day: 0, time: "09:00" }, { kind: "month", day: 32, time: "09:00" }, { kind: "month", day: "1", time: "09:00" }, { kind: "month", day: 1, time: 900 },
    { kind: "hours", every: 5, minute: 0 }, { kind: "hours", every: 24, minute: 0 }, { kind: "hours", every: 6, minute: 60 }, { kind: "hours", every: 6, minute: -1 }, { kind: "hours", every: "6", minute: 0 },
    { kind: "minutes", every: 7 }, { kind: "minutes", every: 0 }, { kind: "minutes", every: 60 },
  ])("refuses %j", (x) => expect(validSchedule(x)).toBeNull());
});

describe("isZone", () => {
  it("takes UTC and the zone names that the server knows, nothing else", () => {
    for (const z of ["UTC", "Europe/Paris", "America/New_York", "America/Argentina/Buenos_Aires", "Asia/Tokyo"]) expect([z, isZone(z)]).toEqual([z, true]);
    for (const z of ["", "Paris", "Europe/Atlantis", "Europe/Paris\nOnCalendar=*:*", "Europe/Paris *:*", "../etc", "UTC;x", 7, null, undefined, "A".repeat(80)]) expect([z, isZone(z)]).toEqual([z, false]);
  });
});
