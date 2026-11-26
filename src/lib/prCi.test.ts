import { describe, expect, it } from "vitest";
import type { PrCi } from "./gh";
import { CI_KEEP_MS, checkRows, checksHref, ciReadPlan, previewLinks, webUrl } from "./prCi";

const run = (name: string, status: "passed" | "failed" | "pending", url: string) => ({ name, status, url, durationMs: 1000 });
const ci = (p: Partial<PrCi>): PrCi => ({ checkRuns: [], deployments: [], logs: [], ...p });

describe("webUrl", () => {
  it("keeps http(s) URLs only", () => {
    expect(webUrl("https://vercel.com/a")).toBe("https://vercel.com/a");
    expect(webUrl("http://x.test/")).toBe("http://x.test/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "vercel.app", "", undefined]) expect(webUrl(bad)).toBeNull();
  });
});

describe("checksHref", () => {
  it("is the PR's checks page while nothing failed or nothing is loaded", () => {
    expect(checksHref("example-org/app-shop", 463, null)).toBe("https://github.com/example-org/app-shop/pull/463/checks");
    expect(checksHref("o/r", 5, ci({ checkRuns: [run("build", "passed", "https://ci.test/1")] }))).toBe("https://github.com/o/r/pull/5/checks");
  });
  it("is the first failed check run that has an http(s) url", () => {
    const c = ci({ checkRuns: [run("lint", "passed", "https://ci.test/1"), run("b-test", "failed", "https://ci.test/2"), run("a-evil", "failed", "javascript:alert(1)")] });
    expect(checksHref("o/r", 5, c)).toBe("https://ci.test/2");
  });
  it("gives no link without a GitHub slug", () => {
    expect(checksHref(undefined, 5, null)).toBeNull();
  });
});

describe("checkRows", () => {
  it("lists failed first and links only an http(s) url", () => {
    const rows = checkRows(ci({ checkRuns: [run("ok", "passed", "https://ci.test/1"), run("bad", "failed", "javascript:x")] }));
    expect(rows.map((r) => [r.name, r.href])).toEqual([["bad", null], ["ok", "https://ci.test/1"]]);
  });
});

describe("previewLinks", () => {
  it("names each link by its environment, the preview one first", () => {
    const c = ci({ deployments: [
      { environment: "Production", state: "success", url: "https://prod.test/" },
      { environment: "Preview", state: "success", url: "https://dapp-abc.vercel.app" },
    ] });
    expect(previewLinks(c)).toEqual([
      { label: "Preview", url: "https://dapp-abc.vercel.app/" },
      { label: "Production", url: "https://prod.test/" },
    ]);
  });
  it("drops a deployment whose url is not http(s), and names a nameless one Preview", () => {
    const c = ci({ deployments: [
      { environment: "Preview", state: "success", url: "javascript:alert(1)" },
      { environment: " ", state: "success", url: "https://x.test/" },
    ] });
    expect(previewLinks(c)).toEqual([{ label: "Preview", url: "https://x.test/" }]);
    expect(previewLinks(null)).toEqual([]);
  });
});

describe("ciReadPlan", () => {
  it("reads once, keeps the read for a minute, and reads again after it", () => {
    expect(ciReadPlan(undefined, "pending", 0)).toBe("read");
    expect(ciReadPlan({ at: 0, checks: "success" }, "success", CI_KEEP_MS - 1)).toBe("keep");
    expect(ciReadPlan({ at: 0, checks: "success" }, "success", CI_KEEP_MS)).toBe("read");
  });
  it("reads past the server's cache when the rollup word changed", () => {
    expect(ciReadPlan({ at: 0, checks: "pending" }, "success", 1000)).toBe("fresh");
  });
});
