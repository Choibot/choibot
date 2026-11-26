// bin/lib/login.ts — `login`: the Claude login of this server. The one step of the install
// with no help: before it there is no model to ask.
//
// The subscription login only (your Claude plan). No API key path and no other provider.
//   1. Claude Code is on the server (install.sh gets it with its official installer).
//   2. `claude auth login`, up to 3 times: Claude shows a link; the person approves and pastes
//      the code back. Each try shows a new link, so a wrong code costs one try.
//   3. The machine check of the step list ("Log in to Claude") decides if the login is there.
//   4. One small real request shows that the account can work: a login with no paid plan, or a
//      plan at its limit, fails here and not later in an agent.
// It asks no question. For the wrong account it shows the account and the plan it found, and
// the two commands that change it.
//
// The commands are the ones of the Claude Code docs: `claude auth login` and `claude auth
// status` (https://code.claude.com/docs/en/cli-reference), the plans that can log in
// (https://code.claude.com/docs/en/setup), the texts of a failed request
// (https://code.claude.com/docs/en/errors).
import { DISPLAY_NAME } from "../../server/brand.js";
import { resolveClaudeBin, type Env } from "../../server/defaults.js";
import { agentAuthOf, agentLoginStatus } from "../../server/agents/agentlogin.js";
import { boxProbes } from "../../server/setup/probes.js";
import { cli, plain, stepOf, type Outcome, type Probes } from "../../server/setup/steps.js";
import { run } from "./exec.js";
import { installEnv } from "./pair.js";

export const LOGIN_TRIES = 3;
export const PLANS = "Pro, Max, Team or Enterprise";

// What `claude auth status` says (JSON). The fields are read one by one: a version of Claude
// Code that leaves one out gives a shorter line here, not an error.
export type ClaudeAccount = { loggedIn: boolean; email: string | null; plan: string | null };

export function parseStatus(stdout: string): ClaudeAccount {
  try {
    const raw = JSON.parse(stdout) as Record<string, unknown>;
    const text = (v: unknown): string | null => (typeof v === "string" && /^[\w.@+ -]{1,80}$/.test(v) ? v : null);
    const plan = text(raw.subscriptionType);
    return { loggedIn: raw.loggedIn === true, email: text(raw.email), plan: plan ? plan[0].toUpperCase() + plan.slice(1) : null };
  } catch {
    return { loggedIn: false, email: null, plan: null };
  }
}

// The result of the small request: it works, the plan is at its limit, or it fails for another
// reason (no paid plan is the usual one). `said`: the first line of Claude's own answer.
export type Request = { state: "works" } | { state: "limit" | "failed"; said: string };

export function requestResult(r: { code: number; stdout: string; stderr: string }): Request {
  if (r.code === 0) return { state: "works" };
  const said = plain(`${r.stdout}\n${r.stderr}`.trim().split("\n").find((l) => l.trim()) ?? "no answer").trim().slice(0, 200);
  return { state: /\blimit\b|temporarily limiting|\b429\b/i.test(said) ? "limit" : "failed", said };
}

type LoginDeps = { repoDir: string; env?: Env; isTTY?: boolean; out?: (s: string) => void };

// 0: logged in, and a request works. 2: logged in, but no request works now. 1: not logged in.
export async function runLogin(d: LoginDeps): Promise<number> {
  const out = d.out ?? ((s: string) => console.log(s));
  const env = installEnv(d.repoDir, d.env ?? process.env);
  const bin = resolveClaudeBin(env);
  // The check of the step list. It reads the Claude facts only.
  const probes = boxProbes({ env, box: () => Promise.reject(new Error("not used")) });
  const check = (): Promise<Outcome> => stepOf("claude").check(probes as Probes);
  const noAi = `${DISPLAY_NAME} goes on with no AI: each step stays a plain step.`;

  let c = await check();
  // Strong protection: the one login is the agents' own, in a folder this account cannot read.
  // The Set-up page makes it (through the console's helper); a terminal never does.
  const agents = agentAuthOf(env);
  if (agents) {
    if (c.done !== true) {
      out(`  ○ ${c.reason} On this server the login is made on the page: open ${DISPLAY_NAME}, Set-up, “Log in to Claude”.`);
      return 1;
    }
    const who = await agentLoginStatus(agents);
    out(`  ✔ Logged in${who.email ? ` as ${who.email}` : ""}.${who.plan ? ` Plan: ${who.plan}.` : ""} (the login of your agents)`);
    return 0;
  }
  if (c.done !== true) {
    if (!(await probes.claude()).installed) {
      out(`  ○ ${c.reason} ${noAi}`);
      return 1;
    }
    if (!(d.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true))) {
      out(`  ○ ${c.reason} The login needs a terminal with a person. ${noAi}`);
      out(`    To log in, run this on your server: ${cli("login")}`);
      return 1;
    }
    out("  Claude shows a link. Open it on your laptop or your phone, approve, and paste the code");
    out(`  that the page shows back here. A paid Claude plan is needed: ${PLANS}.`);
    for (let n = 1; n <= LOGIN_TRIES && c.done !== true; n++) {
      out("");
      await run(bin, ["auth", "login"], { stdio: "inherit" });
      c = await check();
      if (c.done !== true && n < LOGIN_TRIES) out(`\n  The login did not work (try ${n} of ${LOGIN_TRIES}). Here is a new link.`);
    }
    if (c.done !== true) {
      out(`\n  ○ ${c.reason} ${LOGIN_TRIES} tries did not work. ${noAi}`);
      out(`    To try again later: ${cli("login")}`);
      return 1;
    }
  }

  const who = parseStatus((await run(bin, ["auth", "status"], { timeoutMs: 30_000 })).stdout);
  out(`  ✔ Logged in${who.email ? ` as ${who.email}` : ""}.${who.plan ? ` Plan: ${who.plan}.` : ""}`);
  const other = `    Not the right account? Run: claude auth logout   and then: ${cli("login")}`;

  const req = requestResult(await run(bin, ["-p", "Reply with the one word: ready", "--model", "haiku"], { timeoutMs: 90_000 }));
  if (req.state === "works") {
    out("  ✔ Claude answers a test request");
    out(other);
    return 0;
  }
  if (req.state === "limit") {
    out(`  ○ Your Claude plan is at its limit now. Claude said: ${req.said}`);
    out(`    ${noAi} The AI comes back with your plan.`);
  } else {
    out(`  ○ Claude is logged in, but a test request failed. Claude said: ${req.said}`);
    out(`    Claude Code works with a paid plan: ${PLANS}. The free plan does not work. ${noAi}`);
  }
  out(other);
  return 2;
}
