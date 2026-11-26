// server/settings/share.ts — the "Share outside" section of Settings: the add-on that sends a
// ticket's page to a share service on the user's press (server/chief/queue/share.ts). The console
// knows no service: it runs ONE program of the server's owner, the share tool (the contract is in
// server/chief/queue/shareTool.ts and the README). Off until the user sets the tool.
//   GET  /api/settings/share   any session: the tool's path and why it cannot run (or null)
//   POST /api/settings/share   USER (gateUser): { tool: "/abs/path" | null }. The file is checked,
//                              one `scan` of a test page must give a contract answer, then
//                              SHARE_TOOL is written through the one .env writer (envfile.ts) and
//                              used at once, with no restart. No page goes out here.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { gateUser, type ChiefGate } from "../chief/gate.js";
import { parseScan, PATH_RULE, SHARE_TIMEOUT_MS, SHARE_TOOL_RE, toolProblem, toolRunner, type RunTool } from "../chief/queue/shareTool.js";
import { envFileWritable, envWriteBusy, EnvWriteError, writeEnvFile } from "./envfile.js";
import { NEEDS_CHIEF } from "./api.js";

// The tool the share routes use now. Settings changes it in place.
export type ShareToolSetting = { path: string | null };

export function shareToolFromEnv(env: Record<string, string | undefined>): ShareToolSetting {
  const v = (env.SHARE_TOOL ?? "").trim();
  return { path: SHARE_TOOL_RE.test(v) ? v : null };
}

export type ShareSettingsDeps = {
  setting: ShareToolSetting;
  envFile?: string;
  gate?: ChiefGate;
  run?: (tool: string) => RunTool;
  toolProblem?: (path: string) => Promise<string | null>;
  log?: (s: string) => void;
};

const saveBody = z.object({ tool: z.string().max(600).nullable() }).strict();
const TEST_PAGE = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Test</title></head><body><p>A test page of the console. It is not shared.</p></body></html>";

export function registerShareSettings(app: FastifyInstance, d: ShareSettingsDeps): void {
  const log = d.log ?? ((s: string) => console.warn(s));
  const problemOf = d.toolProblem ?? toolProblem;

  app.get("/api/settings/share", async () => {
    const path = d.setting.path;
    const file = d.envFile ? await envFileWritable(d.envFile) : { ok: false as const, why: "the console has no settings file (.env)" };
    return {
      tool: path,
      problem: path ? await problemOf(path) : null,
      canSave: !!d.gate && file.ok,
      why: !d.gate ? "Saving needs a paired device: the chief of staff is off" : file.ok ? null : `Saving is off: ${file.why}`,
    };
  });

  app.post("/api/settings/share", async (req, reply) => {
    if (!d.envFile) return reply.code(404).send({ error: "not found" });
    if (!d.gate) return reply.code(403).send(NEEDS_CHIEF);
    const caller = await gateUser(d.gate, req, reply);
    if (!caller) return reply;
    const b = saveBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "The request was not understood." });
    if (envWriteBusy()) return reply.code(409).send({ error: "Another save is running. Try again in a moment." });
    const file = await envFileWritable(d.envFile);
    if (!file.ok) return reply.code(409).send({ error: `Saving is off: ${file.why}` });
    const next = b.data.tool === null ? null : b.data.tool.trim();
    if (next !== null) {
      if (!SHARE_TOOL_RE.test(next)) return reply.code(400).send({ error: PATH_RULE });
      const problem = await problemOf(next);
      if (problem) return reply.code(400).send({ error: problem });
      // One check of the contract: `scan` of a small test page must answer as a share tool does.
      const dir = await mkdtemp(join(tmpdir(), "console-share-test-"));
      try {
        const page = join(dir, "test.html");
        await writeFile(page, TEST_PAGE, { mode: 0o600 });
        const r = parseScan(await (d.run ?? toolRunner)(next)(["scan", page], SHARE_TIMEOUT_MS.scan));
        if (!r.ok) return reply.code(400).send({ error: `This program did not answer as a share tool. ${r.error}` });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    try {
      await writeEnvFile(d.envFile, { SHARE_TOOL: next });
    } catch (e) {
      log(`[settings] share tool not saved: ${e instanceof EnvWriteError ? e.message : "the write failed"}`);
      return reply.code(500).send({ error: "Not saved: the settings file of your server could not be written." });
    }
    d.setting.path = next;
    log(`[settings] share tool ${next ? "set" : "removed"} by device ${caller.device ?? "?"}`);
    return { tool: next, problem: null };
  });
}
