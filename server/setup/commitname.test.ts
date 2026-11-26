// server/setup/commitname.test.ts — the name for commits: taken from the GitHub login only
// where git has none. A fake git config (a map) and a fake `gh api user`.
import { describe, expect, it } from "vitest";
import { commitNameView, fromGithubUser, setCommitName } from "./commitname.js";

function fakeGit(start: Record<string, string> = {}) {
  const cfg = new Map(Object.entries(start));
  const writes: string[][] = [];
  const gitConfig = async (args: string[]): Promise<string | null> => {
    if (args[0] === "--get") return cfg.has(args[1]) ? `${cfg.get(args[1])}\n` : null;
    writes.push(args);
    cfg.set(args[0], args[1]);
    return "";
  };
  return { cfg, writes, gitConfig };
}
const ADA = JSON.stringify({ login: "ada-dev", id: 1234567, name: "Ada Lovelace", email: "private@example.com" });
const ghUser = (json = ADA) => async () => json;

describe("fromGithubUser", () => {
  it("gives the name of the account and its noreply address", () => {
    expect(fromGithubUser(ADA)).toEqual({ name: "Ada Lovelace", email: "1234567+ada-dev@users.noreply.github.com" });
  });
  it("uses the login when the account has no name", () => {
    expect(fromGithubUser(JSON.stringify({ login: "ada-dev", id: 7, name: null }))?.name).toBe("ada-dev");
    expect(fromGithubUser(JSON.stringify({ login: "ada-dev", id: 7, name: "  " }))?.name).toBe("ada-dev");
  });
  it("gives a name that is one plain line and no option of git", () => {
    expect(fromGithubUser(JSON.stringify({ login: "ada-dev", id: 7, name: " --global\nAda <x>" }))?.name).toBe("global Ada x");
  });
  it("gives nothing for an answer with no usable login", () => {
    expect(fromGithubUser("{}")).toBeNull();
    expect(fromGithubUser("not json")).toBeNull();
    expect(fromGithubUser(JSON.stringify({ login: "a b", id: 7 }))).toBeNull();
    expect(fromGithubUser(JSON.stringify({ login: "ada-dev", id: "7" }))).toBeNull();
  });
});

describe("commitNameView", () => {
  it("says what git has, and what the step will set", async () => {
    const g = fakeGit();
    expect(await commitNameView({ gitConfig: g.gitConfig, ghUser: ghUser() })).toEqual({
      name: false, email: false, suggest: { name: "Ada Lovelace", email: "1234567+ada-dev@users.noreply.github.com" },
    });
    expect(g.writes).toEqual([]);
  });
  it("does not ask GitHub when git has both", async () => {
    const g = fakeGit({ "user.name": "Owner", "user.email": "owner@example.com" });
    let asked = 0;
    expect(await commitNameView({ gitConfig: g.gitConfig, ghUser: async () => { asked++; return ADA; } })).toEqual({ name: true, email: true, suggest: null });
    expect(asked).toBe(0);
  });
  it("has no suggestion when GitHub gives no login", async () => {
    const g = fakeGit();
    expect((await commitNameView({ gitConfig: g.gitConfig, ghUser: async () => { throw new Error("not logged in"); } })).suggest).toBeNull();
  });
});

describe("setCommitName", () => {
  it("sets the name and the e-mail on a new box", async () => {
    const g = fakeGit();
    expect(await setCommitName({ gitConfig: g.gitConfig, ghUser: ghUser() })).toEqual({ ok: true, wrote: ["name", "email"] });
    expect(g.writes).toEqual([["user.name", "Ada Lovelace"], ["user.email", "1234567+ada-dev@users.noreply.github.com"]]);
  });
  it("never changes a value that git has", async () => {
    const g = fakeGit({ "user.name": "Owner", "user.email": "owner@example.com" });
    expect(await setCommitName({ gitConfig: g.gitConfig, ghUser: ghUser() })).toEqual({ ok: true, wrote: [] });
    expect(g.writes).toEqual([]);
    expect(Object.fromEntries(g.cfg)).toEqual({ "user.name": "Owner", "user.email": "owner@example.com" });
  });
  it("sets only the key that has no value", async () => {
    const g = fakeGit({ "user.name": "Owner" });
    expect(await setCommitName({ gitConfig: g.gitConfig, ghUser: ghUser() })).toEqual({ ok: true, wrote: ["email"] });
    expect(g.cfg.get("user.name")).toBe("Owner");
    expect(g.writes).toEqual([["user.email", "1234567+ada-dev@users.noreply.github.com"]]);
  });
  it("keeps a value that came in between the read and the write", async () => {
    const g = fakeGit();
    let reads = 0;
    const gitConfig = async (args: string[]) => {
      // After the two reads of the view, somebody sets the name on the box.
      if (args[0] === "--get" && ++reads === 3) g.cfg.set("user.name", "Set By Hand");
      return g.gitConfig(args);
    };
    expect(await setCommitName({ gitConfig, ghUser: ghUser() })).toEqual({ ok: true, wrote: ["email"] });
    expect(g.cfg.get("user.name")).toBe("Set By Hand");
  });
  it("writes nothing when GitHub gives no login", async () => {
    const g = fakeGit();
    expect(await setCommitName({ gitConfig: g.gitConfig, ghUser: async () => { throw new Error("x"); } })).toEqual({ ok: false, reason: "no-login" });
    expect(g.writes).toEqual([]);
  });
});
