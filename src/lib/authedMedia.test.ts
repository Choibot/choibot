import { describe, expect, it } from "vitest";
import { BROKEN_SRC, loadMedia } from "./authedMedia";

const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });

describe("loadMedia", () => {
  it("reads the picture with the given fetch and gives an object URL that it revokes once", async () => {
    const made: Blob[] = [];
    const dropped: string[] = [];
    const seen: string[] = [];
    const r = await loadMedia("/api/queue/q1/media/1.png", new AbortController().signal, {
      fetch: async (u) => { seen.push(u); return png(); },
      createObjectURL: (b) => { made.push(b); return "blob:x"; },
      revokeObjectURL: (u) => dropped.push(u),
    });
    expect(seen).toEqual(["/api/queue/q1/media/1.png"]);
    expect([r?.url, made[0].type, made[0].size]).toEqual(["blob:x", "image/png", 4]);
    r!.revoke();
    expect(dropped).toEqual(["blob:x"]);
  });

  it("gives null for a refusal, a body that is not a picture, a network error and an abort", async () => {
    const no = { createObjectURL: () => { throw new Error("must not be called"); }, revokeObjectURL: () => {} };
    const sig = new AbortController().signal;
    expect(await loadMedia("/a", sig, { ...no, fetch: async () => new Response("{}", { status: 401 }) })).toBeNull();
    expect(await loadMedia("/a", sig, { ...no, fetch: async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }) })).toBeNull();
    expect(await loadMedia("/a", sig, { ...no, fetch: async () => { throw new TypeError("network"); } })).toBeNull();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await loadMedia("/a", ctrl.signal, { ...no, fetch: async () => png() })).toBeNull();
  });

  it("shows a failure as a failed <img> does: an address that is never a picture", () => {
    expect(BROKEN_SRC).toBe("data:,");
  });
});
