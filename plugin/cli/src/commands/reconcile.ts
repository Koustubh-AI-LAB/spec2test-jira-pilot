import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure } from '../output.ts';
import { requireConfig } from '../context.ts';
import { createHttpClient } from '../http.ts';

/** Dry by default - --confirm is required to actually write. Mirrors
 *  POST /jira/:issueKey/reconcile's own dry_run contract exactly. */
export async function runReconcile(args: ParsedArgs): Promise<never> {
  const command = 'reconcile';
  const issue = args.flags.issue;
  if (typeof issue !== 'string') usageError(command, 'usage: s2t reconcile --issue <KEY> [--confirm]');
  const confirm = Boolean(args.flags.confirm);

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const res = await http.post(`/jira/${encodeURIComponent(issue)}/reconcile`, { dry_run: !confirm });
  if (!res.ok) emitApiFailure(command, res);

  emit({ ok: true, command, dryRun: !confirm, ...(res.body as object) });
}
