import { describe, it, expect } from "vitest";
import { RUNTIMES, runtimeLabel } from "./runtimes";

describe("runtimes", () => {
  it("lists claude first so it reads as the default", () => {
    expect(RUNTIMES[0].id).toBe("claude");
  });
  it("labels a known runtime", () => {
    expect(runtimeLabel("codex")).toBe("Codex");
  });
  it("labels an absent runtime as claude", () => {
    expect(runtimeLabel(undefined)).toBe("Claude");
  });
  it("falls back to the raw id for an unknown runtime", () => {
    expect(runtimeLabel("mystery")).toBe("mystery");
  });
});
