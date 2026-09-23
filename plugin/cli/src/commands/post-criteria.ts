import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure } from '../output.ts';
import { requireConfig } from '../context.ts';
import { createHttpClient } from '../http.ts';

/** Exactly one of --preview/--confirm is required, neither defaulted -
 *  every Jira write in this CLI is preview, then a separate confirm. */
export async function runPostCriteria(args: ParsedArgs): Promise<never> {
  const command = 'post-criteria';
  const issue = args.flags.issue;
  const requirementId = args.flags['requirement-id'];
  const preview = args.flags.preview === true;
  const confirm = args.flags.confirm === true;
  const force = args.flags.force === true;
  if (typeof issue !== 'string' || typeof requirementId !== 'string') {
    usageError(command, 'usage: s2t post-criteria --issue <KEY> --requirement-id <id> --preview|--confirm [--force]');
  }
  if (preview === confirm) {
    usageError(command, 'exactly one of --preview or --confirm is required');
  }

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const res = await http.post(`/jira/${encodeURIComponent(issue)}/criteria`, {
    requirement_id: requirementId,
    dry_run: preview,
    ...(force ? { force: true } : {}),
  });
  if (!res.ok) emitApiFailure(command, res);

  emit({ ok: true, command, ...(res.body as object) });
}
