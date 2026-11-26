import { describe, it, expect } from "vitest";
import { buildHookSettings, hookToStatus } from "./hooks.js";

describe("buildHookSettings", () => {
  it("registers SessionStart/UserPromptSubmit/Stop/Notification hooks that POST to the token-gated endpoint", () => {
    const s = buildHookSettings({ agentId: "a1", token: "secret", port: 3000 });
    expect(Object.keys(s.hooks).sort()).toEqual(["Notification", "SessionStart", "Stop", "UserPromptSubmit"]);
    const cmd = s.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("127.0.0.1:3000/api/agents/a1/hook");
    expect(cmd).toContain("token=secret");
    expect(cmd).toContain("curl");
    expect(cmd).toContain("@-"); // pipes stdin payload as the body
  });
});

describe("hookToStatus", () => {
  it("SessionStart only captures the session id — a fresh session is not 'running'", () => {
    // SessionStart fires when the claude process launches, before any prompt.
    // It must NOT mark the agent running; it only carries the session id.
    expect(hookToStatus({ hook_event_name: "SessionStart", session_id: "sess-1", source: "startup" }))
      .toEqual({ sessionId: "sess-1" });
  });
  it("UserPromptSubmit marks running (work has started)", () => {
    expect(hookToStatus({ hook_event_name: "UserPromptSubmit", session_id: "sess-1" }))
      .toEqual({ status: "running", sessionId: "sess-1" });
  });
  it("Stop marks idle (waiting on you)", () => {
    expect(hookToStatus({ hook_event_name: "Stop", session_id: "sess-1" }))
      .toEqual({ status: "idle", sessionId: "sess-1" });
  });
  it("Notification marks idle", () => {
    expect(hookToStatus({ hook_event_name: "Notification", session_id: "sess-1" }))
      .toEqual({ status: "idle", sessionId: "sess-1" });
  });
  it("unknown event yields nothing actionable", () => {
    expect(hookToStatus({ hook_event_name: "PreToolUse" })).toEqual({});
  });
});

describe("hookToStatus session-id validation", () => {
  it("drops session ids that are not plain filename-shaped (path-segment safety)", () => {
    expect(hookToStatus({ hook_event_name: "SessionStart", session_id: "../../etc" })).toEqual({});
    expect(hookToStatus({ hook_event_name: "UserPromptSubmit", session_id: "a/b" }))
      .toEqual({ status: "running" });
    expect(hookToStatus({ hook_event_name: "Stop", session_id: "" })).toEqual({ status: "idle" });
    expect(hookToStatus({ hook_event_name: "SessionStart", session_id: ".." })).toEqual({});
    expect(hookToStatus({ hook_event_name: "SessionStart", session_id: "." })).toEqual({});
  });
  it("keeps normal uuid-shaped ids", () => {
    expect(hookToStatus({ hook_event_name: "SessionStart", session_id: "a3d5edfd-3bcf-438f-acc7-15f4da72da81" }))
      .toEqual({ sessionId: "a3d5edfd-3bcf-438f-acc7-15f4da72da81" });
  });
});
