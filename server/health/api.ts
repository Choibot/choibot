// server/health/api.ts — the Server page's health routes. Read only: nothing here stops a
// process or removes a file.
//   GET  /api/server/health        the state now, the short history, who uses what, the disk
//                                  sizes of the known places, the warnings
//   GET  /api/server/status        the worst warning level only (the dot of the sidebar row)
//   POST /api/server/places/check  measure the disk sizes again now (one run at a time)
// WHO: the paired user only (gateUser): an agent, a lead and the fleet master are refused. A
// console with no device pairing has one user behind the console's own sign-in, as every other
// route of such a console: the routes answer there.
// An answer holds numbers and names (a program's name, an agent's title, a folder's name in the
// work folder). No command line, no file content, no settings key.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { gateUser, type ChiefGate } from "../chief/gate.js";
import { DISPLAY_NAME } from "../brand.js";
import type { AgentRecord } from "../agents/store.js";
import { HealthMonitor, type AgentName } from "./monitor.js";
import { Places, type PlacesInput } from "./places.js";
import { isClone } from "../agents/agentclone.js";

type Env = Record<string, string | undefined>;

const PLACES_EVERY_MS = 30 * 60_000;
const PLACES_FIRST_MS = 20_000;

export function agentName(a: Pick<AgentRecord, "id" | "label" | "kind" | "area">): AgentName {
  if (a.kind === "fleet-master") return { id: a.id, title: "Fleet master", kind: "fleet-master" };
  if (a.kind === "lead") return { id: a.id, title: `Lead · ${a.area ?? a.label}`, kind: "lead" };
  return { id: a.id, title: a.label || "Agent", kind: "agent" };
}

// The console's own places and the tools' places under the home folder.
export function fixedPlaces(o: { env: Env; checkout: string; dataDirs: string[]; home?: string }): PlacesInput["fixed"] {
  const home = o.env.HOME || o.home || homedir();
  const set = (k: string): string[] => (o.env[k]?.trim() ? [o.env[k]!.trim()] : []);
  return [
    { id: "console", kind: "console", name: `${DISPLAY_NAME} (the program and its records)`, paths: [o.checkout, ...o.dataDirs] },
    {
      id: "claude", kind: "claude", name: "The agents' conversations and settings",
      paths: [join(home, ".claude"), join(home, ".claude-accounts"), join(home, ".codex"), ...set("CLAUDE_CONFIG_DIR"), ...set("CLAUDE_ACCOUNTS_DIR"), ...set("CODEX_HOME"), ...set("AGENT_HOME_ROOT")],
    },
    {
      id: "downloads", kind: "downloads", name: "Downloads of the tools (package caches)",
      paths: [".cache", ".npm", ".local/share/pnpm", ".cargo", ".rustup", ".bun"].map((p) => join(home, p)),
    },
  ];
}

export function makeHealth(d: {
  workDir: string;
  agents: () => Promise<AgentRecord[]>;
  sessionName: (agentId: string) => string;
  fixed: PlacesInput["fixed"];
  worktreeDir: string;
}): { monitor: HealthMonitor; places: Places } {
  const places = new Places({
    input: async () => ({
      workDir: d.workDir, worktreeDir: d.worktreeDir, fixed: d.fixed,
      // An agent's own clone (strong protection) is not in a folder of copies: not resolved here.
      agents: (await d.agents()).filter((a) => a.worktree && !isClone(a)).map((a) => ({ id: a.id, title: agentName(a).title, worktree: a.worktree, ...(a.repo ? { repo: basename(a.repo) } : {}) })),
    }),
  });
  const monitor = new HealthMonitor({
    workDir: d.workDir, places, sessionName: d.sessionName,
    agents: async () => (await d.agents()).map(agentName),
  });
  return { monitor, places };
}

export function registerHealthApi(app: FastifyInstance, d: {
  // The gate of the chief of staff. Absent: this console has no device pairing.
  gate?: ChiefGate;
  monitor: HealthMonitor;
  places: Places;
}): void {
  const user = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> =>
    !d.gate || (await gateUser(d.gate, req, reply)) !== null;

  app.get("/api/server/health", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    return d.monitor.view();
  });

  app.get("/api/server/status", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    return { level: d.monitor.level() };
  });

  app.post("/api/server/places/check", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    void d.places.check();
    return reply.code(202).send({ checking: true });
  });

  d.monitor.start();
  d.places.start(PLACES_EVERY_MS, PLACES_FIRST_MS);
  app.addHook("onClose", async () => { d.monitor.stop(); d.places.stop(); });
}
