import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure } from '../output.ts';
import { requireConfig } from '../context.ts';
import { createHttpClient } from '../http.ts';
import type { PipelineState } from '../types.ts';
import { deriveLists } from '../types.ts';

/** The skill's only switch input - GET /pipeline/:issueKey plus the three
 *  derived lists, so the skill never has to join criteria[] against
 *  testCases[] itself. See types.ts's deriveLists. */
export async function runStatus(args: ParsedArgs): Promise<never> {
  const command = 'status';
  const issue = args.flags.issue;
  if (typeof issue !== 'string') usageError(command, 'usage: s2t status --issue <KEY>');

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const res = await http.get<PipelineState>(`/pipeline/${encodeURIComponent(issue)}`);
  if (!res.ok) emitApiFailure(command, res);

  emit({ ok: true, command, ...res.body, ...deriveLists(res.body) });
}
