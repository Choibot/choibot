// server/agents/screen.ts — an agent's terminal screen as plain text.
// A headless xterm (the same emulator and version as the browser's) is fed the
// agent's PTY bytes; its viewport is what the user would see in the terminal
// tab. The prompt card reads it to find a dialog that the session file does
// not hold (agents/prompt.ts).
//
// Bounded on purpose, because every live agent has one:
//   - no scrollback: the buffer is the viewport only (cols × rows cells);
//   - xterm parses a write in time slices and yields between them, so a large
//     replay (a reattach seeds up to the scrollback cap) never blocks the loop;
//   - bytes that arrive while more than MAX_PENDING chars wait to be parsed
//     are dropped and counted: a process that floods the PTY costs a bounded
//     parse, not a queue that grows. The screen is right again after the
//     TUI's next full repaint.
import xterm from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const { Terminal } = xterm;

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;
// Chars that may wait in xterm's write queue. A reattach seed (the scrollback
// cap, ~2 MB) must fit.
export const MAX_PENDING = 4 * 1024 * 1024;
// A screen wider or taller than this is never built (a resize is clamped).
const MAX_COLS = 500;
const MAX_ROWS = 200;

export type Screen = {
  cols: number;
  rows: number;
  // One string per viewport row, top first, right-trimmed.
  lines: string[];
  cursor: { x: number; y: number };
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.floor(n) || lo));

export class ScreenMirror {
  private term: HeadlessTerminal;
  private pending = 0;
  private dropped = 0;
  private disposed = false;
  // read() calls that wait for the parser; dispose() releases them.
  private waiters = new Set<() => void>();

  constructor(cols: number = DEFAULT_COLS, rows: number = DEFAULT_ROWS) {
    this.term = new Terminal({
      cols: clamp(cols, 2, MAX_COLS), rows: clamp(rows, 1, MAX_ROWS),
      scrollback: 0, allowProposedApi: true, logLevel: "off",
    });
  }

  // Feed PTY output. Returns at once: xterm parses it in slices.
  write(data: string): void {
    if (this.disposed || data.length === 0) return;
    if (this.pending + data.length > MAX_PENDING) {
      this.dropped += data.length;
      return;
    }
    this.pending += data.length;
    this.term.write(data, () => { this.pending -= data.length; });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const c = clamp(cols, 2, MAX_COLS);
    const r = clamp(rows, 1, MAX_ROWS);
    if (c === this.term.cols && r === this.term.rows) return;
    this.term.resize(c, r);
  }

  // Chars dropped by the pending cap since the mirror was made.
  get droppedChars(): number {
    return this.dropped;
  }

  // The screen once every byte written so far is parsed. After dispose():
  // an empty screen, never a promise that stays open.
  async read(): Promise<Screen> {
    if (!this.disposed) {
      await new Promise<void>((done) => {
        const release = (): void => { this.waiters.delete(release); done(); };
        this.waiters.add(release);
        this.term.write("", release);
      });
    }
    return this.peek();
  }

  // The screen as parsed so far (bytes still in the write queue are not in it).
  peek(): Screen {
    const t = this.term;
    if (this.disposed) return { cols: t.cols, rows: t.rows, lines: [], cursor: { x: 0, y: 0 } };
    const b = t.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < t.rows; y++) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? "");
    return { cols: t.cols, rows: t.rows, lines, cursor: { x: b.cursorX, y: b.cursorY } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of [...this.waiters]) release();
    this.term.dispose();
  }
}
