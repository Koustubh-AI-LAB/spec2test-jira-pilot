import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure } from '../output.ts';
import { requireConfig } from '../context.ts';
import { createHttpClient } from '../http.ts';

/**
 * Exactly one `--test-case-id`, a required `--seen-hash`, no `--all`. This
 * is what makes a vague "looks fine" structurally incapable of
 * batch-approving Gate 2 - there is no flag to point at more than one test
 * case, and parseArgs (cli.ts) cannot accumulate repeated `--test-case-id`
 * into a list even if someone tried; the last one wins, nothing more.
 */
export async function runApproveTestCase(args: ParsedArgs): Promise<never> {
  const command = 'approve-test-case';
  const testCaseId = args.flags['test-case-id'];
  const seenHash = args.flags['seen-hash'];
  const reject = Boolean(args.flags.reject);
  const reason = args.flags.reason;
  if (typeof testCaseId !== 'string' || typeof seenHash !== 'string') {
    usageError(
      command,
      'usage: s2t approve-test-case --test-case-id <id> --seen-hash <hash> [--actor <name>] [--reject --reason <text>]',
    );
  }
  if (reject && typeof reason !== 'string') {
    usageError(command, '--reject requires --reason <text>');
  }

  const cfg = await requireConfig(command);
  const actor = typeof args.flags.actor === 'string' ? args.flags.actor : cfg.actor;
  const http = createHttpClient(cfg.serviceUrl);

  const res = await http.post('/gate2/decisions', {
    subject_id: testCaseId,
    decision: reject ? 'rejected' : 'approved',
    actor,
    channel: 'claude-code',
    ...(reject ? { reason } : {}),
    seen_hash: seenHash,
  });
  if (!res.ok) emitApiFailure(command, res);

  emit({ ok: true, command, ...(res.body as object) });
}
