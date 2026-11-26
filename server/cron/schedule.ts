// server/cron/schedule.ts — the schedule of a recurring task as a small model and as plain
// words ("Every Monday at 09:00"). The timer line (systemd OnCalendar) stays the stored form:
// readSchedule() turns the lines this model can say into the model, and everything else is a
// "custom schedule" that the page shows with no words of its own. Pure: the page imports it too.

/** Monday is 0, Sunday is 6. */
export type Schedule =
  | { kind: "days"; days: number[]; times: string[] }   // on these week days, at each "HH:MM"
  | { kind: "month"; day: number; time: string }        // on this day of each month
  | { kind: "hours"; every: number; minute: number }    // every N hours, at this minute
  | { kind: "minutes"; every: number };                 // every N minutes

/** `zone`: the zone name at the end of the line (IANA or UTC), or null: the server's own zone. */
export type ReadSchedule = { schedule: Schedule; zone: string | null };

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const ZONE_RE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;
const MAX_TIMES = 4;

const SHORTHAND: Record<string, Schedule> = {
  minutely: { kind: "minutes", every: 1 },
  hourly: { kind: "hours", every: 1, minute: 0 },
  daily: { kind: "days", days: ALL_DAYS, times: ["00:00"] },
  weekly: { kind: "days", days: [0], times: ["00:00"] },
  monthly: { kind: "month", day: 1, time: "00:00" },
};

const pad = (n: number) => String(n).padStart(2, "0");
const int = (s: string, max: number): number | null => (/^\d{1,2}$/.test(s) && Number(s) <= max ? Number(s) : null);

function dayIndex(word: string): number | null {
  const w = word.toLowerCase();
  const i = DAY_KEYS.findIndex((k) => w === k || w === DAY_NAMES[DAY_KEYS.indexOf(k)].toLowerCase());
  return i === -1 ? null : i;
}

// "Mon", "Mon..Fri", "Mon-Fri", "Sat,Sun", "Mon,Wed..Fri": the sorted days, or null.
function readDays(token: string): number[] | null {
  const days = new Set<number>();
  for (const part of token.split(",")) {
    const ends = part.split(/\.\.|-/);
    if (ends.length > 2) return null;
    const from = dayIndex(ends[0]);
    const to = ends.length === 2 ? dayIndex(ends[1]) : from;
    if (from === null || to === null) return null;
    // A range can go past Sunday ("Sat..Mon").
    for (let d = from; ; d = (d + 1) % 7) { days.add(d); if (d === to) break; }
  }
  return days.size ? [...days].sort((a, b) => a - b) : null;
}

// "*-*-*": every day. "*-*-01": that day of each month. Else null (a year, a month, a list).
function readDate(token: string): { day: number | null } | null {
  const m = /^\*-\*-(\*|\d{1,2})$/.exec(token);
  if (!m) return null;
  if (m[1] === "*") return { day: null };
  const day = Number(m[1]);
  return day >= 1 && day <= 31 ? { day } : null;
}

type Time =
  | { t: "at"; times: string[] }
  | { t: "hours"; every: number; minute: number }
  | { t: "minutes"; every: number };

// "09:00", "09:00:00", "08,20:00", "*:00", "*:15", "0/6:00", "*:0/15".
function readTime(token: string): Time | null {
  const parts = token.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.length === 3 && !/^0{1,2}$/.test(parts[2])) return null;
  const [h, m] = parts;
  const everyMin = /^(?:\*|0{1,2})\/(\d{1,2})$/.exec(m);
  if (everyMin) {
    const every = Number(everyMin[1]);
    return h === "*" && every >= 1 && every <= 30 && 60 % every === 0 ? { t: "minutes", every } : null;
  }
  const minute = int(m, 59);
  if (minute === null) return null;
  if (h === "*") return { t: "hours", every: 1, minute };
  const everyHour = /^(?:\*|0{1,2})\/(\d{1,2})$/.exec(h);
  if (everyHour) {
    const every = Number(everyHour[1]);
    return every >= 1 && every <= 12 && 24 % every === 0 ? { t: "hours", every, minute } : null;
  }
  const hours = h.split(",").map((x) => int(x, 23));
  if (hours.some((x) => x === null) || new Set(hours).size !== hours.length) return null;
  const sorted = (hours as number[]).sort((a, b) => a - b);
  // "00,06,12,18:00" is "every 6 hours".
  const step = sorted.length > 1 ? sorted[1] - sorted[0] : 0;
  if (sorted.length > 1 && sorted[0] === 0 && 24 % step === 0 && sorted.length === 24 / step && sorted.every((x, i) => x === i * step)) {
    return { t: "hours", every: step, minute };
  }
  if (sorted.length > MAX_TIMES) return null;
  return { t: "at", times: sorted.map((x) => `${pad(x)}:${pad(minute)}`) };
}

/** The model of a timer line, or null: a line this model cannot say (a custom schedule). */
export function readSchedule(line: string): ReadSchedule | null {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  let zone: string | null = null;
  if (tokens.length > 1 && ZONE_RE.test(tokens[tokens.length - 1])) zone = tokens.pop()!;
  if (tokens.length === 1 && SHORTHAND[tokens[0].toLowerCase()]) return { schedule: SHORTHAND[tokens[0].toLowerCase()], zone };

  let days: number[] | null = null;
  let date: { day: number | null } = { day: null };
  let time: Time = { t: "at", times: ["00:00"] };
  let i = 0;
  if (i < tokens.length && /^[A-Za-z]/.test(tokens[i])) {
    days = readDays(tokens[i++]);
    if (!days) return null;
  }
  if (i < tokens.length && tokens[i].includes("-")) {
    const d = readDate(tokens[i++]);
    if (!d) return null;
    date = d;
  }
  if (i < tokens.length) {
    const t = readTime(tokens[i++]);
    if (!t) return null;
    time = t;
  }
  if (i !== tokens.length) return null;

  if (date.day !== null) {
    // A day of the month with week days ("the first Monday") is not in the model.
    if (days || time.t !== "at" || time.times.length !== 1) return null;
    return { schedule: { kind: "month", day: date.day, time: time.times[0] }, zone };
  }
  if (time.t === "at") return { schedule: { kind: "days", days: days ?? ALL_DAYS, times: time.times }, zone };
  // "Every 6 hours" on some week days only is not in the model.
  if (days && days.length !== 7) return null;
  return { schedule: time.t === "hours" ? { kind: "hours", every: time.every, minute: time.minute } : { kind: "minutes", every: time.every }, zone };
}

// ---- from the model to the timer line (the form of the page) ------------------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];
const MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const isInt = (x: unknown, min: number, max: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;

/** A zone that a timer line can name: "UTC" or an IANA name that this server knows. */
export function isZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length > 64 || !ZONE_RE.test(zone)) return false;
  if (zone === "UTC") return true;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: zone }); return true; } catch { return false; }
}

/**
 * The model of a value that the browser sent, or null. Strict: only the fields of the model,
 * each of its fixed kind and range. The result has its days and times in order.
 */
export function validSchedule(x: unknown): Schedule | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  switch (o.kind) {
    case "days": {
      if (!Array.isArray(o.days) || !Array.isArray(o.times)) return null;
      const days = [...new Set(o.days)];
      const times = [...new Set(o.times)];
      if (days.length === 0 || days.length !== o.days.length || !days.every((d) => isInt(d, 0, 6))) return null;
      if (times.length === 0 || times.length > MAX_TIMES || times.length !== o.times.length || !times.every((t) => typeof t === "string" && TIME_RE.test(t))) return null;
      // One timer line has one minute for all its hours ("08,20:00").
      if (new Set((times as string[]).map((t) => t.slice(3))).size !== 1) return null;
      return { kind: "days", days: (days as number[]).sort((a, b) => a - b), times: (times as string[]).sort() };
    }
    case "month":
      return isInt(o.day, 1, 31) && typeof o.time === "string" && TIME_RE.test(o.time) ? { kind: "month", day: o.day, time: o.time } : null;
    case "hours":
      return isInt(o.every, 1, 12) && HOUR_STEPS.includes(o.every) && isInt(o.minute, 0, 59) ? { kind: "hours", every: o.every, minute: o.minute } : null;
    case "minutes":
      return isInt(o.every, 1, 30) && MINUTE_STEPS.includes(o.every) ? { kind: "minutes", every: o.every } : null;
    default:
      return null;
  }
}

function daysToken(days: number[]): string {
  if (days.length === 7) return "";
  // A run of days is a range ("Mon..Fri"); else a list ("Mon,Wed,Fri").
  const run = days.length >= 3 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const name = (d: number) => DAY_KEYS[d][0].toUpperCase() + DAY_KEYS[d].slice(1);
  return `${run ? `${name(days[0])}..${name(days[days.length - 1])}` : days.map(name).join(",")} `;
}

/**
 * The timer line (systemd OnCalendar) of a model. The one place that writes a timer line from
 * what the page sends: `s` comes from validSchedule and `zone` from isZone (null: no zone name,
 * the server's own zone). readSchedule(buildSchedule(s, zone)) gives `s` and `zone` back.
 */
export function buildSchedule(s: Schedule, zone: string | null): string {
  const at = zone ? ` ${zone}` : "";
  switch (s.kind) {
    case "days": return `${daysToken(s.days)}*-*-* ${s.times.map((t) => t.slice(0, 2)).join(",")}:${s.times[0].slice(3)}${at}`;
    case "month": return `*-*-${pad(s.day)} ${s.time}${at}`;
    case "hours": return `*-*-* ${s.every === 1 ? "*" : `0/${s.every}`}:${pad(s.minute)}${at}`;
    case "minutes": return `*-*-* *:0/${s.every}${at}`;
  }
}

function list(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function daysWords(days: number[]): string {
  if (days.length === 7) return "Every day";
  if (days.length === 5 && days.every((d, i) => d === i)) return "Every weekday";
  return `Every ${list(days.map((d) => DAY_NAMES[d]))}`;
}

/** "Every Monday at 09:00", "Every 6 hours", "On day 1 of every month at 09:00". */
export function scheduleWords(s: Schedule): string {
  switch (s.kind) {
    case "days": return `${daysWords(s.days)} at ${list(s.times)}`;
    case "month": return `On day ${s.day} of every month at ${s.time}`;
    case "hours": {
      const every = s.every === 1 ? "Every hour" : `Every ${s.every} hours`;
      return s.minute === 0 ? every : `${every}, at minute ${pad(s.minute)}`;
    }
    case "minutes": return s.every === 1 ? "Every minute" : `Every ${s.every} minutes`;
  }
}

/** "Europe/Paris" is "Paris time"; "America/New_York" is "New York time"; "UTC" stays. */
export function zoneWords(zone: string): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC";
  return `${zone.slice(zone.lastIndexOf("/") + 1).replace(/_/g, " ")} time`;
}

const sameZone = (a: string, b: string) => a === b || (zoneWords(a) === "UTC" && zoneWords(b) === "UTC");

/**
 * What the page shows for a task's timer line. `serverZone`: the zone of a line with no zone
 * name. `viewerZone`: the browser's. The zone is said only when it is not the viewer's own.
 * `custom`: the model cannot say this line; `words` is then "Custom schedule".
 */
export function describeSchedule(line: string, serverZone: string | null, viewerZone: string | null): { words: string; zone: string | null; custom: boolean } {
  const read = readSchedule(line);
  const zone = read?.zone ?? serverZone;
  if (!read) return { words: "Custom schedule", zone, custom: true };
  const words = scheduleWords(read.schedule);
  const say = zone !== null && viewerZone !== null && !sameZone(zone, viewerZone);
  return { words: say ? `${words}, ${zoneWords(zone)}` : words, zone, custom: false };
}
