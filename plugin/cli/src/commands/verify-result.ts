import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure } from '../output.ts';
import { requireConfig } from '../context.ts';
import { createHttpClient } from '../http.ts';
import type { VerifyResultResponse } from '../types.ts';

/**
 * Reads back the certify verdict + reason from a test case's most recent
 * `verify` run - the diagnostic that used to arrive inline in `verify`'s own
 * response before Step 6 made it enqueue-and-return. Never triggers a new
 * run and takes no `--environment-id`, unlike every drafting/verify command:
 * the underlying route is keyed purely by test_case_id, so this works from a
 * fresh `s2t status` with nothing else resolved first.
 */
export async function runVerifyResult(args: ParsedArgs): Promise<never> {
  const command = 'verify-result';
  const testCaseId = args.flags['test-case-id'];
  if (typeof testCaseId !== 'string') usageError(command, 'usage: s2t verify-result --test-case-id <id>');

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const res = await http.get<VerifyResultResponse>(`/test-cases/${encodeURIComponent(testCaseId)}/verify-result`);
  if (!res.ok) emitApiFailure(command, res);

  const summary = !res.body.hasRun ? 'never verified yet' : `${res.body.certify!.verdict}: ${res.body.certify!.reason}`;

  emit({ ok: true, command, summary, ...res.body });
}
