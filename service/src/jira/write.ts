import type { JiraClient } from './client.ts';
import { loadFieldMap, PROPERTY_KEY, VERIFICATION_STATUS } from './read.ts';
import type { FieldMap, PipelineProperty } from './read.ts';
import { contentHash } from '../hash.ts';
import { audit } from '../audit.ts';
import type { AdfNode } from './adf.ts';
import { adfToText, textToAdf } from './adf.ts';

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

/**
 * What a confirmed write would put on the ticket. Built by the very same
 * comment builder the real write uses, from the same inputs and the same
 * fingerprint - that is what makes "preview, then confirm" mean the body you
 * read is the body that lands, not a second rendering that could drift.
 */
export interface WritePreview {
  comment: AdfNode;
  /** Field values that would be set alongside the comment. */
  fields: Record<string, unknown>;
}

export interface WriteOutcome {
  wrote: boolean;
  reason: string;
  fingerprint: string;
  /** Set on a dry run. `wrote` is always false then, and Jira was only read. */
  dryRun?: boolean;
  /** Absent when there is nothing to preview: unchanged, or already on the ticket. */
  preview?: WritePreview;
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

/**
 * Prefix for the marker line every posted comment carries, so a crash between
 * the comment landing and the property write can be recovered from: the next
 * run can tell "already posted, just finish recording it" from "never
 * posted" by searching Jira's own comments instead of trusting only our
 * bookkeeping, which is exactly the thing that crashed.
 */
const MARKER_PREFIX = 'spec2test:fingerprint:';

/**
 * Every comment the service posts is required to start with this - not just
 * for humans to recognise, but so the service itself can tell its own
 * comments apart from a person's. That distinction matters in this pilot
 * specifically: the service authenticates as the same Jira account as the
 * human tester, so a bot-posted comment and a human-written one are
 * otherwise indistinguishable by author alone. A real deployment would run
 * under its own service account and this would be redundant - here it is
 * load-bearing. See findRejectionReason in reconcile.ts, which found this
 * out the hard way: its own refusal notice, posted moments earlier, got
 * mistaken for the PO's actual rejection reason.
 */
export const SERVICE_COMMENT_PREFIX = 'spec2test:';

export function isServiceComment(text: string): boolean {
  return text.startsWith(SERVICE_COMMENT_PREFIX);
}

function criteriaComment(input: PostCriteriaInput, browseUrl: string, fingerprint: string): AdfNode {
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

  // Not shown to the PO in any meaningful way (it is the last line of a
  // comment they have no reason to read closely), but has to be plain,
  // undecorated text so a later flatten-and-substring-search finds it
  // reliably regardless of what marks or node types surround it.
  const marker = {
    type: 'paragraph',
    content: [{ type: 'text', text: `${MARKER_PREFIX}${fingerprint}` }],
  };

  return { type: 'doc', version: 1, content: [heading, instruction, list, footer, marker] } as AdfNode;
}

/**
 * Finds a comment already carrying this fingerprint's marker, if one made it
 * to Jira before a previous run crashed partway through. Recent-first: the
 * comment we are looking for, if it exists, was posted on the most recent
 * write attempt, not on some earlier draft.
 */
async function findPostedComment(
  client: JiraClient,
  issueKey: string,
  fingerprint: string,
): Promise<{ id: string; created: string } | undefined> {
  const res = await client.get<{ comments: { id: string; created: string; body: unknown }[] }>(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?orderBy=-created&maxResults=20`,
  );
  const marker = `${MARKER_PREFIX}${fingerprint}`;
  const match = res.comments.find((c) => adfToText(c.body).includes(marker));
  return match && { id: match.id, created: match.created };
}

function criteriaFields(input: PostCriteriaInput, fields: FieldMap): Record<string, unknown> {
  return {
    [fields.verificationStatus]: { value: VERIFICATION_STATUS.criteriaDrafted },
    [fields.criteriaCertified]: input.certified ?? 0,
    [fields.criteriaTotal]: input.criteria.length,
  };
}

/**
 * Post drafted criteria and set the Gate 1 surface. Idempotent: a second call
 * with unchanged content is a no-op that reports why.
 *
 * `dryRun` reads Jira (the property and the recent comments, exactly as a real
 * write does) and writes nothing, returning the comment and field values a
 * confirmed call would send.
 */
export async function postCriteria(
  client: JiraClient,
  input: PostCriteriaInput,
  options: { fields?: FieldMap; force?: boolean; dryRun?: boolean } = {},
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
      ...(options.dryRun ? { dryRun: true } : {}),
    };
  }

  if (options.dryRun) {
    const posted = await findPostedComment(client, input.issueKey, fingerprint);
    if (posted) {
      return {
        wrote: false,
        dryRun: true,
        reason: 'preview: this comment is already on the ticket; a confirmed call would only finish recording it',
        fingerprint,
      };
    }
    return {
      wrote: false,
      dryRun: true,
      reason: `preview: would post ${input.criteria.length} criteria`,
      fingerprint,
      preview: {
        comment: criteriaComment(input, client.browseUrl(input.issueKey), fingerprint),
        fields: criteriaFields(input, fields),
      },
    };
  }

  await client.request('PUT', `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}`, {
    fields: criteriaFields(input, fields),
    update: { labels: [{ add: LABEL }] },
  });

  // Recovers from the crash window this fingerprint scheme could not close on
  // its own: if a previous run posted the comment and then died before
  // writeProperty, `existing` above never advanced, so this run would
  // otherwise post a second, identical comment. Check Jira itself first.
  const already = await findPostedComment(client, input.issueKey, fingerprint);
  const comment =
    already ??
    (await client.request<{ id: string; created?: string }>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`,
      { body: criteriaComment(input, client.browseUrl(input.issueKey), fingerprint) },
    ));

  // The approval-window check compares this against changelog timestamps,
  // which are Jira's clock - so this has to be Jira's clock too, not ours.
  // Skew between the two machines would otherwise shift the window in which
  // an edit invalidates an approval, in either direction. Jira's own record
  // of when the comment landed is the `created` field on its response; our
  // local time is a fallback only for a malformed response, not the norm.
  const postedAt = comment.created ?? new Date().toISOString();

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
      recovered: Boolean(already),
    },
  });

  return {
    wrote: true,
    reason: already
      ? `recovered from an incomplete previous write - comment already existed, property record completed`
      : `posted ${input.criteria.length} criteria`,
    fingerprint,
  };
}

function driftComment(): AdfNode {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text:
              'spec2test: the requirement text changed after these criteria were approved, ' +
              'so the approval no longer applies. Existing tests keep running, but stop ' +
              'counting as certified until the criteria are re-approved.',
          },
        ],
      },
    ],
  } as AdfNode;
}

/** Mark the ticket stale after drift, so the PO learns it from Jira. */
export async function postDrift(
  client: JiraClient,
  issueKey: string,
  drift: { approvedHash: string; currentHash: string },
  options: { fields?: FieldMap; dryRun?: boolean } = {},
): Promise<WriteOutcome> {
  const fields = options.fields ?? loadFieldMap();
  const fingerprint = contentHash(`stale:${drift.currentHash}`);
  const staleFields = { [fields.verificationStatus]: { value: VERIFICATION_STATUS.stale } };

  const existing = await readProperty(client, issueKey);
  if (existing?.fingerprint === fingerprint) {
    return {
      wrote: false,
      reason: 'drift already reported for this text',
      fingerprint,
      ...(options.dryRun ? { dryRun: true } : {}),
    };
  }

  if (options.dryRun) {
    return {
      wrote: false,
      dryRun: true,
      reason: 'preview: would report drift on the ticket',
      fingerprint,
      preview: { comment: driftComment(), fields: staleFields },
    };
  }

  await client.request('PUT', `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    fields: staleFields,
  });

  await client.request('POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    body: driftComment(),
  });

  // Merge, never replace: `criteria_posted` / `criteria_posted_at` are the
  // only record of what the PO was actually shown, and the approval-window
  // check in reconcile.ts depends on them surviving. Overwriting the property
  // here previously wiped both, which silently turned that check into a
  // no-op - any future approval was honoured with no evidence behind it.
  await writeProperty(client, issueKey, {
    ...existing,
    coverage_state: 'stale',
    fingerprint,
    requirement_hash: drift.currentHash,
    updated_at: new Date().toISOString(),
  });

  return { wrote: true, reason: 'drift reported on the ticket', fingerprint };
}

/**
 * Report a gate outcome the PO would otherwise never see: an approval that
 * arrived during an edit window and was refused, or one that only closed some
 * of the criteria. Without this, the ticket keeps reading "Criteria Approved"
 * while the service has quietly not honoured it - the PO has no way to know
 * gate 1 is not actually closed.
 *
 * Fingerprinted on the outcome so a repeated reconcile with nothing new to
 * say writes nothing, the same discipline postCriteria and postDrift follow.
 */
export async function postRefusal(
  client: JiraClient,
  issueKey: string,
  outcome: { action: string; detail: string },
  options: { dryRun?: boolean } = {},
): Promise<WriteOutcome> {
  const fingerprint = contentHash(`${outcome.action}:${outcome.detail}`);

  const existing = await readProperty(client, issueKey);
  if (existing?.fingerprint === fingerprint) {
    return {
      wrote: false,
      reason: 'already reported for this outcome',
      fingerprint,
      ...(options.dryRun ? { dryRun: true } : {}),
    };
  }

  const comment = textToAdf(`spec2test: ${outcome.detail}`);
  if (options.dryRun) {
    return {
      wrote: false,
      dryRun: true,
      reason: `preview: would report ${outcome.action} on the ticket`,
      fingerprint,
      preview: { comment, fields: {} },
    };
  }

  await client.request('POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    body: comment,
  });

  await writeProperty(client, issueKey, {
    ...existing,
    coverage_state: outcome.action,
    fingerprint,
    updated_at: new Date().toISOString(),
  });

  return { wrote: true, reason: `${outcome.action} reported on the ticket`, fingerprint };
}

export interface VerificationCriterionView {
  id: string;
  body: string;
  stateAffecting: boolean;
  covered: boolean;
}

export interface PostVerificationInput {
  issueKey: string;
  requirementHash: string;
  state: 'awaiting_test_approval' | 'verifying' | 'contract_verified' | 'weak' | 'failing';
  criteria: VerificationCriterionView[];
}

/**
 * Maps the requirement-level rollup (service/src/verification.ts) onto the
 * PO-facing field. `Certified` is never a value this can produce - see the
 * comment on VERIFICATION_STATUS in read.ts. `awaiting_test_approval` and
 * `verifying` are collapsed onto the closest existing field values
 * (`Tests Drafted` / `Tests Approved`) rather than adding new ones - the
 * finer-grained distinction the DB enum makes isn't PO-relevant yet, and
 * keeping the live field's option list small is deliberate for this step.
 */
function verificationStatusValue(state: PostVerificationInput['state']): string {
  switch (state) {
    case 'awaiting_test_approval':
      return VERIFICATION_STATUS.testsDrafted;
    case 'verifying':
      return VERIFICATION_STATUS.testsApproved;
    case 'contract_verified':
      return VERIFICATION_STATUS.contractVerified;
    case 'weak':
      return VERIFICATION_STATUS.weak;
    case 'failing':
      return VERIFICATION_STATUS.failing;
  }
}

function verificationFingerprint(input: PostVerificationInput): string {
  const payload = JSON.stringify({
    state: input.state,
    requirementHash: input.requirementHash,
    criteria: input.criteria
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => [c.id, c.covered, c.stateAffecting]),
  });
  return contentHash(payload);
}

function verificationComment(input: PostVerificationInput, browseUrl: string, fingerprint: string): AdfNode {
  const certifiedCount = input.criteria.filter((c) => c.covered).length;

  const heading = {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: `spec2test verification: ${verificationStatusValue(input.state)} (${certifiedCount}/${input.criteria.length} criteria).`,
        marks: [{ type: 'strong' }],
      },
    ],
  };

  const list = {
    type: 'bulletList',
    content: input.criteria.map((c) => ({
      type: 'listItem',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `${c.covered ? '✓' : '✗'} ${c.body}` },
            ...(c.stateAffecting
              ? [
                  {
                    type: 'text',
                    text:
                      '  [state-affecting: this test’s assertions are proven sound; the app’s ' +
                      'own enforcement of this rule is not yet proven - tier-1 evidence only]',
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

  const marker = {
    type: 'paragraph',
    content: [{ type: 'text', text: `${MARKER_PREFIX}${fingerprint}` }],
  };

  return { type: 'doc', version: 1, content: [heading, list, footer, marker] } as AdfNode;
}

/**
 * Push the verification rollup (state + per-criterion coverage) onto the
 * ticket. Same idempotency discipline as postCriteria: fingerprinted, a
 * repeated call with nothing new to say writes nothing.
 */
export async function postVerification(
  client: JiraClient,
  input: PostVerificationInput,
  options: { fields?: FieldMap; dryRun?: boolean } = {},
): Promise<WriteOutcome> {
  const fields = options.fields ?? loadFieldMap();
  const fingerprint = verificationFingerprint(input);

  const existing = await readProperty(client, input.issueKey);
  if (existing?.fingerprint === fingerprint) {
    return {
      wrote: false,
      reason: 'verification unchanged since the last write',
      fingerprint,
      ...(options.dryRun ? { dryRun: true } : {}),
    };
  }

  const certifiedCount = input.criteria.filter((c) => c.covered).length;
  const now = new Date().toISOString();
  const verificationFields = {
    [fields.verificationStatus]: { value: verificationStatusValue(input.state) },
    [fields.criteriaCertified]: certifiedCount,
    [fields.criteriaTotal]: input.criteria.length,
  };

  if (options.dryRun) {
    const posted = await findPostedComment(client, input.issueKey, fingerprint);
    if (posted) {
      return {
        wrote: false,
        dryRun: true,
        reason: 'preview: this comment is already on the ticket; a confirmed call would only finish recording it',
        fingerprint,
      };
    }
    return {
      wrote: false,
      dryRun: true,
      reason: `preview: would post verification: ${verificationStatusValue(input.state)}`,
      fingerprint,
      // Last Verified is deliberately absent: it is stamped with the wall clock
      // when the write is confirmed, so a preview cannot honestly show it.
      preview: {
        comment: verificationComment(input, client.browseUrl(input.issueKey), fingerprint),
        fields: verificationFields,
      },
    };
  }

  await client.request('PUT', `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}`, {
    fields: { ...verificationFields, [fields.lastVerified]: now },
  });

  const already = await findPostedComment(client, input.issueKey, fingerprint);
  const comment =
    already ??
    (await client.request<{ id: string; created?: string }>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`,
      { body: verificationComment(input, client.browseUrl(input.issueKey), fingerprint) },
    ));
  const postedAt = comment.created ?? now;

  await writeProperty(client, input.issueKey, {
    ...existing,
    coverage_state: input.state,
    fingerprint,
    requirement_hash: input.requirementHash,
    updated_at: postedAt,
  });

  await audit({
    event: 'jira_verification_posted',
    subject: `issue:${input.issueKey}`,
    actor: 'system',
    detail: {
      issue_key: input.issueKey,
      state: input.state,
      certified: certifiedCount,
      total: input.criteria.length,
      fingerprint,
    },
  });

  return {
    wrote: true,
    reason: already
      ? 'recovered from an incomplete previous write - comment already existed, property record completed'
      : `posted verification: ${verificationStatusValue(input.state)}`,
    fingerprint,
  };
}

export async function readProperty(client: JiraClient, issueKey: string): Promise<PipelineProperty | undefined> {
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

export async function writeProperty(client: JiraClient, issueKey: string, value: PipelineProperty): Promise<void> {
  await client.request('PUT', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/properties/${PROPERTY_KEY}`, value);
}
