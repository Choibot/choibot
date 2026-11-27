// server/agents/signout.test.ts — "Sign out" of a Claude login (POST /api/accounts/:id/logout):
// the gate, the agents on the login, the order (no agent stops before Claude signed out), a login
// that comes back, the Recurring runs, and strong protection's two logins through the helper.
// Every Claude here is a fake: a shell script that acts on files of a throwaway folder.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentApi } from "./api.js";
import { SessionStore, type AgentRecord } from "./store.js";
import { EventHub } from "../events.js";
import { accessTokenFor, forgetSignedOut, isSignedOut, loginInPlaceOf, type AccountPaths } from "./accounts.js";
import { AgentLoginStatus, agentLoginStatus } from "./agentlogin.js";
import { makeGate } from "../chief/gate.js";
import { ChiefWait, startWaited } from "../chief/chiefwait.js";
import type { RunNow } from "../cron/running.js";
import { LoginHold } from "./loginhold.js";
import { makeRecoveryCtx } from "./api.js";
import { resumeAgent } from "./recovery.js";
import type { ConsoleEvent } from "../events.js";
import { registerMasterApi } from "../master/api.js";

const W = "11111111-1111-4111-8111-111111111111", W2 = "22222222-2222-4222-8222-222222222222";
const GOOD = "the-good-code#state-1";
const USER = { "x-choibot-user": "device-ok" };

let base: string;
let paths: AccountPaths;
let store: SessionStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "signout-"));
  paths = { root: join(base, "accounts"), defaultDir: join(base, "claude"), defaultClaudeJson: join(base, ".claude.json") };
  await mkdir(join(paths.defaultDir, "projects"), { recursive: true });
  await writeFile(paths.defaultClaudeJson, JSON.stringify({ oauthAccount: { emailAddress: "me@x.io" } }));
  await mkdir(join(base, "ws"), { recursive: true });
  store = new SessionStore(join(base, "store"));
});
afterEach(async () => { forgetSignedOut(); vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });

const credsOf = (id: string) => join(id === "default" ? paths.defaultDir : join(paths.root, id), ".credentials.json");
async function logIn(id: string) {
  await mkdir(join(credsOf(id), ".."), { recursive: true });
  await writeFile(credsOf(id), JSON.stringify({ claudeAiOauth: { accessToken: "not-a-real-token" } }));
}

// A live id ends a tick after kill(), like the real manager. `onKill`: what a test checks or does
// at the moment of the kill (a Claude that writes its login back as it ends).
function fakeTerminals(onKill: (id: string) => void = () => {}) {
  const ids = new Set<string>();
  return {
    spawned: [] as { id: string; env?: Record<string, string> }[],
    killed: [] as string[],
    input: new Map<string, number>(),
    spawn(o: { id: string; env?: Record<string, string> }) { ids.add(o.id); this.spawned.push(o); },
    kill(id: string) { this.killed.push(id); onKill(id); setTimeout(() => ids.delete(id), 20); },
    has(id: string) { return ids.has(id); },
    hasSession: async () => false,
    reattach: async () => null,
    lastInputAt(id: string) { return this.input.get(id); },
    lastOutputAt() { return undefined; },
    write() {}, resize() {}, attach() { return null; },
  };
}

const agent = (id: string, over: Partial<AgentRecord> = {}) => store.save({
  id, label: id, repo: "", worktree: join(base, "ws"), cwd: join(base, "ws"), branch: "", baseBranch: "", sessionId: null,
  hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...over,
} as AgentRecord);

// The fake Claude of basic protection: `auth logout` removes the credentials file of its folder
// (CLAUDE_CONFIG_DIR, or the main login's folder), as Claude Code does. Knobs: a file `fail`
// (the command fails), `keep` (it says yes and removes nothing). `auth login` gives a link and
// takes the code GOOD (it writes the credentials file); `auth status` reads that file.
async function fakeClaude(): Promise<{ bin: string; env: Record<string, string | undefined>; calls: () => string[] }> {
  const bin = join(base, "fake-claude");
  await writeFile(bin, `#!/usr/bin/env bash
dir="\${CLAUDE_CONFIG_DIR:-${paths.defaultDir}}"
echo "$1 $2 $dir" >> "${base}/claude.log"
if [ "$1 $2" = "auth logout" ]; then
  [ -f "${base}/fail" ] && { echo "Failed to log out" >&2; exit 1; }
  [ -f "${base}/keep" ] && exit 0
  rm -f "$dir/.credentials.json"; echo "Successfully logged out from your Anthropic account."; exit 0
fi
if [ "$1 $2" = "auth status" ]; then
  [ -f "$dir/.credentials.json" ] && { echo '{"loggedIn":true,"email":"ada@example.invalid"}'; exit 0; }
  echo '{"loggedIn":false}'; exit 1
fi
if [ "$1 $2" = "auth login" ]; then
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true"
  IFS= read -r code || exit 1
  [ "$code" = "${GOOD}" ] && { mkdir -p "$dir"; echo '{"claudeAiOauth":{"accessToken":"x"}}' > "$dir/.credentials.json"; exit 0; }
  exit 1
fi
exit 1
`, { mode: 0o755 });
  const calls = () => (existsSync(join(base, "claude.log")) ? readFileSync(join(base, "claude.log"), "utf8").trim().split("\n") : []);
  return { bin, env: { PATH: process.env.PATH }, calls };
}

const gate = () => makeGate({
  misconfigured: null, userAuth: "log",
  deps: { devices: { verify: async (t: string) => (t === "device-ok" ? { label: "phone" } : null) } as never, agents: store },
});

async function basicApp(o: {
  chief?: boolean; logins?: string[]; onKill?: (id: string) => void; busy?: (r: AgentRecord) => boolean;
  waits?: () => string[]; runs?: () => Promise<RunNow[]>; relaunch?: (id: string) => Promise<"relaunched" | "waits" | "gone" | "failed">;
} = {}) {
  const claude = await fakeClaude();
  const terminals = fakeTerminals(o.onKill);
  const a = Fastify();
  const refreshed: string[] = [];
  const hub = new EventHub();
  const events: ConsoleEvent[] = [];
  hub.subscribe((e) => { events.push(e); });
  // The hold as the server makes it (index.ts): the login is back, or another login works.
  const loginHold = new LoginHold({
    file: join(base, "data", "logins-held.json"), log: () => {},
    canStart: async (l) => (await accessTokenFor(l, paths)) !== null || (await loginInPlaceOf(l, paths)) !== null,
  });
  const started: string[][] = [];
  registerAgentApi(a, {
    terminals: terminals as never, store, hub, workspaceDir: join(base, "ws"), accounts: paths,
    loginHold, startPersistent: async (ids) => { started.push(ids); },
    claudeLogin: { bin: claude.bin, env: claude.env, log: () => {} }, onClaudeLogin: (id) => refreshed.push(id),
    defaultLoginFile: join(base, "data", "default-login.json"),
    ...(o.chief === false ? {} : { chief: gate() }),
    ...(o.busy ? { agentBusy: o.busy } : {}),
    ...(o.waits ? { relaunchWaits: o.waits } : {}),
    ...(o.runs ? { recurringRuns: o.runs } : {}),
    ...(o.relaunch ? { relaunchPersistent: o.relaunch } : {}),
  });
  for (const id of o.logins ?? ["default"]) {
    if (id !== "default") await mkdir(join(paths.root, id), { recursive: true });
    await logIn(id);
  }
  const signOut = (id: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = USER) =>
    a.inject({ method: "POST", url: `/api/accounts/${id}/logout`, payload, headers });
  // A sign-in from the page, to its end.
  const signIn = async (id: string) => {
    await a.inject({ method: "POST", url: `/api/accounts/${id}/login`, payload: {}, headers: USER });
    await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: GOOD }, headers: USER });
    for (let i = 0; i < 200; i++) {
      if ((await a.inject({ method: "GET", url: "/api/accounts/login", headers: USER })).json().state === "done") return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the sign-in did not end");
  };
  return { a, terminals, claude, signOut, signIn, refreshed, events, loginHold, started };
}

describe("sign out: who may press it", () => {
  it("only the paired owner: an agent header, a local call with no pairing and a wrong device token get 403 pair-required; Claude never runs", async () => {
    const { a, signOut, claude } = await basicApp();
    try {
      await agent("lead-console", { kind: "lead" });
      for (const headers of [
        { "x-choibot-agent": "lead-console", "x-choibot-agent-token": "tok-lead-console" }, // a lead, with its own token
        { "x-choibot-agent": W, "x-choibot-agent-token": "nope" },
        {}, // a local call: no pairing
        { "x-choibot-user": "not-a-device" },
      ]) {
        const r = await signOut("default", {}, headers as Record<string, string>);
        expect([r.statusCode, r.json().error], JSON.stringify(headers)).toEqual([403, "pair-required"]);
      }
      expect(claude.calls()).toEqual([]);
      expect(existsSync(credsOf("default"))).toBe(true);
    } finally { await a.close(); }
  });

  it("with chief off nothing is paired, so nothing signs out", async () => {
    const { a, signOut, claude } = await basicApp({ chief: false });
    try {
      const r = await signOut("default");
      expect([r.statusCode, r.json().error]).toEqual([403, "Pair a device first. Only a paired device can sign out a Claude login."]);
      expect(claude.calls()).toEqual([]);
    } finally { await a.close(); }
  });

  it("no path of the CLI reaches it: no file of bin/ names the route", async () => {
    const root = join(__dirname, "..", "..", "bin");
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(d, e.name)); else files.push(join(d, e.name));
      }
    };
    await walk(root);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(await readFile(f, "utf8"), f).not.toMatch(/\/logout\b/);
  });
});

describe("sign out: basic protection", () => {
  it("a login with no agent: Claude signs out of its own folder; the row says signed out; the default moves on", async () => {
    const { a, signOut, claude, refreshed } = await basicApp({ logins: ["default", "work"] });
    try {
      const r = await signOut("work");
      expect([r.statusCode, r.json()]).toEqual([200, { signedOut: true, moved: 0, waits: 0, working: 0, failed: 0, stopped: 0, notEnded: 0, waiting: [], restarted: [], recurring: [] }]);
      expect(claude.calls()).toEqual([`auth logout ${join(paths.root, "work")}`]);
      expect(existsSync(credsOf("work"))).toBe(false);
      expect(existsSync(credsOf("default"))).toBe(true);
      const rows = (await a.inject({ method: "GET", url: "/api/accounts" })).json().accounts;
      expect(rows.find((x: { id: string }) => x.id === "work")).toMatchObject({ loggedIn: false, signedOut: true });
      expect(refreshed).toEqual(["work"]);
      // Not signed in any more: a second press is refused, and Claude does not run again.
      const again = await signOut("work");
      expect([again.statusCode, again.json().error]).toEqual([409, "This login is not signed in on your server."]);
      expect(claude.calls()).toHaveLength(1);
    } finally { await a.close(); }
  });

  it("another login works: the agents first move there by the move of Move all, then Claude signs out", async () => {
    const { a, signOut, terminals } = await basicApp({ logins: ["default", "work"] });
    try {
      await agent(W);
      terminals.spawn({ id: W });
      terminals.spawned.length = 0;
      // No login named for the agents: refused, nothing moves.
      const none = await signOut("default");
      expect([none.statusCode, none.json().error]).toEqual([400, "Pick the login that its agents move to."]);
      expect(terminals.killed).toEqual([]);
      const r = await signOut("default", { to: "work" });
      expect(r.json()).toMatchObject({ signedOut: true, moved: 1, working: 0, stopped: 0 });
      expect((await store.load(W))?.account).toBe("work");
      expect(terminals.spawned.map((x) => [x.id, x.env?.CLAUDE_CONFIG_DIR])).toEqual([[W, join(paths.root, "work")]]);
      expect(existsSync(credsOf("default"))).toBe(false);
    } finally { await a.close(); }
  });

  it("an agent that works now stays (the rule of the move): no sign-out, the answer says what moved and what did not", async () => {
    const { a, signOut, claude, terminals } = await basicApp({ logins: ["default", "work"] });
    try {
      await agent(W, { status: "running" });
      await agent(W2);
      terminals.spawn({ id: W }); terminals.spawn({ id: W2 });
      const r = await signOut("default", { to: "work" });
      expect([r.statusCode, r.json()]).toEqual([409, { signedOut: false, moved: 1, waits: 0, working: 1, failed: 0, stopped: 0, notEnded: 0, waiting: [], restarted: [], recurring: [], why: "moves" }]);
      expect(claude.calls()).toEqual([]);
      expect(existsSync(credsOf("default"))).toBe(true);
      expect(isSignedOut("default")).toBe(false);
    } finally { await a.close(); }
  });

  it("one login only: Claude signs out first, then the agents' Claude ends; the records stay open", async () => {
    let credsAtKill: boolean | null = null;
    const { a, signOut, terminals } = await basicApp({ onKill: () => { credsAtKill = existsSync(credsOf("default")); } });
    try {
      await agent(W);
      await agent("fleet-master", { kind: "fleet-master" });
      terminals.spawn({ id: W }); terminals.spawn({ id: "fleet-master" });
      const r = await signOut("default");
      expect(r.json()).toMatchObject({ signedOut: true, moved: 0, stopped: 2, notEnded: 0, waiting: ["fleet-master"] });
      expect(terminals.killed.sort()).toEqual(["fleet-master", W].sort());
      // The kill came after the sign-out: a sign-out that fails stops no agent.
      expect(credsAtKill).toBe(false);
      expect((await store.load(W))?.closedAt).toBeUndefined();
    } finally { await a.close(); }
  });

  it("an agent that works or is busy now (a half-typed line, new output, a draft) stops the sign-out: no force", async () => {
    const { a, signOut, claude, terminals } = await basicApp({ busy: (r) => r.id === "fleet-master" });
    try {
      await agent(W, { status: "running" });
      await agent("fleet-master", { kind: "fleet-master" });
      terminals.spawn({ id: W }); terminals.spawn({ id: "fleet-master" });
      const r = await signOut("default");
      expect([r.statusCode, r.json()]).toMatchObject([409, { signedOut: false, working: 2, why: "busy" }]);
      expect(claude.calls()).toEqual([]);
      expect(terminals.killed).toEqual([]);
    } finally { await a.close(); }
    // The default busy check (no chief of staff): a line typed a moment ago.
    const b = await basicApp();
    try {
      await agent(W2);
      b.terminals.spawn({ id: W2 });
      b.terminals.input.set(W2, Date.now());
      expect((await b.signOut("default")).json()).toMatchObject({ signedOut: false, working: 1, why: "busy" });
    } finally { await b.a.close(); }
  });

  it("a move that waits: only an agent whose Claude still runs on THIS login stops the sign-out", async () => {
    let armed: string[] = [];
    const { a, signOut } = await basicApp({ logins: ["default", "work", "spare"], waits: () => armed, relaunch: async () => "waits" });
    try {
      await agent("lead-ops", { kind: "lead", account: "work" });
      // It moves from work to the main login; it is busy, so its relaunch waits: its Claude runs on work.
      const mv = await a.inject({ method: "POST", url: "/api/agents/lead-ops/account", payload: { account: "default" }, headers: USER });
      expect(mv.json()).toMatchObject({ outcome: "waits" });
      // Armed: that relaunch, and one for another reason (a new prompt after a deploy).
      armed = ["lead-ops", "lead-other"];
      // Another login: neither blocks it.
      expect((await signOut("spare")).json()).toMatchObject({ signedOut: true });
      // Work, where lead-ops still runs: the sign-out waits, and says why.
      expect((await signOut("work")).json()).toMatchObject({ signedOut: false, waits: 1, why: "busy" });
      // lead-ops relaunched (no longer armed); another relaunch still is: work signs out.
      armed = ["lead-other"];
      expect((await signOut("work")).json()).toMatchObject({ signedOut: true, waits: 0 });
    } finally { await a.close(); }
  });

  it("a failed sign-out: no agent stops, no mark, the login stays", async () => {
    const { a, signOut, terminals } = await basicApp();
    try {
      await agent(W);
      terminals.spawn({ id: W });
      await writeFile(join(base, "fail"), "");
      const r = await signOut("default");
      expect([r.statusCode, r.json()]).toMatchObject([500, { signedOut: false, why: "failed", stopped: 0 }]);
      expect(terminals.killed).toEqual([]);
      expect(isSignedOut("default")).toBe(false);
      expect(existsSync(credsOf("default"))).toBe(true);
    } finally { await a.close(); }
  });

  it("a Claude writes the login back as it ends: one more sign-out; a login that stays after that is 'not signed out'", async () => {
    // It comes back once: the second sign-out takes it.
    const { a, signOut, claude, terminals } = await basicApp({ onKill: () => { void logIn("default"); } });
    try {
      await agent(W);
      terminals.spawn({ id: W });
      expect((await signOut("default")).json()).toMatchObject({ signedOut: true, stopped: 1 });
      expect(claude.calls()).toHaveLength(2);
      expect(existsSync(credsOf("default"))).toBe(false);
    } finally { await a.close(); }
    // It stays: at most one more sign-out, then the answer says so, and the mark goes.
    forgetSignedOut();
    await rm(join(base, "claude.log"), { force: true });
    const b = await basicApp();
    try {
      await writeFile(join(base, "keep"), "");
      const r = await b.signOut("default");
      expect([r.statusCode, r.json()]).toMatchObject([500, { signedOut: false, why: "still-there" }]);
      expect(b.claude.calls()).toHaveLength(2);
      expect(isSignedOut("default")).toBe(false);
    } finally { await b.a.close(); }
  });

  it("no Claude program on the server: the answer says so, nothing changed", async () => {
    const { a, signOut, terminals } = await basicApp();
    try {
      await rm(join(base, "fake-claude"));
      await agent(W);
      terminals.spawn({ id: W });
      expect((await signOut("default")).json()).toMatchObject({ signedOut: false, why: "no-claude" });
      expect(terminals.killed).toEqual([]);
      expect(existsSync(credsOf("default"))).toBe(true);
    } finally { await a.close(); }
  });

  it("an open sign-in of the login, or a second press while it signs out: refused", async () => {
    const { a, signOut } = await basicApp();
    try {
      const [one, two] = await Promise.all([signOut("default"), signOut("default")]);
      expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
    } finally { await a.close(); }
  });
});

describe("sign out: after it", () => {
  it("basic, one login: the fleet master, a lead and the Coordinator wait; no start runs a Claude meanwhile; the next sign-in from the page starts them; a worker starts again from its pane", async () => {
    const { a, signOut, signIn, terminals, loginHold, started } = await basicApp();
    try {
      await agent(W);
      for (const [id, kind] of [["fleet-master", "fleet-master"], ["coordinator", "coordinator"], ["lead-web", "lead"]] as const) await agent(id, { kind });
      for (const id of [W, "fleet-master", "coordinator", "lead-web"]) terminals.spawn({ id });
      terminals.spawned.length = 0;
      const r = (await signOut("default")).json();
      expect(r).toMatchObject({ signedOut: true, stopped: 4 });
      expect([...r.waiting].sort()).toEqual(["coordinator", "fleet-master", "lead-web"]);
      // Meanwhile each start (the resume route; an ensure or a relaunch retry: resumeAgent too) waits.
      expect((await a.inject({ method: "POST", url: "/api/agents/lead-web/resume", headers: USER })).json()).toMatchObject({ outcome: "waits" });
      const ctx = makeRecoveryCtx({ terminals: terminals as never, store, workspaceDir: join(base, "ws"), accounts: paths, loginHold });
      for (const id of ["fleet-master", "coordinator"]) expect(await resumeAgent((await store.load(id))!, ctx), id).toBe("waits");
      expect(terminals.spawned).toEqual([]);
      expect(started).toEqual([]);
      // The next sign-in of the login, from the page: what the sign-out held starts (startWaited).
      await signIn("default");
      await vi.waitFor(() => expect(started).toEqual([["coordinator", "fleet-master", "lead-web"]]));
      for (const id of ["fleet-master", "coordinator", "lead-web"]) {
        expect(loginHold.waitsFor(id), id).toBe(false);
        expect(await loginHold.mayStart((await store.load(id))!), id).toBe(true);
      }
      // A worker: from its pane (Resume), on the login that is back.
      const w = await a.inject({ method: "POST", url: `/api/agents/${W}/resume`, headers: USER });
      expect(w.json().outcome).toMatch(/^(resumed|cold)$/);
      expect(terminals.spawned.map((x) => x.id)).toEqual([W]);
    } finally { await a.close(); }
  });

  it("each stop is silent: the record is done, the event says quiet (no Telegram message, no digest line), never a plain done", async () => {
    const { a, signOut, terminals, events } = await basicApp();
    try {
      await agent(W); await agent(W2);
      terminals.spawn({ id: W }); terminals.spawn({ id: W2 });
      expect((await signOut("default")).json()).toMatchObject({ signedOut: true, stopped: 2 });
      const status = events.filter((e) => e.type === "agent-status");
      expect(status).toEqual([
        { type: "agent-status", agentId: W, status: "done", quiet: true },
        { type: "agent-status", agentId: W2, status: "done", quiet: true },
      ]);
      for (const id of [W, W2]) expect((await store.load(id))?.status, id).toBe("done");
    } finally { await a.close(); }
  });

  it("an agent that starts a turn while Claude signs out is not ended: it counts as not ended", async () => {
    let n = 0;
    // Quiet at the check before the sign-out, busy at the kill.
    const { a, signOut, terminals } = await basicApp({ busy: () => ++n > 1 });
    try {
      await agent(W);
      terminals.spawn({ id: W });
      expect((await signOut("default")).json()).toMatchObject({ signedOut: true, stopped: 0, notEnded: 1 });
      expect(terminals.killed).toEqual([]);
    } finally { await a.close(); }
    // The same with the record: it is running at the kill.
    const b = await basicApp({ busy: () => false });
    try {
      await agent(W2);
      b.terminals.spawn({ id: W2 });
      const orig = store.load.bind(store);
      let reads = 0;
      vi.spyOn(store, "load").mockImplementation(async (id: string) => {
        const rec = await orig(id);
        return rec && id === W2 && ++reads >= 1 ? { ...rec, status: "running" } : rec;
      });
      expect((await b.signOut("default")).json()).toMatchObject({ stopped: 0, notEnded: 1 });
      expect(b.terminals.killed).toEqual([]);
      vi.restoreAllMocks();
    } finally { await b.a.close(); }
  });

  it("the login came back after two tries: what stopped is said, and the persistent agents start again at once", async () => {
    const { a, signOut, terminals, started, loginHold } = await basicApp();
    try {
      await writeFile(join(base, "keep"), "");
      await agent(W);
      await agent("fleet-master", { kind: "fleet-master" });
      terminals.spawn({ id: W }); terminals.spawn({ id: "fleet-master" });
      const r = await signOut("default");
      expect([r.statusCode, r.json()]).toMatchObject([500, { signedOut: false, why: "still-there", stopped: 2, waiting: [], restarted: ["fleet-master"] }]);
      expect(started).toEqual([["fleet-master"]]);
      expect(loginHold.waitsFor("fleet-master")).toBe(false);
    } finally { await a.close(); }
  });
});

describe("sign out: Recurring runs", () => {
  it("a run on the login, or one that does not know its login yet, stops the sign-out; a run on another login does not", async () => {
    let runs: RunNow[] = [{ name: "nightly", login: "default" }];
    const { a, signOut, claude } = await basicApp({ logins: ["default", "work"], runs: async () => runs });
    try {
      expect((await signOut("default")).json()).toMatchObject({ signedOut: false, recurring: ["nightly"], why: "recurring" });
      runs = [{ name: "starting", login: null }];
      expect((await signOut("default")).json()).toMatchObject({ signedOut: false, recurring: ["starting"], why: "recurring" });
      expect(claude.calls()).toEqual([]);
      expect(isSignedOut("default")).toBe(false);
      runs = [{ name: "other", login: "work" }];
      expect((await signOut("default")).json()).toMatchObject({ signedOut: true, recurring: [] });
    } finally { await a.close(); }
  });

  it("basic protection marks the login first, then reads the runs again: a run seen then stops it and the mark goes", async () => {
    const seen: boolean[] = [];
    const { a, signOut, claude } = await basicApp({
      runs: async () => { seen.push(isSignedOut("default")); return seen.length === 2 ? [{ name: "late", login: null }] : []; },
    });
    try {
      expect((await signOut("default")).json()).toMatchObject({ signedOut: false, recurring: ["late"], why: "recurring" });
      // The first read before the mark, the second after it.
      expect(seen).toEqual([false, true]);
      expect(isSignedOut("default")).toBe(false);
      expect(claude.calls()).toEqual([]);
    } finally { await a.close(); }
  });

  it("a run that started on the login during the sign-out: signed out, and the answer names the run", async () => {
    let n = 0;
    const { a, signOut } = await basicApp({ runs: async () => (++n >= 3 ? [{ name: "late", login: "default" }] : []) });
    try {
      expect((await signOut("default")).json()).toMatchObject({ signedOut: true, recurring: ["late"] });
    } finally { await a.close(); }
  });
});

describe("sign out: strong protection, through the helper", () => {
  const STRONG = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "4242" };

  // The fake sudo runs the fake Claude with the subcommand of the helper call; `old`: an
  // installed helper that has no logout yet.
  async function strongApp(o: { old?: boolean; onKill?: (id: string) => void } = {}) {
    for (const [k, v] of Object.entries(STRONG)) vi.stubEnv(k, v);
    const claude = join(base, "fake-claude-s");
    await writeFile(claude, `#!/usr/bin/env bash
if [ "$1 $2" = "auth status" ]; then
  if [ -f "$CLAUDE_CONFIG_DIR/in" ]; then echo '{"loggedIn":true,"email":"ada@example.invalid"}'; exit 0; fi
  echo '{"loggedIn":false}'; exit 1
fi
[ "$1 $2" = "auth logout" ] && { rm -f "$CLAUDE_CONFIG_DIR/in"; exit 0; }
if [ "$1 $2" = "auth login" ]; then
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true"
  IFS= read -r code || exit 1
  [ "$code" = "${GOOD}" ] && { touch "$CLAUDE_CONFIG_DIR/in"; exit 0; }
  exit 1
fi
exit 1
`, { mode: 0o755 });
    const sudo = join(base, "fake-sudo-s");
    await writeFile(sudo, `#!/usr/bin/env bash
echo "$*" >> "${base}/sudo.log"
${o.old ? `[ "\${@: -1}" = logout ] && { echo "choibot-agent-exec: claude-auth: unknown subcommand: logout" >&2; exit 2; }` : ""}
exec "${claude}" auth "\${@: -1}"
`, { mode: 0o755 });
    const agentDir = join(base, "agent-claude"), chiefDir = join(base, "chief-claude");
    for (const d of [agentDir, chiefDir]) { await mkdir(d, { recursive: true }); await writeFile(join(d, "in"), ""); }
    const exec = (uid: number) => ({ sudo, helper: "/usr/local/bin/choibot-agent-exec", uid });
    const agentAuth = { exec: exec(4242), configDir: agentDir, env: { PATH: process.env.PATH } };
    const chiefAuth = { exec: exec(4343), configDir: chiefDir, env: { PATH: process.env.PATH } };
    const terminals = fakeTerminals(o.onKill);
    const a = Fastify();
    const chiefStatus = new AgentLoginStatus(() => agentLoginStatus(chiefAuth));
    // The real wait of the second sign-in, as index.ts makes it, with the starts recorded.
    const chiefWait = new ChiefWait({ signedIn: async () => (await chiefStatus.read()).loggedIn, log: () => {} });
    const started: string[] = [];
    chiefWait.onSignedIn((ids) => startWaited(ids, {
      master: async () => { started.push("master"); }, masterKnown: async () => true,
      coordinator: async () => { started.push("coordinator"); }, coordinatorKnown: async () => true,
      lead: async (area) => { started.push(`lead:${area}`); },
    }));
    registerAgentApi(a, {
      terminals: terminals as never, store, hub: new EventHub(), workspaceDir: join(base, "ws"), accounts: paths,
      claudeLogin: { log: () => {} }, chiefLogin: { log: () => {} }, chief: gate(),
      agentAuth, agentStatus: new AgentLoginStatus(() => agentLoginStatus(agentAuth)),
      chiefAuth, chiefStatus, chiefWait, onChiefLogin: () => { void chiefWait.signedInNow(); },
    });
    // The Master tab's status, as index.ts wires it.
    registerMasterApi(a, { ensure: async () => "fleet-master", status: () => ({ queuedEvents: 0, queuedMessages: 0, telegram: false, surface: "tab" }), waits: () => chiefWait.waitsFor("fleet-master") });
    await agent(W);
    await agent("fleet-master", { kind: "fleet-master" });
    terminals.spawn({ id: W }); terminals.spawn({ id: "fleet-master" });
    const sudoLog = () => (existsSync(join(base, "sudo.log")) ? readFileSync(join(base, "sudo.log"), "utf8") : "");
    const signOut = (id: string) => a.inject({ method: "POST", url: `/api/accounts/${id}/logout`, payload: {}, headers: USER });
    return { a, terminals, sudoLog, signOut, agentDir, chiefDir, chiefWait, started };
  }

  it("the first login: Claude signs out as the agents' account; the workers end; the second sign-in and the fleet master stay", async () => {
    const { a, terminals, sudoLog, signOut, agentDir, chiefDir } = await strongApp();
    try {
      expect((await signOut("default")).json()).toMatchObject({ signedOut: true, stopped: 1 });
      expect(sudoLog()).toMatch(/-n -u #4242 \/usr\/local\/bin\/choibot-agent-exec claude-auth logout/);
      expect(sudoLog()).not.toMatch(/#4343 .*logout/);
      expect(existsSync(join(agentDir, "in"))).toBe(false);
      expect(existsSync(join(chiefDir, "in"))).toBe(true);
      expect(terminals.killed).toEqual([W]);
      const rows = (await a.inject({ method: "GET", url: "/api/accounts" })).json().accounts;
      expect(rows.map((x: { id: string; loggedIn: boolean }) => [x.id, x.loggedIn])).toEqual([["default", false], ["persistent", true]]);
    } finally { await a.close(); }
  });

  it("the second sign-in: Claude signs out as the second account; the fleet master ends (it waits for the next sign-in); the workers stay", async () => {
    const { a, terminals, sudoLog, signOut, agentDir, chiefDir } = await strongApp();
    try {
      expect((await signOut("persistent")).json()).toMatchObject({ signedOut: true, stopped: 1 });
      expect(sudoLog()).toMatch(/-n -u #4343 \/usr\/local\/bin\/choibot-agent-exec claude-auth logout/);
      expect(sudoLog()).not.toMatch(/#4242 .*logout/);
      expect(existsSync(join(chiefDir, "in"))).toBe(false);
      expect(existsSync(join(agentDir, "in"))).toBe(true);
      expect(terminals.killed).toEqual(["fleet-master"]);
    } finally { await a.close(); }
  });

  it("the second sign-in (the real ChiefWait): the fleet master, a lead and the Coordinator wait; the Master tab says so; no start runs meanwhile; the next sign-in starts each", async () => {
    vi.stubEnv("CHIEF_PERSISTENT_UID", "4343");
    const { a, terminals, signOut, chiefWait, started } = await strongApp();
    try {
      await agent("coordinator", { kind: "coordinator" });
      await agent("lead-web", { kind: "lead" });
      terminals.spawn({ id: "coordinator" }); terminals.spawn({ id: "lead-web" });
      terminals.spawned.length = 0;
      const r = (await signOut("persistent")).json();
      expect(r).toMatchObject({ signedOut: true, stopped: 3 });
      expect([...r.waiting].sort()).toEqual(["coordinator", "fleet-master", "lead-web"]);
      expect(chiefWait.waits().sort()).toEqual(["coordinator", "fleet-master", "lead-web"]);
      // The Master tab: "Waits for its sign-in" (MasterView shows WaitsForSignIn on `waits`).
      expect((await a.inject({ method: "GET", url: "/api/master/status" })).json()).toMatchObject({ waits: true });
      // A start meanwhile (the resume route) waits: no Claude starts.
      expect((await a.inject({ method: "POST", url: "/api/agents/fleet-master/resume", headers: USER })).json()).toMatchObject({ outcome: "waits" });
      expect(terminals.spawned).toEqual([]);
      // The next second sign-in, from the page: each of the three starts.
      await a.inject({ method: "POST", url: "/api/accounts/persistent/login", payload: {}, headers: USER });
      await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: GOOD, account: "persistent" }, headers: USER });
      await vi.waitFor(() => expect(started.sort()).toEqual(["coordinator", "lead:web", "master"]), { timeout: 5000 });
      expect(chiefWait.waits()).toEqual([]);
      expect((await a.inject({ method: "GET", url: "/api/master/status" })).json()).not.toHaveProperty("waits");
    } finally { await a.close(); }
  });

  it("the second sign-in, a Claude writes the login back at its end: the second sign-out removes it, and each of the three kinds still waits for the next sign-in", async () => {
    vi.stubEnv("CHIEF_PERSISTENT_UID", "4343");
    let wrote = false;
    const chiefIn = join(base, "chief-claude", "in");
    const { terminals, signOut, chiefWait, sudoLog, a } = await strongApp({ onKill: () => { if (!wrote) { wrote = true; writeFileSync(chiefIn, ""); } } });
    try {
      await agent("coordinator", { kind: "coordinator" });
      await agent("lead-web", { kind: "lead" });
      terminals.spawn({ id: "coordinator" }); terminals.spawn({ id: "lead-web" });
      const r = (await signOut("persistent")).json();
      expect(r).toMatchObject({ signedOut: true, stopped: 3 });
      expect(wrote).toBe(true);
      // Two sign-outs: the first, and the one after the login came back.
      expect(sudoLog().match(/#4343 \/usr\/local\/bin\/choibot-agent-exec claude-auth logout/g)).toHaveLength(2);
      expect(existsSync(chiefIn)).toBe(false);
      expect(chiefWait.waits().sort()).toEqual(["coordinator", "fleet-master", "lead-web"]);
    } finally { await a.close(); }
  });

  it("an installed helper that has no logout yet: the answer says so, and no agent stops", async () => {
    const { a, terminals, signOut, agentDir } = await strongApp({ old: true });
    try {
      const r = await signOut("default");
      expect([r.statusCode, r.json()]).toMatchObject([500, { signedOut: false, why: "old-helper", stopped: 0 }]);
      expect(terminals.killed).toEqual([]);
      expect(existsSync(join(agentDir, "in"))).toBe(true);
    } finally { await a.close(); }
  });
});
