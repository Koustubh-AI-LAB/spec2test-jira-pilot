/**
 * Preview, then confirm. The whole value of a preview is that the body you read
 * is the body that lands - so the assertions here compare the previewed
 * comment against what the confirmed write actually sent to Jira, not merely
 * that "a preview came back".
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { postCriteria, postDrift, postRefusal, postVerification } from '../src/jira/write.ts';
import type { PostCriteriaInput, PostVerificationInput } from '../src/jira/write.ts';
import { fakeJira } from './helpers/fake-jira.ts';
import type { FakeJira } from './helpers/fake-jira.ts';
import { useTestDatabase } from './helpers/db.ts';

await useTestDatabase();

const ISSUE = 'FAKE-1';

// The real writes audit to Postgres, so the confirm half needs it migrated.
before(async () => {
  await migrate();
});
after(async () => {
  await closePool();
});

function ticket(): FakeJira {
  return fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
}

const criteriaInput: PostCriteriaInput = {
  issueKey: ISSUE,
  requirementHash: 'a'.repeat(64),
  criteria: [
    { id: 'c1', ordinal: 1, body: 'a 4th loan is refused', contentHash: 'h1', stateAffecting: true },
    { id: 'c2', ordinal: 2, body: 'a member can list loans', contentHash: 'h2', stateAffecting: false },
  ],
};

const verificationInput: PostVerificationInput = {
  issueKey: ISSUE,
  requirementHash: 'a'.repeat(64),
  state: 'contract_verified',
  criteria: [
    { id: 'c1', body: 'a 4th loan is refused', stateAffecting: true, covered: true },
    { id: 'c2', body: 'a member can list loans', stateAffecting: false, covered: false },
  ],
};

/** The comment body a confirmed write POSTed, as Jira would have received it. */
function postedComment(jira: FakeJira): unknown {
  const writes = jira.writes.filter((w) => w.method === 'POST' && w.path.endsWith('/comment'));
  assert.equal(writes.length, 1, `expected exactly one comment POST, saw ${writes.length}`);
  return (writes[0]!.body as { body: unknown }).body;
}

function putFields(jira: FakeJira): Record<string, unknown> {
  const puts = jira.writes.filter((w) => w.method === 'PUT' && /\/issue\/[^/]+$/.test(w.path));
  assert.equal(puts.length, 1, `expected exactly one issue PUT, saw ${puts.length}`);
  return (puts[0]!.body as { fields: Record<string, unknown> }).fields;
}

describe('postCriteria dry run', () => {
  it('writes nothing, and previews exactly what a confirmed call sends', async () => {
    const jira = ticket();

    const preview = await postCriteria(jira.client, criteriaInput, { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.wrote, false);
    assert.equal(jira.writes.length, 0, 'a dry run wrote to Jira');
    assert.ok(preview.preview, 'no preview returned');

    const confirmed = await postCriteria(jira.client, criteriaInput);
    assert.equal(confirmed.wrote, true);
    assert.equal(confirmed.fingerprint, preview.fingerprint, 'preview and confirm disagree on the fingerprint');
    assert.deepEqual(preview.preview!.comment, postedComment(jira), 'the previewed comment is not what landed');
    assert.deepEqual(preview.preview!.fields, putFields(jira), 'the previewed fields are not what landed');
  });

  it('the previewed comment carries the same fingerprint marker that crash recovery searches for', async () => {
    const jira = ticket();
    const preview = await postCriteria(jira.client, criteriaInput, { dryRun: true });
    assert.match(JSON.stringify(preview.preview!.comment), new RegExp(`spec2test:fingerprint:${preview.fingerprint}`));
  });

  it('after a confirmed write, a preview reports "unchanged" and offers nothing to post', async () => {
    const jira = ticket();
    await postCriteria(jira.client, criteriaInput);
    const writesBefore = jira.writes.length;

    const preview = await postCriteria(jira.client, criteriaInput, { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.preview, undefined);
    assert.match(preview.reason, /unchanged/);
    assert.equal(jira.writes.length, writesBefore);
  });

  it('when the comment landed but the property write crashed, says so instead of previewing a duplicate', async () => {
    const jira = ticket();
    await postCriteria(jira.client, criteriaInput);
    jira.state.property = undefined; // the crash window: comment exists, bookkeeping does not

    const preview = await postCriteria(jira.client, criteriaInput, { dryRun: true });
    assert.equal(preview.preview, undefined, 'previewed a comment that is already on the ticket');
    assert.match(preview.reason, /already on the ticket/);
  });

  // Step 6 (failure-mode table, "partial Jira sync recorded
  // incomplete"): the dry-run test above only proves the preview
  // *recognizes* the crash window; this proves a real (confirmed) retry
  // actually recovers through it - findPostedComment finds the comment
  // already on the ticket and completes the property write, rather than
  // posting a second, duplicate comment.
  it('a confirmed retry after the same crash recovers via findPostedComment, without a duplicate comment', async () => {
    const jira = ticket();
    await postCriteria(jira.client, criteriaInput);
    assert.equal(jira.state.comments?.length, 1, 'premise: exactly one comment exists');
    jira.state.property = undefined; // the crash window: comment exists, bookkeeping does not

    const recovered = await postCriteria(jira.client, criteriaInput);
    assert.equal(recovered.wrote, true);
    assert.match(recovered.reason, /recovered from an incomplete previous write/);
    assert.equal(jira.state.comments?.length, 1, 'a second, duplicate comment was posted');
    assert.ok(jira.state.property, 'the property write was never completed on retry');

    const commentPosts = jira.writes.filter((w) => w.method === 'POST' && w.path.endsWith('/comment'));
    assert.equal(commentPosts.length, 1, 'only the original write should have POSTed a comment');
  });

  it('a changed criterion produces a different fingerprint and a fresh preview', async () => {
    const jira = ticket();
    await postCriteria(jira.client, criteriaInput);

    const reworded: PostCriteriaInput = {
      ...criteriaInput,
      criteria: [{ ...criteriaInput.criteria[0]!, body: 'a 5th loan is refused', contentHash: 'h1-new' }, criteriaInput.criteria[1]!],
    };
    const preview = await postCriteria(jira.client, reworded, { dryRun: true });
    assert.ok(preview.preview, 'a reworded criterion was reported as unchanged');
    assert.match(JSON.stringify(preview.preview.comment), /5th loan/);
  });
});

describe('postVerification dry run', () => {
  it('previews exactly what a confirmed call sends', async () => {
    const jira = ticket();

    const preview = await postVerification(jira.client, verificationInput, { dryRun: true });
    assert.equal(jira.writes.length, 0, 'a dry run wrote to Jira');
    assert.ok(preview.preview);

    const confirmed = await postVerification(jira.client, verificationInput);
    assert.equal(confirmed.fingerprint, preview.fingerprint);
    assert.deepEqual(preview.preview.comment, postedComment(jira));
  });

  it('omits Last Verified from the preview, because it is stamped at confirm time', async () => {
    const jira = ticket();
    const preview = await postVerification(jira.client, verificationInput, { dryRun: true });
    await postVerification(jira.client, verificationInput);

    const sent = putFields(jira);
    const previewed = preview.preview!.fields;
    assert.ok('customfield_10110' in sent, 'premise: a confirmed write stamps Last Verified');
    assert.ok(!('customfield_10110' in previewed), 'a preview cannot know the confirm-time clock');
    const { customfield_10110: _stamped, ...rest } = sent;
    assert.deepEqual(previewed, rest, 'every other field must match exactly');
  });
});

describe('postDrift and postRefusal dry run', () => {
  const drift = { approvedHash: 'a'.repeat(64), currentHash: 'b'.repeat(64) };

  it('drift: writes nothing and previews the comment a confirmed call sends', async () => {
    const jira = ticket();
    const preview = await postDrift(jira.client, ISSUE, drift, { dryRun: true });
    assert.equal(jira.writes.length, 0);
    assert.ok(preview.preview);

    await postDrift(jira.client, ISSUE, drift);
    assert.deepEqual(preview.preview.comment, postedComment(jira));
    assert.deepEqual(preview.preview.fields, putFields(jira));
  });

  it('refusal: writes nothing and previews the comment a confirmed call sends', async () => {
    const jira = ticket();
    const outcome = { action: 'gate1_blocked', detail: 'no presentation record for one criterion' };

    const preview = await postRefusal(jira.client, ISSUE, outcome, { dryRun: true });
    assert.equal(jira.writes.length, 0);
    assert.ok(preview.preview);

    await postRefusal(jira.client, ISSUE, outcome);
    assert.deepEqual(preview.preview.comment, postedComment(jira));
  });
});
