import { describe, expect, it } from "vitest";
import { envKey, envKeys, envRead, legacyMarkers, names, namesDecision, NEW_NAMES, OLD_NAMES, repoFoldersToRead, resolveNames } from "./names.mjs";

describe("one names table", () => {
  it("every install has these names", () => {
    expect(NEW_NAMES).toEqual({
      legacy: false,
      unit: "choibot.service",
      cronUnitPrefix: "choibot-cron-",
      dataDir: "choibot",
      configDir: "choibot",
      envPrefix: "CHOIBOT_",
      repoFolder: ".choibot",
      hooksFile: ".choibot-hooks.json",
      agentsFolder: ".choibot-agents",
      dtachPrefix: "choibot-",
      dtachDir: "choibot-dtach",
      cliEntry: "bin/choibot.ts",
    });
    expect(Object.isFrozen(NEW_NAMES)).toBe(true);
    expect(OLD_NAMES).toBe(NEW_NAMES);
  });

  it("no env and no file makes another table", () => {
    const all = (): boolean => true;
    expect(legacyMarkers({ HOME: "/home/u", CHOIBOT_AGENT_ID: "a1" }, all)).toEqual([]);
    for (const markers of [[], ["a"], ["a", "b"]]) expect(resolveNames(markers)).toBe(NEW_NAMES);
    expect(names()).toBe(NEW_NAMES);
    expect(namesDecision()).toEqual({ names: NEW_NAMES, markers: [] });
  });

  it("names() keeps its answer when the env changes", () => {
    const home = process.env.HOME;
    process.env.HOME = "/nonexistent-home";
    process.env.CHOIBOT_AGENT_ID = "late";
    try { expect(names()).toBe(NEW_NAMES); } finally { process.env.HOME = home; delete process.env.CHOIBOT_AGENT_ID; }
  });
});

describe("env keys", () => {
  it("one key for each name", () => {
    expect(envKey("AGENT_ID")).toBe("CHOIBOT_AGENT_ID");
    expect(envKey("WIDGET_DIR", NEW_NAMES)).toBe("CHOIBOT_WIDGET_DIR");
    expect(envKeys("USER_TOKEN")).toEqual(["CHOIBOT_USER_TOKEN"]);
  });

  it("reads the key", () => {
    expect(envRead({ CHOIBOT_AGENT_ID: "a1" }, "AGENT_ID")).toBe("a1");
    expect(envRead({}, "AGENT_ID")).toBeUndefined();
  });
});

describe("repoFoldersToRead", () => {
  it("one folder", () => {
    expect(repoFoldersToRead()).toEqual([".choibot"]);
  });
});
