import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure, emitFailure } from '../output.ts';
import { requireConfig, requireProvenance, readJsonFile } from '../context.ts';
import { createHttpClient } from '../http.ts';
import type { RequirementRow } from '../types.ts';

/**
 * `--json-file` holds `[{body, state_affecting?}]`. `POST /requirements/:id/criteria`
 * itself accepts no provenance - `criterion` has no provenance columns; the
 * requirement row's own provenance (stamped by draft-requirement) is, by
 * design, the record of the whole drafting act. --model/prompt-lock are
 * still validated here even though nothing is forwarded: it is what catches
 * a stale prompt or a bad model id before a POST, and keeps this command's
 * own stdout self-documenting. See PLAN-5.3-5.7-WALKING-SKELETON.md 5.4,
 * "Which grounding, and one honesty problem worth naming".
 */
export async function runDraftCriteria(args: ParsedArgs): Promise<never> {
  const command = 'draft-criteria';
  const requirementId = args.flags['requirement-id'];
  const model = args.flags.model;
  const jsonFile = args.flags['json-file'];
  if (typeof requirementId !== 'string' || typeof model !== 'string' || typeof jsonFile !== 'string') {
    usageError(command, 'usage: s2t draft-criteria --requirement-id <id> --model <id> --json-file <path>');
  }

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  // POST /requirements/:id/criteria has no existence guard of its own - a
  // bad id would otherwise hit Postgres as a raw FK violation (500), not a
  // clean 404. This is also where groundingText comes from.
  const reqRes = await http.get<{ requirement: RequirementRow }>(`/requirements/${encodeURIComponent(requirementId)}`);
  if (!reqRes.ok) emitApiFailure(command, reqRes);

  requireProvenance(command, { model, promptFile: 'criteria.v1.md', groundingText: reqRes.body.requirement.body });

  const criteria = readJsonFile(command, jsonFile);
  if (!Array.isArray(criteria)) {
    emitFailure(command, 'json_file_invalid', '--json-file must contain a JSON array of {body, state_affecting?}');
  }

  const res = await http.post(`/requirements/${encodeURIComponent(requirementId)}/criteria`, { criteria });
  if (!res.ok) emitApiFailure(command, res);

  emit({ ok: true, command, ...(res.body as object) });
}
