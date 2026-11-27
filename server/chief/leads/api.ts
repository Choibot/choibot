// server/chief/leads/api.ts — the /api/leads routes (spec §13). Registered only
// when CHIEF_ENABLED=1; every route answers 503 while misconfigured.
//   POST /api/leads         USER: start an area's lead (the spec names no other path)
//   POST /api/leads/:area/avatar  USER: the avatar pick of an area's lead (a number, lib/leadAvatar)
//   POST /api/leads/report  LEAD only: write report.md and add a lead-report digest line
//                           (no line for a report marked `needs: "none"`, master/quiet.ts)
//   GET  /api/leads         any session: the areas with their lead (sessionId, cwd)
//   GET  /api/leads/:area   any session: repos, lead id and the last report
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionStore } from "../../agents/store.js";
import type { EventQueue } from "../../master/events.js";
import { LEAD_REPORT_NEEDS, leadReportIsAlert } from "../../master/quiet.js";
import { atomicWrite, onChain, readText } from "../files.js";
import { AVATAR_VARIANTS } from "../../../src/lib/leadAvatar.js";
import { gateRoute, gateUser, type ChiefGate } from "../gate.js";
import { AREA_RE, leadId, type AreaStore } from "./areas.js";
import type { LeadRuntimes } from "./lead.js";

export type LeadsApiDeps = {
  gate: ChiefGate;
  areas: Pick<AreaStore, "read" | "setRepos" | "setAvatar">;
  agents: Pick<SessionStore, "load">;
  // <chiefDir>/leads: <area>/report.md lives here, console-side.
  leadsDir: string;
  events: Pick<EventQueue, "addLead">;
  runtimes: Pick<LeadRuntimes, "ensure">;
  ensureLead: (area: string) => Promise<string>;
  log?: (s: string) => void;
  // True while that lead waits for the second sign-in (chief/chiefwait.ts): its row says so.
  waits?: (leadId: string) => boolean;
  // That wait is for a Claude login that was signed out on the page (agents/loginhold.ts).
  waitsLogin?: (leadId: string) => boolean;
};

const startBody = z.object({ area: z.string().regex(AREA_RE), repos: z.array(z.string().min(1).max(100)).max(50) });
// `needs`: what the report asks of the master. "none" is a pure status report
// (written, no digest line); absent counts as not known, so the line passes.
const reportBody = z.object({ text: z.string().min(1).max(1500), needs: z.enum(LEAD_REPORT_NEEDS).optional() });

const avatarBody = z.object({ variant: z.number().int().min(0).max(AVATAR_VARIANTS - 1) });

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function registerLeadsApi(app: FastifyInstance, d: LeadsApiDeps): void {
  const { gate } = d;
  const log = d.log ?? ((s: string) => console.warn(s));
  const reportPath = (area: string): string => join(d.leadsDir, area, "report.md");

  const guard = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        return await fn(req, reply);
      } catch (e) {
        log(`[chief] leads ${req.method} ${req.routeOptions.url} failed: ${errText(e)}`);
        return reply.code(500).send({ error: "internal error" });
      }
    };

  const reportAt = async (area: string): Promise<number | null> => {
    try { return (await stat(reportPath(area))).mtimeMs; } catch { return null; }
  };

  app.post("/api/leads", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    const b = startBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "invalid body" });
    const { area, repos } = b.data;
    await d.areas.setRepos(area, repos);
    // The runtime first, so the lead's inbox exists before its first event.
    d.runtimes.ensure(leadId(area), { starting: true, recordExists: true });
    return { id: await d.ensureLead(area) };
  }));

  // Only how the lead looks in the console: no lead is started and no repo changes.
  app.post("/api/leads/:area/avatar", guard(async (req, reply) => {
    if (!(await gateUser(gate, req, reply))) return reply;
    const b = avatarBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: `variant must be a whole number from 0 to ${AVATAR_VARIANTS - 1}` });
    const area = (req.params as { area: string }).area;
    if (!(await d.areas.setAvatar(area, b.data.variant))) return reply.code(404).send({ error: "unknown area" });
    return { area, avatar: b.data.variant };
  }));

  app.post("/api/leads/report", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const caller = await gate.caller(req);
    const rec = caller.level === "lead" && caller.agentId ? await d.agents.load(caller.agentId) : null;
    if (!rec || rec.kind !== "lead" || !rec.area || !AREA_RE.test(rec.area)) return reply.code(403).send({ error: "leads only" });
    const b = reportBody.safeParse(req.body ?? {});
    if (!b.success) {
      const needs = b.error.issues.some((i) => i.path[0] === "needs");
      return reply.code(400).send({ error: needs ? `needs must be one of ${LEAD_REPORT_NEEDS.join(", ")}` : "text must be 1 to 1500 characters" });
    }
    const path = reportPath(rec.area);
    await onChain(path, () => atomicWrite(path, b.data.text));
    if (leadReportIsAlert(b.data.needs)) d.events.addLead("lead-report", rec.area, rec.id);
    return { ok: true };
  }));

  app.get("/api/leads", guard(async (_req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const rows = [];
    for (const [area, e] of Object.entries(await d.areas.read())) {
      const rec = e.leadId ? await d.agents.load(e.leadId) : null;
      // The model the lead runs on (its last start), for the quiet tag of the list; its login
      // (absent = the default one), for the hover text and the pane's header.
      const model = rec?.runModel ?? rec?.model;
      const account = rec?.account;
      rows.push({
        area, repos: e.repos, leadId: e.leadId ?? null, status: rec?.status ?? null, avatar: e.avatar ?? 0,
        reportAt: await reportAt(area), sessionId: rec?.sessionId ?? null, cwd: rec?.cwd ?? null,
        ...(model ? { model } : {}),
        ...(account ? { account } : {}),
        ...(e.leadId && d.waits?.(e.leadId) ? { waits: true, ...(d.waitsLogin?.(e.leadId) ? { waitsLogin: true } : {}) } : {}),
      });
    }
    return rows;
  }));

  app.get("/api/leads/:area", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const area = (req.params as { area: string }).area;
    const areas = await d.areas.read();
    const e = AREA_RE.test(area) && Object.hasOwn(areas, area) ? areas[area] : undefined;
    if (!e) return reply.code(404).send({ error: "unknown area" });
    return { area, repos: e.repos, leadId: e.leadId ?? null, report: await readText(reportPath(area)) };
  }));
}
