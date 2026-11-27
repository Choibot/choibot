// src/lib/agents.test.ts
import { describe, it, expect, vi } from "vitest";

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
async function run(r: Response) {
  vi.resetModules();
  vi.doMock("./chief", async () => ({ ...(await vi.importActual<typeof import("./chief")>("./chief")), chiefFetch: async () => r }));
  const m = await import("./agents");
  return m.mergeAgent("a1");
}

describe("mergeAgent refusal sentences", () => {
  it("403 pair-required (telegram) gives the pairing sentence", async () => {
    expect(await run(res(403, { error: "pair-required", userAuth: "telegram" })))
      .toEqual({ ok: false, message: "Merge needs a paired device — send /pair <label> in the Master topic" });
  });
  it("403 pair-required (log) gives the box sentence", async () => {
    expect(await run(res(403, { error: "pair-required", userAuth: "log" })))
      .toEqual({ ok: false, message: "Merge needs a paired device. On a paired device: Settings, Devices, “Add a device”. With no paired device: run `pnpm choibot brain pair <label>` on your server" });
  });
  it("503 gives the misconfigured text", async () => {
    expect(await run(res(503, { error: "chief-misconfigured" })))
      .toEqual({ ok: false, message: "Chief misconfigured — see `pnpm choibot doctor`" });
  });
  it("409 keeps today's message", async () => {
    expect(await run(res(409, {}))).toEqual({ ok: false, message: "agent still live — stop it first" });
  });
});

describe("the model tag of a row and a header", () => {
  it("uses the model of the last start, else the record's model, else none", async () => {
    const { agentModel } = await import("./agents");
    expect(agentModel({ runModel: "opus", model: "sonnet" })).toBe("opus");
    expect(agentModel({ model: "sonnet" })).toBe("sonnet");
    expect(agentModel({})).toBeUndefined();
  });
  it("the row's tag is the model word only; the login is not the default one", async () => {
    const { modelWord, loginOf } = await import("./agents");
    expect(modelWord("opus")).toBe("opus");
    expect(modelWord("claude-opus-5-5")).toBe("opus-5-5");
    expect(modelWord(undefined)).toBeUndefined();
    expect(loginOf("choibot")).toBe("choibot");
    expect(loginOf("default")).toBeUndefined();
    expect(loginOf("")).toBeUndefined();
    expect(loginOf(undefined)).toBeUndefined();
  });
  it("shows the model and the login; no tag when the console cannot know either", async () => {
    const { modelTag } = await import("./agents");
    expect(modelTag("opus", "choibot")).toEqual({ text: "opus · @choibot", title: "Model: opus · Claude account: choibot" });
    expect(modelTag("claude-sonnet-5-5", "default")).toEqual({ text: "sonnet-5-5", title: "Model: claude-sonnet-5-5" });
    expect(modelTag(undefined, "choibot")).toEqual({ text: "@choibot", title: "Claude account: choibot" });
    expect(modelTag(undefined, "default")).toBeNull();
    expect(modelTag(undefined)).toBeNull();
  });
});
