// server/chief/queue/share.test.ts — "Share outside" on a ticket: the contract parsers, a real run
// of a fake share tool (argv, env allowlist, time limit), the file that goes out, and the four
// USER-only routes on the real gate and store. No real share service is ever called.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RICH_CSP, RICH_TOKENS } from "../../../src/lib/richTicket";
import type { AgentRecord } from "../../agents/store.js";
import { COORDINATOR_ID } from "../../coordinator/paths.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER } from "../auth.js";
import { makeGate } from "../gate.js";
import { registerQueueApi, type QueueApiDeps } from "./api.js";
import { QueueShare, fileName } from "./share.js";
import { bodyHtml, cssVars, loadLook, shareHtml } from "./shareDoc.js";
import {
  parseAdd, parseScan, runFailure, runTool, SHARE_TOOL_RE, toolEnv, toolProblem, toolText, type RunTool, type ToolRun,
} from "./shareTool.js";
import { QueueStore, type NewItem } from "./store.js";

const run = (o: Partial<ToolRun>): ToolRun => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...o });

describe("the contract's answers", () => {
  it("scan: BLOCKED and warning lines are hits; exit 1 with no hit, another code, a time-out or no start is a failed check", () => {
    expect(parseScan(run({ stdout: "clean: nothing\n" }))).toEqual({ ok: true, hits: [] });
    expect(parseScan(run({ code: 1, stdout: "warning  handle: ...@abc...\nBLOCKED  email: ...a@b.co...\nother\n" }))).toEqual({
      ok: true, hits: [{ level: "warning", text: "handle: ...@abc..." }, { level: "blocked", text: "email: ...a@b.co..." }],
    });
    expect(parseScan(run({ code: 1, stderr: "only .html files can be shared\n" }))).toEqual({ ok: false, error: "The share tool said: only .html files can be shared" });
    expect(parseScan(run({ code: 2 })).ok).toBe(false);
    expect(parseScan(run({ code: null, timedOut: true }))).toEqual({ ok: false, error: "The share tool did not finish in time." });
    expect(parseScan(run({ code: null, spawnError: "ENOENT" }))).toEqual({ ok: false, error: "The share tool is not on your server any more." });
  });

  it("add: one https link, its page id, a one-tap link only for the same address, and the password", () => {
    const out = "title:    T\nlink:     https://share.example.test/doc-abc\npassword: AB12-CD34\none-tap:  https://share.example.test/doc-abc#pw=AB12-CD34\nverified: ok\n";
    expect(parseAdd(run({ stdout: out }))).toEqual({
      ok: true, link: "https://share.example.test/doc-abc", oneTap: "https://share.example.test/doc-abc#pw=AB12-CD34", password: "AB12-CD34", docId: "doc-abc", checked: true,
    });
    // A tool that checks its own work can exit 1 after the link: the page is out, not checked.
    expect(parseAdd(run({ code: 1, stdout: out }))).toMatchObject({ ok: true, docId: "doc-abc", checked: false });
    // A one-tap link to another place is dropped, never shown.
    expect(parseAdd(run({ stdout: "link: https://share.example.test/doc-abc\none-tap: https://evil.example.test/doc-abc#pw=x\n" }))).toMatchObject({ ok: true, oneTap: null });
    expect(parseAdd(run({ stdout: "link: https://share.example.test/doc-abc\none-tap: https://share.example.test/other#pw=x\n" }))).toMatchObject({ ok: true, oneTap: null });
  });

  it("add: refuses a link that is not https, holds a user, has no page id, or comes twice; scrubs the password from a reason", () => {
    for (const link of ["http://share.example.test/doc", "javascript:alert(1)", "https://u:p@share.example.test/doc", "https://share.example.test/", "https://share.example.test/a b", "https://share.example.test/doc#x"]) {
      expect(parseAdd(run({ stdout: `link: ${link}\n` })).ok).toBe(false);
    }
    expect(parseAdd(run({ stdout: "link: https://a.example.test/x\nlink: https://a.example.test/y\n" }))).toEqual({ ok: false, error: "The share tool gave more than one link. Nothing is kept." });
    expect(parseAdd(run({ code: 1, stdout: "password: SECRET-PW\n", stderr: "crash near SECRET-PW\n" }))).toEqual({ ok: false, error: "The share tool said: crash near …" });
    expect(runFailure(run({ code: 3 }))).toBe("The share tool stopped with code 3.");
    expect(toolText("a\u0007b\n\n c")).toBe("a b c");
  });

  it("the tool's path: absolute, plain characters, no empty, . or .. part", () => {
    for (const ok of ["/home/you/bin/share-tool", "/opt/x/share.py", "/a/.hidden/t"]) expect(SHARE_TOOL_RE.test(ok)).toBe(true);
    for (const bad of ["share.py", "/", "/a/../b", "/a/./b", "/a//b", "/a/b c", "/a/$(x)", "/a;rm", "/a/b/"]) expect(SHARE_TOOL_RE.test(bad)).toBe(false);
  });

  it("the env allowlist: what a program needs, never a secret", () => {
    const env = toolEnv({ PATH: "/bin", HOME: "/h", TELEGRAM_BOT_TOKEN: "t", GH_TOKEN: "g", CHIEF_ENABLED: "1", LANG: "en_US.UTF-8" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LANG: "en_US.UTF-8" });
    expect(toolEnv({ PATH: "/bin" }).LANG).toBe("C.UTF-8");
  });
});

describe("a real run of a fake tool", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "share-tool-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const script = (body: string, mode = 0o755): string => {
    const p = join(dir, "tool");
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, mode);
    return p;
  };

  it("gets its arguments as they are (no shell) and only the allowlisted env", async () => {
    const tool = script('printf "%s\\n" "$@"; env | cut -d= -f1 | sort | tr "\\n" " "');
    const r = await runTool(tool, ["scan", "/x/$(touch pwned) a;b.html"], { timeoutMs: 5000, env: toolEnv({ PATH: process.env.PATH, HOME: dir, SECRET_KEY: "s" }), cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").slice(0, 2)).toEqual(["scan", "/x/$(touch pwned) a;b.html"]);
    expect(r.stdout).not.toContain("SECRET_KEY");
    expect(r.stdout).toContain("HOME");
  });

  it("is stopped at its time limit", async () => {
    const r = await runTool(script("sleep 5"), [], { timeoutMs: 200, env: toolEnv(process.env), cwd: dir });
    expect(r.timedOut).toBe(true);
  });

  it("toolProblem: a missing file, a folder, a file anyone can change, a file that is not a program", async () => {
    expect(await toolProblem("rel/path")).toMatch(/full path/);
    expect(await toolProblem(join(dir, "none"))).toMatch(/no file/);
    mkdirSync(join(dir, "d"));
    expect(await toolProblem(join(dir, "d"))).toMatch(/not a file/);
    expect(await toolProblem(script("true", 0o777))).toMatch(/Any user/);
    expect(await toolProblem(script("true", 0o644))).toMatch(/not a program/);
    expect(await toolProblem(script("true", 0o775))).toBeNull();
    expect(await toolProblem(script("true"), { uid: 4242 })).toMatch(/another user/);
  });
});

describe("the file that goes out", () => {
  it("has the policy first, no script, the title, the body as the first block, then the checked page; light with a dark media query", () => {
    const html = shareHtml({ title: "Pick <b>one</b>", body: "**Bold** and [a link](https://example.com)\nline 2", page: { css: ".x{color:var(--ok)}\n", html: "<p class=\"x\">page</p>" } },
      { fontCss: "@font-face{}", light: { "--bg-1": "#ffffff", "--ink-0": "red;}</style><script>" }, dark: { "--bg-1": "#111112" } });
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<title>"));
    expect(html).toContain(`content="${RICH_CSP}"`);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("<title>Pick &lt;b&gt;one&lt;/b&gt;</title>");
    expect(html).toContain("--bg-1:#ffffff;");
    expect(html).not.toContain("--ink-0:red");
    expect(html).toContain("@media (prefers-color-scheme:dark){:root{--bg-1:#111112;}}");
    expect(html.indexOf("<strong>Bold</strong>")).toBeLessThan(html.indexOf('<p class="x">page</p>'));
    // A link shows as its text and its address, as in the frame.
    expect(html).toContain('<span data-link="">a link</span> <span class="link-addr">https://example.com</span>');
    expect(html).not.toMatch(/<a\s/);
  });

  it("a body the check refuses goes out as plain text", () => {
    expect(bodyHtml("x <script>alert(1)</script>")).not.toContain("<script");
    expect(bodyHtml("| a | b |\n|:-|-:|\n| 1 | 2 |")).toContain('<th style="text-align:left">a</th>');
    expect(bodyHtml("")).toBe("");
  });

  it("the look: every colour of the frame in both themes, from the console's own style sheet, and its two fonts", async () => {
    const look = await loadLook();
    for (const t of RICH_TOKENS) {
      expect(look.light[t], t).toMatch(/^#/);
      expect(look.dark[t], t).toMatch(/^#/);
    }
    expect(look.light["--bg-1"]).not.toBe(look.dark["--bg-1"]);
    expect(look.fontCss).toContain('font-family:"Console Sans"');
    expect(look.fontCss).toContain('font-family:"Console Mono"');
    expect(cssVars(":root { --a: 1; /* } */ --b: #fff; }", ":root")).toEqual({ "--a": "1", "--b": "#fff" });
  });

  it("the download name is the title in plain characters", () => {
    expect(fileName({ id: "q1", title: "Pick a DB: A/B?" })).toBe("Pick a DB AB.html");
    expect(fileName({ id: "q12345678", title: "日本" })).toBe("q12345678.html");
  });
});

// --- the routes -----------------------------------------------------------------------------

const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/ws/app", worktree: `/ws/wt-${id}`, branch: `agent/${id}`, baseBranch: "main",
  sessionId: null, hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...o,
});
const RECORDS: Record<string, AgentRecord> = {
  [FLEET_MASTER_ID]: rec(FLEET_MASTER_ID, { kind: "fleet-master", repo: "" }),
  [COORDINATOR_ID]: rec(COORDINATOR_ID, { kind: "coordinator" as AgentRecord["kind"], repo: "" }),
  a1: rec("a1"), "lead-app": rec("lead-app", { kind: "lead" as AgentRecord["kind"] }),
};
type H = Record<string, string>;
const agentHdr = (id: string): H => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });
const item: NewItem = {
  agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "app", area: "app",
  kind: "question", title: "Which plan?", body: "Plan A is cheaper.\nMail ops@example.invalid", blocking: false,
};

describe("the share routes", () => {
  let dir: string;
  let app: FastifyInstance;
  let store: QueueStore;
  let user: H;
  let logs: string[];
  let calls: string[][];
  let files: string[];
  let tool: string | null;
  let scanOut: ToolRun;
  let addOut: ToolRun;
  let removeOut: ToolRun;
  let checks: string[];

  // The fake tool records each call and the file it was given (read while it exists).
  const fakeRun = (): RunTool => async (args) => {
    calls.push(args);
    if (args[0] === "scan" || args[0] === "add") files.push(readFileSync(args[1]!, "utf8"));
    return args[0] === "scan" ? scanOut : args[0] === "add" ? addOut : removeOut;
  };

  async function build(o: { misconfigured?: string | null } = {}) {
    dir = mkdtempSync(join(tmpdir(), "share-api-"));
    store = new QueueStore(join(dir, "queue"), { now: () => 1000, log: () => {} });
    const devices = new DeviceStore(join(dir, "user-devices.json"));
    user = { [USER_HEADER]: await devices.add("phone") };
    const gate = makeGate({ misconfigured: o.misconfigured ?? null, userAuth: "log", deps: { devices, agents: { load: async (id: string) => RECORDS[id] ?? null } } });
    logs = []; calls = []; files = []; checks = [];
    tool = "/opt/share-tool";
    scanOut = run({ stdout: "clean\n" });
    addOut = run({ stdout: "link: https://share.example.test/doc-abc\npassword: PW-1234-ZZ\none-tap: https://share.example.test/doc-abc#pw=PW-1234-ZZ\n" });
    removeOut = run({});
    const share = new QueueShare({
      store, tool: () => tool, run: fakeRun, toolProblem: async () => null, now: () => 5000, log: (s) => logs.push(s),
      check: async (u) => { checks.push(u); return true; },
    });
    app = Fastify();
    const no = (): never => { throw new Error("not used"); };
    registerQueueApi(app, {
      gate, undoMs: 1, store, actions: {} as QueueApiDeps["actions"], add: no, events: { addQueue: async () => {} }, agents: { load: async () => null },
      weekMetrics: async () => ({ decisions: 0, corrections: 0 }), hardened: () => false, prWatch: { refreshSoon: () => {} }, previewEnabled: true, share,
    });
    await app.ready();
  }
  beforeEach(() => build());
  afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

  const add = async (o: Partial<NewItem> = {}) => (await store.add({ ...item, ...o })).id;
  const call = (method: "GET" | "POST", url: string, headers: H = user, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it("only the paired user: an agent, a lead, the master, the Coordinator and no pairing get 403, and the tool never runs", async () => {
    const id = await add();
    for (const h of [{}, agentHdr("a1"), agentHdr("lead-app"), agentHdr(FLEET_MASTER_ID), agentHdr(COORDINATOR_ID), { ...agentHdr("a1"), ...user }]) {
      for (const [m, path] of [["GET", "share"], ["POST", "share"], ["POST", "share/stop"], ["GET", "share/file"]] as const) {
        const res = await call(m, `/api/queue/${id}/${path}`, h as H, m === "POST" ? {} : undefined);
        expect(res.statusCode, `${m} ${path} ${JSON.stringify(Object.keys(h))}`).toBe(403);
      }
    }
    expect(calls).toEqual([]);
    expect((await store.get(id))?.share).toBeUndefined();
  });

  it("503 while misconfigured", async () => {
    await app.close(); await build({ misconfigured: "x" });
    expect((await call("GET", `/api/queue/${await add()}/share`)).statusCode).toBe(503);
  });

  it("the confirm step: what goes out and the check's hits; with no tool, no run", async () => {
    const id = await add();
    scanOut = run({ code: 1, stdout: "BLOCKED  email: ...ops@example.invalid...\n" });
    const v = await call("GET", `/api/queue/${id}/share`);
    expect(v.json()).toEqual({ tool: true, shared: null, what: { title: "Which plan?", body: true, page: false }, hits: [{ level: "blocked", text: "email: ...ops@example.invalid..." }] });
    expect(calls).toEqual([["scan", expect.stringMatching(new RegExp(`/${id}\\.html$`))]]);
    tool = null; calls = [];
    expect((await call("GET", `/api/queue/${id}/share`)).json()).toMatchObject({ tool: false, hits: [] });
    expect(calls).toEqual([]);
  });

  it("publish: a hit the user did not say yes to refuses it; with every hit ticked it goes out with --allow-sensitive", async () => {
    const id = await add();
    scanOut = run({ code: 1, stdout: "BLOCKED  email: ...ops@example.invalid...\nwarning  placeholder: TODO\n" });
    const no = await call("POST", `/api/queue/${id}/share`, user, { accept: ["email: ...ops@example.invalid..."] });
    expect(no.statusCode).toBe(409);
    expect(no.json()).toMatchObject({ reason: "hits" });
    expect(calls.map((c) => c[0])).toEqual(["scan"]);
    const yes = await call("POST", `/api/queue/${id}/share`, user, { accept: ["email: ...ops@example.invalid...", "placeholder: TODO"] });
    expect(yes.statusCode).toBe(200);
    expect(calls.at(-1)).toEqual(["add", expect.stringMatching(/\.html$/), "--allow-sensitive"]);
  });

  it("publish: the file is the stored ticket; the answer has the one-tap link and the password once; the ticket and the log never do", async () => {
    const id = await add();
    const res = await call("POST", `/api/queue/${id}/share`, user, { accept: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ link: "https://share.example.test/doc-abc", oneTap: "https://share.example.test/doc-abc#pw=PW-1234-ZZ", password: "PW-1234-ZZ" });
    expect(calls).toEqual([["scan", expect.any(String)], ["add", expect.any(String)]]);
    expect(files[1]).toBe(files[0]);
    expect(files[1]).toContain("<title>Which plan?</title>");
    expect(files[1]).toContain("Plan A is cheaper.");
    const stored = await store.get(id);
    expect(stored?.share).toEqual({ docId: "doc-abc", link: "https://share.example.test/doc-abc", at: 5000, device: expect.any(String), checked: true });
    expect(JSON.stringify(stored)).not.toContain("PW-1234-ZZ");
    expect(readFileSync(join(dir, "queue", `${id}.json`), "utf8")).not.toContain("PW-1234-ZZ");
    expect(logs).toEqual([`[queue] ${id}: shared outside as doc-abc by device ${stored?.share?.device}`]);
    expect(checks).toEqual([]); // the tool checked its own work (exit 0)
    // Once shared, a second publish is refused and runs nothing.
    calls = [];
    expect((await call("POST", `/api/queue/${id}/share`, user, {})).json()).toMatchObject({ reason: "shared" });
    expect(calls).toEqual([]);
  });

  it("publish: the browser cannot send HTML or a path", async () => {
    const id = await add();
    for (const body of [{ html: "<p>x</p>" }, { file: "/etc/passwd" }, { accept: "x" }, { accept: [], path: "/tmp/x.html" }]) {
      expect((await call("POST", `/api/queue/${id}/share`, user, body)).statusCode).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("publish: a tool that exits 1 after the link: the ticket keeps the share, and the console looks at the link once", async () => {
    const id = await add();
    addOut = { ...addOut, code: 1 };
    const res = await call("POST", `/api/queue/${id}/share`, user, {});
    expect(res.statusCode).toBe(200);
    expect(checks).toEqual(["https://share.example.test/doc-abc"]);
    expect((await store.get(id))?.share?.checked).toBe(true);
  });

  it("publish: a failed add keeps nothing and shows the tool's reason, not its output", async () => {
    const id = await add();
    addOut = run({ code: 1, stdout: "link: http://plain.example.test/x\n", stderr: "not shared: remove these items\n" });
    const res = await call("POST", `/api/queue/${id}/share`, user, {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("The share tool gave a link that is not an https address. Nothing is kept.");
    expect((await store.get(id))?.share).toBeUndefined();
    expect(logs).toEqual([expect.stringContaining("share outside failed")]);
  });

  it("a page that does not pass the check never goes out", async () => {
    const id = await add({ html: { bytes: 10 } });
    mkdirSync(join(dir, "queue", "media", id), { recursive: true });
    writeFileSync(store.pagePath(id), "<script>alert(1)</script>");
    expect((await call("POST", `/api/queue/${id}/share`, user, {})).statusCode).toBe(422);
    expect((await call("GET", `/api/queue/${id}/share/file`)).statusCode).toBe(422);
    expect(calls).toEqual([]);
    writeFileSync(store.pagePath(id), "<style>.k{color:var(--ok)}</style><p class=\"k\">ok page</p>");
    const res = await call("POST", `/api/queue/${id}/share`, user, {});
    expect(res.statusCode).toBe(200);
    expect(files[1]).toContain('<p class="k">ok page</p>');
  });

  it("stop sharing: the tool's remove with the page id; the ticket forgets the share; one log line", async () => {
    const id = await add();
    await call("POST", `/api/queue/${id}/share`, user, {});
    calls = []; logs = [];
    const res = await call("POST", `/api/queue/${id}/share/stop`, user, {});
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([["remove", "doc-abc"]]);
    expect((await store.get(id))?.share).toBeUndefined();
    expect(logs).toEqual([expect.stringMatching(new RegExp(`^\\[queue\\] ${id}: stopped sharing doc-abc by device `))]);
    expect((await call("POST", `/api/queue/${id}/share/stop`, user, {})).json()).toMatchObject({ reason: "not-shared" });
  });

  it("stop sharing that fails keeps the share", async () => {
    const id = await add();
    await call("POST", `/api/queue/${id}/share`, user, {});
    removeOut = run({ code: 1, stderr: "no such doc\n" });
    const res = await call("POST", `/api/queue/${id}/share/stop`, user, {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("The share tool said: no such doc");
    expect((await store.get(id))?.share?.docId).toBe("doc-abc");
  });

  it("the download: the same file as an attachment, with no share tool too", async () => {
    tool = null;
    const id = await add();
    const res = await call("GET", `/api/queue/${id}/share/file`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="Which plan.html"');
    expect(res.headers["content-security-policy"]).toContain("sandbox");
    expect(res.body).toContain("<title>Which plan?</title>");
    expect(calls).toEqual([]);
    expect((await call("POST", `/api/queue/${id}/share`, user, {})).json()).toMatchObject({ reason: "no-tool" });
  });
});
