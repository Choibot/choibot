import { describe, it, expect } from "vitest";
import { opsArgv } from "./steps.js";

describe("opsArgv", () => {
  it("status covers the console unit", () => {
    expect(opsArgv("status")).toEqual([
      ["systemctl", "--user", "status", "--no-pager", "-n", "0", "choibot"],
    ]);
  });
  it("logs defaults to console and follows", () => {
    expect(opsArgv("logs")).toEqual([["journalctl", "--user", "-u", "choibot", "-f", "-n", "100"]]);
  });
  it("restart defaults to the console unit", () => {
    expect(opsArgv("restart")).toEqual([["systemctl", "--user", "restart", "choibot"]]);
  });
  it("stop stops the console unit", () => {
    expect(opsArgv("stop")).toEqual([["systemctl", "--user", "stop", "choibot"]]);
  });
  it("rejects unknown targets", () => {
    expect(() => opsArgv("logs", "bogus")).toThrow(/unknown/);
    expect(() => opsArgv("status", "console")).toThrow(/unknown/);
    expect(() => opsArgv("stop", "console")).toThrow(/unknown/);
    // gate/tunnel are gone — a leftover habit must fail loudly, not half-apply.
    expect(() => opsArgv("logs", "gate")).toThrow(/unknown/);
    expect(() => opsArgv("restart", "tunnel")).toThrow(/unknown/);
  });
  it("restart accepts a single named unit", () => {
    expect(opsArgv("restart", "console")).toEqual([["systemctl", "--user", "restart", "choibot"]]);
  });
});
