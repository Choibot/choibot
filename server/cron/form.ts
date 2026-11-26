// server/cron/form.ts — the form of a recurring task ("New task" and "Change"): what the browser
// sends, checked field by field, and the task definition that the server makes of it. Pure
// (the page imports the limits and the name rule too).
// A task definition runs later with the rights of the console, so the browser never sends a
// path, a unit name or a timer line: the name is checked by a strict pattern, the repo is a
// name of the server's own list, and the schedule is the plain-words model, written as a timer
// line by one function (buildSchedule).
import { buildSchedule, isZone, validSchedule, type Schedule } from "./schedule";

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/; // = bin/lib/cronspec.ts NAME_RE (a node module)
export const RESERVED_NAMES: readonly string[] = ["console", "gate", "tunnel"]; // = bin/lib/cronspec.ts
export const WHAT_MAX = 8_000;
export const DRAFT_TEXT_MAX = 2_000;
export const TELLS = ["needs", "always"] as const;
export type Tell = (typeof TELLS)[number];

export type TaskForm = {
  name: string;
  // A repo of the server's list, by its name. null: the work folder.
  repo: string | null;
  what: string;
  // null: keep the schedule that the task has (Change only: a custom schedule stays as it is).
  when: Schedule | null;
  // The zone of the times (the browser's). null: the server's own zone.
  zone: string | null;
  tell: Tell;
};
export type FormField = "name" | "repo" | "what" | "when" | "tell";
export type FormError = { field: FormField; error: string };

/** "Morning error digest!" is "morning-error-digest": the name of a task from its title. */
export function nameOfTitle(title: string): string {
  return title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41).replace(/-+$/, "");
}

/** Why a name is not good, or null. */
export function nameProblem(name: string): string | null {
  if (!NAME_RE.test(name)) return "Give the task a name with letters or numbers.";
  if (RESERVED_NAMES.includes(name)) return "This name is taken by your server. Choose another name.";
  return null;
}

/**
 * The form of a request body. `name`: the name in the address for a change (the body's name is
 * then not read). A schedule that runs each few minutes is refused: each run uses the plan.
 */
export function readForm(body: unknown, mode: "new" | "change", name?: string): { ok: true; form: TaskForm } | ({ ok: false } & FormError) {
  const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const no = (field: FormField, error: string) => ({ ok: false as const, field, error });
  const taskName = mode === "change" ? String(name ?? "") : typeof b.name === "string" ? b.name : "";
  const bad = nameProblem(taskName);
  if (bad) return no("name", bad);
  if (b.repo !== null && b.repo !== undefined && (typeof b.repo !== "string" || b.repo === "" || b.repo.length > 200)) return no("repo", "Choose a repo of the list.");
  const what = typeof b.what === "string" ? b.what.trim() : "";
  if (!what) return no("what", "Say what the task does.");
  if (what.length > WHAT_MAX) return no("what", "The text is too long.");
  // The runner gives the text to the Claude program as one argument: a dash at the start would be read as an option.
  if (what.startsWith("-")) return no("what", "The text cannot start with a dash.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(what)) return no("what", "The text has a character that a task cannot have.");
  let when: Schedule | null = null;
  if (b.when === null || b.when === undefined) {
    if (mode === "new") return no("when", "Say when the task runs.");
  } else {
    when = validSchedule(b.when);
    if (!when) return no("when", "Say when the task runs.");
    if (when.kind === "minutes") return no("when", "A task cannot run more than one time each hour.");
  }
  if (b.zone !== null && b.zone !== undefined && !isZone(b.zone)) return no("when", "Your server does not know this time zone.");
  if (typeof b.tell !== "string" || !(TELLS as readonly string[]).includes(b.tell)) return no("tell", "Choose when the task tells you.");
  return { ok: true, form: { name: taskName, repo: typeof b.repo === "string" ? b.repo : null, what, when, zone: typeof b.zone === "string" ? b.zone : null, tell: b.tell as Tell } };
}

/** The fields of a task definition that the engine has (bin/lib/cronspec.ts CronJobSpec). */
export type SpecFields = {
  name: string; schedule: string; prompt: string; workdir?: string; model?: string | null; effort?: string | null; account?: string;
  timeoutMinutes?: number; notify: "always" | "on-failure"; enabled: boolean; createdAt?: number;
};

/**
 * The task definition of a form. `workdir`: the folder of the form's repo, from the server's
 * own list (undefined: the work folder). `old`: the task as it is (a change): what the form
 * does not show stays (the model, the Claude login, the time limit, on or paused, when made).
 */
export function specOfForm(form: TaskForm, workdir: string | undefined, old?: SpecFields): SpecFields {
  return {
    ...(old ? { model: old.model, effort: old.effort, ...(old.account ? { account: old.account } : {}), timeoutMinutes: old.timeoutMinutes, createdAt: old.createdAt } : {}),
    name: form.name,
    schedule: form.when ? buildSchedule(form.when, form.zone) : old?.schedule ?? "",
    prompt: form.what,
    ...(workdir ? { workdir } : {}),
    notify: form.tell === "always" ? "always" : "on-failure",
    enabled: old ? old.enabled : true,
  };
}
