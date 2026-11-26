// server/agents/consoleline.ts — a line that the console itself types into an agent (after a
// move to another login: "go on"). A leaf module with no import: the thread reader uses it too.
const TEXT_MAX = 200;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);

// The console types this line into the agent one time after a move. The thread shows its
// first sentences as a quiet line of the console, not as a message of the user (thread.ts).
export const CONSOLE_MARK = "[console] ";
const FOR_AGENT = " (For the agent: ";

// `signedOut`: the old login was signed out (not at a limit): the line says what is true.
export function goOnText(loginName: string, signedOut = false): string {
  const name = loginName.replace(/[^\w.@+-]/g, "").slice(0, 80) || "another login";
  return `${CONSOLE_MARK}Moved to ${name}. The agent goes on.${FOR_AGENT}the Claude login that you used was ${signedOut ? "signed out" : "at its limit"}, so your last turn was cut. You are on another login now. Go on with the work that you were doing, from where it stopped. Do not start it again from zero.)`;
}

// What the thread shows for a line of the console: the part that is for the person.
export function consoleNote(text: string): string | null {
  if (!text.startsWith(CONSOLE_MARK)) return null;
  const body = text.slice(CONSOLE_MARK.length);
  const cut = body.indexOf(FOR_AGENT);
  return oneLine(cut >= 0 ? body.slice(0, cut) : body) || null;
}
