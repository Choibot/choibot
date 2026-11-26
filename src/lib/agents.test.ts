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
