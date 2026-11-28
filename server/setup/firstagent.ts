// server/setup/firstagent.ts — the first agent of a new console: one button starts one agent in
// the picked repo with a FIXED small task, safe in any repo (it changes only the README), that
// ends in a real pull request. This file also says how that agent and its pull request are
// now, in states the page turns into plain words.
//
// The console remembers only which agent it started (a small file in its data folder). All the
// rest is read fresh: the record of the agent, and the tickets of the Queue. Nothing here marks
// a step done: the checks of steps.ts read the same tickets.
// Nothing here runs by itself: only start() starts an agent.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PromptKind } from "../agents/prompt.js";
import type { AgentRecord } from "../agents/store.js";
import type { QueueItem } from "../chief/queue/types.js";

export const FIRST_TASK_TITLE = "Add a “Run it locally” section to the README";
export const FIRST_AGENT_LABEL = "First task";
// A first turn starts in seconds: after this long with no turn, the row says so.
export const NO_SESSION_MS = 90_000;

// The task, as the agent gets it. The rules of the Queue (how to add the ticket of a pull
// request) are in the instructions every agent of the console has.
export const FIRST_TASK_PROMPT = [
  "This is the first task in this repo. Keep it small and safe.",
  "",
  "1. Read the repo: the README (if there is one) and the files that say how the project is built and started (for example package.json, a Makefile, pyproject.toml, go.mod, Cargo.toml, a Dockerfile, a compose file).",
  "2. Add a short \"Run it locally\" section to the README: what to install and how to start the project, taken only from what the repo really contains. Do not invent a command. If the repo has no README, make a short one with this section.",
  "3. If the README already has such a section, correct or complete it. If nothing is wrong or missing, add a short \"Project layout\" section that names the main folders instead.",
  "4. Change only the README. No app code, no settings file, no dependency.",
  "5. Commit, push your branch and open a pull request. In its description, say in 2 or 3 sentences what you added and where the facts come from.",
  "6. Add the ticket of the pull request to the Queue, as your instructions say. Then stop.",
  "",
  "If you cannot push or cannot open the pull request, say why in one short message and stop.",
].join("\n");

// working: a turn runs. waiting: the turn ended (the agent waits for the user). ended: its
// program is not there any more. error: it stopped with an error. closed: the user closed it.
// gone: its record is deleted.
export type FirstAgentState = "working" | "waiting" | "ended" | "error" | "closed" | "gone";
// open: the ticket waits for the user. merged: GitHub says merged. closed: all else.
export type FirstTicketState = "open" | "merged" | "closed";

export type FirstView = {
  task: string;
  // The repo the button starts the agent in (a folder name): the last pick of "Pick a repo"
  // while it is there, else the first repo with push access. Null: no repo with push access.
  repo: string | null;
  // Before the start: every repo the first task can run in (the "Change" control). The names
  // are folders of the work folder that the server found. Empty once an agent started.
  repos: string[];
  agent: null | {
    id: string; name: string; state: FirstAgentState; startedAt: number;
    // The agent opened a pull request (GitHub knows it), with or without a ticket.
    pullRequest: boolean;
    // The error's own sentence when the Claude program cut its last turn (the record's `stop`):
    // a limit, a model error, a signed-out login. Not there while it works.
    error?: string;
    // NO_SESSION_MS after the start that sent the task (store.ts firstPromptAt; else the press)
    // Claude has not taken it in (the record still keeps the first message, store.ts
    // firstPrompt): its thread has no session, and Claude may wait for an answer on its screen.
    noSession: boolean;
    // A known dialog of Claude on its screen (a folder question, a login method, a picker): it
    // waits for the user's answer. The card shows the dialog with the agent pane's own card.
    dialog?: FirstDialog;
  };
  // The newest pull request ticket of that agent.
  ticket: null | { id: string; state: FirstTicketState };
  // While the first agent has no ticket that waits: the newest pull request ticket of another
  // agent (one the user started) that waits. The step "Merge the first PR" merges it on its card.
  // Null or not there: none.
  other?: null | { id: string };
  now: number;
};

// The kinds of dialog the card can show: every known one (agents/prompt.ts), not a screen the
// console does not know ("unknown": its terminal shows it).
export type FirstDialog = Exclude<PromptKind, "unknown">;

export type StartResult =
  | { ok: true; view: FirstView }
  | { ok: false; why: "no-repo" | "unknown-repo" | "working" | "busy" | "failed" };

type Kept = { agentId: string; repo: string; startedAt: number };

export type FirstAgentDeps = {
  // Where the id of the first agent is kept.
  file: string;
  agents: { load(id: string): Promise<AgentRecord | null> };
  // Where the last pick of "Pick a repo" is kept. Default: a file next to `file`.
  pickFile?: string;
  // The repos the first task can run in: the repos of the work folder that GitHub lets the
  // login push to, in the order of the work folder.
  repos: () => Promise<{ name: string; path: string }[]>;
  spawn: (req: { prompt: string; repo: string; label: string }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  // The tickets of the Queue ([] on a console with no Queue).
  tickets: () => Promise<QueueItem[]>;
  // The dialog on the agent's screen now, read as the prompt card reads it (agents/prompt-api.ts
  // readPrompt). Null: none, or no live terminal. Not given: the view has no dialog.
  dialog?: (id: string) => Promise<PromptKind | null>;
  // A start changed what the checks read.
  changed?: () => void;
  now?: () => number;
  log?: (s: string) => void;
};

const agentState = (r: AgentRecord | null): FirstAgentState => {
  if (!r) return "gone";
  if (r.closedAt !== undefined) return "closed";
  return r.status === "running" ? "working" : r.status === "idle" ? "waiting" : r.status === "error" ? "error" : "ended";
};

export const ticketState = (i: QueueItem): FirstTicketState =>
  i.status === "open" || i.status === "snoozed" ? "open" : i.status === "withdrawn" && i.lastError === "merged" ? "merged" : "closed";

// The ticket to show for an agent: one that waits for the user, else a merged one, else the newest.
export function ticketOf(items: QueueItem[], agentId: string): QueueItem | null {
  const mine = items.filter((i) => i.kind === "pr" && i.agentId === agentId).sort((a, b) => b.createdAt - a.createdAt);
  return mine.find((i) => ticketState(i) === "open") ?? mine.find((i) => ticketState(i) === "merged") ?? mine[0] ?? null;
}

// The newest pull request ticket that waits for the user, of an agent that is not `but`. Only a
// ticket of a GitHub pull request: the Merge of the Queue needs its address.
export function otherOpen(items: QueueItem[], but: string | null): QueueItem | null {
  const open = items.filter((i) => i.kind === "pr" && i.agentId !== but && ticketState(i) === "open" && !!i.pr && "url" in i.pr);
  return open.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

// The page asks for the view every few seconds. The repos are read from GitHub, so that
// answer is kept this long (a start reads it fresh).
const REPO_TTL_MS = 60_000;

type Repo = { name: string; path: string };

export class FirstAgent {
  private starting = false;
  private reposKept: { at: number; list: Repo[] } | null = null;

  private pickFile(): string { return this.d.pickFile ?? join(dirname(this.d.file), "picked-repo.json"); }

  // The user picked a repo in "Pick a repo" (a copy ended well, or the repo was there): the
  // first task uses it. The name is a folder of the work folder, given by the server's copy.
  async picked(name: string): Promise<void> {
    if (!name) return;
    this.reposKept = null;
    await this.keep(this.pickFile(), { repo: name });
  }

  private async pick(): Promise<string | null> {
    try {
      const k = JSON.parse(await readFile(this.pickFile(), "utf8")) as { repo?: unknown };
      return typeof k.repo === "string" && k.repo ? k.repo : null;
    } catch {
      return null; // no pick on record
    }
  }

  private async repos(now: number, fresh = false): Promise<Repo[]> {
    if (!fresh && this.reposKept && now - this.reposKept.at < REPO_TTL_MS) return this.reposKept.list;
    const list = await this.d.repos().catch(() => [] as Repo[]);
    this.reposKept = { at: now, list };
    return list;
  }

  // The repo of the first task with no other word from the user: the pick while it is in the
  // list (there, and with push access), else the first of the list.
  private async usual(list: Repo[]): Promise<Repo | null> {
    const pick = await this.pick();
    return list.find((r) => r.name === pick) ?? list[0] ?? null;
  }

  private async keep(file: string, value: object): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(value));
    await rename(`${file}.tmp`, file);
  }

  constructor(private d: FirstAgentDeps) {}

  private async kept(): Promise<Kept | null> {
    try {
      const k = JSON.parse(await readFile(this.d.file, "utf8")) as Partial<Kept>;
      return typeof k.agentId === "string" && typeof k.repo === "string" && typeof k.startedAt === "number" ? { agentId: k.agentId, repo: k.repo, startedAt: k.startedAt } : null;
    } catch {
      return null; // no file: no first agent yet
    }
  }

  async view(): Promise<FirstView> {
    const now = (this.d.now ?? Date.now)();
    const kept = await this.kept();
    if (!kept) {
      const [list, items] = await Promise.all([this.repos(now), this.d.tickets().catch(() => [] as QueueItem[])]);
      const other = otherOpen(items, null);
      return { task: FIRST_TASK_TITLE, repo: (await this.usual(list))?.name ?? null, repos: list.map((r) => r.name), agent: null, ticket: null, other: other && { id: other.id }, now };
    }
    const [rec, items] = await Promise.all([this.d.agents.load(kept.agentId).catch(() => null), this.d.tickets().catch(() => [] as QueueItem[])]);
    const ticket = ticketOf(items, kept.agentId);
    const other = ticket && ticketState(ticket) === "open" ? null : otherOpen(items, kept.agentId);
    // Only while the agent is there and no ticket of its pull request is on record.
    const there = rec && rec.closedAt === undefined && (rec.status === "running" || rec.status === "idle") && !ticket;
    const kind = there && this.d.dialog ? await this.d.dialog(kept.agentId).catch(() => null) : null;
    const dialog = kind && kind !== "unknown" ? kind : null;
    return {
      task: FIRST_TASK_TITLE, repo: kept.repo, repos: [],
      agent: {
        id: kept.agentId, name: rec?.label ?? FIRST_AGENT_LABEL, state: agentState(rec), startedAt: kept.startedAt, pullRequest: !!rec?.prUrl || ticket !== null,
        noSession: rec?.firstPrompt !== undefined && now - (rec.firstPromptAt ?? kept.startedAt) >= NO_SESSION_MS,
        ...(rec?.stop && rec.status !== "running" ? { error: rec.stop.text } : {}),
        ...(dialog ? { dialog } : {}),
      },
      ticket: ticket && { id: ticket.id, state: ticketState(ticket) },
      other: other && { id: other.id },
      now,
    };
  }

  // Starts the first agent. With one that is there (it works, or it waits), the answer is the
  // view and no second agent starts: a second press does nothing. `again`: start a new one
  // (the "Try again" button), but never while the first one works. `repo`: the name of the
  // repo to use (the "Change" control). It is only matched against the list this server made:
  // a name the list does not hold is refused, so no path of the browser reaches the start.
  // With no name: the repo of the agent before (a new try), else the pick, else the first.
  async start(o: { again?: boolean; repo?: string } = {}): Promise<StartResult> {
    if (this.starting) return { ok: false, why: "busy" };
    this.starting = true;
    try {
      const before = await this.view();
      if (before.agent) {
        const state = before.agent.state;
        // Its pull request waits for the user: that is the next step, not a new agent.
        if (before.ticket?.state === "open") return { ok: true, view: before };
        if (state === "working") return o.again ? { ok: false, why: "working" } : { ok: true, view: before };
        if (state === "waiting" && !o.again) return { ok: true, view: before };
      }
      const list = await this.repos((this.d.now ?? Date.now)(), true);
      let repo: Repo | null;
      if (o.repo !== undefined) {
        repo = list.find((r) => r.name === o.repo) ?? null;
        if (!repo) return { ok: false, why: "unknown-repo" };
      } else {
        repo = (before.agent ? list.find((r) => r.name === before.repo) : undefined) ?? (await this.usual(list));
      }
      if (!repo) return { ok: false, why: "no-repo" };
      const r = await this.d.spawn({ prompt: FIRST_TASK_PROMPT, repo: repo.path, label: FIRST_AGENT_LABEL });
      if (!r.ok) {
        // The cause stays in the log of the console.
        this.log(`the first agent did not start: ${r.error.slice(0, 200)}`);
        return { ok: false, why: "failed" };
      }
      const kept: Kept = { agentId: r.id, repo: repo.name, startedAt: (this.d.now ?? Date.now)() };
      await this.keep(this.d.file, kept);
      this.log(`the first agent started in ${repo.name}`);
      this.d.changed?.();
      return { ok: true, view: await this.view() };
    } finally {
      this.starting = false;
    }
  }

  private log(what: string): void {
    (this.d.log ?? ((s: string) => console.warn(s)))(`[setup] ${what}`);
  }
}
