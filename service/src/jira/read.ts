import type { JiraClient } from './client.ts';
import { requirementText, adfToText } from './adf.ts';
import { contentHash } from '../hash.ts';
import { byInstant, instant } from './time.ts';
import { ServiceError } from '../errors.ts';

/**
 * Everything the reconcile needs from Jira, fetched in the shape it needs it.
 *
 * The pipeline reads a ticket's *current* state every run and works out what
 * changed - there is no webhook and nothing has to be reachable from Jira. The
 * consequence is that this module is the only source of truth about what the
 * ticket says, so it fetches the changelog too: "who approved, and when" is
 * only answerable from history.
 */

/** Field ids are per-site. Created in the S2T project; see README. */
export interface FieldMap {
  verificationStatus: string;
  criteriaCertified: string;
  criteriaTotal: string;
  lastVerified: string;
}

export const DEFAULT_FIELDS: FieldMap = {
  verificationStatus: 'customfield_10107',
  criteriaCertified: 'customfield_10108',
  criteriaTotal: 'customfield_10109',
  lastVerified: 'customfield_10110',
};

export function loadFieldMap(env: NodeJS.ProcessEnv = process.env): FieldMap {
  return {
    verificationStatus: env.JIRA_FIELD_VERIFICATION_STATUS ?? DEFAULT_FIELDS.verificationStatus,
    criteriaCertified: env.JIRA_FIELD_CRITERIA_CERTIFIED ?? DEFAULT_FIELDS.criteriaCertified,
    criteriaTotal: env.JIRA_FIELD_CRITERIA_TOTAL ?? DEFAULT_FIELDS.criteriaTotal,
    lastVerified: env.JIRA_FIELD_LAST_VERIFIED ?? DEFAULT_FIELDS.lastVerified,
  };
}

/**
 * Confirms every configured field id actually exists in this Jira site.
 *
 * A missing or mistyped id is the one failure mode nothing else catches: a
 * read of an unknown custom field just comes back `undefined`, so
 * `Verification Status` silently reads as "(unset)" forever and the pipeline
 * sits at `gate1_pending` with no error anywhere. `.env` fell into exactly
 * this - it shipped with none of the JIRA_FIELD_* variables set, and only
 * worked because DEFAULT_FIELDS happened to hardcode this site's own ids.
 * A write against a bad id at least fails loud (Jira refuses it); a read
 * never does, which is why this has to be checked up front rather than left
 * to surface on its own.
 */
export async function validateFieldMap(client: JiraClient, fields: FieldMap): Promise<void> {
  const known = await client.get<{ id: string }[]>('/rest/api/3/field');
  const knownIds = new Set(known.map((f) => f.id));

  const missing = Object.entries(fields).filter(([, id]) => !knownIds.has(id));
  if (missing.length > 0) {
    throw new ServiceError(
      'jira_field_not_found',
      'these configured field ids do not exist on this Jira site: ' +
        missing.map(([key, id]) => `${key}=${id}`).join(', ') +
        " - check JIRA_FIELD_* in .env against the site's actual custom field ids",
    );
  }
}

/**
 * The PO's Gate 1 signal, and (from `contractVerified` on) the PO-facing
 * rollup written by postVerification. `certified: 'Certified'` never
 * appears here on purpose: tier-1-only evidence proves
 * assertion soundness, not that the app enforces the rule, so this phase is
 * only ever honest calling it `Contract-Verified`. `Certified` is reserved
 * for tier-2 evidence and therefore unreachable until then.
 *
 * `Contract-Verified`, `Weak` and `Failing` need to be added as select
 * options on the live `Verification Status` custom field before a live run
 * writes them - same manual step as `Criteria Rejected` (see README).
 */
export const VERIFICATION_STATUS = {
  notStarted: 'Not Started',
  criteriaDrafted: 'Criteria Drafted',
  criteriaApproved: 'Criteria Approved',
  criteriaRejected: 'Criteria Rejected',
  testsDrafted: 'Tests Drafted',
  testsApproved: 'Tests Approved',
  contractVerified: 'Contract-Verified',
  weak: 'Weak',
  failing: 'Failing',
  stale: 'Stale',
} as const;

export interface ChangelogEntry {
  at: string;
  authorAccountId: string;
  authorName: string;
  field: string;
  from: string;
  to: string;
}

export interface CommentEntry {
  id: string;
  created: string;
  authorAccountId: string;
  authorName: string;
  /** Flattened via adfToText - same treatment as the requirement description. */
  text: string;
}

export interface TicketSnapshot {
  key: string;
  summary: string;
  status: string;
  labels: string[];
  /** Canonical requirement text: summary + flattened description. */
  requirementText: string;
  /** Hash of the above. The value Gate 1 approval is bound to. */
  requirementHash: string;
  verificationStatus: string | undefined;
  updated: string;
  changelog: ChangelogEntry[];
  /** Our own bookkeeping, stored on the ticket itself. */
  property: PipelineProperty | undefined;
  /** Oldest first, same convention as changelog. Used to find a rejection's reason. */
  comments: CommentEntry[];
}

/**
 * Stored as the `spec2test` issue property. Lets a re-run tell "nothing has
 * changed, write nothing" from "genuinely new", without a second datastore and
 * without re-posting the same comment on every invocation.
 */
export interface PipelineProperty {
  coverage_state: string;
  /** Hash of the payload we last wrote, not of the requirement. */
  fingerprint: string;
  requirement_hash?: string;
  /** When the criteria comment went up. Bounds the "what did they see" window. */
  criteria_posted_at?: string;
  /**
   * criterion id -> content hash, exactly as presented in that comment. Gate 1
   * binds to these rather than to the rows' current hashes: the comment is the
   * presentation, so it is the thing the PO actually approved.
   */
  criteria_posted?: Record<string, string>;
  updated_at: string;
}

export const PROPERTY_KEY = 'spec2test';

interface RawIssue {
  key: string;
  fields: Record<string, unknown>;
}

interface RawChangelog {
  values: {
    created: string;
    author?: { accountId?: string; displayName?: string };
    items: { field: string; fieldId?: string; fromString?: string | null; toString?: string | null }[];
  }[];
}

export async function fetchTicket(
  client: JiraClient,
  issueKey: string,
  fields: FieldMap = loadFieldMap(),
): Promise<TicketSnapshot> {
  const wanted = ['summary', 'status', 'labels', 'description', 'updated', fields.verificationStatus].join(',');

  const issue = await client.get<RawIssue>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${wanted}`);

  const summary = String(issue.fields.summary ?? '');
  const text = requirementText(summary, issue.fields.description);

  const vs = issue.fields[fields.verificationStatus] as { value?: string } | null | undefined;
  const status = issue.fields.status as { name?: string } | undefined;

  return {
    key: issue.key,
    summary,
    status: status?.name ?? '',
    labels: (issue.fields.labels as string[] | undefined) ?? [],
    requirementText: text,
    requirementHash: contentHash(text),
    verificationStatus: vs?.value,
    updated: String(issue.fields.updated ?? ''),
    changelog: await fetchChangelog(client, issueKey),
    property: await fetchProperty(client, issueKey),
    comments: await fetchComments(client, issueKey),
  };
}

/**
 * Full changelog, oldest first. Paged deliberately rather than taking the
 * first page: the entry that matters is the PO's approval, and on a
 * long-running ticket that is not on page one.
 */
export async function fetchChangelog(client: JiraClient, issueKey: string): Promise<ChangelogEntry[]> {
  const out: ChangelogEntry[] = [];
  const pageSize = 100;

  for (let startAt = 0; ; startAt += pageSize) {
    const page = await client.get<RawChangelog & { isLast?: boolean; total?: number }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?startAt=${startAt}&maxResults=${pageSize}`,
    );
    for (const entry of page.values ?? []) {
      for (const item of entry.items ?? []) {
        out.push({
          at: entry.created,
          authorAccountId: entry.author?.accountId ?? '',
          authorName: entry.author?.displayName ?? '',
          field: item.fieldId ?? item.field,
          from: item.fromString ?? '',
          to: item.toString ?? '',
        });
      }
    }
    // Short page is checked in addition to isLast/total, not instead of them -
    // fetchComments' equivalent loop found this the hard way: relying only on
    // a field the response might not actually carry turns a missing field
    // into an infinite loop instead of an obvious error.
    const got = page.values?.length ?? 0;
    const seen = startAt + got;
    if (page.isLast || got === 0 || got < pageSize || (page.total !== undefined && seen >= page.total)) {
      break;
    }
  }

  // Sorted as instants, not strings: Jira sends offset timestamps (+0530) and a
  // lexicographic sort across mixed offsets orders them wrongly.
  return out.sort(byInstant);
}

interface RawComment {
  id: string;
  created: string;
  author?: { accountId?: string; displayName?: string };
  body: unknown;
}

/**
 * Oldest first, same convention as the changelog. Used to find the PO's own
 * explanation for a rejection - a select field has no free-text slot for one,
 * so the reason has to come from wherever they actually wrote it.
 */
export async function fetchComments(client: JiraClient, issueKey: string): Promise<CommentEntry[]> {
  const out: CommentEntry[] = [];
  const pageSize = 100;

  for (let startAt = 0; ; startAt += pageSize) {
    const page = await client.get<{ comments: RawComment[]; total?: number }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=${pageSize}&orderBy=created`,
    );
    for (const c of page.comments ?? []) {
      out.push({
        id: c.id,
        created: c.created,
        authorAccountId: c.author?.accountId ?? '',
        authorName: c.author?.displayName ?? '',
        text: adfToText(c.body),
      });
    }
    // A short page is the reliable exit signal on its own - fewer results
    // than requested means there is nothing left to fetch, regardless of
    // whether `total` came back at all. Relying on `total` alone found its
    // own bug during testing: a page that never reports `total` fetches the
    // same page forever, silently looping the caller straight into an OOM
    // rather than an obvious error.
    const got = page.comments?.length ?? 0;
    const seen = startAt + got;
    if (got === 0 || got < pageSize || (page.total !== undefined && seen >= page.total)) break;
  }

  // byInstant expects an `.at` field (the changelog's shape); comments carry
  // `.created` instead, so sort by instant() directly rather than reuse it.
  return out.sort((a, b) => instant(a.created) - instant(b.created));
}

export async function fetchProperty(client: JiraClient, issueKey: string): Promise<PipelineProperty | undefined> {
  try {
    const res = await client.get<{ value: PipelineProperty }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/properties/${PROPERTY_KEY}`,
    );
    return res.value;
  } catch (err) {
    // A ticket the pipeline has never touched has no property. That is the
    // normal first-run path, not an error.
    if (err && typeof err === 'object' && 'jiraStatus' in err && err.jiraStatus === 404) {
      return undefined;
    }
    throw err;
  }
}
