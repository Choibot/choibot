// server/setup/actions.ts — the actions of the Set-up page for GitHub and the first repo.
//   GET  /api/setup/github/login   the login that runs: its state, the code, the address
//   POST /api/setup/github/login   start a login ({ fresh: true }: a new code)
//   GET  /api/setup/github/name    does git have a name and an e-mail for commits, and what the
//                                  step will set
//   POST /api/setup/github/name    set them from the GitHub login (only where git has none)
//   GET  /api/setup/repos          the repos of the GitHub login (?q= search, ?page=)
//   GET  /api/setup/repos/clone    the copy that runs: its state and how far it is
//   POST /api/setup/repos/clone    copy one repo of the list into the work folder ({ repo })
//   GET  /api/setup/first          the first agent and its pull request ticket, as states
//   POST /api/setup/first          start the first agent with its fixed task ({ again: true }: a
//                                  new one, after the first one stopped with no pull request;
//                                  { repo }: the name of one repo of the server's own list)
// Every route is for the paired user only (gateUser): an agent, a lead and the fleet master
// are refused, the reads too (a login code and the names of private repos are in them). A
// console with no device pairing has no user, so no route here answers.
// An answer holds states and plain facts: no token, no file path, no line of a tool.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gateUser, type ChiefGate } from "../chief/gate.js";
import { commitNameView, setCommitName, shareCommitName, type CommitNameDeps } from "./commitname.js";
import type { FirstAgent } from "./firstagent.js";
import type { AppLoginReason, AppLoginState } from "../gh/applogin.js";
import type { LoginReason, LoginState } from "./ghlogin.js";
import type { RepoPick } from "./repopick.js";

// The login of the step: gh's own (setup/ghlogin.ts), or, with the GitHub app switch on, the
// ChoiBot app's device flow (gh/applogin.ts). Both have the same states.
export type SetupLoginReason = LoginReason | AppLoginReason;
export type SetupLoginState = LoginState | AppLoginState;
export type SetupLogin = { state(): SetupLoginState; start(o: { fresh?: boolean }): Promise<SetupLoginState> };

// The login as the page gets it. `app`: the login is the ChoiBot app's; appUrl is its public
// page on GitHub (null: not set), where the person installs it on the repos that they pick.
export type LoginView = (
  | { state: "idle" | "starting" | "done" }
  | { state: "waiting"; code: string; url: string; leftMs: number }
  | { state: "failed"; reason: SetupLoginReason }
) & { app?: { appUrl: string | null } };

export const NEEDS_PAIRING = { error: "needs-pairing", text: "This action needs a paired device." };

export function registerSetupActions(app: FastifyInstance, d: {
  // The gate of the chief of staff. Absent: device pairing is off, every route answers 403.
  gate?: ChiefGate;
  login: SetupLogin;
  // The GitHub app switch is on: the login is the app's, and each login view says so.
  githubApp?: { appUrl: string | null };
  repos: RepoPick;
  // Absent: this console cannot start the first agent from the page (the routes answer 404).
  first?: FirstAgent;
  commitName?: CommitNameDeps;
  // Strong protection: give the commit name to the agents' account too (agentGitIdentity).
  agentIdentity?: (name: string, email: string) => Promise<boolean>;
  // An action changed what a check reads: the kept answer of the step list is dropped.
  changed: () => void;
  now?: () => number;
  log?: (s: string) => void;
}): void {
  const log = d.log ?? ((s: string) => console.warn(s));
  const now = d.now ?? Date.now;
  const user = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!d.gate) { reply.code(403).send(NEEDS_PAIRING); return false; }
    return (await gateUser(d.gate, req, reply)) !== null;
  };

  // The page gets the time that is left, not a clock time: its clock can differ from the server's.
  const via = d.githubApp ? { app: { appUrl: d.githubApp.appUrl } } : {};
  const loginView = (s: SetupLoginState): LoginView =>
    s.state === "waiting" ? { state: "waiting", code: s.code, url: s.url, leftMs: Math.max(0, s.expiresAt - now()), ...via } : { ...s, ...via };

  app.get("/api/setup/github/login", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    return loginView(d.login.state());
  });

  app.post("/api/setup/github/login", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const fresh = (req.body as { fresh?: unknown } | null)?.fresh === true;
    return loginView(await d.login.start({ fresh }));
  });

  app.get("/api/setup/github/name", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    return commitNameView(d.commitName);
  });

  app.post("/api/setup/github/name", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const r = await setCommitName(d.commitName);
    if (!r.ok) {
      return reply.code(409).send({ error: r.reason === "no-login" ? "GitHub gave no account. Connect GitHub first." : "Your server did not save the name." });
    }
    if (r.wrote.length) { log(`[setup] commit ${r.wrote.join(" and ")} set from the GitHub login`); d.changed(); }
    // Strong protection: the agents commit under their own account, with the same name.
    if (d.agentIdentity && !(await shareCommitName(d.agentIdentity, d.commitName))) {
      log("[setup] the commit name did not reach the agents' account");
      // 500, never 502: Cloudflare (the hosted console's edge) puts its own page in place of the body of an origin 502 or 504, and the page then
      // says only "The console did not answer". The same for each sentence below.
      return reply.code(500).send({ error: "Your server did not give the name to your agents. Try again." });
    }
    return { ok: true, wrote: r.wrote };
  });

  app.get("/api/setup/repos", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const q = req.query as { q?: string; page?: string; fresh?: string };
    try {
      return await d.repos.page({ q: typeof q.q === "string" ? q.q : "", page: Number(q.page) || 0, fresh: q.fresh === "1" });
    } catch {
      // The cause (a line of gh) stays on the server.
      return reply.code(500).send({ error: "GitHub did not give the list of your repos." });
    }
  });

  app.get("/api/setup/repos/clone", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    return d.repos.cloneState();
  });

  app.post("/api/setup/repos/clone", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const repo = (req.body as { repo?: unknown } | null)?.repo;
    if (typeof repo !== "string") return reply.code(400).send({ error: "Pick a repo of the list." });
    let r;
    try { r = await d.repos.clone(repo); } catch { return reply.code(500).send({ error: "GitHub did not give the list of your repos." }); }
    if (r.state === "refused") {
      if (r.why === "busy") return reply.code(409).send({ error: "A copy runs now. Wait until it ends." });
      return reply.code(400).send({ error: r.why === "no-push" ? "GitHub gives no push access to this repo." : "Pick a repo of the list." });
    }
    return r;
  });

  app.get("/api/setup/first", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    if (!d.first) return reply.code(404).send({ error: "not found" });
    return d.first.view();
  });

  app.post("/api/setup/first", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    if (!d.first) return reply.code(404).send({ error: "not found" });
    const body = req.body as { again?: unknown; repo?: unknown } | null;
    const again = body?.again === true;
    // A name only, matched against the list of the server (firstagent.ts). Never a path.
    if (body?.repo !== undefined && typeof body.repo !== "string") return reply.code(400).send({ error: "Pick a repo of the list." });
    const r = await d.first.start({ again, ...(typeof body?.repo === "string" ? { repo: body.repo } : {}) });
    if (r.ok) return r.view;
    if (r.why === "unknown-repo") return reply.code(400).send({ error: "Pick a repo of the list." });
    if (r.why === "no-repo") return reply.code(409).send({ error: "No repo with push access is on your server. Do the step “Pick a repo” first." });
    if (r.why === "working") return reply.code(409).send({ error: "The first agent works now. Wait until it stops." });
    if (r.why === "busy") return reply.code(409).send({ error: "The agent starts now. Wait a moment." });
    return reply.code(500).send({ error: "The agent did not start. Press the button again." });
  });
}
