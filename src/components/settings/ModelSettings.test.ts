import { describe, expect, it } from "vitest";
import { modelStatus } from "./ModelSettings";

const read = (o: Partial<{ model: string; wrong: string | null }> = {}) =>
  ({ model: "opus", set: false, wrong: null, choices: ["fable", "opus", "sonnet", "haiku"], canSave: true, why: null, ...o });

describe("Settings > Model status line", () => {
  it("names the model of new agents, warns on a value that is not a model, and says when it cannot read", () => {
    expect(modelStatus(read())).toEqual({ tone: "ok", text: "New agents use Opus" });
    expect(modelStatus(read({ model: "haiku" }))).toEqual({ tone: "ok", text: "New agents use Haiku" });
    expect(modelStatus(read({ wrong: "gpt" }))).toEqual({ tone: "warn", text: "\"gpt\" is not a model: new agents use Opus" });
    expect(modelStatus({ error: "the console did not answer" }).tone).toBe("err");
    expect(modelStatus(null).tone).toBe("load");
  });
});
