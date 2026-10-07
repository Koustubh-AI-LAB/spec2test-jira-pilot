import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure } from '../output.ts';
import { requireConfig } from '../context.ts';
import { createHttpClient } from '../http.ts';
import type { TestCaseRow } from '../types.ts';

/**
 * Reads back one test case's full row, `spec` included - what a human needs
 * to see before deciding Gate 2. `s2t status`'s `testCases[]` only ever
 * carries id/name/state/contentHash, so a resumed session (no memory of the
 * same-turn `draft-test-case` output that originally had the spec) had no
 * way to show it. Never triggers a draft or a decision; a pure read, same
 * discipline as `verify-result`.
 */
export async function runGetTestCase(args: ParsedArgs): Promise<never> {
  const command = 'get-test-case';
  const testCaseId = args.flags['test-case-id'];
  if (typeof testCaseId !== 'string') usageError(command, 'usage: s2t get-test-case --test-case-id <id>');

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const res = await http.get<TestCaseRow>(`/test-cases/${encodeURIComponent(testCaseId)}`);
  if (!res.ok) emitApiFailure(command, res);

  emit({ ok: true, command, ...(res.body as object) });
}
