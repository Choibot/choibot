// Standing queue instruction for every non-master agent when the chief is on
// (spec §5.2). Placed after NO_MERGE_RULE, before the brain.
import { names } from "../../names.mjs";
import { RICH_BODY_MAX, RICH_HEIGHT_MAX, RICH_HEIGHT_MIN, RICH_MAX_TEXT } from "./rich.js";
import { BODY_MAX } from "./schema.js";

// A ticket's rich part (rich.ts, src/lib/richTicket.ts): one main form per ticket (the body only, or
// a page with a short summary in the body; schema.ts refuses a long body with a page), what the file
// may hold, the base classes of the console's page and the limits, and that a share outside is the
// user's press (share.ts). For workers, leads and the master; the Coordinator's prompt is its own.
export function queueRichPrompt(): string {
  const file = `${names().repoFolder}/tickets/<name>.html`;
  return (
    `An item of any kind can also carry one page that you write in HTML and CSS: add "html":{"file":"${file}","height":<px>}. ` +
    `A ticket has one main form: never write the same content in the body and in the page. A short ask is the body only. ` +
    `Use a page for a long ask that needs illustration: a table that compares the options of a choice, steps with values, a before/after of what a PR changes, a checklist of what you checked for a question. ` +
    `Do not use one for a short ask, for plain text, or for a picture of the UI (that is a screenshot). ` +
    `With a page, the page carries the content and the body is a short summary of at most ${RICH_BODY_MAX} characters: what it is, the one or two facts that decide, and what to answer. ` +
    `Telegram, the fleet master and search get only the body, and the page can fail to show: write the summary so that a person can decide, or know the next step, from the body alone (a summary, not a copy). ` +
    `The limit of ${RICH_BODY_MAX} is only for a ticket with a page: a ticket with screenshots and no page has a body of at most ${BODY_MAX} characters that says all the user needs to decide. ` +
    `The file holds only content and <style> blocks (no <html>, <head> or <body>). The console adds its fonts, its colours for light and dark as CSS variables (--bg-0 to --bg-3, --ink-0 to --ink-2, --line, --ok, --warn, --err) and these classes: ` +
    `.callout, .badge, .dot (.ok .warn .err .run), .cols (two columns, for a before/after), ul.checks (li.done, li.fail), .label, .muted, .num, .add, .del. Use them before you write CSS of your own, and never set a colour that is not a variable. A table scrolls sideways on a phone. ` +
    `Limits: ${RICH_MAX_TEXT}; no script, form, button, frame, <link> or outside address (an image is a data: image; a link shows as its text and its address). The page only shows: the user answers with the console's buttons, so never draw a button. ` +
    `The frame cannot measure the page: give "height" (${RICH_HEIGHT_MIN}–${RICH_HEIGHT_MAX} px) near the real height of the page. \`queue add\` refuses a page that breaks a limit and says why. ` +
    `A page for the user goes in a ticket: do not publish pages to a share service or send the user a share link for them. ` +
    `A share with another person is the user's own press ("Share outside" on the ticket): when the user wants a page for someone else, put it in a ticket and say so; never publish it yourself.`
  );
}

export function queueAgentPrompt(cli: string): string {
  return (
    `Decisions for the user go through the queue, never through chat: run \`${cli} queue add\` (JSON on stdin) with kind pr | choice | preview | question, e.g. {"kind":"choice","title":"…","body":"…","options":[{"key":"A","label":"…"},{"key":"B","label":"…"}]}; a PR: {"kind":"pr","title":"…","body":"…","pr":{"url":"https://github.com/<owner>/<repo>/pull/<n>"}}. ` +
    `After an \`add\` with \`"blocking": true\`, end your turn; the answer arrives as your next message, starting with \`[queue <id>]\`. ` +
    `Indented lines right under a \`[queue <id>]\` line are part of that answer. ` +
    `If the user answers in chat instead, run \`${cli} queue withdraw <id>\`. ` +
    `When a PR is ready, add a \`pr\` item (in a repo with no remote, \`{"pr": {"branch": "<your branch>"}}\`): the user merges (the merge rule above holds). ` +
    `One ask is one item: never add a second item for the same PR or the same question. ` +
    `For UI work, put 1–4 PNG screenshots saved as \`${names().repoFolder}/previews/<topic>-<n>.png\` in the \`pr\` item itself: {"kind":"pr","title":"…","body":"…","pr":{"url":"https://…"},"preview":{"images":["${names().repoFolder}/previews/<topic>-1.png"]}}. ` +
    `Add a \`preview\` item only for a look the user must see while there is no PR yet. Example: {"kind":"preview","title":"…","body":"…","preview":{"images":["${names().repoFolder}/previews/<topic>-1.png"],"url":"https://…"}}. ` +
    `${queueRichPrompt()} ` +
    `Never use the AskUserQuestion tool.`
  );
}
