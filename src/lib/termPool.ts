// The agent terminals a browser tab keeps alive after they leave the screen, so
// switching back to one only shows it. Bounded: each entry holds an xterm buffer
// and a websocket, so past the cap the least recently used one is disposed and
// its next open replays from the server, as a first open does.
export type Poolable = { dispose(): void };

export const DESKTOP_POOL_CAP = 10;
export const MOBILE_POOL_CAP = 4;

// NEXT_PUBLIC_AGENT_TERMINAL_POOL (build time) overrides the default cap; 0 or
// less keeps nothing but the terminal on screen.
export function poolCap(raw: string | undefined, mobile: boolean): number {
  const n = raw ? Number(raw) : NaN;
  if (Number.isInteger(n)) return Math.max(0, n);
  return mobile ? MOBILE_POOL_CAP : DESKTOP_POOL_CAP;
}

export class TermPool<T extends Poolable> {
  // Insertion order is recency order: oldest first.
  private entries = new Map<string, T>();
  private mounted = new Set<string>();

  constructor(private cap: () => number) {}

  get size(): number { return this.entries.size; }

  // Take the terminal for `key` onto the screen, creating it if needed.
  acquire(key: string, create: () => T): T {
    const entry = this.entries.get(key) ?? create();
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.mounted.add(key);
    this.evict();
    return entry;
  }

  // The terminal for `key` left the screen. It stays live unless over the cap.
  release(key: string): void {
    this.mounted.delete(key);
    this.evict();
  }

  // The agent is gone for good.
  drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.mounted.delete(key);
    entry.dispose();
  }

  // A terminal on screen never counts against the cap and is never disposed.
  private evict(): void {
    let spare = this.entries.size - this.mounted.size - this.cap();
    for (const [key, entry] of this.entries) {
      if (spare <= 0) return;
      if (this.mounted.has(key)) continue;
      this.entries.delete(key);
      entry.dispose();
      spare--;
    }
  }

  // Every live terminal, for changes that apply to all of them.
  forEach(fn: (entry: T) => void): void {
    this.entries.forEach((entry) => fn(entry));
  }
}
