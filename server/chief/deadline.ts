// server/chief/deadline.ts — a time limit on a promise the caller cannot cancel
// (a gh or git child): the caller stops waiting, the call itself goes on.

// Rejects after `ms` with "<what> timed out after <ms> ms"; settles as `p` before that.
export function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
