import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { runBrain, type BrainDeps } from "./brain.js";

type Call = { method: string; path: string; body: any; headers: Record<string, string> };

function world(routes: Record<string, (body: any) => { status?: number; body?: unknown }>, o: Partial<BrainDeps> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const written: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const h = routes[`${method} ${u.pathname}`];
    const r = h ? h(body) : { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  const deps: Partial<BrainDeps> = {
    fetch: f, readStdin: async () => "", stdinIsTTY: false, stderrIsTTY: true,
    out: (s) => out.push(s), err: (s) => err.push(s), env: { HOME: "/nonexistent/brain-test-home", PORT: "4321", CHOIBOT_USER_TOKEN: "ut" },
    flags: {}, readFile: () => null,
    writeToken: async (_env, t) => { written.push(t); return "/tmp/fake"; },
    ...o,
  };
  return { calls, out, err, written, deps };
}

describe("choibot brain claim", () => {
  it("posts the #pair code and writes the token", async () => {
    const w = world({ "POST /api/chief/pair/claim": () => ({ body: { token: "tok1", label: "laptop" } }) });
    expect(await runBrain("claim", ["http://h/#pair=abc"], w.deps)).toBe(0);
    expect(w.calls[0].body).toEqual({ code: "abc" });
    expect(Object.keys(w.calls[0].headers).filter((k) => k.startsWith("x-choibot"))).toEqual([]);
    expect(w.written).toEqual(["tok1"]);
    expect(JSON.parse(w.out.join(""))).toEqual({ label: "laptop" });
  });
  it("exits 1 and writes no token when the URL has no #pair code", async () => {
    const w = world({});
    expect(await runBrain("claim", ["http://h/"], w.deps)).toBe(1);
    expect(w.written).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(w.err.join("")).toContain("pair");
  });
  it("refuses in an agent shell", async () => {
    const w = world({}, { env: { CLAUDECODE: "1", PORT: "4321" } });
    expect(await runBrain("claim", ["http://h/#pair=abc"], w.deps)).toBe(1);
    expect(w.err.join("")).toContain("claim runs in a human shell only");
    expect(w.calls).toEqual([]);
    expect(w.written).toEqual([]);
  });
});

describe("choibot brain pair", () => {
  it("prints url and expiresAt with no identity headers", async () => {
    const w = world({ "POST /api/chief/pair/start": () => ({ body: { url: "http://h/#pair=z", expiresAt: 99 } }) });
    expect(await runBrain("pair", ["phone"], w.deps)).toBe(0);
    expect(w.calls[0].body).toEqual({ label: "phone" });
    expect(Object.keys(w.calls[0].headers).filter((k) => k.startsWith("x-choibot"))).toEqual([]);
    expect(JSON.parse(w.out.join(""))).toEqual({ url: "http://h/#pair=z", expiresAt: 99 });
  });
  it("refuses in an agent shell", async () => {
    const w = world({}, { env: { CLAUDECODE: "1", PORT: "4321" } });
    expect(await runBrain("pair", ["phone"], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
});

describe("choibot brain devices / revoke", () => {
  it("send only the user token", async () => {
    const w = world({
      "GET /api/brain/devices": () => ({ body: [{ label: "phone" }] }),
      "POST /api/brain/devices/phone/revoke": () => ({ body: { ok: true } }),
    }, { flags: { "user-token": "ut" } });
    expect(await runBrain("devices", [], w.deps)).toBe(0);
    expect(JSON.parse(w.out.join(""))).toEqual([{ label: "phone" }]);
    expect(await runBrain("revoke", ["phone"], w.deps)).toBe(0);
    for (const c of w.calls) {
      expect(Object.keys(c.headers).filter((k) => k.startsWith("x-choibot"))).toEqual(["x-choibot-user"]);
    }
    expect(w.calls[1].path).toBe("/api/brain/devices/phone/revoke");
  });
});

describe("choibot brain devices / revoke without a user token", () => {
  it("refuse in an agent env instead of sending agent headers", async () => {
    const w = world({ "GET /api/brain/devices": () => ({ body: [] }) }, {
      env: { HOME: "/nonexistent/brain-test-home", PORT: "4321", CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "t1" },
    });
    expect(await runBrain("devices", [], w.deps)).toBe(1);
    expect(await runBrain("revoke", ["phone"], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
});

describe("choibot brain claim HOME guard", () => {
  it("does not spend the code when HOME is unset", async () => {
    const w = world({ "POST /api/chief/pair/claim": () => ({ body: { token: "t", label: "l" } }) }, {
      env: { PORT: "4321" },
    });
    expect(await runBrain("claim", ["http://h/#pair=abc"], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.err.join("")).toContain("HOME");
  });
});

describe("choibot brain decision", () => {
  it("refuses a TTY stdin with no request", async () => {
    const w = world({}, { stdinIsTTY: true });
    expect(await runBrain("decision", [], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
  it("invalid JSON exits 1 before any request", async () => {
    const w = world({}, { readStdin: async () => "{nope" });
    expect(await runBrain("decision", [], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
  it("sends the agent identity headers", async () => {
    const w = world({ "POST /api/brain/decisions": () => ({ body: { ok: true } }) }, {
      readStdin: async () => '{"kind":"merge"}',
      env: { CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "t1", PORT: "4321" },
    });
    expect(await runBrain("decision", [], w.deps)).toBe(0);
    expect(w.calls[0].body).toEqual({ kind: "merge" });
    expect(w.calls[0].headers["x-choibot-agent"]).toBe("a1");
    expect(w.calls[0].headers["x-choibot-agent-token"]).toBe("t1");
    expect(w.calls[0].headers["x-choibot-user"]).toBeUndefined();
  });
});

const AGENT_ENV = { HOME: "/nonexistent/brain-test-home", PORT: "4321", CHOIBOT_AGENT_ID: "m1", CHOIBOT_AGENT_PASS: "p1" };
const userHdr = (c: Call) => Object.keys(c.headers).filter((k) => k.startsWith("x-choibot"));

describe("choibot brain list / show", () => {
  it("list --state active hits ?state=active; default is all", async () => {
    const seen: string[] = [];
    const calls: string[] = [];
    const w = world({ "GET /api/brain/rules": () => ({ body: [] }) });
    const f = w.deps.fetch!;
    w.deps.fetch = (async (u: any, i: any) => { seen.push(String(u)); return f(u, i); }) as typeof fetch;
    expect(await runBrain("list", [], { ...w.deps, flags: { state: "active" } })).toBe(0);
    expect(await runBrain("list", [], w.deps)).toBe(0);
    expect(seen.map((u) => new URL(u).search)).toEqual(["?state=active", "?state=all"]);
    void calls;
  });
  it("show prints text, updatedAt, proposed boolean", async () => {
    const w = world({ "GET /api/brain": () => ({ body: { text: "# Brain", updatedAt: 5, proposed: { text: "x" } } }) });
    expect(await runBrain("show", [], w.deps)).toBe(0);
    expect(JSON.parse(w.out.join(""))).toEqual({ text: "# Brain", updatedAt: 5, proposed: true });
  });
});

describe("choibot brain confirm / retire", () => {
  it("confirm sends the confirm body with only x-choibot-user", async () => {
    const w = world({ "POST /api/brain/rules/r_ab123": () => ({ body: { id: "r_ab123" } }) });
    expect(await runBrain("confirm", ["r_ab123"], { ...w.deps, flags: { confidence: "0.95" } })).toBe(0);
    expect(w.calls[0].body).toEqual({ confirm: true, via: "cli", confidence: 0.95 });
    expect(userHdr(w.calls[0])).toEqual(["x-choibot-user"]);
  });
  it("confirm without a user token exits 1 with no request", async () => {
    const w = world({}, { env: AGENT_ENV });
    expect(await runBrain("confirm", ["r_ab123"], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
  it("confirm rejects a bad confidence", async () => {
    const w = world({});
    expect(await runBrain("confirm", ["r_ab123"], { ...w.deps, flags: { confidence: "high" } })).toBe(1);
    expect(w.calls).toEqual([]);
  });
  it("retire sends why from stdin", async () => {
    const w = world({ "POST /api/brain/rules/r_ab123": () => ({ body: {} }) }, { readStdin: async () => '{"why":"stale"}' });
    expect(await runBrain("retire", ["r_ab123"], w.deps)).toBe(0);
    expect(w.calls[0].body).toEqual({ retire: { why: "stale" }, via: "cli" });
    expect(userHdr(w.calls[0])).toEqual(["x-choibot-user"]);
  });
});

describe("choibot brain distill / apply / rollback", () => {
  it("distill --dry-run sends dryRun: true over the long-call path", async () => {
    const w = world({}, {});
    const long = world({ "POST /api/brain/distill": () => ({ body: { ok: true } }) });
    expect(await runBrain("distill", [], { ...w.deps, flags: { "dry-run": true }, longFetch: long.deps.fetch })).toBe(0);
    expect(long.calls[0].body).toEqual({ dryRun: true });
    expect(userHdr(long.calls[0])).toEqual(["x-choibot-user"]);
    expect(w.calls).toEqual([]);
  });
  it("distill without the flag sends dryRun: false", async () => {
    const long = world({ "POST /api/brain/distill": () => ({ body: {} }) });
    expect(await runBrain("distill", [], { ...long.deps, longFetch: long.deps.fetch })).toBe(0);
    expect(long.calls[0].body).toEqual({ dryRun: false });
  });
  it("apply posts as user and prints {version}, null when no previous brain was saved", async () => {
    const w = world({ "POST /api/brain/apply": () => ({ body: { version: null } }) });
    expect(await runBrain("apply", [], w.deps)).toBe(0);
    expect(w.calls[0].path).toBe("/api/brain/apply");
    expect(userHdr(w.calls[0])).toEqual(["x-choibot-user"]);
    expect(JSON.parse(w.out.join(""))).toEqual({ version: null });
  });
  it("rollback --version sends the version", async () => {
    const w = world({ "POST /api/brain/rollback": () => ({ body: {} }) });
    expect(await runBrain("rollback", [], { ...w.deps, flags: { version: "123" } })).toBe(0);
    expect(w.calls[0].body).toEqual({ version: "123" });
    expect(await runBrain("rollback", [], w.deps)).toBe(0);
    expect(w.calls[1].body).toEqual({});
  });
});

describe("choibot brain add", () => {
  const body = '{"text":"use pnpm","scope":{"area":"*"},"kind":"preference"}';
  it("master env sends agent headers and no via", async () => {
    const w = world({ "POST /api/brain/rules": () => ({ body: { id: "r_1" } }) }, { env: AGENT_ENV, readStdin: async () => body });
    expect(await runBrain("add", [], w.deps)).toBe(0);
    expect(w.calls[0].body).not.toHaveProperty("via");
    expect(w.calls[0].headers["x-choibot-agent"]).toBe("m1");
    expect(w.calls[0].headers["x-choibot-user"]).toBeUndefined();
  });
  it("--user-token sends via: cli", async () => {
    const w = world({ "POST /api/brain/rules": () => ({ body: { id: "r_1" } }) }, { env: AGENT_ENV, flags: { "user-token": "ut" }, readStdin: async () => body });
    expect(await runBrain("add", [], w.deps)).toBe(0);
    expect(w.calls[0].body).toMatchObject({ text: "use pnpm", via: "cli" });
    expect(userHdr(w.calls[0])).toEqual(["x-choibot-user"]);
  });
  it("refuses a TTY stdin", async () => {
    const w = world({}, { stdinIsTTY: true });
    expect(await runBrain("add", [], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
});

describe("choibot brain import-memory", () => {
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-mem-"));
    writeFileSync(join(dir, "a.md"), "---\nname: a\ndescription: Prefer pnpm\ntype: feedback\n---\nbody description: no\n");
    writeFileSync(join(dir, "b.md"), `---\ndescription: ${"x".repeat(300)}\n---\n`);
    writeFileSync(join(dir, "MEMORY.md"), "# Index\n- [a](a.md) description: nope\n");
    writeFileSync(join(dir, "c.txt"), "---\ndescription: not md\n---\n");
    mkdirSync(join(dir, "d.md"));
    return dir;
  };
  it("posts candidates, counts a 409 as skipped, cuts to 200", async () => {
    const dir = fixture();
    let n = 0;
    const w = world({ "POST /api/brain/rules": () => (++n === 2 ? { status: 409, body: { error: "duplicate", id: "r_x" } } : { body: { id: "r_1" } }) },
      { readFile: (p) => readFileSync(p, "utf8") });
    expect(await runBrain("import-memory", [dir], w.deps)).toBe(0);
    expect(JSON.parse(w.out.join(""))).toEqual({ candidates: 1, skipped: 1 });
    expect(w.calls).toHaveLength(2);
    expect(w.calls[0].body).toEqual({ text: "Prefer pnpm", state: "candidate", source: { memoryFile: "a.md" },
      scope: { area: "*", audience: "all" }, kind: "preference" });
    expect(w.calls[1].body.text).toHaveLength(200);
    expect(userHdr(w.calls[0])).toEqual(["x-choibot-user"]);
  });
  it("cuts a description to 200 units without splitting an emoji", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-mem-"));
    writeFileSync(join(dir, "e.md"), `---\ndescription: ${"x".repeat(199)}😀 more\n---\n`);
    const w = world({ "POST /api/brain/rules": () => ({ body: { id: "r_1" } }) }, { readFile: (p) => readFileSync(p, "utf8") });
    expect(await runBrain("import-memory", [dir], w.deps)).toBe(0);
    expect(w.calls[0].body.text).toBe("x".repeat(199));
  });
  it("warns and skips an unreadable file", async () => {
    const dir = fixture();
    const w = world({ "POST /api/brain/rules": () => ({ body: {} }) }, { readFile: (p) => (p.endsWith("a.md") ? null : readFileSync(p, "utf8")) });
    expect(await runBrain("import-memory", [dir], w.deps)).toBe(0);
    expect(w.err.join("")).toContain("a.md");
    expect(JSON.parse(w.out.join(""))).toEqual({ candidates: 1, skipped: 0 });
  });
  it("a missing dir exits 1", async () => {
    const w = world({});
    expect(await runBrain("import-memory", ["/nonexistent/brain-mem-none"], w.deps)).toBe(1);
  });
});

describe("choibot brain triage", () => {
  const RULES = [
    { id: "r_aaaaa", text: "A", state: "candidate" },
    { id: "r_bbbbb", text: "should we still merge this?", state: "candidate" },
    { id: "r_ccccc", text: "never commit plan files", state: "candidate" },
    { id: "r_ddddd", text: "show me other option, I don't like this", state: "candidate" },
    { id: "r_eeeee", text: "use pnpm for installs", state: "candidate" },
    { id: "r_fffff", text: "yes fable is defualt", state: "active" },
    { id: "r_ggggg", text: "gone", state: "retired" },
  ];
  const BRAIN = "# Brain (2026-11-18)\n\n## Always\n- Fable 5.2 is the default model [r_fffff]\n- shared line [r_ggggg] [r_fffff]\n";
  const routes = {
    "GET /api/brain/rules": () => ({ body: RULES }),
    "GET /api/brain": () => ({ body: { text: BRAIN } }),
    "POST /api/brain/rules/r_aaaaa": () => ({ body: {} }), "POST /api/brain/rules/r_bbbbb": () => ({ body: {} }),
    "POST /api/brain/rules/r_ccccc": () => ({ body: {} }), "POST /api/brain/rules/r_ddddd": () => ({ body: {} }),
    "POST /api/brain/rules/r_eeeee": () => ({ body: {} }), "POST /api/brain/rules/r_fffff": () => ({ body: {} }),
  };
  // jev: sure yes to "use pnpm …", not sure (0.2 to 0.8) on "never commit …", sure no to
  // the rest; it never sees a one-time answer the plain test drops.
  const seen: string[][] = [];
  const SCORE: Record<string, number> = { r_eeeee: 0.9, r_ccccc: 0.5, r_ddddd: 0.1 };
  const judge = async (texts: { id: string; text: string }[]) => {
    seen.push(texts.map((t) => t.id));
    return new Map(texts.map((t) => [t.id, SCORE[t.id] ?? 0]));
  };
  const plan = (w: ReturnType<typeof world>) => JSON.parse(w.out.join(""));

  it("dry run: sorts the candidates, plans the BRAIN.md wording, writes nothing", async () => {
    seen.length = 0;
    const w = world(routes, { judge });
    expect(await runBrain("triage", [], w.deps)).toBe(0);
    const p = plan(w);
    expect(p).toMatchObject({ candidates: 5, judge: "jev", applied: false, weeks: 1 });
    expect(p.keep.map((r: { id: string; why: string }) => [r.id, r.why])).toEqual([["r_eeeee", "jev 0.90"]]);
    expect(p.notSure.map((r: { id: string; why: string }) => [r.id, r.why])).toEqual([["r_ccccc", "jev 0.50"]]);
    expect(p.drop.map((r: { id: string; why: string }) => [r.id, r.why])).toEqual([
      ["r_aaaaa", "fewer than 3 words"], ["r_bbbbb", "a question"], ["r_ddddd", "jev 0.10"]]);
    expect(p.reword).toEqual([{ id: "r_fffff", from: "yes fable is defualt", to: "Fable 5.2 is the default model" }]);
    expect(seen).toEqual([["r_ccccc", "r_ddddd", "r_eeeee"]]);
    expect(w.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("--no-jev: the marker words decide", async () => {
    const w = world(routes, { judge, flags: { "no-jev": true } });
    expect(await runBrain("triage", [], w.deps)).toBe(0);
    const p = plan(w);
    expect(p.judge).toBe("markers");
    expect(p.keep.map((r: { id: string }) => r.id)).toEqual(["r_ccccc"]);
    expect(p.notSure).toEqual([]);
  });

  it("--apply retires the drops (why triage), marks the keeps and the not-sure ones with an edit, rewords the active rules, as USER", async () => {
    const w = world(routes, { judge, flags: { apply: true } });
    expect(await runBrain("triage", [], w.deps)).toBe(0);
    const posts = w.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => [c.path, c.body])).toEqual([
      ["/api/brain/rules/r_aaaaa", { retire: { why: "triage" }, via: "cli" }],
      ["/api/brain/rules/r_bbbbb", { retire: { why: "triage" }, via: "cli" }],
      ["/api/brain/rules/r_ddddd", { retire: { why: "triage" }, via: "cli" }],
      ["/api/brain/rules/r_eeeee", { text: "use pnpm for installs", via: "cli" }],
      ["/api/brain/rules/r_ccccc", { text: "never commit plan files", via: "cli" }],
      ["/api/brain/rules/r_fffff", { text: "Fable 5.2 is the default model", via: "cli" }],
    ]);
    expect(posts.every((c) => c.headers["x-choibot-user"] === "ut")).toBe(true);
    expect(plan(w).applied).toBe(true);
  });

  it("--file reads a copy of rules.jsonl (dry run only); --apply with --file is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-triage-"));
    const file = join(dir, "rules.jsonl");
    writeFileSync(file, [
      { ev: "add", id: "r_aaaaa", at: 1, text: "A", scope: { area: "*" }, kind: "correction", source: { origin: "user-line" }, confidence: 0.6, state: "candidate" },
      { ev: "add", id: "r_ccccc", at: 2, text: "always run the tests", scope: { area: "*" }, kind: "preference", source: { origin: "master" }, confidence: 0.6, state: "candidate" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
    const w = world({}, { judge: async () => null, readFile: read, flags: { file } });
    expect(await runBrain("triage", [], w.deps)).toBe(0);
    expect(plan(w)).toMatchObject({ candidates: 2, judge: "markers", keep: [{ id: "r_ccccc" }], drop: [{ id: "r_aaaaa" }], applied: false });
    expect(w.calls).toEqual([]);
    const a = world({}, { readFile: read, flags: { file, apply: true } });
    expect(await runBrain("triage", [], a.deps)).toBe(1);
    expect(a.err.join("")).toContain("--apply works on the console only");
    expect(a.calls).toEqual([]);
  });
});

describe("triagePlan weeks", () => {
  it("counts the weeks the kept rules take at the 5-a-week limit", async () => {
    const { triagePlan } = await import("./triage.js");
    const rules = Array.from({ length: 11 }, (_, i) => ({ id: `r_${String(i).padStart(5, "0")}`, text: `always check thing number ${i}`, state: "candidate" }));
    const half = new Map(rules.map((r, i) => [r.id, i < 6 ? 0.9 : 0.5]));
    const p = await triagePlan(rules, "", async () => half);
    expect([p.keep.length, p.notSure.length, p.drop.length, p.weeks]).toEqual([6, 5, 0, 3]);
    expect((await triagePlan([], "", async () => new Map())).weeks).toBe(0);
  });
});
