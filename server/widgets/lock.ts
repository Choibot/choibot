// server/widgets/lock.ts — a per-key async mutex. Every write for one widget
// (refresh, ingest, state, ui, delete) runs under that widget's key, so two
// viewers, or a list scan during a refresh, never append the same history
// entry twice (spec "History").
export class KeyedLock {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
