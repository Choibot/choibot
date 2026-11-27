import { describe, it, expect } from "vitest";
import { NO_MERGE_RULE, brainPrompt } from "../chief/brain/prompt.js";
import { queueAgentPrompt } from "../chief/queue/prompt.js";
import { remindAgentPrompt } from "../chief/remind/prompt.js";
import { buildClaudeArgs, SHARED_DOCS_PROMPT, ISSUE_AGENT_PROMPT, TOKEN_RULES, repoAgentPrompt, agentPrompt, clonePushPrompt, widgetsPrompt } from "./argv.js";

describe("SHARED_DOCS_PROMPT", () => {
  it("names the manifest and the self-contained artifact rule", () => {
    expect(SHARED_DOCS_PROMPT).toContain(".choibot/docs.json");
    expect(SHARED_DOCS_PROMPT).toContain("self-contained");
    expect(buildClaudeArgs({ systemPrompt: SHARED_DOCS_PROMPT }, {})).toContain("--append-system-prompt");
  });
});

describe("buildClaudeArgs", () => {
  it("always includes the autonomy flag", () => {
    expect(buildClaudeArgs({})).toContain("--dangerously-skip-permissions");
  });

  it("maps model, effort, and system prompt", () => {
    const a = buildClaudeArgs({ model: "claude-opus-4-8", effort: "high", systemPrompt: "Be terse." });
    expect(a).toEqual(expect.arrayContaining([
      "--model", "claude-opus-4-8",
      "--effort", "high",
      "--append-system-prompt", "Be terse.",
      "--dangerously-skip-permissions",
    ]));
  });

  it("omits model/effort/system-prompt when absent", () => {
    const a = buildClaudeArgs({});
    expect(a).not.toContain("--model");
    expect(a).not.toContain("--effort");
    expect(a).not.toContain("--append-system-prompt");
  });

  it("promptSnapshotOff pushes --system-prompt-snapshot off right after the autonomy flag", () => {
    const a = buildClaudeArgs({ model: "m" }, { promptSnapshotOff: true, settingsPath: "/tmp/h.json" });
    const i = a.indexOf("--dangerously-skip-permissions");
    expect(a[i + 1]).toBe("--system-prompt-snapshot");
    expect(a[i + 2]).toBe("off");
    expect(a[i + 3]).toBe("--settings");
    expect(buildClaudeArgs({}, { promptSnapshotOff: false })).not.toContain("--system-prompt-snapshot");
    expect(buildClaudeArgs({})).not.toContain("--system-prompt-snapshot");
  });

  it("adds --settings when a settings path is given", () => {
    const a = buildClaudeArgs({}, { settingsPath: "/tmp/h.json" });
    const i = a.indexOf("--settings");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(a[i + 1]).toBe("/tmp/h.json");
  });

  it("adds --resume <id> when resuming", () => {
    const a = buildClaudeArgs({}, { resume: "sess-1" });
    const i = a.indexOf("--resume");
    expect(a[i + 1]).toBe("sess-1");
  });

  it("puts the initial prompt LAST as a positional arg", () => {
    const a = buildClaudeArgs({ model: "opus" }, { prompt: "do the thing" });
    expect(a[a.length - 1]).toBe("do the thing");
  });

  it("omits the positional prompt when empty", () => {
    const a = buildClaudeArgs({}, { prompt: "" });
    expect(a[a.length - 1]).not.toBe("");
  });
});

describe("repoAgentPrompt", () => {
  it("is the shared-docs prompt for a normal agent", () => {
    expect(repoAgentPrompt(undefined)).toBe(SHARED_DOCS_PROMPT);
  });
  it("appends the issue prompt after the shared-docs prompt for an issue agent", () => {
    expect(repoAgentPrompt("issue")).toBe(`${SHARED_DOCS_PROMPT}\n\n${ISSUE_AGENT_PROMPT}`);
    expect(ISSUE_AGENT_PROMPT).toContain("Never use the AskUserQuestion tool");
  });
});

describe("widgetsPrompt", () => {
  it("names the folder, the files, the script contract, the API and the MCP rule", () => {
    const p = widgetsPrompt("/data/widgets/a1");
    for (const part of [
      "Console widgets:", "/data/widgets/a1/", "widget.html", "meta.json", "refresh", "actions/<name>",
      "data.json", "stdin", "30 s", "CHOIBOT_WIDGET_DIR", "choibot.refresh", "choibot.ask", "choibot.setState",
      "choibot.setAutoRefresh", "choibot:data", "MCP", "[widget <id>] Refresh", "watch or track",
      "starting with a letter or digit", "red dot", "min 30", "choibot.history", '{mode:"agent"}', "cancelled", "⟳",
      "The frame is sandboxed: localStorage and popups do not work; use choibot.setState for state.",
    ]) expect(p).toContain(part);
  });
});

describe("agentPrompt", () => {
  const root = "/data/widgets";
  const tail = (id: string) => widgetsPrompt(`/data/widgets/${id}`);
  it("repo agent: docs prompt, then the widgets prompt for its own folder", () => {
    expect(agentPrompt({ id: "a1", repo: "/r" }, root)).toBe(`${SHARED_DOCS_PROMPT}\n\n${tail("a1")}`);
  });
  it("issue agent: docs, issue, then widgets", () => {
    expect(agentPrompt({ id: "i1", repo: "/r", kind: "issue" }, root))
      .toBe(`${SHARED_DOCS_PROMPT}\n\n${ISSUE_AGENT_PROMPT}\n\n${tail("i1")}`);
  });
  it("workspace agent: widgets only", () => {
    expect(agentPrompt({ id: "w1", repo: "" }, root)).toBe(tail("w1"));
  });
  it("with chief: widgets (no Docs text), the token rules, NO_MERGE_RULE, then the queue paragraph, for worker, issue and workspace", () => {
    for (const rec of [{ id: "a1", repo: "/r" }, { id: "i1", repo: "/r", kind: "issue" }, { id: "w1", repo: "" }]) {
      const withChief = agentPrompt(rec, root, { brain: "", cli: "C" });
      expect(withChief).toBe(`${tail(rec.id)}\n\n${TOKEN_RULES}\n\n${NO_MERGE_RULE}\n\n${queueAgentPrompt("C")}\n\n${remindAgentPrompt("C")}`);
      expect(withChief).not.toContain(ISSUE_AGENT_PROMPT);
      expect(withChief).not.toContain(SHARED_DOCS_PROMPT);
      expect(withChief.indexOf("queue withdraw")).toBeGreaterThan(withChief.indexOf(NO_MERGE_RULE));
      expect(withChief).toContain('{"pr": {"branch": "<your branch>"}}');
      expect(withChief).toContain(".choibot/previews/<topic>-<n>.png");
    }
  });
  it("the token rules: four lines under one heading, each one line", () => {
    const lines = TOKEN_RULES.split("\n");
    expect(lines[0]).toBe("## Token use");
    expect(lines.slice(1)).toHaveLength(4);
    for (const l of lines.slice(1)) expect(l.startsWith("- ")).toBe(true);
    expect(TOKEN_RULES).toContain('"haiku" or "sonnet"');
  });
  it("with a brain: brainPrompt follows NO_MERGE_RULE", () => {
    const rec = { id: "a1", repo: "/r" };
    const out = agentPrompt(rec, root, { brain: "## Always\n- x [r_1]", cli: "C" });
    expect(out).toBe(`${tail("a1")}\n\n${TOKEN_RULES}\n\n${NO_MERGE_RULE}\n\n${queueAgentPrompt("C")}\n\n${remindAgentPrompt("C")}\n\n${brainPrompt("## Always\n- x [r_1]")}`);
  });
});

describe("agentPrompt of an agent with its own copy (strong protection, part 3)", () => {
  const chief = { brain: "", cli: "pnpm choibot" };
  it("says that git push and gh have no login, and names agents pr and fetch-base with its base", () => {
    const p = agentPrompt({ id: "a1", repo: "/srv/w/r", clone: true, baseBranch: "develop" }, "/w", chief);
    expect(p).toContain(clonePushPrompt("pnpm choibot", "develop"));
    expect(p).toContain("`pnpm choibot agents pr`");
    expect(p).toContain("`git fetch console && git merge console/develop`");
  });
  it("another agent's prompt is unchanged", () => {
    const a = agentPrompt({ id: "a1", repo: "/srv/w/r", baseBranch: "develop" }, "/w", chief);
    expect(a).not.toContain("agents pr");
    expect(agentPrompt({ id: "a1", repo: "/srv/w/r", clone: false }, "/w", chief)).toBe(a);
  });
});
