import { JiraError } from '../../src/jira/client.ts';
import type { JiraClient } from '../../src/jira/client.ts';
import type { PipelineProperty } from '../../src/jira/read.ts';

/**
 * A scripted stand-in for Jira, used only by the lifecycle tests.
 *
 * The live tests in jira.test.ts stay as they are: they prove what Jira
 * *actually does* - that a changelog records a field change the way we expect,
 * that a property round-trips. This fake proves something different and
 * complementary: that given a particular ticket state and a particular local
 * state, the reconcile reaches the right decision.
 *
 * Sequences are the whole point here. "Approve, then drift, then re-present,
 * then re-approve" is the path that was broken, and driving it against the
 * real Jira would be slow, would depend on a changelog that cannot be reset,
 * and could not simulate clock skew or a missing property at all.
 */

export interface ChangelogItem {
  at: string;
  accountId?: string;
  displayName?: string;
  field: string;
  from?: string;
  to?: string;
}

export interface FakeTicketState {
  key: string;
  summary: string;
  /** Plain text; wrapped into a minimal ADF document. */
  description: string;
  status?: string;
  labels?: string[];
  verificationStatus?: string;
  changelog: ChangelogItem[];
  property?: PipelineProperty;
}

export interface FakeJira {
  client: JiraClient;
  state: FakeTicketState;
  /** Every non-GET call, in order, for asserting what was written. */
  writes: { method: string; path: string; body: unknown }[];
  /** Applies a Verification Status change and records it in the changelog. */
  setVerificationStatus(value: string, at: string, accountId?: string): void;
  /** Edits the summary and records it, the way a PO editing the ticket would. */
  editSummary(summary: string, at: string): void;
}

const FIELD = 'customfield_10107';

function adf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: text
      .split(/\n{2,}/)
      .filter(Boolean)
      .map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
  };
}

export function fakeJira(initial: FakeTicketState): FakeJira {
  const state: FakeTicketState = { status: 'Backlog', labels: [], ...initial };
  const writes: { method: string; path: string; body: unknown }[] = [];

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (method !== 'GET') {
      writes.push({ method, path, body });
      // Property writes are what the reconcile later reads back, so the fake
      // has to actually store them or the round trip proves nothing.
      if (method === 'PUT' && path.includes('/properties/spec2test')) {
        state.property = body as PipelineProperty;
      }
      if (method === 'DELETE' && path.includes('/properties/spec2test')) {
        state.property = undefined;
      }
      if (method === 'POST' && path.endsWith('/comment')) {
        return { id: String(writes.length), created: '2026-09-11T10:00:00.000+0530' };
      }
      return undefined;
    }

    if (path.includes('/properties/spec2test')) {
      if (!state.property) throw new JiraError('jira_request_failed', 'not found', 404);
      return { value: state.property };
    }

    if (path.includes('/changelog')) {
      return {
        isLast: true,
        total: state.changelog.length,
        values: state.changelog.map((c) => ({
          created: c.at,
          author: { accountId: c.accountId ?? 'acct-po', displayName: c.displayName ?? 'PO' },
          items: [
            {
              field: c.field,
              fieldId: c.field,
              fromString: c.from ?? null,
              toString: c.to ?? null,
            },
          ],
        })),
      };
    }

    return {
      key: state.key,
      fields: {
        summary: state.summary,
        status: { name: state.status },
        labels: state.labels,
        description: adf(state.description),
        updated: '2026-09-11T10:00:00.000+0530',
        [FIELD]: state.verificationStatus ? { value: state.verificationStatus } : null,
      },
    };
  }

  const client = {
    request,
    get: (path: string) => request('GET', path),
    browseUrl: (key: string) => `https://example.atlassian.net/browse/${key}`,
    resolvedBase: 'https://example.atlassian.net',
    config: { siteUrl: 'https://example.atlassian.net', email: 'x@y.z', token: 't' },
    preflight: async () => ({ accountId: 'acct-po', displayName: 'PO', base: 'fake' }),
  } as unknown as JiraClient;

  return {
    client,
    state,
    writes,
    setVerificationStatus(value, at, accountId = 'acct-po') {
      state.changelog.push({
        at,
        accountId,
        field: FIELD,
        from: state.verificationStatus,
        to: value,
      });
      state.verificationStatus = value;
    },
    editSummary(summary, at) {
      state.changelog.push({ at, field: 'summary', from: state.summary, to: summary });
      state.summary = summary;
    },
  };
}
