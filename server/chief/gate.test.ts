// server/chief/gate.test.ts — route gate helpers (spec §4.4, §7, plan decision 12),
// driven through a tiny Fastify app with one route per helper.
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER, type Caller, type CallerDeps } from "./auth.js";
import { CHIEF_ERR, gateMerge, gateRoute, gateUser, makeGate, USER_ALONE_ERR, type ChiefGate } from "./gate.js";

const USER_TOKEN = "u".repeat(43);

function rec(id: string, kind: string | undefined, hookToken: string): AgentRecord {
  return {
    id, label: id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
    hookToken, status: "idle", createdAt: 1, ...(kind ? { kind: kind as AgentRecord["kind"] } : {}),
  };
}

const RECORDS: Record<string, AgentRecord> = {
  master: rec("master", "fleet-master", "tok-master"),
  worker: rec("worker", undefined, "tok-worker"),
  lead1: rec("lead1", "lead", "tok-lead1"),
  iss1: rec("iss1", "issue", "tok-iss1"),
};

// A fake CallerDeps that counts its calls, so a test can see the gate did not
// look at the caller at all.
function fakeDeps() {
  const calls = { verify: 0, load: 0 };
  const deps: CallerDeps = {
    devices: {
      verify: async (token: string) => {
        calls.verify++;
        return token === USER_TOKEN ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null;
      },
    },
    agents: {
      load: async (id: string) => {
        calls.load++;
        return RECORDS[id] ?? null;
      },
    },
  };
  return { deps, calls };
}

const agent = (id: string, token: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: token });
const user = { [USER_HEADER]: USER_TOKEN };

let app: FastifyInstance;
let ran: string[];
let seen: Caller[];

async function build(o: { misconfigured?: string | null; userAuth?: "telegram" | "log"; strong?: boolean } = {}) {
  const { deps, calls } = fakeDeps();
  const gate: ChiefGate = makeGate({ misconfigured: o.misconfigured ?? null, userAuth: o.userAuth ?? "log", ...(o.strong !== undefined ? { strong: o.strong } : {}), deps });
  ran = [];
  seen = [];
  app = Fastify();
  app.post("/route", async (_req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    ran.push("route");
    return { ok: true };
  });
  app.post("/user", async (req, reply) => {
    const caller = await gateUser(gate, req, reply);
    if (!caller) return reply;
    ran.push("user");
    seen.push(caller);
    return { ok: true };
  });
  app.post("/merge", async (req, reply) => {
    if (!(await gateMerge(gate, req, reply))) return reply;
    ran.push("merge");
    return { ok: true };
  });
  await app.ready();
  return { gate, calls };
}

const hit = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, headers });

afterEach(async () => {
  await app?.close();
});

describe("CHIEF_ERR", () => {
  it("holds the spec's error strings verbatim", () => {
    expect(CHIEF_ERR).toEqual({
      pairRequired: "pair-required",
      misconfigured: "chief-misconfigured",
      mergeUserOnly: "merge is a user action",
    });
  });
});

describe("makeGate", () => {
  it("carries misconfigured and userAuth, and caller() reads the request headers", async () => {
    const { gate } = await build({ misconfigured: "CHIEF_CONSOLE_URL is not set", userAuth: "telegram" });
    expect(gate.misconfigured).toBe("CHIEF_CONSOLE_URL is not set");
    expect(gate.userAuth).toBe("telegram");
    let got: Caller | undefined;
    await app.close();
    app = Fastify();
    app.get("/who", async (req) => {
      got = await gate.caller(req);
      return {};
    });
    await app.inject({ method: "GET", url: "/who", headers: agent("master", "tok-master") });
    expect(got).toEqual({ level: "master", agentHeaders: true, agentId: "master", kind: "fleet-master" });
    await app.inject({ method: "GET", url: "/who", headers: user });
    expect(got).toEqual({ level: "user", agentHeaders: false, device: "laptop" });
  });
});

describe("misconfigured", () => {
  for (const url of ["/route", "/user", "/merge"]) {
    it(`${url} answers 503 chief-misconfigured for every caller and never runs the handler`, async () => {
      const { calls } = await build({ misconfigured: "CHIEF_USER_AUTH=telegram but the Master topic is not configured" });
      for (const headers of [{}, user, agent("master", "tok-master"), agent("worker", "tok-worker")]) {
        const res = await hit(url, headers);
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: "chief-misconfigured" });
      }
      expect(ran).toEqual([]);
      // The 503 comes before any caller lookup.
      expect(calls).toEqual({ verify: 0, load: 0 });
    });
  }
});

describe("gateRoute", () => {
  it("lets every caller through when the config is sound", async () => {
    await build();
    for (const headers of [{}, user, agent("worker", "tok-worker")]) {
      const res = await hit("/route", headers);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    }
    expect(ran).toEqual(["route", "route", "route"]);
  });
});

describe("gateUser", () => {
  it("headerless → 403 pair-required with the mode's userAuth", async () => {
    await build({ userAuth: "log" });
    const res = await hit("/user");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "pair-required", userAuth: "log" });
    expect(ran).toEqual([]);
  });

  it("names userAuth telegram in telegram mode", async () => {
    await build({ userAuth: "telegram" });
    const res = await hit("/user");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "pair-required", userAuth: "telegram" });
  });

  it("a valid user token → the handler runs with the user caller", async () => {
    await build();
    const res = await hit("/user", user);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(ran).toEqual(["user"]);
    expect(seen).toEqual([{ level: "user", agentHeaders: false, device: "laptop" }]);
  });

  it("a bad user token → 403 pair-required", async () => {
    await build();
    const res = await hit("/user", { [USER_HEADER]: "x".repeat(43) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "pair-required", userAuth: "log" });
    expect(ran).toEqual([]);
  });

  // Decision 12: every non-USER caller of a USER route gets pair-required,
  // agent headers included; only the merge routes answer otherwise.
  it("agent headers of any kind, valid or not → 403 pair-required", async () => {
    await build();
    for (const headers of [
      agent("master", "tok-master"), agent("worker", "tok-worker"), agent("lead1", "tok-lead1"),
      agent("master", "wrong"), { [AGENT_TOKEN_HEADER]: "tok-master" }, { ...user, ...agent("master", "tok-master") },
    ]) {
      const res = await hit("/user", headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "pair-required", userAuth: "log" });
    }
    expect(ran).toEqual([]);
  });
});

describe("gateMerge", () => {
  it("a valid user token → 200", async () => {
    await build();
    const res = await hit("/merge", user);
    expect(res.statusCode).toBe(200);
    expect(ran).toEqual(["merge"]);
  });

  it("fleet-master agent headers → 200", async () => {
    await build();
    const res = await hit("/merge", agent("master", "tok-master"));
    expect(res.statusCode).toBe(200);
    expect(ran).toEqual(["merge"]);
  });

  it("strong protection: the user merges; the fleet master gets 403 with the reason and what to do", async () => {
    const { gate } = await build({ strong: true });
    expect(gate.strong).toBe(true);
    const res = await hit("/merge", agent("master", "tok-master"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: USER_ALONE_ERR.merge });
    expect(res.json().error).toMatch(/only the user merges: use the Merge button of the Queue/);
    expect(ran).toEqual([]);
    expect((await hit("/merge", user)).statusCode).toBe(200);
    expect(ran).toEqual(["merge"]);
    // A worker still gets the merge refusal it always got.
    expect((await hit("/merge", agent("worker", "tok-worker"))).json()).toEqual({ error: CHIEF_ERR.mergeUserOnly });
  });

  it("strong is off by default (basic mode): the master merges as before", async () => {
    const { gate } = await build();
    expect(gate.strong).toBe(false);
    expect((await hit("/merge", agent("master", "tok-master"))).statusCode).toBe(200);
  });

  const refused: [string, Record<string, string>][] = [
    ["worker", agent("worker", "tok-worker")],
    ["lead", agent("lead1", "tok-lead1")],
    ["issue agent", agent("iss1", "tok-iss1")],
    ["fleet-master id with a wrong token", agent("master", "wrong")],
    ["cron:<job> header with no record", agent("cron:nightly", "tok-master")],
    ["agent token header alone", { [AGENT_TOKEN_HEADER]: "tok-master" }],
    ["valid user token plus agent headers", { ...user, ...agent("worker", "tok-worker") }],
  ];
  for (const [name, headers] of refused) {
    it(`${name} → 403 merge is a user action`, async () => {
      await build();
      const res = await hit("/merge", headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "merge is a user action" });
      expect(ran).toEqual([]);
    });
  }

  it("headerless → 403 pair-required with userAuth", async () => {
    await build({ userAuth: "telegram" });
    const res = await hit("/merge");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "pair-required", userAuth: "telegram" });
    expect(ran).toEqual([]);
  });

  it("a bad user token and no agent headers → 403 pair-required", async () => {
    await build({ userAuth: "log" });
    const res = await hit("/merge", { [USER_HEADER]: "x".repeat(43) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "pair-required", userAuth: "log" });
    expect(ran).toEqual([]);
  });
});
