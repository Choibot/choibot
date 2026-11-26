// server/settings/github.test.ts — the GitHub status of Settings with the ChoiBot app switch on:
// with no app key, no gh call at all (gh's own stored login never counts); with the key, the
// login and the rate, and no per-repo read (the app's list gives the repos).
import { describe, expect, it } from "vitest";
import type { AppTokenView } from "../gh/appapi.js";
import { githubStatus } from "./github.js";

function run(key: AppTokenView | null) {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "user") return JSON.stringify({ login: "ana-dev" });
    if (args[1] === "rate_limit") return JSON.stringify({ resources: { core: { limit: 5000, remaining: 4990, reset: 9 } } });
    return JSON.stringify({ permissions: { pull: true, push: true } });
  };
  const repos = async () => [{ name: "shop", slug: "acme/shop", path: "/ws/shop" }];
  return { calls, status: githubStatus({ gh, repos, now: () => 7, ...(key ? { app: async () => key } : {}) }) };
}

describe("githubStatus with the ChoiBot app", () => {
  it("with no key or a refused key: not connected, and gh is never asked", async () => {
    for (const key of [{ state: "none" }, { state: "signed-out", why: "refused" }] as AppTokenView[]) {
      const { calls, status } = run(key);
      expect(await status).toEqual({ login: null, error: "ChoiBot is not connected", rate: null, repos: [], checkedAt: 7, app: { key } });
      expect(calls).toEqual([]);
    }
  });

  it("with the key: the login and the rate, and no per-repo read", async () => {
    const key: AppTokenView = { state: "ok", accessLeftMs: 1, refreshLeftMs: 2 };
    const { calls, status } = run(key);
    expect(await status).toEqual({ login: "ana-dev", rate: { limit: 5000, remaining: 4990, reset: 9 }, repos: [], checkedAt: 7, app: { key } });
    expect(calls).toEqual([["api", "user"], ["api", "rate_limit"]]);
  });

  it("with the switch off: as before, with a read of each repo", async () => {
    const { calls, status } = run(null);
    expect((await status).repos).toEqual([{ name: "shop", slug: "acme/shop", read: true, push: true }]);
    expect(calls).toEqual([["api", "user"], ["api", "rate_limit"], ["api", "repos/acme/shop"]]);
  });
});
