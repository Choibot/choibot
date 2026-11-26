import { describe, expect, it } from "vitest";
import { latestRequest } from "./latest-request.js";

describe("latestRequest", () => {
  it("ignores an older response that arrives after the newest response", async () => {
    const resolvers: ((value: string) => void)[] = [];
    const accepted: string[] = [];
    const load = latestRequest(
      () => new Promise<string>((resolve) => { resolvers.push(resolve); }),
      (value) => { accepted.push(value); },
    );

    load();
    load();
    resolvers[1]("new");
    await Promise.resolve();
    resolvers[0]("old");
    await Promise.resolve();

    expect(accepted).toEqual(["new"]);
  });
});
