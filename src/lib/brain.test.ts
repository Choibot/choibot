import { describe, expect, it, vi } from "vitest";
import {
  addRule, devicesStatus, editRule, fetchBrain, fetchEditorOff, protectionWords, readActiveRules, removeRule, rulesStatus, scopeLabel,
  userAuthLabel, type RuleRow,
} from "./brain";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const BODY = { text: "# Brain", updatedAt: 5, size: 7, hardened: false, userAuth: "log", distill: { enabled: true } };

describe("fetchBrain", () => {
  it("404 -> off", async () => {
    const f = vi.fn(async (_u: string) => json(404, {}));
    expect(await fetchBrain({ fetch: f as unknown as typeof fetch })).toEqual({ state: "off" });
    expect(f.mock.calls[0][0]).toBe("/api/brain");
  });
  it("503 -> misconfigured", async () => {
    const f = vi.fn(async () => json(503, { error: "chief-misconfigured" }));
    expect(await fetchBrain({ fetch: f as unknown as typeof fetch })).toEqual({ state: "misconfigured" });
  });
  it("200 -> on", async () => {
    const f = vi.fn(async () => json(200, BODY));
    expect(await fetchBrain({ fetch: f as unknown as typeof fetch })).toEqual({ state: "on", brain: BODY });
  });
  it("a network error or other status -> error (not off)", async () => {
    expect(await fetchBrain({ fetch: (async () => { throw new Error("x"); }) as unknown as typeof fetch })).toEqual({ state: "error" });
    expect(await fetchBrain({ fetch: (async () => json(500, {})) as unknown as typeof fetch })).toEqual({ state: "error" });
  });
});

describe("fetchEditorOff (overview decision 45)", () => {
  const with200 = (body: unknown) => fetchEditorOff({ fetch: (async () => json(200, body)) as unknown as typeof fetch });
  it("true only when GET /api/brain is on and says editorOff: true", async () => {
    const f = vi.fn(async (_u: string) => json(200, { ...BODY, editorOff: true }));
    expect(await fetchEditorOff({ fetch: f as unknown as typeof fetch })).toBe(true);
    expect(f.mock.calls[0][0]).toBe("/api/brain");
    expect(await with200({ ...BODY, editorOff: false })).toBe(false);
    expect(await with200({ ...BODY, editorOff: "yes" })).toBe(false);
    expect(await with200(BODY)).toBe(false);
  });
  it("flag off (404), misconfigured (503), another status or a network error: false, the button shows as today", async () => {
    for (const status of [404, 503, 500]) {
      expect(await fetchEditorOff({ fetch: (async () => json(status, {})) as unknown as typeof fetch }), String(status)).toBe(false);
    }
    expect(await fetchEditorOff({ fetch: (async () => { throw new Error("x"); }) as unknown as typeof fetch })).toBe(false);
  });
});

describe("userAuthLabel", () => {
  it("strong only when hardened", () => {
    expect(userAuthLabel({ hardened: true })).toBe("strong");
    expect(userAuthLabel({ hardened: false })).toBe("weak");
  });
});

describe("protectionWords", () => {
  it("says the level and what Telegram counts for, in plain words", () => {
    expect(protectionWords({ hardened: true, userAuth: "telegram" }).level).toMatch(/^Strong\./);
    expect(protectionWords({ hardened: false, userAuth: "telegram" }).level).toMatch(/^Basic\./);
    expect(protectionWords({ hardened: false, userAuth: "telegram" }).telegram).toMatch(/counts as you/);
    expect(protectionWords({ hardened: false, userAuth: "log" }).telegram).toMatch(/pair from your server.*never answers a ticket by itself/);
    // Words for a new user: no "system user", no name of an install mode.
    for (const b of [{ hardened: true, userAuth: "telegram" }, { hardened: false, userAuth: "telegram" }, { hardened: false, userAuth: "log" }] as const) {
      expect(`${protectionWords(b).level} ${protectionWords(b).telegram}`).not.toMatch(/system user|log mode|\bWeak\b/);
    }
  });
});

describe("scopeLabel", () => {
  it("is null for every agent, else names who gets the rule", () => {
    expect(scopeLabel({ area: "*" })).toBeNull();
    expect(scopeLabel({ area: "*", audience: "all" })).toBeNull();
    expect(scopeLabel({ area: "*", audience: "workers" })).toBe("Workers only");
    expect(scopeLabel({ area: "*", audience: "master" })).toBe("Master and leads");
    expect(scopeLabel({ area: "app-shop", repo: "app-shop" })).toBe("Area app-shop");
  });
});

describe("readActiveRules and the status lines", () => {
  const rule: RuleRow = { id: "r_aaaaa", text: "Always run the tests", state: "active", scope: { area: "*" }, createdAt: 1 };
  it("rows, flag off, misconfigured, a refusal and no answer", async () => {
    expect(await readActiveRules({ fetch: vi.fn(async () => json(200, [rule])) })).toEqual({ rows: [rule] });
    expect(await readActiveRules({ fetch: vi.fn(async () => json(404, {})) })).toEqual({ off: true });
    expect(await readActiveRules({ fetch: vi.fn(async () => json(503, {})) })).toMatchObject({ error: expect.stringContaining("misconfigured") });
    expect(await readActiveRules({ fetch: vi.fn(async () => { throw new Error("down"); }) })).toEqual({ error: "the console did not answer" });
  });
  it("asks for the active rules only", async () => {
    const f = vi.fn(async () => json(200, []));
    await readActiveRules({ fetch: f });
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("/api/brain/rules?state=active");
  });
  it("rulesStatus and devicesStatus", () => {
    expect(rulesStatus(null).tone).toBe("load");
    expect(rulesStatus({ rows: [] })).toEqual({ tone: "off", text: "No rules yet." });
    expect(rulesStatus({ rows: [rule, rule] })).toEqual({ tone: "ok", text: "2 rules. Agents get them in their prompt when they start." });
    expect(rulesStatus({ off: true }).tone).toBe("off");
    expect(rulesStatus({ error: "x" })).toEqual({ tone: "err", text: "Cannot read the rules: x" });
    expect(devicesStatus({ rows: [] })).toEqual({ tone: "off", text: "No paired devices." });
    expect(devicesStatus({ rows: [{ label: "phone", createdAt: 1 }] })).toEqual({ tone: "ok", text: "1 paired device." });
  });
});

describe("rule actions", () => {
  const sent = (f: ReturnType<typeof vi.fn>) => {
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    return { url: String(url), body: JSON.parse(String(init.body)) };
  };
  it("add is a rule for every agent; edit confirms the new text; remove retires", async () => {
    const f1 = vi.fn(async () => json(200, {}));
    expect(await addRule("Always run the tests", { fetch: f1 })).toEqual({ ok: true });
    expect(sent(f1)).toMatchObject({ url: expect.stringContaining("/api/brain/rules"), body: { text: "Always run the tests", scope: { area: "*" }, via: "tab" } });
    const f2 = vi.fn(async () => json(200, {}));
    await editRule("r_aaaaa", "Run the tests", { fetch: f2 });
    expect(sent(f2)).toMatchObject({ url: expect.stringContaining("/api/brain/rules/r_aaaaa"), body: { text: "Run the tests", confirm: true, via: "tab" } });
    const f3 = vi.fn(async () => json(200, {}));
    await removeRule("r_aaaaa", { fetch: f3 });
    expect(sent(f3).body).toEqual({ retire: { why: "removed in Settings" }, via: "tab" });
  });
  it("a duplicate add says so in words", async () => {
    expect(await addRule("x y z", { fetch: vi.fn(async () => json(409, { error: "duplicate", id: "r_aaaaa" })) }))
      .toEqual({ ok: false, error: "This rule is there already." });
  });
});
