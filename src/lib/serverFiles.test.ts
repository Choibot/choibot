import { describe, expect, it } from "vitest";
import { changedWord, childPath, crumbs, fetchContent, fetchList, fetchPrivate, nextSort, savePrivate, shownRows, type Entry } from "./serverFiles";

const res = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as never;

describe("the Files tab's data", () => {
  it("asks for the home folder with no path, and encodes a path", async () => {
    const urls: string[] = [];
    const fetch = (async (u: string) => { urls.push(u); return new Response("{}", { status: 200 }); }) as never;
    await fetchList(null, { fetch });
    await fetchList("/a b/c&d", { fetch });
    await fetchContent("/x/#y", { fetch });
    expect(urls).toEqual(["/api/server/files/list", "/api/server/files/list?path=%2Fa%20b%2Fc%26d", "/api/server/files/content?path=%2Fx%2F%23y"]);
  });

  it("gives the server's plain line for a refusal, and says when pairing is what is missing", async () => {
    expect(await fetchList("/x", { fetch: res(403, { error: "refused", why: "key", text: "Not shown: it holds a key or a login" }) }))
      .toEqual({ ok: false, refused: { pairing: false, text: "Not shown: it holds a key or a login" } });
    expect((await fetchList("/x", { fetch: res(403, { error: "needs-pairing", text: "Pair a device first." }) }))).toEqual({ ok: false, refused: { pairing: true, text: "Pair a device first." } });
    expect((await fetchList("/x", { fetch: res(403, { error: "pair-required" }) }) as { refused: { pairing: boolean } }).refused.pairing).toBe(true);
    expect(await fetchList("/x", { fetch: (async () => { throw new Error("offline"); }) as never })).toEqual({ ok: false, refused: { pairing: false, text: "Your server did not answer." } });
  });

  it("reads and sets the private places", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetch = (async (u: string, init?: RequestInit) => { calls.push([u, init]); return new Response(JSON.stringify({ places: ["/srv/x"], canChange: true }), { status: 200 }); }) as never;
    expect(await fetchPrivate({ fetch })).toEqual({ ok: true, value: { places: ["/srv/x"], canChange: true } });
    await savePrivate(["/srv/x", "/opt/y"], { fetch });
    expect(calls[1][0]).toBe("/api/server/files/private");
    expect(calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ places: ["/srv/x", "/opt/y"] }) });
    expect(await savePrivate(["/"], { fetch: res(400, { error: "bad-place", text: "\"/\" cannot be private." }) })).toEqual({ ok: false, refused: { pairing: false, text: "\"/\" cannot be private." } });
  });

  it("builds the path bar, with the home folder as one step", () => {
    expect(crumbs("/home/you/workspace/shop", "/home/you")).toEqual([
      { label: "Home", path: "/home/you" }, { label: "workspace", path: "/home/you/workspace" }, { label: "shop", path: "/home/you/workspace/shop" },
    ]);
    expect(crumbs("/home/you", "/home/you")).toEqual([{ label: "Home", path: "/home/you" }]);
    expect(crumbs("/etc/ssl", "/home/you")).toEqual([{ label: "/", path: "/" }, { label: "etc", path: "/etc" }, { label: "ssl", path: "/etc/ssl" }]);
    expect(crumbs("/", "/home/you")).toEqual([{ label: "/", path: "/" }]);
    expect(crumbs("/home/younger", "/home/you")[0]).toEqual({ label: "/", path: "/" });
    expect([childPath("/", "etc"), childPath("/etc", "ssl")]).toEqual(["/etc", "/etc/ssl"]);
  });

  it("filters by name and sorts; an entry with no size or date is at the end", () => {
    const items: Entry[] = [
      { name: "b.txt", kind: "file", size: 10, mtime: 300 }, { name: "A.txt", kind: "file", size: 500, mtime: 100 }, { name: "src", kind: "dir", mtime: 200, bytes: 9000 },
      { name: ".ssh", kind: "dir", locked: "key" }, { name: "file10", kind: "file", size: 1, mtime: 50 }, { name: "file9", kind: "file", size: 2, mtime: 60 },
    ];
    const names = (rows: Entry[]) => rows.map((r) => r.name);
    expect(names(shownRows(items, "", { key: "name", down: false }))).toEqual([".ssh", "src", "A.txt", "b.txt", "file9", "file10"]);
    expect(names(shownRows(items, "", { key: "size", down: true }))).toEqual(["src", "A.txt", "b.txt", "file9", "file10", ".ssh"]);
    expect(names(shownRows(items, "", { key: "size", down: false }))).toEqual(["file10", "file9", "b.txt", "A.txt", "src", ".ssh"]);
    expect(names(shownRows(items, "", { key: "changed", down: true }))).toEqual(["b.txt", "src", "A.txt", "file9", "file10", ".ssh"]);
    expect(names(shownRows(items, " TXT ", { key: "name", down: true }))).toEqual(["b.txt", "A.txt"]);
    expect([nextSort({ key: "name", down: false }, "name"), nextSort({ key: "name", down: false }, "size"), nextSort({ key: "size", down: true }, "name")])
      .toEqual([{ key: "name", down: true }, { key: "size", down: true }, { key: "name", down: false }]);
  });

  it("words the time of a change", () => {
    const now = new Date(2026, 10, 20, 15, 0).getTime();
    expect(changedWord(new Date(2026, 10, 20, 9, 5).getTime(), now)).toBe("Today 09:05");
    expect(changedWord(new Date(2026, 10, 3, 9, 5).getTime(), now)).toBe("3 Nov");
    expect(changedWord(new Date(2024, 0, 9).getTime(), now)).toBe("9 Jan 2024");
  });
});
