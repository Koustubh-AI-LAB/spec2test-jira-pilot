import { createHash } from 'node:crypto';

/**
 * Canonical content hash. Approval is bound to this value, so the
 * normalisation has to be stable: trailing whitespace and line-ending
 * differences must not read as a content change and silently reopen a gate.
 */
export function contentHash(value: string): string {
  const normalised = value.replace(/\r\n/g, '\n').trim();
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}
