// server/setup/steps.ts — the set-up steps of a new console, in order. ONE list: the installer
// (`setup`), the health check (`doctor`) and the browser (GET /api/setup/steps) all read it.
//
// The rule: a machine check decides what is done. Nothing else can mark a step done: not a
// guide, not a user, not a stored flag. Each check is a pure function of the facts its probes
// give, so a test runs it with fake probes. The probes that read a real box are in probes.ts.
//
// What a user reads here (title, why, the text of a state) is plain words: no settings key, no
// file path, no secret. The machine is "your server" for the user ("the box" is our word).
// A leaf module (brand.ts only): bin/ and the browser bundle import it (src/lib/setup.ts). So the
// import below has no ".js": the bundler of the browser does not map ".js" to a ".ts" file.
import { CLI_NAME, DISPLAY_NAME, USER_CLI } from "../brand";

export const NODE_MIN = 22;

// The two ways the step "Open … from your devices" is done. The page reads which one it is:
// a new device needs the private address, and the tunnel works on one computer only.
export const ACCESS_READY = "The private address is ready";
export const ACCESS_TUNNEL = "Open through the SSH tunnel";

// A probe that this reader does not have (the CLI has no probe of the running console).
export class NotChecked extends Error {}
// A check that throws this has no row on this console (the second sign-in, where no second
// account is asked for).
export class NotHere extends Error {}

// How a user starts a command of the CLI: from the folder of the console, or, on an install
// that the install script made, with the command that script wrote (it gives its name, or its
// full path when the shell does not find the name, in the env of each call: install.sh). The
// browser has no such env: there the build of the pages put the command in (brand.ts USER_CLI).
export const cli = (sub: string): string => {
  const own = typeof process === "undefined" ? undefined : process.env?.CHOIBOT_CLI;
  return `${own && /^[A-Za-z0-9/._-]{1,200}$/.test(own) ? own : USER_CLI} ${sub}`;
};

// ------------------------------------------------------------------- the facts

// The box under the console: what `doctor` checks, as plain facts.
export type BoxFacts = {
  linux: boolean;
  // The Node version that runs the console, like "22.11.0".
  node: string;
  // This user can run services (a systemd user manager answers).
  userServices: boolean;
  // Plain names of the tools that are not on the box ("git", "the build tools").
  missingTools: string[];
  // The folder is an install of the console.
  checkout: boolean;
  // The settings the console cannot start without are there.
  settings: boolean;
  // False: the Queue is on, but its settings are not complete.
  queue: boolean;
  // The services of this user stay on after a logout.
  staysOn: boolean;
  // Required technical checks that fail and have no fact of their own here.
  unknownFailures: number;
  service: "running" | "stopped" | "none";
  // The console answers on the box.
  answers: boolean;
};

export type Probes = {
  box(): Promise<BoxFacts>;
  claude(): Promise<{ installed: boolean; loggedIn: boolean }>;
  access(): Promise<{ state: "ready" | "no-address" | "signed-out" | "none" }>;
  // With the GitHub app switch on: app-none (the app is not connected), app-refused (GitHub
  // refused its refresh), app-ended (its key ran out); unsaved: a new key lives in memory only.
  github(): Promise<{
    installed: boolean; login: string | null; commitName: boolean;
    problem?: "signed-out" | "no-answer" | "app-none" | "app-refused" | "app-ended"; unsaved?: boolean;
  }>;
  // onBox: repos on the box with a GitHub address. canPush: the first one GitHub lets this
  // login push to (it has 1 commit or more), else null.
  repos(): Promise<{ onBox: number; canPush: string | null }>;
  devices(): Promise<{ pairing: boolean; count: number }>;
  // tickets: the console keeps tickets (the Queue is on), so a pull request can be on record.
  agents(): Promise<{ started: number; running: number; pullRequests: number; tickets: boolean }>;
  merged(): Promise<{ count: number }>;
  // account: a Telegram account is connected. tested: a test message went out to it. name: how
  // Telegram names the account. tickets: the ticket cards have a chat (the fleet master chat, or
  // the user's chat with the bot). master: that chat is the fleet master chat.
  telegram(): Promise<{ bot: "none" | "failed" | "ok"; account: boolean; tested: boolean; name: string | null; tickets: boolean; master: boolean }>;
  leads(): Promise<{ on: boolean; live: number }>;
  // The second sign-in (server/chief/chiefaccount.ts): asked for here, ready (its settings and
  // its helper work), signed in, and the persistent agents that wait for it (their ids).
  persistentLogin(): Promise<{ wanted: boolean; ready: boolean; loggedIn: boolean; waits: string[] }>;
};

// ------------------------------------------------------------------- the steps

export type StepId =
  | "install" | "claude" | "access" | "pair" | "github" | "repo" | "agent" | "merge"
  | "phone" | "telegram" | "lead" | "persistent";

// The result of one check. `error`: the last error the check saw, in plain words.
export type Outcome = { done: true; note: string } | { done: false; reason: string; error?: string };

// What completes a step: an action (a button, or a command of the CLI) or a form. `built`:
// the part exists in the product today. A part that is not built is a name only: tests see it,
// a user never does (runSteps leaves it out).
export type Completes = { kind: "action" | "form"; name: string; built: boolean };

export type Step = {
  id: StepId;
  title: string;
  // One line: why the user does this.
  why: string;
  // After the first success: the set-up is done without it.
  optional?: true;
  // A console may have no row of it (its check throws NotHere): the page shows it only when
  // the answer of the server holds it.
  sometimes?: true;
  // Steps that must be done first. Always earlier in the list.
  needs?: StepId[];
  // Where the facts are: on the box (the CLI can check with the console stopped) or in the
  // running console.
  on: "box" | "console";
  completes: Completes;
  check(p: Probes): Promise<Outcome>;
};

const ok = (note: string): Outcome => ({ done: true, note });
const no = (reason: string, error?: string): Outcome => ({ done: false, reason, ...(error ? { error } : {}) });

const list = (words: string[]): string =>
  words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export const STEPS: Step[] = [
  {
    id: "install",
    title: `Install ${DISPLAY_NAME}`,
    why: "Your server needs Node, some tools and the service that keeps the console on.",
    on: "box",
    completes: { kind: "action", name: "setup", built: true },
    async check(p) {
      const b = await p.box();
      const major = Number(b.node.split(".")[0]);
      if (!b.linux) return no(`This server does not run Linux. ${DISPLAY_NAME} needs Linux.`);
      if (!(major >= NODE_MIN)) return no(`This server has ${major > 0 ? `Node ${major}` : "an unknown Node version"}. ${DISPLAY_NAME} needs Node ${NODE_MIN} or newer.`);
      if (!b.userServices) return no("This user cannot run services on your server. Log in to your server as this user with SSH, not with su.");
      if (b.missingTools.length) return no(`${list(b.missingTools)} ${b.missingTools.length === 1 ? "is" : "are"} not on your server.`);
      if (!b.checkout) return no(`This folder is not an install of ${DISPLAY_NAME}.`);
      if (!b.settings) return no("The settings of the console are not complete.");
      if (!b.queue) return no("The Queue is on, but its settings are not complete.");
      if (!b.staysOn) return no(`${DISPLAY_NAME} stops when you log out of your server.`);
      if (b.unknownFailures > 0) return no("A technical check failed.");
      if (b.service === "none") return no(`The service of ${DISPLAY_NAME} is not installed.`);
      if (b.service === "stopped") return no(`The service of ${DISPLAY_NAME} does not run.`);
      if (!b.answers) return no(`${DISPLAY_NAME} does not answer on this server.`);
      return ok(`Node ${major}, the tools and the service are ready`);
    },
  },
  {
    id: "claude",
    title: "Log in to Claude",
    why: "Your agents work with your Claude plan.",
    on: "box",
    completes: { kind: "form", name: "claude-login", built: true },
    async check(p) {
      const c = await p.claude();
      if (!c.installed) return no("The Claude program is not on your server.");
      if (!c.loggedIn) return no("Claude is not logged in on your server.");
      return ok("Logged in");
    },
  },
  {
    id: "access",
    title: `Open ${DISPLAY_NAME} from your devices`,
    why: "A private address lets your laptop and your phone open the console. There is no public door.",
    on: "box",
    completes: { kind: "action", name: "private-address", built: false },
    // Done: the private address is ready, OR a device is paired. A paired device proves that
    // the user did open the console from a device: with the SSH tunnel line of the install,
    // which needs no account (pick A, 2026-11-20). The private address is then the first
    // thing that "Add your phone" asks for (ACCESS_READY tells the two apart).
    async check(p) {
      const a = await p.access();
      if (a.state === "ready") return ok(ACCESS_READY);
      // A reader with no device list (the CLI with the console stopped) has only the facts above.
      let paired = false;
      try {
        const d = await p.devices();
        paired = d.pairing && d.count >= 1;
      } catch (e) {
        if (!(e instanceof NotChecked)) throw e;
      }
      if (paired) return ok(ACCESS_TUNNEL);
      if (a.state === "none") return no("Tailscale is not on your server. It gives the console a private address.");
      if (a.state === "signed-out") return no("Tailscale is on your server, but it is not signed in.");
      return no("The console has no private address yet.");
    },
  },
  {
    id: "pair",
    title: "Pair this device",
    why: "Only paired devices can use the console.",
    on: "console",
    completes: { kind: "form", name: "pair-device", built: true },
    async check(p) {
      const d = await p.devices();
      if (!d.pairing) return no("Device pairing is off on this console.");
      if (d.count < 1) return no("No device is paired yet.");
      return ok(`${count(d.count, "device")} paired`);
    },
  },
  {
    id: "github",
    title: "Connect GitHub",
    why: "Your agents open pull requests with your GitHub account.",
    on: "box",
    completes: { kind: "action", name: "github-login", built: true },
    async check(p) {
      const g = await p.github();
      if (!g.installed) return no("The GitHub tool is not on your server.");
      // Not connected yet: the normal start, not a failure. The row's own part says what to do.
      if (g.problem === "app-none") return no("GitHub is not connected.");
      if (g.problem === "app-refused") return no("GitHub no longer takes the key of your server.", "Connect GitHub again.");
      if (g.problem === "app-ended") return no("The GitHub key of your server ran out.", "Connect GitHub again.");
      if (!g.login) {
        return no("GitHub is not connected.", g.problem === "signed-out" ? "GitHub answered: not logged in." : "GitHub did not answer.");
      }
      if (!g.commitName) return no(`GitHub is connected as ${g.login}. Your server has no name and e-mail for commits yet.`);
      return ok(g.unsaved ? `Connected as ${g.login}. Your server could not save the new key: after a restart, connect GitHub again.` : `Connected as ${g.login}`);
    },
  },
  {
    id: "repo",
    title: "Pick a repo",
    why: "The first agent works in this repo.",
    needs: ["github"],
    on: "box",
    completes: { kind: "form", name: "repo-picker", built: true },
    async check(p) {
      const r = await p.repos();
      if (r.onBox < 1) return no("No repo is on your server yet.");
      if (!r.canPush) return no("GitHub gives no push access to the repos on your server. Agents cannot open pull requests there.");
      return ok(r.onBox === 1 ? r.canPush : `${r.canPush} and ${r.onBox - 1} more`);
    },
  },
  {
    id: "agent",
    title: "Start the first agent",
    why: "An agent does one small task and opens a pull request.",
    needs: ["claude", "repo"],
    on: "console",
    completes: { kind: "action", name: "first-agent", built: true },
    // Done: a pull request of an agent is on record (a ticket). An agent that only started is
    // not enough: it can stop with no pull request, and then the user must see it here. A
    // console with no Queue has no tickets: there, an agent that started is all there is.
    async check(p) {
      const a = await p.agents();
      const note = a.running > 0 ? `${count(a.running, "agent")} at work` : "Started";
      if (a.pullRequests >= 1) return ok(note);
      if (a.started < 1) return no("No agent has started yet.");
      if (!a.tickets) return ok(note);
      if (a.running > 0) return no("An agent works. Its pull request is not open yet.");
      return no("An agent started, but no pull request is on record yet.");
    },
  },
  {
    id: "merge",
    title: "Merge the first PR",
    why: "You read the ticket in the Queue and merge. Then the set-up is done.",
    needs: ["agent"],
    on: "console",
    completes: { kind: "action", name: "merge", built: true },
    async check(p) {
      const m = await p.merged();
      if (m.count < 1) return no("No pull request of an agent is merged yet.");
      return ok("Merged");
    },
  },
  {
    id: "phone",
    title: "Add your phone",
    why: "Scan a code with the phone. 1 minute.",
    optional: true,
    needs: ["pair"],
    on: "console",
    completes: { kind: "form", name: "add-device", built: true },
    async check(p) {
      const d = await p.devices();
      if (!d.pairing) return no("Device pairing is off on this console.");
      if (d.count < 2) return no("Only 1 device is paired.");
      return ok(`${count(d.count, "device")} paired`);
    },
  },
  {
    id: "telegram",
    title: "Telegram",
    why: "Get tickets on your phone and answer with one tap. 3 minutes.",
    optional: true,
    on: "console",
    completes: { kind: "form", name: "telegram", built: true },
    async check(p) {
      const t = await p.telegram();
      if (t.bot === "none") return no("No Telegram bot is set up.");
      if (t.bot === "failed") return no("The Telegram bot does not work.", "Telegram did not accept the bot, or it did not answer.");
      // Done only when tickets really reach Telegram. A console with its fleet master chat set
      // (by hand, or with a code) is done, as before.
      if (t.tickets && t.master) return ok("Tickets come to Telegram");
      if (!t.account) return no("The bot works. It waits for your message.");
      if (!t.tickets) return no("Your Telegram account is connected, but the Queue of this console does not run, so no ticket comes to Telegram.");
      if (!t.tested) return no("Your Telegram account is connected, but no test message went out yet.");
      return ok(t.name ? `Tickets come to ${t.name} in Telegram` : "Tickets come to Telegram");
    },
  },
  {
    id: "lead",
    title: "A lead for your repo",
    why: "A lead plans the work and runs the agents for you.",
    optional: true,
    needs: ["repo"],
    on: "console",
    completes: { kind: "action", name: "new-lead", built: true },
    async check(p) {
      const l = await p.leads();
      if (!l.on) return no("Leads are off on this console.");
      if (l.live < 1) return no("No lead runs yet.");
      return ok(`${count(l.live, "lead")} at work`);
    },
  },
  {
    // Only where the second account is asked for (strong protection): elsewhere no row.
    id: "persistent",
    sometimes: true,
    title: "Sign in for your assistant",
    why: "Your assistant (the fleet master), a lead for a repo, and the helper that turns events into tickets need a second sign-in, with the same Claude account and plan. Then your agents cannot act as them.",
    optional: true,
    on: "console",
    completes: { kind: "form", name: "persistent-login", built: true },
    async check(p) {
      const s = await p.persistentLogin().catch((e: unknown) => { throw e instanceof NotChecked ? new NotHere() : e; });
      if (!s.wanted) throw new NotHere();
      // Asked for, but the server cannot make it yet: no sign-in is offered (the page shows
      // this text and no login card), and the fix is a command of the server.
      if (!s.ready) return no(PERSISTENT_NOT_READY);
      if (s.loggedIn) return ok("Signed in");
      if (s.waits.length > 0) return no(`${list(s.waits.map(waiterName))} ${s.waits.length === 1 ? "waits" : "wait"} for this sign-in.`);
      return no("Not signed in yet. Sign in when you want them.");
    },
  },
];

// The second sign-in is asked for, but the server is not ready for it: the row's text. The page
// offers no sign-in with it (src/components/setup/SetupList.tsx).
export const PERSISTENT_NOT_READY = "Your server is not ready for this sign-in yet. Run strong-setup again on your server, as root, then press Check again.";
// The command that the page shows under it: the RUNBOOK's ("Strong protection", the first run).
// (The row's text has no path: plain() turns a path into "a file".)
export const PERSISTENT_FIX_COMMAND = `sudo /opt/${CLI_NAME}/bin/${CLI_NAME} strong-setup --user ${CLI_NAME}`;

// How the page names a persistent agent that waits (plain words: no id).
function waiterName(id: string, i: number): string {
  const name = id === "fleet-master" ? "the fleet master" : id === "coordinator" ? "the helper for tickets" : id.startsWith("lead-") ? `the lead for ${id.slice(5)}` : "an agent";
  return i === 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

export const stepOf = (id: StepId): Step => STEPS.find((s) => s.id === id)!;

// ------------------------------------------------------------------ the runner

export type StepState = "done" | "todo" | "blocked";

// What a reader gets for one step. Plain words only.
export type StepStatus = {
  id: StepId;
  title: string;
  why: string;
  optional: boolean;
  state: StepState;
  // done: a short note ("Connected as ada-dev"). Else: why the step is open.
  text: string;
  // blocked: the step to do first.
  blockedBy?: StepId;
  error?: string;
  // The action or the form that completes the step. Absent while it is not built.
  completes?: { kind: Completes["kind"]; name: string };
};

export const NOT_CHECKED = "This step is not checked here.";
export const CHECK_FAILED = "The check did not run.";

// The last guard on what a user reads: a file path or a settings key that came in with a
// fact (a repo name, an answer of a tool) does not go out.
export function plain(text: string): string {
  return text
    .replace(/(^|[\s"'(=:])~?\/[\w.@-]+(\/[\w.@-]*)*/g, "$1a file")
    .replace(/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/g, "a setting");
}

// Runs every check, in the order of the list. A probe runs one time for all the steps that
// read it. A check that throws leaves its step open: a step is done only when its check says so.
export async function runSteps(
  probes: Partial<Probes>,
  opts: { steps?: Step[]; onError?: (id: StepId, e: unknown) => void } = {},
): Promise<StepStatus[]> {
  const memo = new Map<string, Promise<unknown>>();
  const once = new Proxy({} as Probes, {
    get: (_t, name: string) => () => {
      const probe = (probes as Record<string, (() => Promise<unknown>) | undefined>)[name];
      if (!probe) return Promise.reject(new NotChecked(name));
      if (!memo.has(name)) memo.set(name, Promise.resolve().then(probe));
      return memo.get(name)!;
    },
  });

  const out: StepStatus[] = [];
  const doneIds = new Set<StepId>();
  for (const step of opts.steps ?? STEPS) {
    let outcome: Outcome;
    try {
      outcome = await step.check(once);
    } catch (e) {
      if (e instanceof NotHere) continue;
      if (!(e instanceof NotChecked)) opts.onError?.(step.id, e);
      outcome = { done: false, reason: e instanceof NotChecked ? NOT_CHECKED : CHECK_FAILED };
    }
    const base = {
      id: step.id, title: step.title, why: step.why, optional: step.optional === true,
      ...(step.completes.built ? { completes: { kind: step.completes.kind, name: step.completes.name } } : {}),
    };
    if (outcome.done === true) {
      doneIds.add(step.id);
      out.push({ ...base, state: "done", text: plain(outcome.note) });
      continue;
    }
    const first = (step.needs ?? []).find((n) => !doneIds.has(n));
    if (first) {
      out.push({ ...base, state: "blocked", text: `First: ${stepOf(first).title}.`, blockedBy: first });
      continue;
    }
    out.push({ ...base, state: "todo", text: plain(outcome.reason), ...(outcome.error ? { error: plain(outcome.error) } : {}) });
  }
  return out;
}
