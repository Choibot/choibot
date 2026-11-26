// server/master/draft.ts — what the user is doing in the Master tab's terminal.
// Fed with every web input chunk (server/agents/ws.ts). The inbox must not paste
// into a half-typed line (draft) or while the user is typing (quiet window).
export const DRAFT_TTL_MS = 10 * 60_000;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Reports the browser's xterm sends on its own, not keystrokes: focus in/out,
// cursor position reports, primary/secondary device attributes, OSC replies,
// DCS replies (e.g. DECRQSS \x1bP1$r…\x1b\\).
const REPORT_RE = /\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[[?>][\d;]*c|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;

// A web input chunk without the browser's own reports: what the user typed.
export function stripReports(data: string): string {
  return data.replace(REPORT_RE, "");
}

// True when a web input chunk presses Enter. xterm's own reports never do.
export function pressesEnter(data: string): boolean {
  return stripReports(data).includes("\r");
}

// Length of the escape sequence at s[i] (s[i] === ESC): CSI up to its final
// byte, SS3 (ESC O x), or ESC + one char (Alt+key).
function escLength(s: string, i: number): number {
  const next = s[i + 1];
  if (next === "[") {
    let j = i + 2;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) break;
      j++;
    }
    return j + 1 - i;
  }
  if (next === "O") return 3;
  return next === undefined ? 1 : 2;
}

export class InputTracker {
  private draft = false;
  private inPaste = false;
  private lastAt: number | null = null;

  constructor(private now: () => number = Date.now) {}

  onInput(data: string): { submitted: boolean } {
    const s = data.replace(REPORT_RE, "");
    if (!s) return { submitted: false };
    this.lastAt = this.now();
    let submitted = false;
    for (let i = 0; i < s.length;) {
      if (s.startsWith(PASTE_START, i)) { this.inPaste = true; i += PASTE_START.length; continue; }
      if (s.startsWith(PASTE_END, i)) { this.inPaste = false; i += PASTE_END.length; continue; }
      const c = s[i];
      if (c === "\x1b") { i += escLength(s, i); continue; }
      if (c === "\r" && !this.inPaste) { this.draft = false; submitted = true; i++; continue; }
      // Ctrl+C / Ctrl+U empty Claude Code's input line: no draft left.
      if ((c === "\x03" || c === "\x15") && !this.inPaste) { this.draft = false; i++; continue; }
      if (c >= " " && c !== "\x7f") this.draft = true;
      i++;
    }
    return { submitted };
  }

  hasDraft(): boolean {
    return this.draft && this.lastAt !== null && this.now() - this.lastAt < DRAFT_TTL_MS;
  }

  quietFor(ms: number): boolean {
    return this.lastAt === null || this.now() - this.lastAt >= ms;
  }
}
