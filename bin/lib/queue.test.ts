import { describe, it, expect } from "vitest";
import { USER_ALONE_ERR } from "../../server/chief/gate.js";
import { runQueue, type QueueDeps } from "./queue.js";

type Call = { method: string; path: string; search: string; body: any; headers: Record<string, string> };

function world(routes: Record<string, (body: any) => { status?: number; body?: unknown }>, o: Partial<QueueDeps> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const h = routes[`${method} ${u.pathname}`];
    const r = h ? h(body) : { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  const deps: Partial<QueueDeps> = {
    fetch: f, readStdin: async () => "", stdinIsTTY: false, stderrIsTTY: true,
    out: (s) => out.push(s), err: (s) => err.push(s),
    env: { HOME: "/nonexistent/queue-test-home", PORT: "4321", CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p1", CHOIBOT_USER_TOKEN: "ut" },
    flags: {}, readFile: () => null,
    ...o,
  };
  return { calls, out, err, deps };
}

describe("choibot queue add", () => {
  it("sends agent headers and the stdin JSON unchanged", async () => {
    const raw = '{"kind":"choice","title":"t","extra":[1,2]}';
    const w = world({ "POST /api/queue": () => ({ body: { id: "q7k2m9x1a" } }) }, { readStdin: async () => raw });
    expect(await runQueue("add", [], w.deps)).toBe(0);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].body).toEqual(JSON.parse(raw));
    expect(w.calls[0].headers["x-choibot-agent"]).toBe("a1");
    expect(w.calls[0].headers["x-choibot-agent-token"]).toBe("p1");
    expect(Object.keys(w.calls[0].headers).some((k) => k.toLowerCase() === "x-choibot-user")).toBe(false);
    expect(JSON.parse(w.out.join(""))).toEqual({ id: "q7k2m9x1a" });
  });
  it("exits 1 with no request on invalid JSON", async () => {
    const w = world({}, { readStdin: async () => "{nope" });
    expect(await runQueue("add", [], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.err.join("")).toContain("invalid JSON");
  });
  it("exits 1 with no request on a TTY stdin", async () => {
    const w = world({}, { stdinIsTTY: true });
    expect(await runQueue("add", [], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
  it("prints the server error on stderr", async () => {
    const w = world({ "POST /api/queue": () => ({ status: 400, body: { error: "title too long" } }) }, { readStdin: async () => "{}" });
    expect(await runQueue("add", [], w.deps)).toBe(1);
    expect(w.err).toEqual(["title too long"]);
  });
});

describe("choibot queue list", () => {
  const items = [{ id: "qaaaaaaa1", agentId: "a1", area: "app-shop" }, { id: "qaaaaaaa2", agentId: "a2", area: "app-shop" }];
  it("builds the query from --open and --area", async () => {
    const w = world({ "GET /api/queue": () => ({ body: { items } }) }, { flags: { open: true, area: "app-shop" } });
    expect(await runQueue("list", [], w.deps)).toBe(0);
    expect(w.calls[0].search).toBe("?status=open&area=app-shop");
    expect(JSON.parse(w.out.join(""))).toEqual(items);
  });
  it("uses status=all and no area by default", async () => {
    const w = world({ "GET /api/queue": () => ({ body: { items } }) });
    await runQueue("list", [], w.deps);
    expect(w.calls[0].search).toBe("?status=all");
  });
  it("--mine filters by CHOIBOT_AGENT_ID", async () => {
    const w = world({ "GET /api/queue": () => ({ body: { items } }) }, { flags: { mine: true } });
    await runQueue("list", [], w.deps);
    expect(JSON.parse(w.out.join("")).map((i: any) => i.id)).toEqual(["qaaaaaaa1"]);
  });
});

describe("choibot queue list flags", () => {
  const items = [{ id: "qaaaaaaa1", agentId: "X" }, { id: "qaaaaaaa2", agentId: "Y" }];
  const route = { "GET /api/queue": () => ({ body: { items } }) };
  it("--mine prefers --agent over CHOIBOT_AGENT_ID", async () => {
    const w = world({ ...route, "GET /api/agents/X": () => ({ body: { id: "X", hookToken: "ht" } }) },
      { flags: { mine: true, agent: "X", "user-token": "ut" }, env: { PORT: "4321", CHOIBOT_AGENT_ID: "Y", CHOIBOT_AGENT_PASS: "p" } });
    expect(await runQueue("list", [], w.deps)).toBe(0);
    expect(JSON.parse(w.out.join("")).map((i: any) => i.id)).toEqual(["qaaaaaaa1"]);
  });
  it("--mine with no identity exits 1, no request", async () => {
    const w = world(route, { flags: { mine: true }, env: { PORT: "4321" } });
    expect(await runQueue("list", [], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
  it("encodes --area", async () => {
    const w = world(route, { flags: { area: "a b&c=d" } });
    await runQueue("list", [], w.deps);
    expect(w.calls[0].search).toBe("?status=all&area=a%20b%26c%3Dd");
  });
  it("rejects an empty or bare --area", async () => {
    for (const area of ["", true as const]) {
      const w = world(route, { flags: { area } });
      expect(await runQueue("list", [], w.deps)).toBe(1);
      expect(w.calls).toEqual([]);
    }
  });
});

describe("choibot queue id validation", () => {
  it.each(["..", ".", "../brain", "q1", "Qaaaaaaa1", "qaaaaaaa1/x"])("rejects id %s without a request", async (id) => {
    for (const sub of ["show", "withdraw", "recommend", "answer", "undo"]) {
      const w = world({}, { readStdin: async () => "{}" });
      expect(await runQueue(sub, [id], w.deps)).toBe(1);
      expect(w.calls).toEqual([]);
    }
  });
});

describe("choibot queue show / withdraw / recommend", () => {
  it("show prints the item", async () => {
    const w = world({ "GET /api/queue/qaaaaaaa1": () => ({ body: { id: "qaaaaaaa1", title: "t" } }) });
    expect(await runQueue("show", ["qaaaaaaa1"], w.deps)).toBe(0);
    expect(JSON.parse(w.out.join("")).id).toBe("qaaaaaaa1");
  });
  it("show says on stderr that an item has a page and where its copy is; the JSON on stdout stays whole", async () => {
    const html = { bytes: 812, height: 240, copy: "/data/queue/media/qaaaaaaa1/page.html" };
    const w = world({ "GET /api/queue/qaaaaaaa1": () => ({ body: { id: "qaaaaaaa1", title: "t", body: "b", html } }) });
    expect(await runQueue("show", ["qaaaaaaa1"], w.deps)).toBe(0);
    expect(JSON.parse(w.out.join(""))).toEqual({ id: "qaaaaaaa1", title: "t", body: "b", html });
    expect(w.err).toEqual(["This item has a page (812 bytes): the user sees it in the Queue. The body is the text of the ticket. The copy of the page: /data/queue/media/qaaaaaaa1/page.html"]);
    const plain = world({ "GET /api/queue/qaaaaaaa1": () => ({ body: { id: "qaaaaaaa1", title: "t" } }) });
    await runQueue("show", ["qaaaaaaa1"], plain.deps);
    expect(plain.err).toEqual([]);
  });
  it("show without an id fails", async () => {
    const w = world({});
    expect(await runQueue("show", [], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
  it("show prints a 404 error", async () => {
    const w = world({ "GET /api/queue/qaaaaaaa9": () => ({ status: 404, body: { error: "no such item" } }) });
    expect(await runQueue("show", ["qaaaaaaa9"], w.deps)).toBe(1);
    expect(w.err.join("")).toContain("no such item");
  });
  it("withdraw posts", async () => {
    const w = world({ "POST /api/queue/qaaaaaaa1/withdraw": () => ({ body: { ok: true } }) });
    expect(await runQueue("withdraw", ["qaaaaaaa1"], w.deps)).toBe(0);
    expect(w.calls[0].method).toBe("POST");
    expect(w.calls[0].path).toBe("/api/queue/qaaaaaaa1/withdraw");
  });
  it("recommend sends the stdin JSON", async () => {
    const w = world({ "POST /api/queue/qaaaaaaa1/recommend": () => ({ body: { ok: true } }) }, { readStdin: async () => '{"value":"B"}' });
    expect(await runQueue("recommend", ["qaaaaaaa1"], w.deps)).toBe(0);
    expect(w.calls[0].body).toEqual({ value: "B" });
  });
  it("recommend refuses a TTY", async () => {
    const w = world({}, { stdinIsTTY: true });
    expect(await runQueue("recommend", ["qaaaaaaa1"], w.deps)).toBe(1);
    expect(w.calls).toEqual([]);
  });
  it("answer sends the stdin JSON and prints the item", async () => {
    const raw = '{"value":"B","auto":true,"ruleIds":["r_8f3k2"],"confidence":0.9}';
    const w = world({ "POST /api/queue/qaaaaaaa1/answer": () => ({ body: { id: "qaaaaaaa1", status: "auto" } }) }, { readStdin: async () => raw });
    expect(await runQueue("answer", ["qaaaaaaa1"], w.deps)).toBe(0);
    expect(w.calls[0].body).toEqual(JSON.parse(raw));
    expect(JSON.parse(w.out.join(""))).toEqual({ id: "qaaaaaaa1", status: "auto" });
    expect(w.err).toEqual([]);
  });
  it("answer with a downgrade prints the item on stdout, the reason on stderr, exit 0", async () => {
    const w = world({ "POST /api/queue/qaaaaaaa1/answer": () => ({ body: { id: "qaaaaaaa1", status: "open", downgraded: "needs 2 confirms" } }) },
      { readStdin: async () => '{"value":"B","auto":true}' });
    expect(await runQueue("answer", ["qaaaaaaa1"], w.deps)).toBe(0);
    expect(JSON.parse(w.out.join(""))).toEqual({ id: "qaaaaaaa1", status: "open" });
    expect(w.err.join("")).toContain("needs 2 confirms");
  });
  it("answer: with strong protection the console refuses the auto answer; the CLI prints the reason, exit 1", async () => {
    const w = world({ "POST /api/queue/qaaaaaaa1/answer": () => ({ status: 403, body: { error: USER_ALONE_ERR.auto } }) },
      { readStdin: async () => '{"value":"B","auto":true}' });
    expect(await runQueue("answer", ["qaaaaaaa1"], w.deps)).toBe(1);
    expect(w.err.join("")).toContain("with strong protection only the user answers a ticket");
  });
  it("answer refuses a TTY and invalid JSON without a request", async () => {
    const tty = world({}, { stdinIsTTY: true });
    expect(await runQueue("answer", ["qaaaaaaa1"], tty.deps)).toBe(1);
    const bad = world({}, { readStdin: async () => "{nope" });
    expect(await runQueue("answer", ["qaaaaaaa1"], bad.deps)).toBe(1);
    expect(tty.calls.length + bad.calls.length).toBe(0);
  });
  it("undo posts and prints the item; a server refusal exits 1", async () => {
    const w = world({ "POST /api/queue/qaaaaaaa1/undo": () => ({ body: { id: "qaaaaaaa1", status: "open" } }) });
    expect(await runQueue("undo", ["qaaaaaaa1"], w.deps)).toBe(0);
    expect(w.calls[0]).toMatchObject({ method: "POST", path: "/api/queue/qaaaaaaa1/undo" });
    expect(JSON.parse(w.out.join(""))).toEqual({ id: "qaaaaaaa1", status: "open" });
    const no = world({ "POST /api/queue/qaaaaaaa1/undo": () => ({ status: 403, body: { error: "the master undoes only its own auto answer" } }) });
    expect(await runQueue("undo", ["qaaaaaaa1"], no.deps)).toBe(1);
    expect(no.err.join("")).toContain("the master undoes only");
  });
  it("unknown sub prints help, exit 2", async () => {
    const w = world({});
    expect(await runQueue(undefined, [], w.deps)).toBe(2);
  });
});

// The Merge button of a pr ticket is a USER route of the tab only (server/chief/queue/merge.ts):
// no `choibot queue` command calls it, with any id, flags or stdin, as an agent or with a user token.
describe("choibot queue never merges", () => {
  it("no subcommand calls a merge route", async () => {
    const paths: string[] = [];
    const stdin = '{"value":"approve","method":"squash","checks":"accept","kind":"pr","title":"t","body":"b","pr":{"url":"https://github.com/o/r/pull/1"}}';
    for (const sub of ["add", "show", "list", "withdraw", "recommend", "answer", "undo", "merge", "merge-pr", undefined]) {
      for (const env of [{ CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p1" }, { CHOIBOT_USER_TOKEN: "ut" }]) {
        const w = world({}, { readStdin: async () => stdin, env: { HOME: "/nonexistent/queue-test-home", PORT: "4321", ...env } });
        await runQueue(sub, ["qaaaaaaa1", "squash"], w.deps);
        paths.push(...w.calls.map((c) => c.path));
      }
    }
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => /merge/.test(p))).toEqual([]);
  });
});
