import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure } from '../output.ts';
import { requireConfig } from '../context.ts';
import { createHttpClient } from '../http.ts';
import { resolveContext } from '../resolve.ts';
import type { RunOnceResult } from '../types.ts';

/** POST /test-cases/:id/verify is synchronous today - this can block for
 *  minutes. SKILL.md warns before calling it. */
export async function runVerify(args: ParsedArgs): Promise<never> {
  const command = 'verify';
  const testCaseId = args.flags['test-case-id'];
  if (typeof testCaseId !== 'string') usageError(command, 'usage: s2t verify --test-case-id <id>');

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const ctx = await resolveContext(http, cfg);
  if (!ctx.ok) emitApiFailure(command, ctx.failure);

  const res = await http.post<RunOnceResult>(`/test-cases/${encodeURIComponent(testCaseId)}/verify`, {
    environment_id: ctx.environment.id,
  });
  if (!res.ok) emitApiFailure(command, res);

  const summary =
    res.body.status === 'done'
      ? `verified: ${res.body.verification?.state ?? 'unknown'}`
      : `failed: ${res.body.lastError ?? 'unknown error'}`;

  emit({ ok: true, command, summary, ...(res.body as object) });
}
