import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, stat, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildCodexArgs, codexRuntime } from "./codex.js";
import type { AgentRecord } from "../store.js";

const rec = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "id-1", label: "l", repo: "/r", worktree: "/w", branch: "b", baseBranch: "m",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, runtime: "codex", ...over,
});

const planRec = (transcriptPath: string, over: Partial<AgentRecord> = {}): AgentRecord => ({
  ...rec(),
  worktree: dirname(dirname(dirname(dirname(transcriptPath)))),
  transcriptPath,
  ...over,
});

describe("buildCodexArgs", () => {
  it("puts the working dir and bypass flags on a fresh session", () => {
    expect(buildCodexArgs({}, { cwd: "/w" })).toEqual([
      "-C", "/w",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
    ]);
  });

  it("appends a non-empty prompt as the trailing positional", () => {
    expect(buildCodexArgs({}, { cwd: "/w", prompt: "do it" })).toEqual([
      "-C", "/w",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "do it",
    ]);
  });

  it("ignores a blank prompt", () => {
    expect(buildCodexArgs({}, { cwd: "/w", prompt: "   " })).toEqual([
      "-C", "/w",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
    ]);
  });

  it("leads with the resume subcommand and its session id", () => {
    expect(buildCodexArgs({}, { cwd: "/w", resume: "sess-9" })).toEqual([
      "resume", "sess-9",
      "-C", "/w",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
    ]);
  });

  it("carries a prompt through a resume", () => {
    expect(buildCodexArgs({}, { cwd: "/w", resume: "sess-9", prompt: "go" })).toEqual([
      "resume", "sess-9",
      "-C", "/w",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "go",
    ]);
  });

  it("passes a model preset through", () => {
    expect(buildCodexArgs({ model: "gpt-5.2" }, { cwd: "/w" })).toEqual([
      "-C", "/w",
      "--model", "gpt-5.2",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
    ]);
  });

  it("does not accept claude flags", () => {
    const args = buildCodexArgs({ systemPrompt: "S" }, { cwd: "/w", settingsPath: "/s.json" });
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--settings");
  });

  it("always carries the hook-trust bypass, without which hooks silently never fire", () => {
    expect(buildCodexArgs({}, { cwd: "/w" })).toContain("--dangerously-bypass-hook-trust");
    expect(buildCodexArgs({}, { cwd: "/w", resume: "s1" })).toContain("--dangerously-bypass-hook-trust");
  });
});

describe("codex hookToStatus", () => {
  it("captures the session id on SessionStart without going running", () => {
    expect(codexRuntime.hookToStatus({ hook_event_name: "SessionStart", session_id: "s1" }))
      .toEqual({ sessionId: "s1" });
  });
  it("goes running on UserPromptSubmit", () => {
    expect(codexRuntime.hookToStatus({ hook_event_name: "UserPromptSubmit", session_id: "s1" }))
      .toEqual({ status: "running", sessionId: "s1" });
  });
  it("goes idle on Stop", () => {
    expect(codexRuntime.hookToStatus({ hook_event_name: "Stop", session_id: "s1" }))
      .toEqual({ status: "idle", sessionId: "s1" });
  });
  it("drops a path-shaped session id", () => {
    expect(codexRuntime.hookToStatus({ hook_event_name: "SessionStart", session_id: "../etc" }))
      .toEqual({});
  });
});

describe("codex hookToStatus captures the transcript path", () => {
  it("returns transcript_path so the record can store it", () => {
    expect(codexRuntime.hookToStatus({
      hook_event_name: "SessionStart", session_id: "s1",
      transcript_path: "/home/u/.codex/sessions/2026/08/13/rollout-x-s1.jsonl",
    })).toEqual({
      sessionId: "s1",
      transcriptPath: "/home/u/.codex/sessions/2026/08/13/rollout-x-s1.jsonl",
    });
  });
  it("ignores a relative transcript path", () => {
    expect(codexRuntime.hookToStatus({
      hook_event_name: "SessionStart", session_id: "s1", transcript_path: "../escape.jsonl",
    })).toEqual({ sessionId: "s1" });
  });
  // The stored path is later opened and its contents parsed into the rail, so an
  // absolute path is a floor, not the whole check: /proc/self/environ and
  // /dev/urandom are absolute too.
  it("ignores an absolute path that is not a rollout file", () => {
    for (const p of ["/proc/self/environ", "/dev/urandom", "/etc/shadow", "/home/u/.codex/sessions"]) {
      expect(codexRuntime.hookToStatus({
        hook_event_name: "SessionStart", session_id: "s1", transcript_path: p,
      })).toEqual({ sessionId: "s1" });
    }
  });
  it("ignores a NUL-bearing or absurdly long path", () => {
    expect(codexRuntime.hookToStatus({
      hook_event_name: "SessionStart", session_id: "s1", transcript_path: "/a/\0b.jsonl",
    })).toEqual({ sessionId: "s1" });
    expect(codexRuntime.hookToStatus({
      hook_event_name: "SessionStart", session_id: "s1",
      transcript_path: `/${"a".repeat(5000)}.jsonl`,
    })).toEqual({ sessionId: "s1" });
  });
  it("ignores a non-string transcript path", () => {
    expect(codexRuntime.hookToStatus({
      hook_event_name: "SessionStart", session_id: "s1",
      transcript_path: { toString: () => "/x.jsonl" } as unknown as string,
    })).toEqual({ sessionId: "s1" });
  });
  it("does not attach a transcript path to an unknown event", () => {
    expect(codexRuntime.hookToStatus({
      hook_event_name: "PreToolUse", session_id: "s1", transcript_path: "/a/rollout-x.jsonl",
    })).toEqual({});
  });
});

describe("codex canResume", () => {
  it("is false without a session id", async () => {
    expect(await codexRuntime.canResume(rec(), "/w")).toBe(false);
  });

  it("is false without a recorded transcript path", async () => {
    expect(await codexRuntime.canResume(rec({ sessionId: "s9" }), "/w")).toBe(false);
  });

  it("is true when the recorded rollout still exists", async () => {
    const base = await mkdtemp(join(tmpdir(), "cxres-"));
    const sessions = join(base, ".choibot", "codex-home", "sessions");
    await mkdir(sessions, { recursive: true });
    const roll = join(sessions, "rollout-x-s9.jsonl");
    await writeFile(roll, "{}\n");
    expect(await codexRuntime.canResume(planRec(roll, { sessionId: "s9" }), base)).toBe(true);
    await rm(base, { recursive: true, force: true });
  });

  it("is false when the recorded rollout is gone", async () => {
    const base = await mkdtemp(join(tmpdir(), "cxres-gone-"));
    const sessions = join(base, ".choibot", "codex-home", "sessions");
    await mkdir(sessions, { recursive: true });
    const gone = join(sessions, "rollout-x-s9.jsonl");
    expect(await codexRuntime.canResume(planRec(gone, { sessionId: "s9" }), base)).toBe(false);
    await rm(base, { recursive: true, force: true });
  });

  it("is false when the recorded path is a directory, not a file", async () => {
    const base = await mkdtemp(join(tmpdir(), "cxres-dir-"));
    const roll = join(base, ".choibot", "codex-home", "sessions", "rollout.jsonl");
    await mkdir(roll, { recursive: true });
    expect(await codexRuntime.canResume(planRec(roll, { sessionId: "s9" }), base)).toBe(false);
    await rm(base, { recursive: true, force: true });
  });
});

const planLine = (steps: { step: string; status: string }[]) =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: steps }) },
  }) + "\n";

describe("codex readPlan", () => {
  const dirs: string[] = [];
  const tmp = async (tag: string) => {
    const d = await mkdtemp(join(tmpdir(), `cxplan-${tag}-`));
    dirs.push(d);
    const sessions = join(d, ".choibot", "codex-home", "sessions");
    await mkdir(sessions, { recursive: true });
    return sessions;
  };
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("is empty with no recorded rollout path", async () => {
    expect(await codexRuntime.readPlan(rec())).toEqual([]);
  });

  it("is empty when the rollout is gone", async () => {
    const base = await tmp("gone");
    expect(await codexRuntime.readPlan(planRec(join(base, "rollout-x.jsonl")))).toEqual([]);
  });

  it("reads the current plan out of the rollout", async () => {
    const base = await tmp("ok");
    const roll = join(base, "rollout-x.jsonl");
    await writeFile(roll, planLine([{ step: "old", status: "pending" }]) +
      planLine([{ step: "a", status: "completed" }, { step: "b", status: "in_progress" }]));
    expect(await codexRuntime.readPlan(planRec(roll))).toEqual([
      { id: "1", subject: "a", status: "completed" },
      { id: "2", subject: "b", status: "in_progress" },
    ]);
  });

  it("is empty for a rollout that has no plan yet", async () => {
    const base = await tmp("noplan");
    const roll = join(base, "rollout-x.jsonl");
    await writeFile(roll, JSON.stringify({ type: "session_meta", payload: { id: "s" } }) + "\n");
    expect(await codexRuntime.readPlan(planRec(roll))).toEqual([]);
  });

  it("rejects a rollout outside this agent's Codex session directory", async () => {
    const sessions = await tmp("outside");
    const outside = join(dirname(dirname(dirname(sessions))), "outside.jsonl");
    await writeFile(outside, planLine([{ step: "secret", status: "pending" }]));
    expect(await codexRuntime.readPlan(planRec(outside, {
      worktree: dirname(dirname(dirname(dirname(sessions)))),
    }))).toEqual([]);
  });

  it("rejects a rollout symlink", async () => {
    const sessions = await tmp("symlink");
    const target = join(sessions, "target.jsonl");
    const alias = join(sessions, "alias.jsonl");
    await writeFile(target, planLine([{ step: "hidden", status: "pending" }]));
    await symlink(target, alias);
    expect(await codexRuntime.readPlan(planRec(alias))).toEqual([]);
  });

  // The three hardening cases. `.jsonl` vets a NAME; these vet the target.
  it("is empty for a directory wearing a .jsonl name", async () => {
    const base = await tmp("dir");
    const roll = join(base, "rollout-x.jsonl");
    await mkdir(roll);
    expect(await codexRuntime.readPlan(planRec(roll))).toEqual([]);
  });

  it("does not hang on a FIFO wearing a .jsonl name", async () => {
    const base = await tmp("fifo");
    const roll = join(base, "rollout-x.jsonl");
    execFileSync("mkfifo", [roll]);
    // No writer will ever open this: a blocking open() would never return, so
    // the assertion below only completes because readPlan refuses to block.
    expect(await codexRuntime.readPlan(planRec(roll))).toEqual([]);
  }, 5000);

  it("reads only the tail of an oversized rollout", async () => {
    const base = await tmp("big");
    const roll = join(base, "rollout-x.jsonl");
    const filler = JSON.stringify({ type: "event_msg", payload: { type: "token_count", pad: "x".repeat(4000) } }) + "\n";
    await writeFile(roll,
      planLine([{ step: "stale", status: "pending" }]) +
      filler.repeat(300) +                                   // ~1.2 MB, over the cap
      planLine([{ step: "current", status: "in_progress" }]));
    const st = await stat(roll);
    expect(st.size).toBeGreaterThan(1024 * 1024);
    // The stale plan sits before the window and is correctly invisible.
    expect(await codexRuntime.readPlan(planRec(roll))).toEqual([
      { id: "1", subject: "current", status: "in_progress" },
    ]);
  });

  // The nasty one: the truncation point lands EXACTLY on a newline, so the
  // first record inside the window is already complete. Dropping it as if it
  // were partial loses the plan outright.
  it("keeps a complete first record when the tail window opens on a boundary", async () => {
    const base = await tmp("boundary");
    const roll = join(base, "rollout-x.jsonl");
    const MAX = 1024 * 1024; // MAX_PLAN_BYTES
    const plan = planLine([{ step: "current", status: "in_progress" }]);
    // Pad the window out to exactly MAX bytes (all ASCII, so chars === bytes),
    // then put a whole line in front of it. The window therefore opens on the
    // first byte of `plan`, and the byte before it is the head's newline.
    const pre = '{"type":"event_msg","payload":{"type":"token_count","pad":"';
    const post = '"}}\n';
    const pad = pre + "z".repeat(MAX - plan.length - pre.length - post.length) + post;
    const tail = plan + pad;
    expect(tail.length).toBe(MAX);
    const head = planLine([{ step: "stale", status: "pending" }]);
    await writeFile(roll, head + tail);
    expect((await stat(roll)).size).toBe(head.length + MAX);
    expect(await codexRuntime.readPlan(planRec(roll))).toEqual([
      { id: "1", subject: "current", status: "in_progress" },
    ]);
  });

  it("keeps line one when the file is exactly at the cap", async () => {
    const base = await tmp("atcap");
    const roll = join(base, "rollout-x.jsonl");
    const MAX = 1024 * 1024;
    const plan = planLine([{ step: "current", status: "completed" }]);
    const pre = '{"type":"event_msg","payload":{"type":"token_count","pad":"';
    const post = '"}}\n';
    const body = plan + pre + "z".repeat(MAX - plan.length - pre.length - post.length) + post;
    expect(body.length).toBe(MAX);
    await writeFile(roll, body);
    expect(await codexRuntime.readPlan(planRec(roll))).toEqual([
      { id: "1", subject: "current", status: "completed" },
    ]);
  });

  it("still finds the plan when the tail window starts mid-record", async () => {
    const base = await tmp("mid");
    const roll = join(base, "rollout-x.jsonl");
    const plan = planLine([{ step: "current", status: "completed" }]);
    // Pad so the 1 MB window opens partway through a very long line.
    const huge = JSON.stringify({ type: "event_msg", payload: { pad: "y".repeat(1_100_000) } }) + "\n";
    await writeFile(roll, huge + plan);
    expect(await codexRuntime.readPlan(planRec(roll))).toEqual([
      { id: "1", subject: "current", status: "completed" },
    ]);
  });
});

// Ruling 2c-7-a: the codex home is built by path in the agent-writable
// worktree, and the agent uid could not read it (console-owned 0700) anyway.
// A hardened deployment refuses a codex launch before any write.
describe("codex prepare, hardened", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("refuses with a clear error and writes nothing", async () => {
    for (const [k, v] of Object.entries({
      CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
    })) vi.stubEnv(k, v);
    const wt = await mkdtemp(join(tmpdir(), "codex-wt-"));
    try {
      const r = {
        id: "c1", label: "", repo: "/ws/app", worktree: wt, cwd: wt, branch: "", baseBranch: "",
        sessionId: null, hookToken: "t", status: "idle", createdAt: 1, runtime: "codex",
      } as AgentRecord;
      await expect(codexRuntime.prepare(r, { port: 3999, workspaceDir: "/ws-unused" })).rejects.toThrow(/hardened deployment/);
      await expect(stat(join(wt, ".choibot"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });
});
