// bin/lib/fleet.ts — `choibot fleet [queue|agents|leads|cron]`: the state of the fleet in short
// plain lines, for the fleet master (it gets no event line: it reads when the user asks). Read-only:
// GET routes only, in parallel. With no section it prints all of them with a cap per section;
// with a section, every line of that one. `choibot coordinator` is in the same file: the
// Coordinator's state, and `tell`, the fleet master's hand-off of a task.
import { createConsoleClient, msg, defaultIo, readStdinJson, type CliEnv } from "./client.js";
import type { Cli } from "./cli.js";
import { CLI_NAME } from "../../server/brand.js";

const HELP = `${CLI_NAME} fleet — the state of the fleet, short (read-only)

  fleet            open tickets, agents, leads, recurring tasks and the Coordinator; a few lines each
  fleet queue      every open ticket, one line each
  fleet agents     every agent that is not closed, one line each
  fleet leads      every lead with the time of its last report
  fleet cron       every recurring task with the state of its last run and its next run`;

const COORD_HELP = `${CLI_NAME} coordinator — the Coordinator (the background agent that reads the events)

  coordinator          its state and its last activity
  coordinator tell     the fleet master or the user: give it a task; JSON {"text": "..."} on stdin.
                       It can add a ticket, recommend on a ticket and write to a lead; nothing more.`;

export type FleetDeps = {
  fetch: typeof fetch;
  readStdin: () => Promise<string>;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
  env: CliEnv;
  flags: Cli["flags"];
  readFile: (p: string) => string | null;
  now?: () => number;
};

// The parts of the routes' answers that the lines use.
export type FleetTicket = {
  id: string; kind: string; agentId: string; repo: string; title: string; createdAt: number;
  blocking?: boolean; status?: string; recommend?: { value: string };
};
export type FleetAgent = { id: string; label?: string; repo?: string; status: string; kind?: string; prNumber?: number; closedAt?: number; spawnedBy?: string };
export type FleetLead = { area: string; repos?: string[]; leadId: string | null; status: string | null; reportAt: number | null };
// lastRun.state: what the console says of the run (server/cron/result.ts); an older console sends none.
export type FleetJob = { name: string; enabled?: boolean; nextRun: string | null; lastRun: { finishedAt: number; ok: boolean; state?: string } | null };
export type FleetCoordinator = { state: string; lastActivityAt: number | null; queuedEvents: number; model: string };

export const SUMMARY_CAP = 8;
const TITLE_MAX = 70;

export function ago(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const short = (id: string): string => (/^[0-9a-f]{8}-/.test(id) ? `agent-${id.slice(0, 8)}` : id);
const base = (p: string | undefined): string => (p ? p.replace(/\/+$/, "").split("/").pop() ?? "" : "");
const capped = (lines: string[], cap: number | null, more: string): string[] =>
  (cap === null || lines.length <= cap ? lines : [...lines.slice(0, cap), `  +${lines.length - cap} more: ${more}`]);

// Blocking tickets first, then the oldest first: what waits longest for the user.
export function queueLines(items: FleetTicket[], now: number, cap: number | null): string[] {
  const open = [...items].sort((a, b) => Number(b.blocking === true) - Number(a.blocking === true) || a.createdAt - b.createdAt);
  const blocking = open.filter((i) => i.blocking === true).length;
  const snoozed = open.filter((i) => i.status === "snoozed").length;
  const head = `Queue: ${open.length} open${blocking ? `, ${blocking} blocking` : ""}${snoozed ? `, ${snoozed} snoozed` : ""}`;
  const lines = open.map((i) =>
    `  ${i.id} ${i.kind}${i.blocking ? " blocking" : ""} · ${i.repo || "-"} · ${short(i.agentId)} · ${ago(now - i.createdAt)} · ${clip(flat(i.title), TITLE_MAX)}${i.recommend ? ` · suggested: ${clip(flat(i.recommend.value), 20)}` : ""}`);
  return [head, ...capped(lines, cap, `${CLI_NAME} fleet queue`)];
}

const STATE: Record<string, string> = { running: "working", idle: "waiting", error: "failed", done: "done" };
// The summary names only the failed agents; the section lists every agent that is not closed.
export function agentLines(agents: FleetAgent[], cap: number | null): string[] {
  const live = agents.filter((a) => a.closedAt === undefined);
  const n = (s: string): number => live.filter((a) => a.status === s).length;
  const counts = [[n("running"), "working"], [n("idle"), "waiting"], [n("error"), "failed"], [n("done"), "done"]]
    .filter(([c]) => c).map(([c, w]) => `${c} ${w}`).join(", ");
  const head = `Agents: ${live.length}${counts ? ` (${counts})` : ""}`;
  const line = (a: FleetAgent): string =>
    `  ${a.id} ${STATE[a.status] ?? a.status} · ${base(a.repo) || "-"}${a.prNumber ? ` · PR #${a.prNumber}` : ""}${a.spawnedBy ? ` · of ${a.spawnedBy}` : ""}${a.label ? ` · ${clip(flat(a.label), 50)}` : ""}`;
  if (cap === null) return [head, ...live.map(line)];
  return [head, ...capped(live.filter((a) => a.status === "error").map(line), cap, `${CLI_NAME} fleet agents`)];
}

export function leadLines(leads: FleetLead[], now: number): string[] {
  return [`Leads: ${leads.length}`, ...leads.map((l) =>
    `  ${l.area} ${l.leadId === null ? "no lead" : STATE[l.status ?? ""] ?? l.status ?? "not started"} · ${l.reportAt ? `report ${ago(now - l.reportAt)} ago` : "no report"}${l.repos?.length ? ` · ${l.repos.join(", ")}` : ""}`)];
}

// The state of a last run in the words of a digest line (ok: finished with no result line).
const runWord = (r: NonNullable<FleetJob["lastRun"]>): string =>
  !r.ok || r.state === "failed" ? "did-not-finish" : r.state === "clear" ? "all-clear" : r.state === "needs" ? "needs-you" : "ok";

export function cronLines(jobs: FleetJob[], now: number): string[] {
  const count = (word: string) => jobs.filter((j) => j.lastRun && runWord(j.lastRun) === word).length;
  const needs = count("needs-you"), failed = count("did-not-finish");
  return [`Recurring: ${jobs.length} task${jobs.length === 1 ? "" : "s"}${needs ? `, ${needs} need${needs === 1 ? "s" : ""} you` : ""}${failed ? `, ${failed} did not finish` : ""}`, ...jobs.map((j) =>
    `  ${j.name}${j.enabled === false ? " (paused)" : ""} · ${j.lastRun ? `${runWord(j.lastRun)} ${ago(now - j.lastRun.finishedAt).replace(/^(?!now$)(.*)$/, "$1 ago")}` : "no run yet"}${j.nextRun ? ` · next ${j.nextRun}` : ""}`)];
}

export function coordinatorLine(c: FleetCoordinator, now: number): string {
  const state = c.state === "not-started" ? "not started" : c.state;
  return `Coordinator: ${state} · ${c.lastActivityAt ? `last activity ${ago(now - c.lastActivityAt)} ago` : "no activity yet"}${c.queuedEvents ? ` · ${c.queuedEvents} event${c.queuedEvents === 1 ? "" : "s"} wait` : ""}`;
}

const SECTIONS = ["queue", "agents", "leads", "cron"] as const;
type Section = (typeof SECTIONS)[number];

export async function runFleet(sub: string | undefined, _rest: string[], overrides?: Partial<FleetDeps>): Promise<number> {
  const d: FleetDeps = { ...defaultIo(), ...overrides };
  if (sub !== undefined && !(SECTIONS as readonly string[]).includes(sub)) { d.out(HELP); return 2; }
  const only = sub as Section | undefined;
  const client = createConsoleClient(d);
  const cap = only ? null : SUMMARY_CAP;
  // One section that cannot be read does not hide the others: its line says why.
  const part = async (name: string, wanted: boolean, make: () => Promise<string[]>): Promise<string[]> => {
    if (!wanted) return [];
    try { return await make(); } catch (e) { return [`${name}: not read (${msg(e)})`]; }
  };
  const want = (s: Section): boolean => only === undefined || only === s;
  const now = (d.now ?? Date.now)();
  const parts = await Promise.all([
    part("Queue", want("queue"), async () => {
      const r = (await client.call("GET", "/api/queue?status=open")) as { items?: FleetTicket[]; serverNow?: number };
      return queueLines(r.items ?? [], r.serverNow ?? now, cap);
    }),
    part("Agents", want("agents"), async () => agentLines(((await client.call("GET", "/api/agents")) as { sessions?: FleetAgent[] }).sessions ?? [], cap)),
    part("Leads", want("leads"), async () => leadLines((await client.call("GET", "/api/leads")) as FleetLead[], now)),
    part("Cron", want("cron"), async () => cronLines(((await client.call("GET", "/api/cron/jobs")) as { jobs?: FleetJob[] }).jobs ?? [], now)),
    part("Coordinator", only === undefined, async () => [coordinatorLine((await client.call("GET", "/api/coordinator")) as FleetCoordinator, now)]),
  ]);
  d.out(parts.flat().join("\n"));
  return 0;
}

export async function runCoordinator(sub: string | undefined, _rest: string[], overrides?: Partial<FleetDeps>): Promise<number> {
  const d: FleetDeps = { ...defaultIo(), ...overrides };
  try {
    const client = createConsoleClient(d);
    if (sub === undefined) { d.out(JSON.stringify(await client.call("GET", "/api/coordinator"), null, 2)); return 0; }
    if (sub === "tell") {
      d.out(JSON.stringify(await client.call("POST", "/api/coordinator/task", await readStdinJson(d, sub)), null, 2));
      return 0;
    }
    d.out(COORD_HELP);
    return 2;
  } catch (e) {
    d.err(msg(e));
    return 1;
  }
}
