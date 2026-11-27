// server/agents/title.ts — the title of an agent: the short name of its task that the list and
// the header show (its record's `label`). Given at `agents spawn` ("title") or by a rename. With
// no title a spawn keeps the fallback of spawn.ts (the start of the prompt). The CLI and the
// routes take the same check.

export const TITLE_MAX = 40;

// The title, trimmed, or the one line that says why it is refused.
export function checkTitle(v: unknown): { title: string } | { error: string } {
  if (typeof v !== "string") return { error: "title must be text" };
  const title = v.trim();
  if (!title) return { error: "title must not be empty" };
  // One line: no line break, tab or other control character.
  if (/[\u0000-\u001f\u007f]/.test(title)) return { error: "title must be one line" };
  const n = [...title].length;
  if (n > TITLE_MAX) return { error: `title is ${n} characters; the most is ${TITLE_MAX}` };
  return { title };
}
