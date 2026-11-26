// server/gh/apprepos.test.ts — the repos that the ChoiBot app reaches, read from a fake GitHub
// API (testkit.ts): the token only in the Authorization header, no read at all with no token,
// a push only where the person may push AND the installation may write, GitHub's own settings
// pages only as the links to change the repos.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppReposError, listAppRepos } from "./apprepos.js";
import { FAKE_ACCESS, fakeGithub, type FakeGithub } from "./testkit.js";

let gh: FakeGithub;
beforeEach(async () => { gh = await fakeGithub(); });
afterEach(async () => { await gh.close(); });

const install = (id: number, login: string, contents: string, html = `https://github.com/settings/installations/${id}`) => ({
  id, account: { login, type: "User" }, html_url: html, repository_selection: "selected", permissions: { contents, metadata: "read" },
});
const repo = (full: string, o: { push?: boolean; pushed?: string; archived?: boolean } = {}) => ({
  full_name: full, private: true, archived: o.archived ?? false, language: "TypeScript", pushed_at: o.pushed ?? "2026-11-20T10:00:00Z", size: 1200,
  permissions: { admin: false, push: o.push ?? true, pull: true },
});

describe("listAppRepos", () => {
  it("reads nothing with no token", async () => {
    await expect(listAppRepos({ token: async () => null, api: gh.base })).rejects.toMatchObject({ why: "not-connected" });
    expect(gh.requests).toEqual([]);
  });

  it("lists the repos of each installation, newest push first, with the links to change them", async () => {
    gh.answer("/user/installations", { body: { total_count: 2, installations: [
      install(11, "ana", "write"),
      install(12, "acme", "read", "https://github.com/organizations/acme/settings/installations/12"),
    ] } });
    gh.answer("/user/installations/11/repositories", { body: { total_count: 2, repositories: [repo("ana/site", { pushed: "2026-11-01T00:00:00Z" }), repo("ana/old", { archived: true })] } });
    gh.answer("/user/installations/12/repositories", { body: { total_count: 1, repositories: [repo("acme/shop", { pushed: "2026-11-25T00:00:00Z" })] } });
    const r = await listAppRepos({ token: async () => FAKE_ACCESS, api: gh.base });
    expect(r.repos.map((x) => [x.slug, x.push, x.archived])).toEqual([
      // acme's installation may only read contents: no push there, whatever the person may do.
      ["acme/shop", false, false], ["ana/old", true, true], ["ana/site", true, false],
    ]);
    expect(r.manage).toEqual([
      { account: "ana", url: "https://github.com/settings/installations/11" },
      { account: "acme", url: "https://github.com/organizations/acme/settings/installations/12" },
    ]);
    expect(r.capped).toBe(false);
    for (const q of gh.requests) {
      expect(q.method).toBe("GET");
      expect(q.headers.authorization).toBe(`Bearer ${FAKE_ACCESS}`);
      expect(q.query).not.toContain(FAKE_ACCESS);
    }
  });

  it("follows the pages of an installation", async () => {
    gh.answer("/user/installations", { body: { installations: [install(11, "ana", "write")] } });
    const full = Array.from({ length: 100 }, (_, i) => repo(`ana/r${i}`));
    gh.answer("/user/installations/11/repositories", { body: { repositories: full } }, { body: { repositories: [repo("ana/last")] } });
    const r = await listAppRepos({ token: async () => FAKE_ACCESS, api: gh.base });
    expect(r.repos).toHaveLength(101);
    expect(gh.requests.filter((q) => q.path.endsWith("/repositories")).map((q) => q.query)).toEqual(["?per_page=100&page=1", "?per_page=100&page=2"]);
  });

  it("never gives a link that is not one of GitHub's settings pages", async () => {
    gh.answer("/user/installations", { body: { installations: [install(11, "ana", "write", "https://evil.example/settings/installations/11")] } });
    gh.answer("/user/installations/11/repositories", { body: { repositories: [] } });
    expect((await listAppRepos({ token: async () => FAKE_ACCESS, api: gh.base })).manage).toEqual([]);
  });

  it("says refused on a 401, and no-answer on a 5xx", async () => {
    gh.answer("/user/installations", { status: 401, body: { message: "Bad credentials" } });
    await expect(listAppRepos({ token: async () => FAKE_ACCESS, api: gh.base })).rejects.toBeInstanceOf(AppReposError);
    await expect(listAppRepos({ token: async () => FAKE_ACCESS, api: gh.base })).rejects.toMatchObject({ why: "refused" });
    gh.answer("/user/installations", { status: 502, body: { message: "x" } });
    await expect(listAppRepos({ token: async () => FAKE_ACCESS, api: gh.base })).rejects.toMatchObject({ why: "no-answer" });
  });
});
