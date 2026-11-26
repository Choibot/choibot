// server/settings/share.test.ts — Settings, "Share outside": the share tool is set only by the paired
// user, only to a program that answers the contract, through the one .env writer, at once.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER } from "../chief/auth.js";
import { makeGate } from "../chief/gate.js";
import type { RunTool, ToolRun } from "../chief/queue/shareTool.js";
import { registerShareSettings, shareToolFromEnv, type ShareToolSetting } from "./share.js";

const rec: AgentRecord = { id: "a1", label: "a1", repo: "/ws/app", worktree: "/ws/wt", branch: "agent/a1", baseBranch: "main", sessionId: null, hookToken: "tok-a1", status: "idle", createdAt: 1 };

describe("Settings: Share outside", () => {
  let dir: string;
  let app: FastifyInstance;
  let env: string;
  let user: Record<string, string>;
  let setting: ShareToolSetting;
  let answer: ToolRun;
  let calls: string[][];
  let logs: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "share-settings-"));
    env = join(dir, ".env");
    writeFileSync(env, "# mine\nPORT=3000\n", { mode: 0o600 });
    const devices = new DeviceStore(join(dir, "devices.json"));
    user = { [USER_HEADER]: await devices.add("laptop") };
    const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices, agents: { load: async (id: string) => (id === "a1" ? rec : null) } } });
    setting = shareToolFromEnv({});
    answer = { code: 0, stdout: "clean\n", stderr: "", timedOut: false };
    calls = []; logs = [];
    const run = (tool: string): RunTool => async (args) => { calls.push([tool, ...args]); return answer; };
    app = Fastify();
    registerShareSettings(app, { setting, envFile: env, gate, run, toolProblem: async (p) => (p.startsWith("/ok/") ? null : "There is no file at this path on your server."), log: (s) => logs.push(s) });
    await app.ready();
  });
  afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

  const save = (tool: string | null, headers = user) => app.inject({ method: "POST", url: "/api/settings/share", headers, payload: { tool } });

  it("is off until set; the env value is used only when it keeps the value rule", async () => {
    expect((await app.inject({ method: "GET", url: "/api/settings/share" })).json()).toEqual({ tool: null, problem: null, canSave: true, why: null });
    expect(shareToolFromEnv({ SHARE_TOOL: "/opt/t" }).path).toBe("/opt/t");
    expect(shareToolFromEnv({ SHARE_TOOL: "t; rm -rf /" }).path).toBeNull();
  });

  it("only the paired user saves: an agent or no pairing gets 403 and nothing changes", async () => {
    for (const h of [{}, { [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "tok-a1" }] as Record<string, string>[]) expect((await save("/ok/tool", h)).statusCode).toBe(403);
    expect(calls).toEqual([]);
    expect(readFileSync(env, "utf8")).toBe("# mine\nPORT=3000\n");
  });

  it("a save checks the program with one scan of a test page, writes SHARE_TOOL and applies it at once", async () => {
    const res = await save("/ok/tool");
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([["/ok/tool", "scan", expect.stringMatching(/test\.html$/)]]);
    expect(readFileSync(env, "utf8")).toBe("# mine\nPORT=3000\nSHARE_TOOL=/ok/tool\n");
    expect(setting.path).toBe("/ok/tool");
    expect(logs).toEqual([expect.stringMatching(/^\[settings\] share tool set by device /)]);
    expect(logs[0]).not.toContain("/ok/tool");
    // Off again: the key goes, the setting with it.
    expect((await save(null)).statusCode).toBe(200);
    expect(readFileSync(env, "utf8")).toBe("# mine\nPORT=3000\n");
    expect(setting.path).toBeNull();
  });

  it("refuses a path that breaks the rule, a file that cannot run, and a program that does not answer as a share tool", async () => {
    expect((await save("/ok/a b")).json().error).toMatch(/^Give the full path of the program/);
    expect((await save("/ok/../etc/x")).json().error).toMatch(/^Give the full path of the program/);
    expect((await save("/nope/tool")).json().error).toBe("There is no file at this path on your server.");
    answer = { code: 2, stdout: "", stderr: "usage: ls\n", timedOut: false };
    const res = await save("/ok/ls");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("This program did not answer as a share tool. The share tool said: usage: ls");
    expect(readFileSync(env, "utf8")).toBe("# mine\nPORT=3000\n");
    expect(setting.path).toBeNull();
  });
});
