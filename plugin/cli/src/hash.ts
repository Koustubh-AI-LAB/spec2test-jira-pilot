import { createHash } from 'node:crypto';

/**
 * Mirrors service/src/hash.ts EXACTLY - byte for byte, on purpose. Four
 * places in this system now hash content (service, the Jira write path,
 * runner, this CLI); if this drifted even in normalisation, a `--seen-hash`
 * the CLI computed locally could stop matching what the service computed,
 * and every Gate 2 decision would 409 `stale_decision` for no real reason.
 * `test/hash.test.ts` asserts the two functions agree on the same inputs.
 */
export function contentHash(value: string): string {
  const normalised = value.replace(/\r\n/g, '\n').trim();
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}
