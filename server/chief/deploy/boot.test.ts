// server/chief/deploy/boot.test.ts — the checks that turn deploy on (boot.ts armedFor): a release
// and an archive install never get a deploy ticket; a git checkout goes on to the unit check, as
// before.
import { describe, expect, it } from "vitest";
import type { Armed } from "./config.js";
import { armedFor } from "./boot.js";

const UNIT = "choibot.service";
const on = { active: true };

describe("armedFor", () => {
  it("is off for a release and for an archive install, before any unit check", async () => {
    const own = async (): Promise<Armed> => { throw new Error("no unit check"); };
    expect(await armedFor(on, UNIT, false, { kind: "release", own })).toEqual({ ok: false, why: "this console runs a release: it gets new code from a release, not from git" });
    expect(await armedFor(on, UNIT, false, { kind: "archive", own })).toEqual({ ok: false, why: "this console was installed from an archive file: it has no git checkout" });
  });

  it("asks the unit check on a git checkout, as before", async () => {
    const asked: string[] = [];
    const own = async (u: string): Promise<Armed> => { asked.push(u); return { ok: true }; };
    expect(await armedFor(on, UNIT, false, { kind: "checkout", own })).toEqual({ ok: true });
    expect(asked).toEqual([UNIT]);
  });

  it("keeps its first two checks first", async () => {
    const own = async (): Promise<Armed> => ({ ok: true });
    expect(await armedFor({ active: false }, UNIT, false, { kind: "release", own })).toEqual({ ok: false, why: "the chief is misconfigured" });
    expect(await armedFor(on, UNIT, true, { kind: "archive", own })).toEqual({ ok: false, why: "this console is a dev server, not a production build" });
  });
});
