// server/setup/probes.ts — the probes that read a real box for the step list (steps.ts).
// Two groups:
//   boxProbes      facts of the box itself (tools, logins, repos). The CLI and the console run
//                  the same code, so `doctor` and the browser agree.
//   consoleProbes  facts only the running console has (devices, agents, tickets, leads).
// A probe gives facts, never a verdict: the checks in steps.ts decide. No probe gives a secret,
// a file path or a settings key: the bot token and the logins stay in here.
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { run, which } from "../../bin/lib/exec.js";
import { accountPaths, listAccounts } from "../agents/accounts.js";
import type { ClaudeAccount } from "../../bin/lib/login.js";
import { agentAuthOf, agentLoginStatus } from "../agents/agentlogin.js";
import { runGit } from "../agents/git.js";
import { isPersistentKind, type AgentRecord } from "../agents/store.js";
import type { DeviceView } from "../chief/auth.js";
import { deadline } from "../chief/deadline.js";
import type { Areas } from "../chief/leads/areas.js";
import type { QueueItem } from "../chief/queue/types.js";
import { resolveClaudeBin, resolveWorkspaceDir, type Env } from "../defaults.js";
import type { AppTokenState } from "../gh/applogin.js";
import { gh, GhError } from "../gh/exec.js";
import { listRepos } from "../gh/repos.js";
import { telegramConfig, type BotInfo } from "../settings/telegram.js";
import { parseIssuesUserId } from "../issues/paths.js";
import type { BoxFacts, Probes } from "./steps.js";

// No tool call of a probe waits longer than this.
const TOOL_MS = 15_000;
// A GitHub login: letters, digits and single hyphens.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
// Repos asked for push access: this many at a time, this many in all.
const REPO_BATCH = 5;
const REPO_MAX = 30;

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

// The repos of the work folder (by folder name, in order) that have a commit and that GitHub
// lets this login push to. `first`: stop at the first one (the check of the step needs no
// more). The first task can run in each of them (firstagent.ts).
export async function pushRepos(env: Env, o: { first?: boolean } = {}): Promise<{ onBox: number; names: string[] }> {
  const all = (await listRepos(resolveWorkspaceDir(env))).slice(0, REPO_MAX);
  const pushable = async (r: { slug: string; path: string }): Promise<boolean> => {
    try {
      await runGit(r.path, ["-C", r.path, "rev-parse", "--verify", "-q", "HEAD"], { timeout: TOOL_MS }, r.path);
      return (await deadline(gh(["api", `repos/${r.slug}`, "--jq", ".permissions.push"]), TOOL_MS, "the repo access")).trim() === "true";
    } catch {
      return false; // no commit yet, or GitHub gives no answer for this repo
    }
  };
  const names: string[] = [];
  for (let i = 0; i < all.length; i += REPO_BATCH) {
    const batch = all.slice(i, i + REPO_BATCH);
    const yes = await Promise.all(batch.map(pushable));
    names.push(...batch.filter((_, n) => yes[n]).map((r) => r.name));
    if (o.first && names.length) return { onBox: all.length, names: names.slice(0, 1) };
  }
  return { onBox: all.length, names };
}

// The private address in the answer of `tailscale serve status`.
export function privateAddress(serveStatus: string): string | null {
  return serveStatus.match(/https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*/)?.[0] ?? null;
}

// The private address of THIS console (https://<name>), when Tailscale hands the console's
// port to the user's own network (the same test as the `access` probe below). Null: none.
export async function consoleAddress(env: Env): Promise<string | null> {
  if (!(await which("tailscale"))) return null;
  const r = await run("tailscale", ["serve", "status"], { timeoutMs: TOOL_MS });
  if (r.code !== 0 || !r.stdout.includes(`127.0.0.1:${env.PORT || "3100"}`)) return null;
  return privateAddress(r.stdout);
}

export type BoxDeps = {
  // The settings of the console: the env it runs with, or (the CLI) the values of its file.
  env: Env;
  // The facts of the technical checks (bin/lib/doctor.ts boxFacts).
  box: () => Promise<BoxFacts>;
  // Strong protection: the read of the agents' login (agentlogin.ts). The server gives its kept
  // read (null: no helper); with none given, the settings decide (the CLI).
  agentStatus?: (() => Promise<ClaudeAccount>) | null;
  // The GitHub app switch is on: the state of the app's key (gh/applogin.ts). Then the step is
  // done only with that key, never with another login of gh.
  githubApp?: () => Promise<AppTokenState>;
};

export function boxProbes(d: BoxDeps): Pick<Probes, "box" | "claude" | "access" | "github" | "repos"> {
  const env = d.env;
  return {
    box: d.box,

    // The Claude program is there, and a login of it is on the box. (One small real request,
    // the second half of the design's check, needs the login step of the installer.)
    async claude() {
      const bin = resolveClaudeBin(env);
      const installed = isAbsolute(bin) && executable(bin);
      // Strong protection: the one login is the agents' own, read through the helper.
      const fromSettings = d.agentStatus === undefined ? agentAuthOf(env) : null;
      const agents = d.agentStatus ?? (fromSettings ? () => agentLoginStatus(fromSettings) : null);
      if (agents) return { installed, loggedIn: (await agents()).loggedIn };
      const loggedIn = (await listAccounts(accountPaths(env))).some((a) => a.loggedIn);
      return { installed, loggedIn };
    },

    // The private address: Tailscale hands the console's port to the user's own network.
    async access() {
      if (!(await which("tailscale"))) return { state: "none" };
      const r = await run("tailscale", ["serve", "status"], { timeoutMs: TOOL_MS });
      if (r.code !== 0) return { state: "signed-out" };
      return { state: r.stdout.includes(`127.0.0.1:${env.PORT || "3100"}`) ? "ready" : "no-address" };
    },

    // GitHub answers with a login, and the box has a name and an e-mail for commits. GitHub and
    // git run through the console's own helpers (gh/exec.ts, agents/git.ts), as every call of
    // the server does.
    async github() {
      const set = async (key: string): Promise<boolean> => {
        try {
          return (await runGit(process.cwd(), ["config", "--global", "--get", key], { timeout: TOOL_MS })).stdout.trim() !== "";
        } catch {
          return false; // git gives exit 1 for a key that is not set
        }
      };
      let unsaved = false;
      if (d.githubApp) {
        const t = await d.githubApp();
        // No key of the app: not connected. The GitHub tool itself is checked once a key is
        // there, by the call of gh below (it says "not on your server" then).
        if (t.state !== "ok") {
          const appProblem = t.state === "none" ? "app-none" : t.why === "refused" ? "app-refused" : "app-ended";
          return { installed: true, login: null, problem: appProblem, commitName: false };
        }
        unsaved = t.unsaved === true;
      }
      let login: string | null = null;
      let problem: "signed-out" | "no-answer" | undefined;
      try {
        const name = (await deadline(gh(["api", "user", "--jq", ".login"]), TOOL_MS, "the GitHub login")).trim();
        if (LOGIN_RE.test(name)) login = name; else problem = "no-answer";
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        if (/ENOENT/.test(text)) return { installed: false, login: null, commitName: false };
        problem = (e instanceof GhError && e.kind === "not_authed") || /bad credentials|HTTP 401/i.test(text) ? "signed-out" : "no-answer";
      }
      return { installed: true, login, ...(problem ? { problem } : {}), ...(unsaved ? { unsaved } : {}), commitName: (await set("user.name")) && (await set("user.email")) };
    },

    // The repos of the workspace with a GitHub address, and the first one (by name) that has a
    // commit and that GitHub lets this login push to.
    async repos() {
      const r = await pushRepos(env, { first: true });
      return { onBox: r.onBox, canPush: r.names[0] ?? null };
    },
  };
}

export type ConsoleDeps = {
  env: Env;
  agents: { list(): Promise<AgentRecord[]>; exists(id: string): Promise<boolean> };
  // The chief of staff (the Queue, device pairing), when it is on. `problem`: why it does not
  // run, or null.
  chief?: {
    problem: string | null;
    devices: { list(): Promise<DeviceView[]> };
    queue: { list(): Promise<QueueItem[]> };
  };
  // The lead areas, when leads run.
  areas?: { read(): Promise<Areas> };
  // Does Telegram accept the bot of this token? (settings/telegram.ts BotCheck: cached.)
  bot: (token: string) => Promise<BotInfo>;
  // The account connected with a one-time code (settings/link.ts): is one connected, its name,
  // and did the test message go out. Absent: the console has no such state.
  link?: () => Promise<{ connected: boolean; name: string | null; tested: boolean }>;
};

// One set per run of the list: the tickets are read one time for both probes that need them.
export function consoleProbes(d: ConsoleDeps): Pick<Probes, "devices" | "agents" | "merged" | "telegram" | "leads"> {
  const chiefRuns = !!d.chief && d.chief.problem === null;
  let items: Promise<QueueItem[]> | undefined;
  const prTickets = async (): Promise<QueueItem[]> =>
    (await (items ??= d.chief ? d.chief.queue.list() : Promise.resolve([]))).filter((i) => i.kind === "pr");

  return {
    async devices() {
      if (!d.chief || !chiefRuns) return { pairing: false, count: 0 };
      return { pairing: true, count: (await d.chief.devices.list()).length };
    },

    // Worker agents (not the fleet master, not a lead), and the pull requests on record: a
    // ticket stays after its agent is gone, so the first agent still counts later.
    async agents() {
      const workers = (await d.agents.list()).filter((r) => !isPersistentKind(r.kind));
      return {
        started: workers.length,
        running: workers.filter((r) => r.status === "running" && r.closedAt === undefined).length,
        pullRequests: (await prTickets()).length,
        tickets: chiefRuns,
      };
    },

    // A pull request ticket that closed because GitHub says "merged" (the Merge button of the
    // Queue, or a merge on github.com: queue/prwatch.ts).
    async merged() {
      return { count: (await prTickets()).filter((i) => i.status === "withdrawn" && i.lastError === "merged").length };
    },

    async telegram() {
      const token = (d.env.TELEGRAM_BOT_TOKEN ?? "").trim();
      if (!token) return { bot: "none", account: false, tested: false, name: null, tickets: false, master: false };
      const targets = telegramConfig(d.env, { active: chiefRuns, problem: d.chief?.problem ?? null }).targets;
      const queue = targets.find((t) => t.id === "queue");
      const link = d.link ? await d.link() : null;
      return {
        bot: (await d.bot(token)).ok ? "ok" : "failed",
        account: link ? link.connected : parseIssuesUserId(d.env.TELEGRAM_ISSUES_USER_ID) !== null,
        tested: link?.tested === true,
        name: link?.name ?? null,
        tickets: !!queue && queue.missing.length === 0 && !queue.problem,
        master: targets.find((t) => t.id === "master")?.missing.length === 0,
      };
    },

    async leads() {
      if (!d.areas) return { on: false, live: 0 };
      const ids = Object.values(await d.areas.read()).map((a) => a.leadId).filter((id): id is string => !!id);
      const live = await Promise.all(ids.map((id) => d.agents.exists(id)));
      return { on: true, live: live.filter(Boolean).length };
    },
  };
}
