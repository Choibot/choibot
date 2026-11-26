// server/health/history.ts — a short history of the processor, the memory and the swap, in the
// memory of the server process: about 1 hour of every sample, and 24 hours as 5-minute averages.
// No file and no database: a restart of the console starts the history again.

// [time (ms), processor %, memory %, swap %]
export type Point = [number, number, number, number];

export const FINE_KEEP_MS = 60 * 60_000;
export const COARSE_STEP_MS = 5 * 60_000;
export const COARSE_KEEP_MS = 24 * 60 * 60_000;

const round = (n: number): number => Math.round(n * 10) / 10;

export class History {
  readonly fine: Point[] = [];
  readonly coarse: Point[] = [];
  // The 5-minute step in progress: its number and the sums of its samples.
  private step: { n: number; count: number; sum: [number, number, number] } | null = null;

  add(t: number, cpu: number, mem: number, swap: number): void {
    this.fine.push([t, round(cpu), round(mem), round(swap)]);
    while (this.fine.length && this.fine[0][0] < t - FINE_KEEP_MS) this.fine.shift();
    const n = Math.floor(t / COARSE_STEP_MS);
    if (this.step && this.step.n !== n) {
      const s = this.step;
      this.coarse.push([(s.n + 1) * COARSE_STEP_MS, round(s.sum[0] / s.count), round(s.sum[1] / s.count), round(s.sum[2] / s.count)]);
      while (this.coarse.length && this.coarse[0][0] < t - COARSE_KEEP_MS) this.coarse.shift();
      this.step = null;
    }
    this.step ??= { n, count: 0, sum: [0, 0, 0] };
    this.step.count += 1;
    this.step.sum[0] += cpu;
    this.step.sum[1] += mem;
    this.step.sum[2] += swap;
  }

  // For how long, up to the newest sample, column `col` was at `min` or more without a break (ms).
  heldMs(col: 1 | 2 | 3, min: number): number {
    const last = this.fine.length - 1;
    if (last < 0 || this.fine[last][col] < min) return 0;
    let i = last;
    while (i > 0 && this.fine[i - 1][col] >= min) i -= 1;
    return this.fine[last][0] - this.fine[i][0];
  }
}
