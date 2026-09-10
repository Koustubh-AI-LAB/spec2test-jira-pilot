import type { JiraClient } from './client.ts';
import { loadFieldMap, PROPERTY_KEY, VERIFICATION_STATUS } from './read.ts';
import type { FieldMap, PipelineProperty } from './read.ts';
import { contentHash } from '../hash.ts';
import { audit } from '../audit.ts';
import type { AdfNode } from './adf.ts';

/**
 * Write-back to the ticket: the PO's surface.
 *
 * Every write is fingerprinted first. A pipeline that re-posts its comment on
 * each invocation trains the PO to mute the ticket, and a muted ticket is a
 * dead gate - so "nothing changed" has to mean "write nothing", not "write the
 * same thing again".
 */

export interface CriterionView {
  id: string;
  ordinal: number;
  body: string;
  contentHash: string;
  stateAffecting: boolean;
}

export interface PostCriteriaInput {
  issueKey: string;
  criteria: CriterionView[];
  requirementHash: string;
  /** Present once tests exist; drives the counters. */
  certified?: number;
}

export interface WriteOutcome {
  wrote: boolean;
  reason: string;
  fingerprint: string;
}

const LABEL = 'spec2test';

/**
 * The fingerprint covers exactly what a reader would notice: the criteria
 * shown, the state claimed, and the counters. It deliberately excludes
 * timestamps - a clock tick is not a change worth notifying anyone about.
 */
function fingerprintOf(input: PostCriteriaInput, coverageState: string): string {
  const payload = JSON.stringify({
    coverageState,
    requirementHash: input.requirementHash,
    certified: input.certified ?? 0,
    criteria: input.criteria
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c) => [c.ordinal, c.contentHash, c.stateAffecting]),
  });
  return contentHash(payload);
}

function criteriaComment(input: PostCriteriaInput, browseUrl: string): AdfNode {
  const heading = {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: 'spec2test drafted these acceptance criteria from this ticket.',
        marks: [{ type: 'strong' }],
      },
    ],
  };

  const instruction = {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text:
          `To approve, set Verification Status to "${VERIFICATION_STATUS.criteriaApproved}". ` +
          'Editing the requirement after approving reopens this gate - the approval is ' +
          'bound to the exact wording below.',
      },
    ],
  };

  const list = {
    type: 'bulletList',
    content: input.criteria
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c) => ({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: c.body },
              ...(c.stateAffecting
                ? [
                    {
                      type: 'text',
                      text: '  [changes data - needs stronger evidence than a read-only check]',
                      marks: [{ type: 'em' }],
                    },
                  ]
                : []),
            ],
          },
        ],
      })),
  };

  const footer = {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: `requirement ${input.requirementHash.slice(0, 12)} - ${browseUrl}`,
        marks: [{ type: 'em' }],
      },
    ],
  };

  return { type: 'doc', version: 1, content: [heading, instruction, list, footer] } as AdfNode;
}

/**
 * Post drafted criteria and set the Gate 1 surface. Idempotent: a second call
 * with unchanged content is a no-op that reports why.
 */
export async function postCriteria(
  client: JiraClient,
  input: PostCriteriaInput,
  options: { fields?: FieldMap; force?: boolean } = {},
): Promise<WriteOutcome> {
  const fields = options.fields ?? loadFieldMap();
  const coverageState = 'criteria_drafted';
  const fingerprint = fingerprintOf(input, coverageState);

  const existing = await readProperty(client, input.issueKey);
  if (!options.force && existing?.fingerprint === fingerprint) {
    return {
      wrote: false,
      reason: 'unchanged since the last write; comment and fields left alone',
      fingerprint,
    };
  }

  const postedAt = new Date().toISOString();

  await client.request('PUT', `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}`, {
    fields: {
      [fields.verificationStatus]: { value: VERIFICATION_STATUS.criteriaDrafted },
      [fields.criteriaCertified]: input.certified ?? 0,
      [fields.criteriaTotal]: input.criteria.length,
    },
    update: { labels: [{ add: LABEL }] },
  });

  await client.request(
    'POST',
    `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`,
    { body: criteriaComment(input, client.browseUrl(input.issueKey)) },
  );

  // Written last, and only after the comment lands. If the comment call fails,
  // the fingerprint is not advanced and the next run retries instead of
  // believing it already posted.
  const property: PipelineProperty = {
    coverage_state: coverageState,
    fingerprint,
    requirement_hash: input.requirementHash,
    criteria_posted_at: postedAt,
    criteria_posted: Object.fromEntries(input.criteria.map((c) => [c.id, c.contentHash])),
    updated_at: postedAt,
  };
  await writeProperty(client, input.issueKey, property);

  await audit({
    event: 'jira_criteria_posted',
    subject: `issue:${input.issueKey}`,
    actor: 'system',
    detail: {
      issue_key: input.issueKey,
      criteria: input.criteria.length,
      fingerprint,
      requirement_hash: input.requirementHash,
    },
  });

  return { wrote: true, reason: `posted ${input.criteria.length} criteria`, fingerprint };
}

/** Mark the ticket stale after drift, so the PO learns it from Jira. */
export async function postDrift(
  client: JiraClient,
  issueKey: string,
  drift: { approvedHash: string; currentHash: string },
  options: { fields?: FieldMap } = {},
): Promise<WriteOutcome> {
  const fields = options.fields ?? loadFieldMap();
  const fingerprint = contentHash(`stale:${drift.currentHash}`);

  const existing = await readProperty(client, issueKey);
  if (existing?.fingerprint === fingerprint) {
    return { wrote: false, reason: 'drift already reported for this text', fingerprint };
  }

  await client.request('PUT', `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    fields: { [fields.verificationStatus]: { value: VERIFICATION_STATUS.stale } },
  });

  await client.request('POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text:
                'The requirement text changed after these criteria were approved, so the ' +
                'approval no longer applies. Existing tests keep running, but stop counting ' +
                'as certified until the criteria are re-approved.',
            },
          ],
        },
      ],
    },
  });

  await writeProperty(client, issueKey, {
    coverage_state: 'stale',
    fingerprint,
    requirement_hash: drift.currentHash,
    updated_at: new Date().toISOString(),
  });

  return { wrote: true, reason: 'drift reported on the ticket', fingerprint };
}

export async function readProperty(
  client: JiraClient,
  issueKey: string,
): Promise<PipelineProperty | undefined> {
  try {
    const res = await client.get<{ value: PipelineProperty }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/properties/${PROPERTY_KEY}`,
    );
    return res.value;
  } catch (err) {
    if (err && typeof err === 'object' && 'jiraStatus' in err && err.jiraStatus === 404) {
      return undefined;
    }
    throw err;
  }
}

export async function writeProperty(
  client: JiraClient,
  issueKey: string,
  value: PipelineProperty,
): Promise<void> {
  await client.request(
    'PUT',
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/properties/${PROPERTY_KEY}`,
    value,
  );
}
