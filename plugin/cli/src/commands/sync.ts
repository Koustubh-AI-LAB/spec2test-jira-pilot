import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure } from '../output.ts';
import { requireConfig } from '../context.ts';
import { createHttpClient } from '../http.ts';

/**
 * Exactly one of --preview/--confirm, neither defaulted - but unlike
 * post-criteria, --preview here is NOT a no-op: `computeVerification`
 * always recomputes and persists `requirement.state` to Postgres, since
 * that recompute is deterministic (not a decision) and every other
 * state-changing step does the same. `--preview` only ever means "don't
 * write the Jira comment/fields" for this command. `postgresWritten: true`
 * is always reported so a caller reading `--preview`'s output can see that
 * side effect happened, rather than assuming parity with post-criteria's
 * genuinely inert preview.
 */
export async function runSync(args: ParsedArgs): Promise<never> {
  const command = 'sync';
  const issue = args.flags.issue;
  const requirementId = args.flags['requirement-id'];
  const preview = args.flags.preview === true;
  const confirm = args.flags.confirm === true;
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

  emit({ ok: true, command, postgresWritten: true, ...(res.body as object) });
}
