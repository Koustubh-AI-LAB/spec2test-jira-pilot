import { parse } from 'yaml';
import type { ParsedArgs } from '../cli.ts';
import { emit, emitApiFailure } from '../output.ts';
import { requireConfig } from '../context.ts';
import { createHttpClient } from '../http.ts';
import { resolveContext } from '../resolve.ts';
import type { GroundingResult } from '../types.ts';

/** Default output is a summary (source, hash, byte count, route list) - the
 *  full OpenAPI text only with --full, since it can be large and a drafting
 *  prompt mostly just needs to know what routes exist. */
export async function runGrounding(args: ParsedArgs): Promise<never> {
  const command = 'grounding';
  const full = args.flags.full === true;

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const ctx = await resolveContext(http, cfg);
  if (!ctx.ok) emitApiFailure(command, ctx.failure);

  const res = await http.get<GroundingResult>(`/environments/${ctx.environment.id}/grounding`);
  if (!res.ok) emitApiFailure(command, res);

  const routes: string[] = [];
  try {
    const doc = parse(res.body.text) as { paths?: Record<string, Record<string, unknown>> };
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const method of Object.keys(methods ?? {})) {
        routes.push(`${method.toUpperCase()} ${path}`);
      }
    }
  } catch {
    // Best-effort summary only - the grounding text itself is untouched, and
    // an actually-invalid schema is caught definitively by /specs/validate,
    // not by this command's own listing.
  }

  emit({
    ok: true,
    command,
    environmentId: ctx.environment.id,
    source: res.body.source,
    contentHash: res.body.contentHash,
    bytes: Buffer.byteLength(res.body.text, 'utf8'),
    routes: routes.sort(),
    ...(full ? { text: res.body.text } : {}),
  });
}
