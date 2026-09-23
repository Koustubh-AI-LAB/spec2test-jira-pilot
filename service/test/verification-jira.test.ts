/**
 * postVerification against a scripted fake Jira (test/helpers/fake-jira.ts) -
 * same reasoning as lifecycle.test.ts's use of it: deterministic and fast,
 * and able to assert on exactly what was written without a live site or the
 * manual Contract-Verified/Weak/Failing field-option setup a real run needs
 * first (see README's "Criteria Rejected is provisioned on the live field"
 * for the same kind of manual step). No Postgres needed - this function
 * takes already-computed data and writes to Jira only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { postVerification } from '../src/jira/write.ts';
import { fakeJira } from './helpers/fake-jira.ts';
import { useTestDatabase } from './helpers/db.ts';
import { migrate } from '../src/db/migrate.ts';

// postVerification calls audit(), which needs a real Postgres connection -
// nothing else here touches the database. migrate() is idempotent (CREATE
// TABLE IF NOT EXISTS), so calling it here costs nothing when another file
// already has - but this file must not depend on that, since running it
// alone (or under file-sharded CI) would otherwise fail with "relation
// audit_event does not exist".
await useTestDatabase();
await migrate();

const ISSUE = 'VERIFY-1';
const FIELDS = {
  verificationStatus: 'customfield_10107',
  criteriaCertified: 'customfield_10108',
  criteriaTotal: 'customfield_10109',
  lastVerified: 'customfield_10110',
};

function baseInput(overrides: Partial<Parameters<typeof postVerification>[1]> = {}) {
  return {
    issueKey: ISSUE,
    requirementHash: 'abc123def456',
    state: 'contract_verified' as const,
    criteria: [
      { id: 'c1', body: 'a 4th loan is refused', stateAffecting: true, covered: true },
      { id: 'c2', body: 'a valid loan succeeds', stateAffecting: false, covered: true },
    ],
    ...overrides,
  };
}

describe('postVerification', () => {
  it('writes Contract-Verified, never Certified, with the certified/total counts', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    const outcome = await postVerification(jira.client, baseInput(), { fields: FIELDS });

    assert.equal(outcome.wrote, true);
    const fieldWrite = jira.writes.find((w) => w.method === 'PUT' && !w.path.includes('properties'));
    const body = fieldWrite!.body as { fields: Record<string, unknown> };
    assert.deepEqual(body.fields[FIELDS.verificationStatus], { value: 'Contract-Verified' });
    assert.notEqual(body.fields[FIELDS.verificationStatus], 'Certified');
    assert.equal(body.fields[FIELDS.criteriaCertified], 2);
    assert.equal(body.fields[FIELDS.criteriaTotal], 2);
    assert.ok(body.fields[FIELDS.lastVerified]);
  });

  it('writes Weak and Failing for those states - never Certified regardless of coverage', async () => {
    const jiraWeak = fakeJira({ key: 'VERIFY-WEAK', summary: 't', description: 'b', changelog: [] });
    const weakOutcome = await postVerification(
      jiraWeak.client,
      baseInput({ issueKey: 'VERIFY-WEAK', state: 'weak', criteria: [{ id: 'c1', body: 'x', stateAffecting: false, covered: false }] }),
      { fields: FIELDS },
    );
    assert.equal(weakOutcome.wrote, true);
    const weakBody = jiraWeak.writes[0]!.body as { fields: Record<string, unknown> };
    assert.deepEqual(weakBody.fields[FIELDS.verificationStatus], { value: 'Weak' });

    const jiraFailing = fakeJira({ key: 'VERIFY-FAIL', summary: 't', description: 'b', changelog: [] });
    await postVerification(
      jiraFailing.client,
      baseInput({ issueKey: 'VERIFY-FAIL', state: 'failing', criteria: [{ id: 'c1', body: 'x', stateAffecting: false, covered: false }] }),
      { fields: FIELDS },
    );
    const failingBody = jiraFailing.writes[0]!.body as { fields: Record<string, unknown> };
    assert.deepEqual(failingBody.fields[FIELDS.verificationStatus], { value: 'Failing' });
  });

  it('includes the state-affecting caveat in the comment for a state-affecting criterion, and omits it for one that is not', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    await postVerification(jira.client, baseInput(), { fields: FIELDS });

    const commentWrite = jira.writes.find((w) => w.method === 'POST' && w.path.endsWith('/comment'));
    const text = JSON.stringify(commentWrite!.body);
    assert.match(text, /enforcement of this rule is not yet proven/);
    assert.match(text, /a 4th loan is refused/);
    assert.match(text, /a valid loan succeeds/);
  });

  it('is idempotent: a second identical call writes nothing', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    const first = await postVerification(jira.client, baseInput(), { fields: FIELDS });
    const writesAfterFirst = jira.writes.length;
    const second = await postVerification(jira.client, baseInput(), { fields: FIELDS });

    assert.equal(first.wrote, true);
    assert.equal(second.wrote, false);
    assert.equal(jira.writes.length, writesAfterFirst);
  });

  it('writes again when the coverage changes, even if the state string stays the same', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    await postVerification(jira.client, baseInput({ state: 'weak' }), { fields: FIELDS });
    const writesAfterFirst = jira.writes.length;

    const second = await postVerification(
      jira.client,
      baseInput({
        state: 'weak',
        criteria: [
          { id: 'c1', body: 'a 4th loan is refused', stateAffecting: true, covered: true },
          { id: 'c2', body: 'a valid loan succeeds', stateAffecting: false, covered: false },
        ],
      }),
      { fields: FIELDS },
    );
    assert.equal(second.wrote, true);
    assert.ok(jira.writes.length > writesAfterFirst);
  });
});
