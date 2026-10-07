import type { ParsedArgs } from '../cli.ts';
import { emit, usageError, emitApiFailure } from '../output.ts';
import { requireConfig, requireProvenance } from '../context.ts';
import { createHttpClient } from '../http.ts';
import { resolveProject } from '../resolve.ts';
import type { PipelineState } from '../types.ts';

/**
 * No --body flag, deliberately: title and body come from the ticket's own
 * text (GET /pipeline's jira.summary/jira.requirementText), copied verbatim.
 * If this command let Claude paraphrase the ticket into the requirement
 * body, `contentHash(ticket.requirementText)` would stop matching
 * `requirement.source_text_hash` on the very next reconcile - drift, from a
 * bug that would look like a Jira sync problem rather than what it is.
 */
export async function runDraftRequirement(args: ParsedArgs): Promise<never> {
  const command = 'draft-requirement';
  const issue = args.flags.issue;
  // --model is validated below, only when actually drafting - a resume
  // needs none of it, and POST /requirements itself only requires
  // provenance when it is NOT resuming (server.ts's own requireProvenance
  // call sits after the resume check, for the same reason).
  if (typeof issue !== 'string') {
    usageError(command, 'usage: s2t draft-requirement --issue <KEY> --model <id> [--temperature <n>]');
  }

  const cfg = await requireConfig(command);
  const http = createHttpClient(cfg.serviceUrl);

  const project = await resolveProject(http, cfg);
  if (!project.ok) emitApiFailure(command, project);

  const pipeline = await http.get<PipelineState>(`/pipeline/${encodeURIComponent(issue)}`, {
    project_id: project.body.id,
  });
  if (!pipeline.ok) emitApiFailure(command, pipeline);

  const body: Record<string, unknown> = {
    project_id: project.body.id,
    jira_issue_key: issue,
    title: pipeline.body.jira.summary,
    body: pipeline.body.jira.requirementText,
  };

  if (pipeline.body.requirement === null) {
    const model = args.flags.model;
    if (typeof model !== 'string') {
      usageError(command, '--model is required to draft (this ticket has no open requirement to resume)');
    }
    const temperature = typeof args.flags.temperature === 'string' ? Number(args.flags.temperature) : undefined;
    Object.assign(
      body,
      requireProvenance(command, {
        model,
        promptFile: 'criteria.v1.md',
        groundingText: pipeline.body.jira.requirementText,
        temperature,
      }),
    );
  }

  const res = await http.post('/requirements', body);
  if (!res.ok) emitApiFailure(command, res);

  emit({ ok: true, command, ...(res.body as object) });
}
