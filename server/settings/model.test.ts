// server/settings/model.test.ts — Settings > Model: the model of an agent with none of its own.
// Only the paired user saves it, only to one of the models, through the one .env writer, at once.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER } from "../chief/auth.js";
import { makeGate } from "../chief/gate.js";
import { registerModelSettings, wrongModelLine } from "./model.js";

const rec: AgentRecord = { id: "a1", label: "a1", repo: "/ws/app", worktree: "/ws/wt", branch: "agent/a1", baseBranch: "main", sessionId: null, hookToken: "tok-a1", status: "idle", createdAt: 1 };

describe("Settings: Model", () => {
  let dir: string;
  let app: FastifyInstance;
  let file: string;
  let user: Record<string, string>;
  let env: Record<string, string | undefined>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "model-settings-"));
    file = join(dir, ".env");
    writeFileSync(file, "# mine\nPORT=3000\n", { mode: 0o600 });
    const devices = new DeviceStore(join(dir, "devices.json"));
    user = { [USER_HEADER]: await devices.add("laptop") };
    const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices, agents: { load: async (id: string) => (id === "a1" ? rec : null) } } });
    env = {};
    app = Fastify();
    registerModelSettings(app, { envFile: file, gate, env, log: () => {} });
    await app.ready();
  });
  afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const save = (model: unknown, headers = user) => app.inject({ method: "POST", url: "/api/settings/model", headers, payload: { model } });
  const read = async () => (await app.inject({ method: "GET", url: "/api/settings/model" })).json();

  it("not set: opus, with the four choices", async () => {
    expect(await read()).toEqual({ model: "opus", set: false, wrong: null, choices: ["fable", "opus", "sonnet", "haiku"], canSave: true, why: null });
  });
  it("each model saves to .env and applies at once", async () => {
    for (const m of ["fable", "sonnet", "haiku", "opus"]) {
      const r = await save(m);
      expect(r.statusCode).toBe(200);
      expect(readFileSync(file, "utf8")).toContain(`AGENT_MODEL=${m}\n`);
      expect(env.AGENT_MODEL).toBe(m);
      expect((await read()).model).toBe(m);
    }
    expect(readFileSync(file, "utf8").startsWith("# mine\nPORT=3000\n")).toBe(true);
  });
  it("a value that is not a model: 400 with a clear line, nothing written", async () => {
    for (const m of ["gpt-5", "claude-opus-5-5", ""]) {
      const r = await save(m);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("Not saved: the model must be one of fable, opus, sonnet, haiku.");
    }
    expect((await save(3)).statusCode).toBe(400);
    expect(readFileSync(file, "utf8")).toBe("# mine\nPORT=3000\n");
  });
  it("only the paired user saves: an agent or no pairing gets 403", async () => {
    for (const h of [{}, { [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "tok-a1" }] as Record<string, string>[]) expect((await save("haiku", h)).statusCode).toBe(403);
    expect(readFileSync(file, "utf8")).toBe("# mine\nPORT=3000\n");
  });
  it("a wrong value in .env: the GET says so, and the boot line names it", async () => {
    env.AGENT_MODEL = "gpt";
    expect(await read()).toMatchObject({ model: "opus", set: false, wrong: "gpt" });
    expect(wrongModelLine(env)).toBe('[settings] AGENT_MODEL="gpt" is not a model (fable, opus, sonnet, haiku): agents start on opus');
    expect(wrongModelLine({ AGENT_MODEL: "sonnet" })).toBeNull();
    expect(wrongModelLine({})).toBeNull();
  });
});
