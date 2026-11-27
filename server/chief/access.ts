// server/chief/access.ts — strong protection: what each caller may ask of the console.
//
// Why: with strong protection the agents run as their own Linux account, but every process on
// the server can open 127.0.0.1, and server/auth.ts lets every loopback peer past the cookie
// layer. So in strong protection a request from loopback says nothing about who sent it: this
// hook decides from the caller's credential only (server/chief/auth.ts callerOf):
//   user         a paired device's token (x-choibot-user): every route (the routes check the rest);
//   master, lead, coordinator, agent   an agent's own token: the list of its level, below;
//   console      the token of the console's own account (consoletoken.ts): a short list;
//   none         no credential that verifies: the one allow-list of the front proxy's gate
//                (server/frontproxy.ts allowedWithoutDevice: the app's shell, /_next/static, the
//                icons, PAIRING_ROUTES) and, on this listener only, the two routes with a token of
//                their own (OWN_TOKEN_ROUTES); for a TRUE loopback peer only (LOOPBACK_ROUTES),
//                the version that runs.
// FAIL CLOSED: a route that no list names is refused for every level but user, so a new route
// stays closed until it is listed on purpose. The routes keep their own checks (the owner of an
// item, the level, the spawn area) in addition.
//
// Basic mode (no strong protection) registers nothing: one account gives no wall in any case.
//
// Why a layer of its own, and not a "loopback" kind in registerDeviceGate (frontproxy.ts): that
// gate knows only "a paired device or not". On loopback the console's agents and its own account
// call too, with their own tokens; their levels are this layer. The answer to a caller with no
// credential is that gate's answer (401 "pair-required" for the API, 404 for a page), so the page
// opens its pairing screen in the same way.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isPersistentKind, type AgentRecord, type SessionStore } from "../agents/store.js";
import { coordinatorMay } from "../coordinator/gate.js";
import { COORDINATOR_ID } from "../coordinator/paths.js";
import { isAgentId } from "../ids.js";
import { CLI_NAME } from "../brand.js";
import { allowedWithoutDevice, listenerKind, PAIRING_ROUTES } from "../frontproxy.js";
import { VERSION_ROUTE } from "../release.js";
import type { Caller, CallerLevel } from "./auth.js";
import { gateRoute, USER_ALONE_ERR, type ChiefGate } from "./gate.js";
import { hardenedDeployment } from "./hardened.js";
import type { QueueItem } from "./queue/types.js";

// "<METHOD> <route pattern>" as Fastify registers it (HEAD is read as GET).
export type RouteKey = string;

// The two routes that check a token of their own (the route does it): an agent's hook (?token)
// and the Recurring runner (x-cron-token). For loopback only: the front proxy never takes them.
export const OWN_TOKEN_ROUTES: ReadonlySet<RouteKey> = new Set([
  "POST /api/agents/:id/hook",
  "POST /api/cron/notify",
]);
// What a caller with no credential reaches on loopback: the front proxy's one allow-list and the
// two routes above. NOT POST /api/chief/pair/start (log mode): it mints a pairing link and answers
// it, so any process that sent it with no agent header could claim that link and become the user.
// It is a write of the console's own account (`brain pair`, a person at the server's shell).
export const NONE_ROUTES: ReadonlySet<RouteKey> = new Set([...PAIRING_ROUTES, ...OWN_TOKEN_ROUTES]);
// What every caller reaches from a TRUE loopback peer (AccessRequest.loopback): the version that
// runs (server/release.ts: kind, version, commit, build id, channel, time of the build; no secret).
// The updater of a hosted server (root, on the server) reads it after each start, with no
// credential. Never through the front proxy's listener, never for another peer: there it stays a
// paired device's.
export const LOOPBACK_ROUTES: ReadonlySet<RouteKey> = new Set([`GET ${VERSION_ROUTE}`]);
// A loopback request with one of these headers came through a proxy on this server (tailscale
// serve, a tunnel) for another peer: it is not a true loopback peer.
export const FORWARDED_HEADERS: readonly string[] = ["x-forwarded-for", "forwarded", "x-real-ip"];

// Which agent a rule with an `:id` may name: itself, a worker (not a persistent agent), a worker
// that the caller spawned, a queue item of the caller, or (a lead) an item of the caller or of a
// worker that it spawned.
export type Target = "self" | "worker" | "self-or-worker" | "spawned" | "self-or-spawned" | "own-item" | "own-or-spawned-item";
export type Rule = { route: RouteKey; target?: Target };

// A worker: what its CLI calls (bin/lib/queue.ts, remind.ts, agents.ts `pr` and `fetch-base`,
// cron.ts `list`), on itself or its own items. No list of agents, no events stream, no other
// agent's thread, screen, terminal or input, no spawn, stop or resume.
export const WORKER_RULES: readonly Rule[] = [
  { route: "POST /api/queue" },
  // The route lists only the caller's own items for this level (queue/api.ts).
  { route: "GET /api/queue" },
  { route: "GET /api/queue/:id", target: "own-item" },
  { route: "GET /api/queue/:id/page", target: "own-item" },
  { route: "POST /api/queue/:id/withdraw", target: "own-item" },
  // The routes take only the caller's own reminders (remind/api.ts mayManage).
  { route: "GET /api/reminders" },
  { route: "POST /api/reminders" },
  { route: "POST /api/reminders/:id/cancel" },
  { route: "GET /api/agents/:id", target: "self" },
  { route: "GET /api/agents/:id/pr", target: "self" },
  { route: "POST /api/agents/:id/pr", target: "self" },
  { route: "POST /api/agents/:id/fetch-base", target: "self" },
  { route: "GET /api/cron/jobs" },
  { route: "GET /api/cron/jobs/:name/runs" },
];

// A lead: a worker's list, plus its workers (its prompt, server/chief/leads/prompt.ts: agents
// spawn, list, resume, close, rename; leads report; queue show and recommend on its workers' items).
// It reads the thread and the screen only of a worker that IT spawned (the record's spawnedBy).
// `queue list`: every item, as before (the route filters only a worker's list).
const LEAD_ITEM_ROUTES: ReadonlySet<RouteKey> = new Set(["GET /api/queue/:id", "GET /api/queue/:id/page"]);
export const LEAD_RULES: readonly Rule[] = [
  ...WORKER_RULES.filter((r) => r.route !== "GET /api/agents/:id" && !LEAD_ITEM_ROUTES.has(r.route)),
  { route: "GET /api/agents/:id", target: "self-or-spawned" },
  { route: "GET /api/queue/:id", target: "own-or-spawned-item" },
  { route: "GET /api/queue/:id/page", target: "own-or-spawned-item" },
  // The route takes only an item of the lead's own workers (queue/actions.ts recommend).
  { route: "POST /api/queue/:id/recommend", target: "own-or-spawned-item" },
  { route: "GET /api/agents" },
  { route: "GET /api/repos" },
  // The route refuses a repo outside the lead's area (agents/api.ts leadSpawnRefusal).
  { route: "POST /api/agents" },
  { route: "GET /api/agents/:id/thread", target: "spawned" },
  { route: "GET /api/agents/:id/screen", target: "spawned" },
  { route: "POST /api/agents/:id/stop", target: "spawned" },
  { route: "POST /api/agents/:id/resume", target: "spawned" },
  { route: "POST /api/agents/:id/close", target: "spawned" },
  // The title of a worker in the list (agents/api.ts rename: the same owner rule as close).
  { route: "POST /api/agents/:id/rename", target: "spawned" },
  // The review of a worker's change (strong protection: no GitHub login, and nothing is run in
  // the worker's folder): its recorded PR from GitHub by the console's login, and its own report.
  { route: "GET /api/agents/:id/pr-diff", target: "spawned" },
  { route: "GET /api/agents/:id/pr-file", target: "spawned" },
  { route: "GET /api/agents/:id/diff", target: "spawned" },
  { route: "GET /api/leads" },
  { route: "GET /api/leads/:area" },
  { route: "POST /api/leads/report" },
];

// The fleet master (the user's assistant): its CLI (agents.ts, queue.ts, brain.ts, leads.ts,
// cron.ts) and the reads of the workers.
export const MASTER_RULES: readonly Rule[] = [
  { route: "POST /api/queue" },
  { route: "GET /api/queue" },
  { route: "GET /api/queue/:id" },
  { route: "GET /api/queue/:id/page" },
  { route: "POST /api/queue/:id/withdraw" },
  // NOT the answer (`queue answer --auto`) and NOT a merge (`agents merge-pr`): with strong
  // protection the user alone answers and merges (USER_ALONE_ROUTES below; the gates refuse them
  // too). A recommendation answers nothing: the user takes it or not. Undo reopens only the
  // master's own auto answer inside its window (QueueActions.undo); no new one exists here.
  { route: "POST /api/queue/:id/recommend" },
  { route: "POST /api/queue/:id/undo" },
  { route: "GET /api/reminders" },
  { route: "POST /api/reminders" },
  { route: "POST /api/reminders/:id/cancel" },
  { route: "GET /api/agents" },
  { route: "GET /api/repos" },
  { route: "POST /api/agents" },
  { route: "GET /api/agents/:id", target: "self-or-worker" },
  { route: "GET /api/agents/:id/thread", target: "worker" },
  { route: "GET /api/agents/:id/screen", target: "worker" },
  { route: "GET /api/agents/:id/tasks", target: "worker" },
  // The review of a worker's change, as for a lead (LEAD_RULES).
  { route: "GET /api/agents/:id/pr-diff", target: "worker" },
  { route: "GET /api/agents/:id/pr-file", target: "worker" },
  { route: "GET /api/agents/:id/diff", target: "worker" },
  { route: "GET /api/agents/:id/pr", target: "self-or-worker" },
  { route: "POST /api/agents/:id/pr", target: "self" },
  { route: "POST /api/agents/:id/fetch-base", target: "self" },
  { route: "POST /api/agents/:id/stop", target: "worker" },
  { route: "POST /api/agents/:id/resume", target: "worker" },
  { route: "POST /api/agents/:id/delete", target: "worker" },
  { route: "GET /api/brain" },
  { route: "GET /api/brain/rules" },
  // `brain add`: the route makes a candidate of the master's (brain/api.ts userOrMaster).
  { route: "POST /api/brain/rules" },
  { route: "POST /api/brain/decisions" },
  { route: "GET /api/coordinator" },
  // `coordinator tell` (bin/lib/fleet.ts).
  { route: "POST /api/coordinator/task" },
  // `cron note`: the route takes the user, the master and the Coordinator (cron/api.ts NOTE_LEVELS).
  { route: "POST /api/cron/jobs/:name/note" },
  { route: "GET /api/leads" },
  { route: "GET /api/leads/:area" },
  { route: "GET /api/cron/jobs" },
  { route: "GET /api/cron/jobs/:name/runs" },
];

// The console's own account: exactly what `doctor`, `status`, `access`, `setup` and the install
// agent (`repair`) call (bin/lib/doctor.ts askConsole; status runs systemctl only; access and the
// set-up's check ask "/", which is the shell), plus ONE write: POST /api/chief/pair/start, which
// `brain pair` needs (a person at the server's shell makes a pairing link and claims it with
// `brain claim`, to get the user's rights).
export const CONSOLE_RULES: readonly Rule[] = [
  { route: "GET /api/setup/steps" },
  { route: "POST /api/chief/pair/start" },
];

const byLevel = (rules: readonly Rule[]): ReadonlyMap<RouteKey, Rule> => new Map(rules.map((r) => [r.route, r]));
export const LEVEL_RULES: Readonly<Record<"agent" | "lead" | "master" | "console", ReadonlyMap<RouteKey, Rule>>> = {
  agent: byLevel(WORKER_RULES),
  lead: byLevel(LEAD_RULES),
  master: byLevel(MASTER_RULES),
  console: byLevel(CONSOLE_RULES),
};

// The routes that, with strong protection, only the user may call, and the refusal that an agent
// gets there (the CLI prints it): a merge of a pull request and the answer of a queue item.
export const USER_ALONE_ROUTES: ReadonlyMap<string, string> = new Map([
  ["POST /api/gh/pr/merge", USER_ALONE_ERR.merge],
  ["POST /api/agents/:id/merge", USER_ALONE_ERR.merge],
  ["POST /api/queue/:id/merge", USER_ALONE_ERR.merge],
  ["POST /api/queue/:id/answer", USER_ALONE_ERR.auto],
]);

export const ACCESS_ERR = {
  agent: "not an action of this agent (strong protection)",
  console: `this needs a paired device: in a shell of this server, run \`${CLI_NAME} brain pair <label>\`, then \`${CLI_NAME} brain claim <url>\``,
} as const;

export type AccessDeps = {
  agents: Pick<SessionStore, "load">;
  queue: { get(id: string): Promise<Pick<QueueItem, "agentId"> | null> };
};

// The request as the hook sees it. `loopback`: a TRUE loopback peer of the main listener: its socket
// (never a header) is 127.0.0.1 or ::1, it did not come in over the front proxy's private listener
// (server/frontproxy.ts listenerKind), and it carries no forwarding header (FORWARDED_HEADERS).
export type AccessRequest = { method: string; route: string | undefined; url: string; params: Record<string, unknown>; socket: boolean; loopback: boolean };

// The front proxy's allow-list (the app's shell and the pairing routes) or a route with a token of
// its own: what every caller reaches.
function open(r: AccessRequest, pageRoute: string): boolean {
  const method = r.method === "HEAD" ? "GET" : r.method;
  if (allowedWithoutDevice(r.method, r.url, r.route, pageRoute, r.socket)) return true;
  if (r.socket || r.route === undefined) return false;
  if (r.loopback && LOOPBACK_ROUTES.has(`${method} ${r.route}`)) return true;
  return OWN_TOKEN_ROUTES.has(`${method} ${r.route}`);
}

const isWorker = (rec: AgentRecord | null): boolean => rec !== null && !isPersistentKind(rec.kind) && rec.id !== COORDINATOR_ID;

async function targetOk(t: Target, caller: Caller, params: Record<string, unknown>, d: AccessDeps): Promise<boolean> {
  const id = params.id;
  if (typeof id !== "string") return false;
  if (t === "own-item" || t === "own-or-spawned-item") {
    const item = await d.queue.get(id);
    if (item === null || caller.agentId === undefined) return false;
    if (item.agentId === caller.agentId) return true;
    if (t === "own-item" || !isAgentId(item.agentId)) return false;
    const owner = await d.agents.load(item.agentId);
    return isWorker(owner) && owner!.spawnedBy === caller.agentId;
  }
  if ((t === "self" || t === "self-or-worker" || t === "self-or-spawned") && id === caller.agentId) return true;
  if (t === "self") return false;
  if (!isAgentId(id)) return false;
  const rec = await d.agents.load(id);
  if (t === "worker" || t === "self-or-worker") return isWorker(rec);
  return isWorker(rec) && rec!.spawnedBy !== undefined && rec!.spawnedBy === caller.agentId;
}

// The decision for one request: true = let it go on to the route.
export async function mayAccess(level: CallerLevel, caller: Caller, r: AccessRequest, pageRoute: string, d: AccessDeps): Promise<boolean> {
  if (level === "user") return true;
  if (open(r, pageRoute)) return true;
  const method = r.method === "HEAD" ? "GET" : r.method;
  // The page catch-all serves nothing more than its allow-list to a caller that is not the user.
  if (r.route === undefined || r.route === pageRoute || level === "none") return false;
  const key = `${method} ${r.route}`;
  // The Coordinator keeps its own gate as it is (coordinator/gate.ts): all reads, its 4 writes.
  if (level === "coordinator") return coordinatorMay(r.method, r.route);
  const rule = LEVEL_RULES[level].get(key);
  if (!rule) return false;
  return rule.target === undefined || targetOk(rule.target, caller, r.params, d);
}

// Registered after the auth layer and the first-run lock, before every route; only with strong
// protection. Returns whether it is on.
export function registerStrongAccess(app: FastifyInstance, d: AccessDeps & { gate: ChiefGate; pageRoute: string; env?: Record<string, string | undefined> }): boolean {
  if (!hardenedDeployment(d.env ?? process.env)) return false;
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const caller = await d.gate.caller(req);
    const r: AccessRequest = {
      method: req.method, route: req.routeOptions.url, url: req.url,
      params: (req.params ?? {}) as Record<string, unknown>,
      socket: (req.headers.upgrade ?? "").toLowerCase() === "websocket",
      loopback: listenerKind(req) === "loopback" && !FORWARDED_HEADERS.some((h) => req.headers[h] !== undefined),
    };
    if (await mayAccess(caller.level, caller, r, d.pageRoute, d)) return undefined;
    if (!gateRoute(d.gate, reply)) return reply;
    if (caller.level === "console") return reply.code(403).send({ error: ACCESS_ERR.console });
    // No credential: the front proxy's answer (server/frontproxy.ts registerDeviceGate), so the
    // page opens its pairing screen (src/lib/chief.ts).
    if (caller.level === "none") {
      const path = req.url.split("?")[0];
      if (path === "/api" || path.startsWith("/api/")) return reply.code(401).send({ error: "pair-required" });
      return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    }
    const alone = r.route === undefined ? undefined : USER_ALONE_ROUTES.get(`${r.method} ${r.route}`);
    return reply.code(403).send({ error: alone ?? ACCESS_ERR.agent });
  });
  return true;
}
