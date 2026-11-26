// A byte-capped ring of terminal output, replayed to a (re)connecting browser
// so it sees history before live streaming resumes. We keep the TAIL: terminal
// scrollback is most useful most-recent-first, and xterm re-wraps fine.
const DEFAULT_CAP = 2 * 1024 * 1024; // ~2MB

export class Scrollback {
  private chunks: string[] = [];
  private bytes = 0;
  // Total chars ever pushed. An offset into the stream is stable across trims,
  // so a reconnecting browser can ask for "everything after N".
  private total = 0;
  constructor(private maxBytes: number = DEFAULT_CAP) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.total += chunk.length;
    this.trim();
  }

  private trim(): void {
    while (this.bytes > this.maxBytes) {
      const over = this.bytes - this.maxBytes;
      const head = this.chunks[0];
      if (head.length <= over) {
        this.chunks.shift();
        this.bytes -= head.length;
      } else {
        this.chunks[0] = head.slice(over);
        this.bytes -= over;
      }
    }
  }

  snapshot(): string {
    return this.chunks.join("");
  }

  // Stream offset just past the newest char.
  get end(): number {
    return this.total;
  }

  // The output after stream offset `from`, or null when the ring no longer holds
  // all of it (or `from` is not a position in this stream): replay in full then.
  since(from: number): string | null {
    if (!Number.isInteger(from) || from > this.total || from < this.total - this.bytes) return null;
    return this.snapshot().slice(from - (this.total - this.bytes));
  }

  get byteLength(): number {
    return this.bytes;
  }
}
