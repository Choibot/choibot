import { describe, expect, it } from "vitest";
import { isAgentModel, settingModel, startModel } from "./model.js";

describe("the model of an agent's start", () => {
  it("the allow list: the four aliases only", () => {
    for (const m of ["fable", "opus", "sonnet", "haiku"]) expect(isAgentModel(m)).toBe(true);
    for (const m of ["", "Opus", "opusplan", "claude-opus-5-5", 1, null]) expect(isAgentModel(m)).toBe(false);
  });
  it("the setting: opus when not set or not a model; else its value", () => {
    expect(settingModel({})).toEqual({ model: "opus", wrong: null });
    expect(settingModel({ AGENT_MODEL: " haiku " })).toEqual({ model: "haiku", wrong: null });
    expect(settingModel({ AGENT_MODEL: "gpt" })).toEqual({ model: "opus", wrong: "gpt" });
  });
  it("a worker: its own model, else the setting, fresh or resumed", () => {
    const env = { AGENT_MODEL: "sonnet" };
    for (const fresh of [true, false]) {
      expect(startModel({ kind: undefined }, { fresh }, env)).toBe("sonnet");
      expect(startModel({ kind: "issue" }, { fresh }, env)).toBe("sonnet");
      expect(startModel({ model: "fable" }, { fresh }, env)).toBe("fable");
    }
    expect(startModel({}, { fresh: true }, {})).toBe("opus");
  });
  it("a lead or the fleet master: the setting on a fresh start; no flag on a resume (it keeps its model)", () => {
    for (const kind of ["lead", "fleet-master"]) {
      expect(startModel({ kind }, { fresh: true }, { AGENT_MODEL: "haiku" })).toBe("haiku");
      expect(startModel({ kind }, { fresh: false }, { AGENT_MODEL: "haiku" })).toBeUndefined();
    }
  });
  it("the Coordinator: never (its own fixed model)", () => {
    for (const fresh of [true, false]) expect(startModel({ kind: "coordinator" }, { fresh }, { AGENT_MODEL: "fable" })).toBeUndefined();
  });
});
