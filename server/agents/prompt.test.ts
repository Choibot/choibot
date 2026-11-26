import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectPrompt, isPromptKey, promptKeySeq, promptRev, PROMPT_KEYS, type Prompt } from "./prompt.js";

// Real screens of Claude Code 2.1.322 at 120×30, captured from a scratch PTY
// (see testdata/screens/README.md). One row per line.
const fixture = (name: string): string[] =>
  readFileSync(fileURLToPath(new URL(`./testdata/screens/${name}.txt`, import.meta.url)), "utf8").replace(/\n$/, "").split("\n");
const detect = (name: string, status?: "running" | "idle" | "done" | "error"): Prompt | null =>
  detectPrompt({ lines: fixture(name) }, { status });
const screen = (text: string): { lines: string[] } => ({ lines: text.replace(/^\n/, "").split("\n") });

describe("detectPrompt: real dialogs", () => {
  it("folder trust: question, folder and both options, with the keys from the shown selection", () => {
    const p = detect("trust-2.1.322")!;
    expect(p.kind).toBe("folder-trust");
    expect(p.question).toBe("Is this a project you created or one you trust?");
    // The path wraps on screen; it comes back as one path.
    expect(p.detail).toMatch(/^\/tmp\/claude-1000\/.*\/scratchpad\/untrusted-uE94$/);
    expect(p.detail).not.toMatch(/\s/);
    // "No, exit" is first and selected: Enter alone would exit.
    expect(p.options).toEqual([
      { label: "No, exit", keys: ["enter"] },
      { label: "Yes, I trust this folder", keys: ["down", "enter"] },
    ]);
    expect(p.selected).toBe(0);
    expect(p.screenText.split("\n")[0]).toMatch(/^─+$/);
    expect(p.screenText).toContain("Enter to confirm · Esc to cancel");
  });

  it("login method: three numbered options", () => {
    const p = detect("login-2.1.322")!;
    expect(p.kind).toBe("login-method");
    expect(p.question).toBe("Select login method:");
    expect(p.options.map((o) => o.label)).toEqual([
      "Claude account with subscription · Individual, Team, or Enterprise",
      "Anthropic Console account · API usage billing",
      "3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI",
    ]);
    expect(p.selected).toBe(0);
    expect(p.options.map((o) => o.keys)).toEqual([["enter"], ["down", "enter"], ["down", "down", "enter"]]);
  });

  it("login method with the second option selected: keys go up and down from there", () => {
    const p = detect("login-second-2.1.322")!;
    expect(p.selected).toBe(1);
    expect(p.options.map((o) => o.keys)).toEqual([["up", "enter"], ["enter"], ["down", "enter"]]);
  });

  it("permission dialog: a numbered picker with the command as detail and a wrapped option joined", () => {
    const p = detect("permission-2.1.322")!;
    expect(p.kind).toBe("picker");
    expect(p.question).toBe("Do you want to proceed?");
    expect(p.detail).toContain("Bash command");
    expect(p.detail).toContain("touch hello.txt");
    expect(p.detail).not.toMatch(/╌/);
    expect(p.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and always allow access to /home/dev/workspace/choibot/.agent-worktrees/agent-01b20a50/.e2e-tmp/idle from this project",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "No",
    ]);
    expect(p.selected).toBe(0);
    expect(p.options[3].keys).toEqual(["down", "down", "down", "enter"]);
  });

  it("permission dialog after Down: the selection and the keys follow", () => {
    const p = detect("permission-moved-2.1.322")!;
    expect(p.selected).toBe(1);
    expect(p.options.map((o) => o.keys)).toEqual([["up", "enter"], ["enter"], ["down", "enter"], ["down", "down", "enter"]]);
  });

  it("theme picker: a list with no numbers is unknown, with the screen text", () => {
    for (const name of ["theme-2.1.322", "theme-moved-2.1.322"]) {
      const p = detect(name)!;
      expect(p.kind).toBe("unknown");
      expect(p.options).toEqual([]);
      expect(p.selected).toBeNull();
      expect(p.screenText).toContain("Choose the text style that looks best with your terminal");
    }
  });

  it("/model picker: the numbered rows only", () => {
    const p = detect("model-picker-2.1.322")!;
    expect(p.kind).toBe("picker");
    expect(p.options).toHaveLength(5);
    expect(p.options[0].label).toBe("Default (recommended) Fable 5.2");
    expect(p.selected).toBe(4);
    expect(p.options[0].keys).toEqual(["up", "up", "up", "up", "enter"]);
  });
});

describe("detectPrompt: real screens that are not a prompt", () => {
  it.each([
    ["the empty input box", "idle-input-2.1.322"],
    ["a running spinner", "running-2.1.322"],
    ["the input box after a turn", "idle-after-turn-2.1.322"],
    ["a numbered list typed in the input box", "typed-list-in-input-2.1.322"],
    ["the slash command menu over the input box", "slash-menu-2.1.322"],
  ])("%s", (_what, name) => {
    expect(detect(name)).toBeNull();
  });

  it("a stopped agent has no prompt, whatever its last screen shows", () => {
    expect(detect("trust-2.1.322", "done")).toBeNull();
    expect(detect("trust-2.1.322", "error")).toBeNull();
    expect(detect("trust-2.1.322", "idle")?.kind).toBe("folder-trust");
    expect(detect("trust-2.1.322", "running")?.kind).toBe("folder-trust");
  });
});

// Shapes with no real capture: older boxed dialogs and edge cases.
describe("detectPrompt: synthetic screens", () => {
  it("an empty screen and a banner alone are not a prompt", () => {
    expect(detectPrompt({ lines: [] })).toBeNull();
    expect(detectPrompt({ lines: ["", "   ", ""] })).toBeNull();
    expect(detectPrompt(screen(`
 ▐▛███▛█   Claude Code v2.1.322
▝▜██████▀  Fable 5.2 · Claude Max
`))).toBeNull();
  });

  it("an old boxed permission dialog", () => {
    const p = detectPrompt(screen(`
● Bash(rm -rf build)

╭──────────────────────────────────────────────────────────────╮
│ Bash command                                                 │
│                                                              │
│   rm -rf build                                               │
│                                                              │
│ Do you want to proceed?                                      │
│ ❯ 1. Yes                                                     │
│   2. Yes, and don't ask again for rm commands                │
│   3. No, and tell Claude what to do differently (esc)        │
╰──────────────────────────────────────────────────────────────╯
`))!;
    expect(p.kind).toBe("picker");
    expect(p.question).toBe("Do you want to proceed?");
    expect(p.detail).toBe("Bash command\nrm -rf build");
    expect(p.options.map((o) => o.label)).toEqual([
      "Yes", "Yes, and don't ask again for rm commands", "No, and tell Claude what to do differently (esc)",
    ]);
  });

  it("an old boxed input box is the input box", () => {
    expect(detectPrompt(screen(`
● Done.

╭──────────────────────────────────────────────────────────────╮
│ > 1. first                                                   │
│   2. second                                                  │
╰──────────────────────────────────────────────────────────────╯
  ? for shortcuts
`))).toBeNull();
  });

  it("options with a description line under each", () => {
    const p = detectPrompt(screen(`
────────────────────────────────────────────────────────────────
 Which library should we use?

 ❯ 1. date-fns
      Small and tree-shakeable
   2. dayjs
      Moment-like API
   3. Type something

 Enter to select · ↑/↓ to navigate · Esc to cancel
`))!;
    expect(p.kind).toBe("picker");
    expect(p.question).toBe("Which library should we use?");
    expect(p.options.map((o) => o.label)).toEqual(["date-fns Small and tree-shakeable", "dayjs Moment-like API", "Type something"]);
  });

  it("a user message in the transcript with no input box is not a picker", () => {
    // Column 0 pointer: a multi-line user message, numbered or not.
    expect(detectPrompt(screen(`
❯ 1. fix the tests
  2. open the PR

● Working on it.
`))).toBeNull();
    expect(detectPrompt(screen(`
❯ first line
  second line
`))).toBeNull();
  });

  it("a numbered list that does not start at 1 is not a picker", () => {
    expect(detectPrompt(screen(`
 Steps:
   2. build
 ❯ 3. deploy
   4. verify
`))).toBeNull();
  });

  it("the input box with a session title in its top border is the input box", () => {
    // From a replay of a live agent: a sub-agent is selected under the box.
    expect(detectPrompt(screen(`
  Ran 2 shell commands

✽ Spelunking… (16m 12s · ↓ 348.4k tokens)

──────────────────────────────────────────── Build the thing ─
❯ Message @general-purpose…
────────────────────────────────────────────────────────────────
  ↑/↓ to select

  ◯ main
❯ ● general-purpose  Implementing the thing
`))).toBeNull();
  });

  it("the Rewind menu: two-line items in a scrolling list are unknown, never buttons", () => {
    const p = detectPrompt(screen(`
✻ Worked for 5m 29s · done 3:02 PM
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Rewind

   Restore the code and/or conversation to the point before…

     ↑ 8 more
     first message
     No code changes

   ❯ second message
     notes.md +9

     ↓ 1 more

   Enter to continue · Esc to cancel
`))!;
    expect(p.kind).toBe("unknown");
    expect(p.options).toEqual([]);
  });

  it("the Rewind confirm step: a numbered list whose last row has the ↓ scroll mark", () => {
    const p = detectPrompt(screen(`
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Rewind

   Confirm you want to restore to the point before you sent this message:

   │ second message
   │ (25m ago)

   This message and everything after it will be removed.
   The code will be restored -9 in notes.md.

   ❯ 1. Restore code and conversation
     2. Restore conversation
     3. Restore code
     4. Summarize from here
   ↓ 5. Summarize up to here


   Enter to continue · Esc to cancel
`))!;
    expect(p.kind).toBe("picker");
    expect(p.question).toBe("This message and everything after it will be removed. The code will be restored -9 in notes.md.");
    expect(p.options.map((o) => o.label)).toEqual([
      "Restore code and conversation", "Restore conversation", "Restore code", "Summarize from here", "Summarize up to here",
    ]);
    expect(p.detail).toContain("Confirm you want to restore");
  });

  it("a numbered list scrolled past its first row is unknown", () => {
    const p = detectPrompt(screen(`
   Pick one

   ↑ 3. Third
   ❯ 4. Fourth
     5. Fifth

   Enter to continue · Esc to cancel
`))!;
    expect(p.kind).toBe("unknown");
  });

  it("a single pointer line is not a picker", () => {
    expect(detectPrompt(screen(`
 Something happened

 ❯ Continue
`))).toBeNull();
  });

  it("a pointer at column 0 counts for a numbered list with a dialog hint", () => {
    const p = detectPrompt(screen(`
What do you want to do?

❯ 1. Stop and wait for limit to reset
  2. Upgrade your plan

Enter to confirm · Esc to cancel
`))!;
    expect(p.kind).toBe("picker");
    expect(p.options.map((o) => o.label)).toEqual(["Stop and wait for limit to reset", "Upgrade your plan"]);
  });

  it("an unknown blocking screen: the screen text and no options", () => {
    const p = detectPrompt(screen(`

 Security notes:

 1. Claude can make mistakes
 2. Only use it with code you trust

 Press Enter to continue…

`))!;
    expect(p).toEqual({
      kind: "unknown", question: "", options: [], selected: null,
      screenText: " Security notes:\n\n 1. Claude can make mistakes\n 2. Only use it with code you trust\n\n Press Enter to continue…",
    });
  });

  it("a checkbox list is unknown: Enter may toggle there", () => {
    const p = detectPrompt(screen(`
 Which checks do you want?

 ❯ 1. [ ] Lint
   2. [x] Tests

 Enter to submit · Esc to cancel
`))!;
    expect(p.kind).toBe("unknown");
    expect(p.options).toEqual([]);
  });

  it("a dialog hint does not count while the input box or a spinner shows", () => {
    expect(detectPrompt(screen(`
 Some overlay
 Esc to cancel
────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────
`))).toBeNull();
    expect(detectPrompt(screen(`
● Working.

✻ Thinking… (esc to interrupt)
 Esc to cancel
`))).toBeNull();
    // The same footer alone is an unknown dialog.
    expect(detectPrompt(screen(`
 Some overlay
 Esc to cancel
`))?.kind).toBe("unknown");
  });

  it("key names in an agent's own text are not a dialog hint", () => {
    // From a replay of a live agent's screen: prose, no input box in view.
    expect(detectPrompt(screen(`
● Type this and copy the result without the quotes:
  read -rs T && printf '%s' "$T" > ~/.config/choibot/user-token
  At the read line, paste the token and press Enter. The token
  stays out of your shell history.
`))).toBeNull();
    expect(detectPrompt(screen(`
● The dialog says "Enter to confirm · Esc to cancel".
`))).toBeNull();
    expect(detectPrompt(screen(`
● Then press enter to continue, or use esc to cancel the run.
`))).toBeNull();
  });

  it("a hint above the last lines of the screen does not count", () => {
    const filler = Array.from({ length: 4 }, (_, i) => `  line ${i}`).join("\n");
    expect(detectPrompt(screen(`\n Esc to cancel\n${filler}\n`))).toBeNull();
  });
});

describe("promptRev", () => {
  it("is empty for no prompt and stable for the same prompt", () => {
    expect(promptRev(null)).toBe("");
    expect(promptRev(detect("trust-2.1.322"))).toBe(promptRev(detect("trust-2.1.322")));
    expect(promptRev(detect("trust-2.1.322"))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes with the selection", () => {
    expect(promptRev(detect("login-2.1.322"))).not.toBe(promptRev(detect("login-second-2.1.322")));
  });

  it("a picker ignores the rest of the screen (the banner animates), an unknown prompt does not", () => {
    const a = detect("login-2.1.322")!;
    expect(promptRev({ ...a, screenText: "other" })).toBe(promptRev(a));
    const u: Prompt = { kind: "unknown", question: "", options: [], selected: null, screenText: "a" };
    expect(promptRev({ ...u, screenText: "b" })).not.toBe(promptRev(u));
  });
});

describe("prompt keys", () => {
  it("the allow-list and its byte sequences", () => {
    expect([...PROMPT_KEYS]).toEqual(["up", "down", "enter", "esc", "tab", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(PROMPT_KEYS.map(promptKeySeq)).toEqual(["\x1b[A", "\x1b[B", "\r", "\x1b", "\t", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("refuses anything else", () => {
    for (const v of ["left", "right", "0", "10", "a", "", "Enter", "\r", "ctrl-c", 1, null, undefined, ["up"]]) {
      expect(isPromptKey(v)).toBe(false);
    }
  });
});
