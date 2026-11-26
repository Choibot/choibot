// server/chief/coderoutes.ts — the code-route gate (spec §3 "Code-route gate"
// and "Typed input to persistent agents", Phase 2c). Only in a hardened
// deployment (ruling P4); otherwise it registers nothing and every route
// answers as before. One preHandler hook, matched on the route pattern and
// the method (never the raw URL):
//   - USER only: the routes that run caller-chosen code as the console uid
//     (services, tasks), typed input and prompt keys to a persistent
//     agent, and the text of a persistent agent's screen;
//   - a non-USER caller may not read the console's own checkout (outside the
//     agent worktree root) or any .env* file through the files API. In a
//     hardened deployment `.env` is 0600 console-owned, so these routes would
//     be an agent's only way to the console's secrets.
// An agent owns its worktree and can swap a file for a symlink after this
// hook (ruling 2c-3-b), so the files routes check again what they open:
// filesGuard below, which index.ts passes to registerFilesApi.
// USER callers are never refused here. The terminal WebSockets are Task 2c-4.
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isPersistentKind, type SessionStore } from "../agents/store.js";
import { isAgentId } from "../ids.js";
import type { FilesGuard } from "../files/api.js";
import { gateUser, pairRequired, type ChiefGate } from "./gate.js";
import { hardenedDeployment } from "./hardened.js";
import { SETTINGS_NAME } from "../layout.js";

type Env = Record<string, string | undefined>;

// "<METHOD> <route pattern>".
const USER_ONLY = new Set([
  "POST /api/services",
  "PATCH /api/services/:id",
  "DELETE /api/services/:id",
  "POST /api/services/:id/start",
]);
const INPUT = "POST /api/agents/:id/input";
// The prompt card (agents/prompt-api.ts): keys are typed input, and the
// prompt and screen routes read the terminal. For a persistent agent each is
// USER only, as its composer input and its terminal WebSocket are.
const PERSISTENT_USER_ONLY = new Set([
  INPUT,
  "POST /api/agents/:id/keys",
  "GET /api/agents/:id/prompt",
  "GET /api/agents/:id/screen",
]);
// The files routes that read content or names, and the query param each one
// resolves (server/files/api.ts). HEAD runs the GET handler too.
const FILE_PARAM = new Map<string, "path" | "root">([
  ["/api/files/content", "path"],
  ["/api/files/search", "root"],
  ["/api/files/all", "root"],
  ["/api/files/definition", "root"],
]);

// p is root or inside it: path boundaries, not string prefixes.
function within(p: string, root: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// The real path, or p itself when it does not resolve (missing, a loop).
async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

// A .env* path component, or the settings file of a release layout (server/layout.ts). Also one git
// quoted (S2): with core.quotepath=off git still quotes a name with a `"`, `\` or control char, so its
// first component starts with `".env`.
const namesEnv = (p: string): boolean => p.split(sep).some((c) => c.startsWith(".env") || c.startsWith('".env') || c === SETTINGS_NAME || c === `"${SETTINGS_NAME}"`);

// Whether a non-USER caller is refused the files-route param q. Resolved as
// the route does (resolve against the cwd, then realpath).
async function guardedPath(q: unknown, env: Env): Promise<boolean> {
  // A repeated param: the route answers 400 anyway; refuse rather than guess.
  if (q !== undefined && typeof q !== "string") return true;
  const asked = resolve(q ?? "");
  return namesEnv(asked) || refusedReal(await real(asked), env);
}

// The rule on a real path: a .env* component, the console checkout or a dir
// that holds it, or inside the checkout outside the agent worktree root.
async function refusedReal(target: string, env: Env): Promise<boolean> {
  if (namesEnv(target)) return true;
  const checkout = await real(process.cwd());
  // A root that holds the checkout: search and the grep fallback recurse into it.
  if (within(checkout, target)) return true;
  if (!within(target, checkout)) return false;
  // Relative like spawn.ts: against the repo, here the console's own checkout.
  // It counts only strictly inside the checkout, never as all of it.
  const wtRoot = await real(resolve(checkout, env.AGENT_WORKTREE_ROOT ?? ".agent-worktrees"));
  return !(wtRoot !== checkout && within(wtRoot, checkout) && within(target, wtRoot));
}

// The PERSISTENT_USER_ONLY routes: a persistent agent's record (decision 47: the
// id is checked before the load). An unknown or invalid id goes to the route.
// A record file that exists but does not load (save is a plain writeFile, so
// a reader can see it half-written) may be a master's: gated (ruling 2c-3-c).
async function persistentTarget(agents: Pick<SessionStore, "load" | "exists">, req: FastifyRequest): Promise<boolean> {
  const id = (req.params as { id?: unknown } | undefined)?.id;
  if (!isAgentId(id)) return false;
  const rec = await agents.load(id);
  if (rec === null) return agents.exists(id);
  return isPersistentKind(rec.kind);
}

// The files routes' second check (ruling 2c-3-b), on what they opened:
// undefined unless hardened, and without a guard the routes run today's code.
export function filesGuard(d: { gate: ChiefGate; env?: Env }): FilesGuard | undefined {
  const env = d.env ?? process.env;
  if (!hardenedDeployment(env)) return undefined;
  return {
    user: async (req) => (await d.gate.caller(req)).level === "user",
    refused: (target) => refusedReal(target, env),
    hidden: namesEnv,
    refuse: (reply) => pairRequired(d.gate, reply),
  };
}

export function registerCodeRouteGate(
  app: FastifyInstance,
  d: { gate: ChiefGate; agents: Pick<SessionStore, "load" | "exists">; env?: Env },
): void {
  const env = d.env ?? process.env;
  if (!hardenedDeployment(env)) return;
  // gateUser sends the refusal itself; returning reply then ends the request.
  const userOnly = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> =>
    (await gateUser(d.gate, req, reply)) ? undefined : reply;

  app.addHook("preHandler", async (req, reply) => {
    const url = req.routeOptions.url;
    if (url === undefined) return undefined;
    const route = `${req.method} ${url}`;
    if (USER_ONLY.has(route)) return userOnly(req, reply);
    // HEAD runs the GET handler too.
    const read = req.method === "HEAD" ? `GET ${url}` : route;
    if (PERSISTENT_USER_ONLY.has(read)) return (await persistentTarget(d.agents, req)) ? userOnly(req, reply) : undefined;
    const param = FILE_PARAM.get(url);
    if (param && (req.method === "GET" || req.method === "HEAD")) {
      const q = (req.query as Record<string, unknown> | undefined)?.[param];
      if (await guardedPath(q, env)) return userOnly(req, reply);
    }
    return undefined;
  });
}
