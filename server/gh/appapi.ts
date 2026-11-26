// server/gh/appapi.ts — the routes of the ChoiBot GitHub app login (PR 1 of the GitHub app plan).
// Registered only while the switch is on (server/gh/appconfig.ts); the page that uses them comes
// with the Set-up step.
//   GET  /api/github/app             the login that runs (its state, the code, the address, the
//                                    time that is left) and the state of the stored token
//   POST /api/github/app/login       start a login ({ fresh: true }: a new code)
//   POST /api/github/app/disconnect  remove the token from this server
//   GET  /api/github/app/repos       for Settings: the repos that the app reaches (null while it
//                                    is not connected) and the repos that the agents used in the
//                                    last 14 days, each marked: the app reaches it, or not
//                                    (?fresh=1: read GitHub again)
// Every route is for the paired user only (gateUser), the read too: it holds a login code.
// An answer holds states and times: never a token, a file path or a line of GitHub.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gateUser, type ChiefGate } from "../chief/gate.js";
import { NEEDS_PAIRING } from "../setup/actions.js";
import type { AppLoginReason, AppLoginState, AppTokenState, GithubApp } from "./applogin.js";
import { AppReposError, type AppRepos, type ManageLink } from "./apprepos.js";
import type { UsedRepo, UsedSource } from "./appused.js";

export type AppLoginView =
  | { state: "idle" | "starting" | "done" }
  | { state: "waiting"; code: string; url: string; leftMs: number }
  | { state: "failed"; reason: AppLoginReason };
export type AppTokenView =
  | { state: "none" }
  | { state: "signed-out"; why: "refused" | "ended" }
  | { state: "ok"; accessLeftMs: number | null; refreshLeftMs: number | null; unsaved?: true };

// The key's state as a page gets it: the time that is left, not a clock time.
export function appTokenView(t: AppTokenState, now: number): AppTokenView {
  const left = (at: number | null) => (at === null ? null : Math.max(0, at - now));
  return t.state === "ok"
    ? { state: "ok", accessLeftMs: left(t.accessExpiresAt), refreshLeftMs: left(t.refreshExpiresAt), ...(t.unsaved ? { unsaved: true as const } : {}) }
    : t;
}

// GET /api/github/app/repos. reach null: the app is not connected, or GitHub did not give the
// list (`why`). In `used`, reach is null where the app's list is not known.
export type AppReposView = {
  reach: { repos: { slug: string; private: boolean; push: boolean }[]; manage: ManageLink[]; appUrl: string | null; capped: boolean } | null;
  why?: "not-connected" | "refused" | "no-answer";
  used: { slug: string; name: string | null; agoMs: number; from: UsedSource[]; reach: boolean | null }[];
  days: number;
};
export const REACH_TTL_MS = 30_000;

// Where the person ends it on GitHub (GitHub docs: "Reviewing and revoking authorization of
// GitHub Apps", "Reviewing and modifying installed GitHub Apps").
export const REVOKE_ON_GITHUB = "On GitHub: Settings → Applications → Authorized GitHub Apps → Revoke. The repos: Settings → Applications → Installed GitHub Apps → Configure.";

export function registerGithubAppApi(app: FastifyInstance, d: {
  gate?: ChiefGate;
  login: Pick<GithubApp, "loginState" | "start" | "tokenState" | "disconnect">;
  // The lists of Settings. Absent: GET /api/github/app/repos is not there.
  repos?: { reach: () => Promise<AppRepos>; used: () => Promise<UsedRepo[]>; appUrl: string | null; days: number };
  // The key went (Disconnect): the kept reads of other parts (Settings, Set-up) are dropped.
  onChange?: () => void;
  now?: () => number;
}): void {
  const now = d.now ?? Date.now;
  const user = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!d.gate) { reply.code(403).send(NEEDS_PAIRING); return false; }
    return (await gateUser(d.gate, req, reply)) !== null;
  };
  // The page gets the time that is left, not a clock time: its clock can differ from the server's.
  const left = (at: number | null) => (at === null ? null : Math.max(0, at - now()));
  const loginView = (s: AppLoginState): AppLoginView =>
    s.state === "waiting" ? { state: "waiting", code: s.code, url: s.url, leftMs: left(s.expiresAt) ?? 0 } : s;
  const tokenView = (t: AppTokenState): AppTokenView => appTokenView(t, now());

  app.get("/api/github/app", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    return { login: loginView(d.login.loginState()), token: tokenView(await d.login.tokenState()) };
  });
  app.post("/api/github/app/login", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const fresh = (req.body as { fresh?: unknown } | null)?.fresh === true;
    return loginView(await d.login.start({ fresh }));
  });
  // The app's list, kept 30 s. Dropped at Disconnect, not at a new login: a reconnect within 30 s
  // comes after a Disconnect. After a key that GitHub refused, a new login within 30 s can still
  // see the list read before the refusal (?fresh=1, the Re-check of Settings, reads again).
  let reachKept: { at: number; list: AppRepos } | null = null;
  app.post("/api/github/app/disconnect", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    try { await d.login.disconnect(); } catch { return reply.code(500).send({ error: "Your server did not remove the token." }); }
    reachKept = null;
    try { d.onChange?.(); } catch { /* the kept reads end by their own time */ }
    return { ok: true, github: REVOKE_ON_GITHUB };
  });

  const lists = d.repos;
  if (!lists) return;
  app.get("/api/github/app/repos", async (req, reply): Promise<AppReposView | FastifyReply> => {
    if (!(await user(req, reply))) return reply;
    const fresh = (req.query as { fresh?: string }).fresh === "1";
    const t = now();
    let reach: AppRepos | null = null;
    let why: AppReposView["why"];
    if ((await d.login.tokenState()).state !== "ok") {
      why = "not-connected";
    } else if (!fresh && reachKept && t - reachKept.at < REACH_TTL_MS) {
      reach = reachKept.list;
    } else {
      try {
        reach = await lists.reach();
        reachKept = { at: t, list: reach };
      } catch (e) {
        why = e instanceof AppReposError ? e.why : "no-answer";
      }
    }
    const reached = reach ? new Set(reach.repos.map((r) => r.slug.toLowerCase())) : null;
    const used = (await lists.used().catch(() => [])).map((u) => ({
      slug: u.slug, name: u.name, agoMs: Math.max(0, t - u.lastAt), from: u.from,
      reach: reached ? reached.has(u.slug.toLowerCase()) : null,
    }));
    return {
      reach: reach ? { repos: reach.repos.map((r) => ({ slug: r.slug, private: r.private, push: r.push && !r.archived })), manage: reach.manage, appUrl: lists.appUrl, capped: reach.capped } : null,
      ...(why ? { why } : {}),
      used, days: lists.days,
    };
  });
}
