import { describe, it, expect } from "vitest";
import { parseCli } from "./cli.js";

describe("parseCli", () => {
  it("parses a bare command", () => {
    expect(parseCli(["setup"])).toEqual({ command: "setup", target: undefined, rest: [], flags: {}, help: false });
  });
  it("parses logs with a target", () => {
    expect(parseCli(["logs", "gate"])).toEqual({ command: "logs", target: "gate", rest: [], flags: {}, help: false });
  });
  it("collects the words after the target into rest", () => {
    expect(parseCli(["cron", "rm", "x"])).toEqual({ command: "cron", target: "rm", rest: ["x"], flags: {}, help: false });
  });
  it("treats a bare `cron` as a command, not top-level help", () => {
    expect(parseCli(["cron"])).toEqual({ command: "cron", target: undefined, rest: [], flags: {}, help: false });
  });
  it("defaults to help when empty or flagged", () => {
    expect(parseCli([]).help).toBe(true);
    expect(parseCli(["--help"]).help).toBe(true);
    expect(parseCli(["setup", "--help"]).help).toBe(true);
  });
  it("takes a flag value out of the positionals", () => {
    expect(parseCli(["agents", "merge-pr", "id1", "--user-token", "T"])).toEqual({
      command: "agents", target: "merge-pr", rest: ["id1"], flags: { "user-token": "T" }, help: false });
  });
  it("treats a boolean flag as true and never eats the next word", () => {
    expect(parseCli(["brain", "distill", "--dry-run"])).toMatchObject({ rest: [], flags: { "dry-run": true } });
    expect(parseCli(["brain", "distill", "--dry-run", "x"])).toMatchObject({ rest: ["x"], flags: { "dry-run": true } });
  });
  it("parses --name value and --name=value", () => {
    expect(parseCli(["brain", "list", "--state", "active"]).flags).toEqual({ state: "active" });
    expect(parseCli(["brain", "list", "--state=all"]).flags).toEqual({ state: "all" });
  });
  it("mixes boolean and valued flags", () => {
    expect(parseCli(["queue", "list", "--open", "--area", "app-shop"])).toMatchObject({
      rest: [], flags: { open: true, area: "app-shop" } });
  });
  it("makes a non-boolean flag followed by a flag or nothing true", () => {
    expect(parseCli(["x", "y", "--state", "--open"]).flags).toEqual({ state: true, open: true });
    expect(parseCli(["x", "y", "--state"]).flags).toEqual({ state: true });
  });
  it("accepts a flag before the command", () => {
    expect(parseCli(["--agent", "a1", "brain", "list"])).toMatchObject({
      command: "brain", target: "list", rest: [], flags: { agent: "a1" } });
  });
  it("keeps '=' inside a --name=value value", () => {
    expect(parseCli(["x", "--q=a=b"]).flags).toEqual({ q: "a=b" });
  });
});
