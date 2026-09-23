import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure, emitFailure } from '../output.ts';
import { requireConfig, requireProvenance, readJsonFile } from '../context.ts';
import { createHttpClient } from '../http.ts';
import { resolveContext } from '../resolve.ts';
import type { GroundingResult, SpecValidationResult } from '../types.ts';

/**
 * Refuses when spec.criterionId !== --criterion-id (a drafting mistake that
 * must never silently attach the wrong spec to the wrong criterion). Never
 * POSTs an ungrounded spec: /specs/validate runs first, and a failure there
 * stops this command before /test-cases is ever called. Surfaces `hints`
 * (see runner's unparseableAssertionHints, 0.3) even on success - an
 * assertion that will never derive a kill fault is worth flagging
 * immediately, not discovered as a quarantine minutes later.
 */
export async function runDraftTestCase(args: ParsedArgs): Promise<never> {
  const command = 'draft-test-case';
  const criterionId = args.flags['criterion-id'];
  const model = args.flags.model;
  const jsonFile = args.flags['json-file'];
  if (typeof criterionId !== 'string' || typeof model !== 'string' || typeof jsonFile !== 'string') {
    usageError(command, 'usage: s2t draft-test-case --criterion-id <id> --model <id> --json-file <path>');
  }

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const ctx = await resolveContext(http, cfg);
  if (!ctx.ok) emitApiFailure(command, ctx.failure);

  const spec = await readJsonFile(command, jsonFile);
  if (typeof spec !== 'object' || spec === null) {
    emitFailure(command, 'json_file_invalid', '--json-file must contain a TestCaseSpec JSON object');
  }
  const specObj = spec as { criterionId?: string; name?: string };
  if (specObj.criterionId !== criterionId) {
    emitFailure(
      command,
      'criterion_id_mismatch',
      `spec.criterionId ("${specObj.criterionId}") does not match --criterion-id ("${criterionId}")`,
    );
  }

  const grounding = await http.get<GroundingResult>(`/environments/${ctx.environment.id}/grounding`);
  if (!grounding.ok) emitApiFailure(command, grounding);

  const validate = await http.post<SpecValidationResult>('/specs/validate', {
    environment_id: ctx.environment.id,
    spec,
  });
  if (!validate.ok) emitApiFailure(command, validate);
  if (!validate.body.ok) {
    emitFailure(command, validate.body.event ?? 'spec_invalid', validate.body.message ?? 'spec failed validation');
  }

  const provenance = requireProvenance(command, {
    model,
    promptFile: 'testcase.v1.md',
    groundingText: grounding.body.text,
  });

  const res = await http.post('/test-cases', {
    criterion_id: criterionId,
    name: specObj.name ?? 'unnamed test case',
    kind: 'api',
    spec,
    ...provenance,
  });
  if (!res.ok) emitApiFailure(command, res);

  emit({ ok: true, command, hints: validate.body.hints ?? [], ...(res.body as object) });
}
