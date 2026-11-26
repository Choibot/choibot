// server/chief/brain/standing.ts — the one test of "is this text a standing rule" (the user's
// pick A "Quiet rules", 2026-11-19). A one-time answer never becomes a rule: a question, a
// one-letter or two-word answer ("A", "done merge"). A standing rule says what to do from now
// on, often with a marker word ("always …", "never …", "from now on …"). Pure, no I/O.

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu;
// Words that mark a lasting rule. Matched on whole words, any case.
const MARKER = /(?:^|[^\p{L}])(?:always|never|from now on|every time|each time|whenever|by default|going forward|in (?:the )?future|any ?time|no more|don['’]?t ever|do not ever|stop using|prefer)(?=$|[^\p{L}])/iu;
// A text that opens like a question, even without its "?": what, why, how, who, which, or a
// helper verb then "we", "you", "it", "i" or "there" ("can we …", "is it …"). Not "when" or
// "where" ("When a PR is ready, open it"), and not an order that starts with a helper verb
// ("Do not push to main", "Don't ever merge").
const ASKS = /^(?:(?:what|why|how|who|which)(?:['’]s)?\b|(?:can|could|should|shall|would|will|is|are|do|does|did|isn['’]?t|aren['’]?t|don['’]?t|doesn['’]?t|can['’]?t|couldn['’]?t|shouldn['’]?t)\s+(?:we|you|it|i|there)\b)/i;
export const MIN_RULE_WORDS = 3;

const words = (t: string): number => t.match(WORD)?.length ?? 0;

// Why `text` can never be a rule, or null. Cheap and sure: it only catches the plain cases.
export function oneTimeReason(text: string): string | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "blank";
  if (t.endsWith("?") || ASKS.test(t)) return "a question";
  if (words(t) < MIN_RULE_WORDS) return `fewer than ${MIN_RULE_WORDS} words`;
  return null;
}

// True when the text has a word that marks a lasting rule.
export const hasStandingMarker = (text: string): boolean => MARKER.test(text);
