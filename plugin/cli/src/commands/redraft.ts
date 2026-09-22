import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure, emitFailure } from '../output.ts';
import { requireConfig, requireProvenance, readJsonFile } from '../context.ts';
import { createHttpClient } from '../http.ts';
import type { PipelineState, RequirementRow } from '../types.ts';

/**
 * No --issue flag: the requirement row's own `jira_issue_key` is used to
 * look up the ticket's CURRENT text - the whole point of redraft is
 * adopting text that may have moved since the requirement was first
 * drafted (drift), or context from a PO rejection. Title/body are taken
 * verbatim from the live ticket, same discipline as draft-requirement.
 */
export async function runRedraft(args: ParsedArgs): Promise<never> {
  const command = 'redraft';
  const requirementId = args.flags['requirement-id'];
  const model = args.flags.model;
  const reason = args.flags.reason;
  const jsonFile = args.flags['json-file'];
  if (
    typeof requirementId !== 'string' ||
    typeof model !== 'string' ||
    typeof reason !== 'string' ||
    typeof jsonFile !== 'string'
  ) {
    usageError(command, 'usage: s2t redraft --requirement-id <id> --model <id> --reason <text> --json-file <path>');
  }

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const reqRes = await http.get<{ requirement: RequirementRow }>(`/requirements/${encodeURIComponent(requirementId)}`);
  if (!reqRes.ok) emitApiFailure(command, reqRes);

  const pipeline = await http.get<PipelineState>(
    `/pipeline/${encodeURIComponent(reqRes.body.requirement.jira_issue_key)}`,
  );
  if (!pipeline.ok) emitApiFailure(command, pipeline);

  const provenance = requireProvenance(command, {
    model,
    promptFile: 'criteria.v1.md',
    groundingText: pipeline.body.jira.requirementText,
  });

  const criteria = readJsonFile(command, jsonFile);
  if (!Array.isArray(criteria)) {
    emitFailure(command, 'json_file_invalid', '--json-file must contain a JSON array of {body, state_affecting?}');
  }

  const res = await http.post(`/requirements/${encodeURIComponent(requirementId)}/redraft`, {
    title: pipeline.body.jira.summary,
    body: pipeline.body.jira.requirementText,
    criteria,
    reason,
    ...provenance,
  });
  if (!res.ok) emitApiFailure(command, res);

  emit({ ok: true, command, ...(res.body as object) });
}
