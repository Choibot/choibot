// server/gh/appapi.test.ts — the app login routes: for the paired user only (the read too), and
// an answer holds states and times, never a token.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { makeGate } from "../chief/gate.js";
import { NEEDS_PAIRING } from "../setup/actions.js";
import { REVOKE_ON_GITHUB, registerGithubAppApi } from "./appapi.js";
import { AppReposError } from "./apprepos.js";
import type { AppLoginState, AppTokenState } from "./applogin.js";
import { FAKE_ACCESS } from "./testkit.js";

const USER = "user-token";
const HOOK = "hook-token";
const user = { [USER_HEADER]: USER };
const agent = { [AGENT_HEADER]: "w1", [AGENT_TOKEN_HEADER]: HOOK };
const ROUTES: ["GET" | "POST", string][] = [["GET", "/api/github/app"], ["POST", "/api/github/app/login"], ["POST", "/api/github/app/disconnect"]];

function app(o: { gate?: boolean } = {}) {
  const a = Fastify();
  const did: string[] = [];
  let login: AppLoginState = { state: "idle" };
  let token: AppTokenState = { state: "ok", accessExpiresAt: 1_000 + 28_800_000, refreshExpiresAt: null };
  const gate = makeGate({
    misconfigured: null, userAuth: "log",
    deps: {
      devices: { verify: async (t: string) => (t === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) },
      agents: { load: async (id: string) => (id === "w1" ? { id, hookToken: HOOK } as never : null) },
    },
  });
  registerGithubAppApi(a, {
    ...(o.gate === false ? {} : { gate }),
    now: () => 1_000,
    login: {
      loginState: () => login,
      start: async (s) => { did.push(`start${s?.fresh ? " fresh" : ""}`); login = { state: "waiting", code: "WDJB-MJHT", url: "https://github.com/login/device", expiresAt: 901_000 }; return login; },
      tokenState: async () => token,
      disconnect: async () => { did.push("disconnect"); token = { state: "none" }; },
    },
  });
  return { a, did };
}

describe("registerGithubAppApi", () => {
  it("refuses an agent and a console with no pairing on every route, and does nothing", async () => {
    const { a, did } = app();
    for (const [method, url] of ROUTES) {
      const r = await a.inject({ method, url, headers: agent, payload: {} });
      expect(r.statusCode, url).toBe(403);
    }
    const off = app({ gate: false });
    for (const [method, url] of ROUTES) {
      const r = await off.a.inject({ method, url, headers: user, payload: {} });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual(NEEDS_PAIRING);
    }
    expect([...did, ...off.did]).toEqual([]);
  });

  it("gives the user the code, the time that is left and the token state, never a token", async () => {
    const { a, did } = app();
    const s = await a.inject({ method: "POST", url: "/api/github/app/login", headers: user, payload: { fresh: true } });
    expect(s.json()).toEqual({ state: "waiting", code: "WDJB-MJHT", url: "https://github.com/login/device", leftMs: 900_000 });
    const g = await a.inject({ method: "GET", url: "/api/github/app", headers: user });
    expect(g.json()).toEqual({
      login: { state: "waiting", code: "WDJB-MJHT", url: "https://github.com/login/device", leftMs: 900_000 },
      token: { state: "ok", accessLeftMs: 28_800_000, refreshLeftMs: null },
    });
    expect(g.body).not.toContain(FAKE_ACCESS);
    const d = await a.inject({ method: "POST", url: "/api/github/app/disconnect", headers: user, payload: {} });
    expect(d.json()).toEqual({ ok: true, github: REVOKE_ON_GITHUB });
    expect(did).toEqual(["start fresh", "disconnect"]);
  });
});

describe("GET /api/github/app/repos", () => {
  const USED = [
    { slug: "acme/shop", name: "shop", lastAt: 1_000 - 3_600_000, from: ["agents" as const] },
    { slug: "acme/infra", name: "infra", lastAt: 1_000 - 86_400_000, from: ["tickets" as const] },
  ];
  const LIST = {
    repos: [{ slug: "Acme/Shop", private: true, push: true, archived: false, language: null, pushedAt: null, sizeKb: 1 }],
    capped: false, manage: [{ account: "acme", url: "https://github.com/organizations/acme/settings/installations/12" }],
  };
  function lists(o: { key: "ok" | "none"; reach?: () => Promise<typeof LIST> }) {
    const a = Fastify();
    let reads = 0;
    const gate = makeGate({
      misconfigured: null, userAuth: "log",
      deps: {
        devices: { verify: async (t: string) => (t === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) },
        agents: { load: async (id: string) => (id === "w1" ? { id, hookToken: HOOK } as never : null) },
      },
    });
    registerGithubAppApi(a, {
      gate, now: () => 1_000,
      login: {
        loginState: () => ({ state: "idle" }), start: async () => ({ state: "idle" }), disconnect: async () => {},
        tokenState: async () => (o.key === "ok" ? { state: "ok", accessExpiresAt: null, refreshExpiresAt: null } : { state: "none" }),
      },
      repos: { reach: async () => { reads++; return (o.reach ?? (async () => LIST))(); }, used: async () => USED, appUrl: "https://github.com/apps/choibot", days: 14 },
    });
    return { a, reads: () => reads };
  }

  it("is for the paired user only", async () => {
    const { a, reads } = lists({ key: "ok" });
    expect((await a.inject({ method: "GET", url: "/api/github/app/repos", headers: agent })).statusCode).toBe(403);
    expect(reads()).toBe(0);
  });

  it("not connected: no read of GitHub, the used repos with no mark", async () => {
    const { a, reads } = lists({ key: "none" });
    const r = (await a.inject({ method: "GET", url: "/api/github/app/repos", headers: user })).json();
    expect(r).toEqual({
      reach: null, why: "not-connected", days: 14,
      used: [
        { slug: "acme/shop", name: "shop", agoMs: 3_600_000, from: ["agents"], reach: null },
        { slug: "acme/infra", name: "infra", agoMs: 86_400_000, from: ["tickets"], reach: null },
      ],
    });
    expect(reads()).toBe(0);
  });

  it("connected: the app's list and a mark on each used repo; the list is kept 30 s unless fresh", async () => {
    const { a, reads } = lists({ key: "ok" });
    const r = (await a.inject({ method: "GET", url: "/api/github/app/repos", headers: user })).json();
    expect(r.reach).toEqual({ repos: [{ slug: "Acme/Shop", private: true, push: true }], manage: LIST.manage, appUrl: "https://github.com/apps/choibot", capped: false });
    expect(r.used.map((u: { slug: string; reach: boolean }) => [u.slug, u.reach])).toEqual([["acme/shop", true], ["acme/infra", false]]);
    await a.inject({ method: "GET", url: "/api/github/app/repos", headers: user });
    expect(reads()).toBe(1);
    await a.inject({ method: "GET", url: "/api/github/app/repos?fresh=1", headers: user });
    expect(reads()).toBe(2);
  });

  it("says why when GitHub refuses the key or does not answer", async () => {
    const { a } = lists({ key: "ok", reach: async () => { throw new AppReposError("refused", "x"); } });
    const r = (await a.inject({ method: "GET", url: "/api/github/app/repos", headers: user })).json();
    expect(r).toMatchObject({ reach: null, why: "refused" });
    expect(r.used.every((u: { reach: unknown }) => u.reach === null)).toBe(true);
  });
});
