// server/audit/words.ts — the words of a row of the clean-up audit, from CODE: what the thing is,
// what happens when it is removed, and how sure the audit is.
// These words are always there. The AI step (./ai.ts) can put better ones in their place; when it
// did not run, the list has these. Pure, no imports of the server: the page reads the types.
import { OWN_REPO, PLAIN, UNSAVED, type Candidate, type Group } from "./scan.js";

export type Sure = "high" | "medium" | "low";

// A row as the page gets it. No full path: `where` is the short path.
export type Row = {
  id: string;
  where: string;
  kind: Candidate["kind"];
  group: Group;
  bytes: number;
  ageDays: number | null;
  what: string;
  effect: string;
  sure: Sure;
  notes: string[];
  // Why the page cannot remove it (plain words). Absent: the row has a "Remove" button.
  noRemove?: string;
  // When the user removed it from the page (ms): the row is then not in the list.
  removed?: number;
  // The words of `what` and `effect` are from the AI step.
  byAi: boolean;
};

export function fixedWords(c: Candidate): Pick<Row, "what" | "effect" | "sure"> {
  const repo = c.repo ? ` of the repo ${c.repo}` : "";
  const unsaved = c.notes.includes(UNSAVED);
  switch (c.kind) {
    case "build-output":
      return { what: `A build output${repo}`, effect: "The next build makes it again.", sure: "high" };
    case "installed-parts":
      return {
        what: `The installed parts${repo}`, sure: c.floor === "safe" ? "high" : "medium",
        effect: c.floor === "safe" ? "The next install downloads them again. This takes some minutes." : "The next install downloads them again. An agent that works in this repo must install them before it can run a test.",
      };
    case "tool-cache":
      return { what: `Downloads that the tool ${c.madeBy ?? "of this folder"} keeps`, effect: "The tool downloads them again when it needs them.", sure: c.floor === "safe" ? "high" : "medium" };
    case "old-build":
      return { what: "A build of ChoiBot that failed its check at a deploy", effect: "ChoiBot does not use it. Nothing is lost.", sure: "high" };
    case "unused-copy":
      if (c.notes.includes(PLAIN)) return { what: `A left-over folder${repo ? ` in the copies${repo}` : ""}. Git does not know it`, effect: "The folder is gone. ChoiBot does not know what is in it.", sure: "low" };
      if (c.notes.includes(OWN_REPO)) return { what: `A full repo in the folder of copies${repo}`, effect: "The repo is gone, with every branch that is only in it.", sure: "low" };
      return unsaved
        ? { what: `A copy${repo} that no agent uses. It ${UNSAVED}`, effect: "The changed files in it that are not on GitHub are lost.", sure: "medium" }
        : { what: `A copy${repo} that no agent uses`, effect: "The copy is gone. Its work is on GitHub.", sure: "high" };
    case "closed-copy":
      return {
        what: `The copy${repo} of the closed agent "${c.agent ?? "?"}"${unsaved ? `. It ${UNSAVED}` : ""}`,
        effect: unsaved ? "The work in it that is not on GitHub is lost, and you cannot open the agent again." : "The agent is deleted with its copy. You cannot open it again.",
        sure: "medium",
      };
    case "temp":
      if (c.count) {
        return c.bulk === "ours"
          ? { what: `${c.count} small temporary folders made by test runs of ChoiBot`, effect: "Nothing is lost. A test run makes new ones when it needs them.", sure: "high" }
          : { what: `${c.count} old temporary folders of other programs`, effect: "ChoiBot does not know what made them. No running program has a file of them open now.", sure: "low" };
      }
      return { what: c.madeBy ? `Temporary files of ${c.madeBy}` : "Temporary files", effect: "Nothing is lost if no program still uses them.", sure: c.floor === "safe" ? "medium" : "low" };
    case "old-log":
      return { what: `An old log${repo}`, effect: "You cannot read this log again.", sure: "high" };
    case "old-archive":
      return { what: "An old archive file", effect: "The file is gone. ChoiBot does not know what it is for.", sure: "low" };
    case "big-file":
      return { what: "A big file", effect: "The file is gone. ChoiBot does not know what it is for.", sure: "low" };
  }
}

// A copy with work that is not saved, and a full repo: never removed from the page.
export function noRemoveOf(c: Candidate): string | undefined {
  if (c.notes.includes(UNSAVED)) return "This page does not remove it: its work is not saved on GitHub. Ask an agent to send the work to GitHub first.";
  if (c.notes.includes(OWN_REPO)) return "This page does not remove it: it is a full repo, and the page cannot check all its branches.";
  return undefined;
}

export function rowOf(c: Candidate): Row {
  const noRemove = noRemoveOf(c);
  return { ...(noRemove ? { noRemove } : {}), id: c.id, where: c.where, kind: c.kind, group: c.floor, bytes: c.bytes, ageDays: c.ageDays, ...fixedWords(c), notes: c.notes, byAi: false };
}
