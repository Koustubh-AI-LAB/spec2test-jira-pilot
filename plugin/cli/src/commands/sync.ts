import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure } from '../output.ts';
import { requireConfig } from '../context.ts';
import { createHttpClient } from '../http.ts';

/** Same preview discipline as post-criteria: exactly one of
 *  --preview/--confirm, neither defaulted. */
export async function runSync(args: ParsedArgs): Promise<never> {
  const command = 'sync';
  const issue = args.flags.issue;
  const requirementId = args.flags['requirement-id'];
  const preview = Boolean(args.flags.preview);
  const confirm = Boolean(args.flags.confirm);
  if (typeof issue !== 'string' || typeof requirementId !== 'string') {
    usageError(command, 'usage: s2t sync --issue <KEY> --requirement-id <id> --preview|--confirm');
  }
  if (preview === confirm) {
    usageError(command, 'exactly one of --preview or --confirm is required');
  }

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const res = await http.post(`/jira/${encodeURIComponent(issue)}/verification`, {
    requirement_id: requirementId,
    dry_run: preview,
  });
  if (!res.ok) emitApiFailure(command, res);

  emit({ ok: true, command, ...(res.body as object) });
}
