/**
 * Jira timestamps arrive with a site-local offset ("2026-09-10T16:00:00.000+0530")
 * while everything we write is UTC ("2026-09-10T10:30:00.000Z"). Those two are
 * the same instant, but the first sorts after the second as a string.
 *
 * This matters more than it looks: the reconcile decides whether a requirement
 * was edited *between* the criteria being posted and the PO approving, and that
 * window is the whole basis for trusting an approval. Compared as strings, the
 * window is arbitrary - it silently rejected valid approvals in one direction
 * and would have accepted invalidated ones in the other.
 */
export function instant(iso: string | undefined): number {
  if (!iso) return Number.NaN;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/** True when `at` falls strictly inside (start, end), as instants. */
export function isBetween(at: string, start: string | undefined, end: string): boolean {
  const a = instant(at);
  const s = instant(start);
  const e = instant(end);
  if (Number.isNaN(a) || Number.isNaN(s) || Number.isNaN(e)) return false;
  return a > s && a < e;
}

export function byInstant(a: { at: string }, b: { at: string }): number {
  return instant(a.at) - instant(b.at);
}
