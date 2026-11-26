// A durable, byte-capped mirror of a persisted agent's terminal output, written
// to disk as it streams. The in-memory Scrollback is lost on a server restart;
// this file is not — so when a fresh server reattaches to a dtach session it
// never spawned, it can replay history the (idle) agent would otherwise never
// repaint. We keep the TAIL: most-recent output is what matters, and xterm
// re-wraps fine. See Scrollback for the in-memory counterpart.
import { appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const DEFAULT_CAP = 2 * 1024 * 1024; // ~2MB, matching Scrollback

export class Transcript {
  // Bytes appended since the last compaction; an estimate of on-disk size used
  // only to decide when to trim. We let the file grow to 2x the cap before
  // rewriting so compaction is infrequent (one read+write per ~cap of output).
  private bytes = 0;

  constructor(private path: string, private maxBytes: number = DEFAULT_CAP) {
    if (existsSync(path)) {
      try { this.bytes = readFileSync(path).byteLength; } catch { this.bytes = 0; }
    }
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    // Best effort: a failed write (a full disk) must never throw into the pty's
    // onData, which would stop the live stream to the browser.
    try { appendFileSync(this.path, chunk); } catch { return; }
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > this.maxBytes * 2) this.compact();
  }

  // Rewrite the file with just the last `maxBytes` chars of history.
  private compact(): void {
    try {
      const tail = readFileSync(this.path, "utf8").slice(-this.maxBytes);
      writeFileSync(this.path, tail);
      this.bytes = Buffer.byteLength(tail);
    } catch { /* best effort — a failed compaction just leaves the file larger */ }
  }

  // The tail of recorded history (≤ maxBytes), or "" if nothing was ever
  // written. Reads the whole file then slices — the file stays near the cap.
  read(): string {
    try { return readFileSync(this.path, "utf8").slice(-this.maxBytes); }
    catch { return ""; }
  }

  remove(): void {
    try { unlinkSync(this.path); } catch { /* already gone */ }
    this.bytes = 0;
  }
}
