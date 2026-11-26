import { describe, expect, it } from "vitest";
import { RICH_BASE_CSS, RICH_TOKENS } from "../../../src/lib/richTicket";
import { queueAgentPrompt, queueRichPrompt } from "./prompt.js";
import { RICH_BODY_MAX, RICH_HEIGHT_MAX, RICH_HEIGHT_MIN, RICH_MAX_TEXT } from "./rich.js";
import { BODY_MAX } from "./schema.js";

describe("queueAgentPrompt", () => {
  const p = queueAgentPrompt("CLI");
  it("renders the cli and keeps no placeholder", () => {
    expect(p).toContain("run `CLI queue add` (JSON on stdin)");
    expect(p).toContain("run `CLI queue withdraw <id>`");
    expect(p).not.toContain("<cli>");
  });
  it("covers pr items for repos without a remote and ends with the AskUserQuestion ban", () => {
    expect(p).toContain('{"pr": {"branch": "<your branch>"}}');
    expect(p).toContain("the user merges (the merge rule above holds)");
    expect(p.endsWith("Never use the AskUserQuestion tool.")).toBe(true);
  });
  // Overview decision 65: one ask is one ticket. The screenshots of a UI PR go in its pr item.
  it("asks for one item per ask: the screenshots of UI work go in the pr item, a preview item only with no PR", () => {
    expect(p).toContain("kind pr | choice | preview | question");
    expect(p).toContain("One ask is one item: never add a second item for the same PR or the same question.");
    expect(p).toContain('For UI work, put 1–4 PNG screenshots saved as `.choibot/previews/<topic>-<n>.png` in the `pr` item itself: '
      + '{"kind":"pr","title":"…","body":"…","pr":{"url":"https://…"},"preview":{"images":[".choibot/previews/<topic>-1.png"]}}.');
    expect(p).toContain("Add a `preview` item only for a look the user must see while there is no PR yet.");
    expect(p).not.toContain("For UI work, add a `preview` item");
    expect(p).toContain('Example: {"kind":"preview"');
    expect(p).toContain('{"kind":"preview","title":"…","body":"…","preview":{"images":[".choibot/previews/<topic>-1.png"],"url":"https://…"}}');
    expect(p).not.toContain("add a `question` item with the preview URL");
  });
  it("tells, right after the sentence that introduces [queue <id>] lines, that indented lines under one belong to the answer", () => {
    expect(p).toContain("the answer arrives as your next message, starting with `[queue <id>]`. "
      + "Indented lines right under a `[queue <id>]` line are part of that answer. If the user answers in chat instead,");
    expect(p.split("Indented lines right under")).toHaveLength(2);
  });
  // A ticket's rich part: when to use one, the base classes and the limits. The owner's ask of
  // 2026-11-26: one main form per ticket, never the same content in the body and in the page.
  it("says when a page helps and when not, names the classes and the limits", () => {
    expect(p).toContain(queueRichPrompt());
    const r = queueRichPrompt();
    expect(r).toContain('add "html":{"file":".choibot/tickets/<name>.html","height":<px>}');
    expect(r).toContain("a table that compares the options of a choice, steps with values, a before/after of what a PR changes, a checklist of what you checked for a question");
    expect(r).toContain("Do not use one for a short ask, for plain text, or for a picture of the UI");
    for (const c of [".callout", ".badge", ".dot (.ok .warn .err .run)", ".cols", "ul.checks (li.done, li.fail)", ".label", ".muted", ".num", ".add", ".del"]) expect(r).toContain(c);
    expect(r).toContain(`Limits: ${RICH_MAX_TEXT}; no script, form, button, frame, <link> or outside address`);
    expect(r).toContain(`give "height" (${RICH_HEIGHT_MIN}–${RICH_HEIGHT_MAX} px)`);
    expect(r).toContain("never draw a button");
    expect(r).toContain("`queue add` refuses a page that breaks a limit and says why.");
  });
  it("gives a ticket one main form: the body only for a short ask; with a page, a short summary of the page's limit", () => {
    const r = queueRichPrompt();
    expect(r).toContain("A ticket has one main form: never write the same content in the body and in the page. A short ask is the body only. "
      + "Use a page for a long ask that needs illustration:");
    expect(r).toContain(`With a page, the page carries the content and the body is a short summary of at most ${RICH_BODY_MAX} characters: `
      + "what it is, the one or two facts that decide, and what to answer.");
    expect(r).toContain("Telegram, the fleet master and search get only the body, and the page can fail to show: "
      + "write the summary so that a person can decide, or know the next step, from the body alone (a summary, not a copy).");
    // A pr ticket with pictures and no page is not under the limit of a page's summary.
    expect(r).toContain(`The limit of ${RICH_BODY_MAX} is only for a ticket with a page: a ticket with screenshots and no page has a body of at most ${BODY_MAX} characters that says all the user needs to decide.`);
    expect(r).not.toContain("must still say all");
    expect(r).not.toContain("The body stays required");
  });
  // The user's ask of 2026-11-20: a page for the user stays in the ticket; a share outside is the
  // user's own press ("Share outside", share.ts), never an agent's publish.
  it("keeps a page for the user in the ticket and leaves a share outside to the user's press", () => {
    const r = queueRichPrompt();
    expect(r).toContain("A page for the user goes in a ticket: do not publish pages to a share service or send the user a share link for them.");
    expect(r).toContain('A share with another person is the user\'s own press ("Share outside" on the ticket)');
    expect(r).toContain("never publish it yourself.");
  });
  // Each class and each colour the prompt names is one the console's page has.
  it("names only classes and colours of the console's page", () => {
    const r = queueRichPrompt();
    for (const c of [".callout", ".badge", ".dot", ".cols", "ul.checks", ".label", ".muted", ".num", ".add", ".del"]) expect(RICH_BASE_CSS).toContain(c);
    for (const t of ["--bg-0", "--bg-3", "--ink-0", "--ink-2", "--line", "--ok", "--warn", "--err"]) {
      expect(r).toContain(t);
      expect(RICH_TOKENS as readonly string[]).toContain(t);
    }
  });
  // Overview decision 60: a pr item has no approve. The sentence never promised one, so it is
  // unchanged (and CHIEF_PROMPT_REV with it).
  it("promises no approve of a pr item: the user merges", () => {
    expect(p).not.toMatch(/approv/i);
    expect(p).toContain("the user merges (the merge rule above holds)");
  });
});
