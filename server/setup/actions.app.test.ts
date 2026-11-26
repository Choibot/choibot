// server/setup/actions.app.test.ts — the Set-up login routes with the GitHub app switch on: the
// same routes and gate, the app's states, and each view says that the login is the app's (with
// the app's page, to install it on repos).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { makeGate } from "../chief/gate.js";
import { registerSetupActions, type SetupLoginState } from "./actions.js";
import { RepoPick } from "./repopick.js";

const USER = "user-token";
const HOOK = "hook-token";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "setup-actions-app-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function app() {
  const a = Fastify();
  const gate = makeGate({
    misconfigured: null, userAuth: "log",
    deps: {
      devices: { verify: async (t: string) => (t === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) },
      agents: { load: async (id: string) => (id === "w1" ? { id, hookToken: HOOK } as never : null) },
    },
  });
  let state: SetupLoginState = { state: "idle" };
  const starts: boolean[] = [];
  registerSetupActions(a, {
    gate, now: () => 1_000, changed: () => {},
    repos: new RepoPick({ workspaceDir: dir, bin: join(dir, "no-gh"), onBox: async () => [] }),
    githubApp: { appUrl: "https://github.com/apps/choibot" },
    login: {
      state: () => state,
      start: async (o) => { starts.push(o.fresh === true); state = { state: "waiting", code: "WDJB-MJHT", url: "https://github.com/login/device", expiresAt: 901_000 }; return state; },
    },
  });
  return { a, starts, fail: (reason: "disabled" | "bad-client") => { state = { state: "failed", reason }; } };
}

describe("the Set-up login with the GitHub app switch on", () => {
  it("gives the app's code with the app's page, to the paired user only", async () => {
    const { a, starts, fail } = app();
    const agent = await a.inject({ method: "POST", url: "/api/setup/github/login", headers: { [AGENT_HEADER]: "w1", [AGENT_TOKEN_HEADER]: HOOK }, payload: {} });
    expect(agent.statusCode).toBe(403);
    const idle = await a.inject({ method: "GET", url: "/api/setup/github/login", headers: { [USER_HEADER]: USER } });
    expect(idle.json()).toEqual({ state: "idle", app: { appUrl: "https://github.com/apps/choibot" } });
    const s = await a.inject({ method: "POST", url: "/api/setup/github/login", headers: { [USER_HEADER]: USER }, payload: { fresh: true } });
    expect(s.json()).toEqual({ state: "waiting", code: "WDJB-MJHT", url: "https://github.com/login/device", leftMs: 900_000, app: { appUrl: "https://github.com/apps/choibot" } });
    expect(starts).toEqual([true]);
    fail("disabled");
    expect((await a.inject({ method: "GET", url: "/api/setup/github/login", headers: { [USER_HEADER]: USER } })).json())
      .toEqual({ state: "failed", reason: "disabled", app: { appUrl: "https://github.com/apps/choibot" } });
  });
});
