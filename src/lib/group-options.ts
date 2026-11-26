// Bucket dropdown options by their optional `group`, preserving first-seen
// order of both groups and items. Options with no group share a single
// `null` bucket. Used by Dropdown to render section headers.
export type GroupableOption = { value: string; label: string; group?: string };

export function groupOptions<T extends GroupableOption>(
  options: T[],
): Array<{ group: string | null; items: T[] }> {
  const order: Array<string | null> = [];
  const buckets = new Map<string | null, T[]>();
  for (const opt of options) {
    const key = opt.group ?? null;
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    buckets.get(key)!.push(opt);
  }
  return order.map((group) => ({ group, items: buckets.get(group)! }));
}
