/**
 * The sequence the unit-per-transition tests never drove: approve, drift,
 * re-present, re-approve. This is where the Gate 1 guarantee actually broke -
 * every individual transition looked fine in isolation.
 *
 * Runs against real Postgres (gate logic is SQL-level and a mock would prove
 * nothing about it) and a scripted fake Jira (see test/helpers/fake-jira.ts),
 * so the sequence is deterministic and fast rather than depending on a real
 * ticket's unresettable changelog.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, getAdminPool, closePool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { contentHash } from '../src/hash.ts';
import { reconcile } from '../src/jira/reconcile.ts';
import { postCriteria } from '../src/jira/write.ts';
import { fakeJira } from './helpers/fake-jira.ts';
import type { FakeJira } from './helpers/fake-jira.ts';

process.env.MIGRATION_DATABASE_URL ??= 'postgresql://spec2test:spec2test@localhost:5435/spec2test';
process.env.DATABASE_URL ??= 'postgresql://spec2test_app:spec2test_app@localhost:5435/spec2test';

const ISSUE = 'FAKE-1';
let requirementId: string;
let criterionIds: string[];

before(async () => {
  await migrate();
});

beforeEach(async () => {
  await getAdminPool().query('TRUNCATE project, audit_event RESTART IDENTITY CASCADE');
});

after(async () => {
  await closePool();
});

async function seed(summary: string, description: string) {
  const pool = getPool();
  const text = `${summary}\n\n${description}`;
  const hash = contentHash(text);

  const project = await pool.query(
    `INSERT INTO project (key, jira_project_key) VALUES ('FAKE-PILOT','FAKE') RETURNING id`,
  );
  const req = await pool.query(
    `INSERT INTO requirement
       (project_id, jira_issue_key, title, body, source_text_hash, state,
        drafted_by_model, prompt_version, grounding_hash, temperature)
     VALUES ($1,$2,$3,$4,$5,'awaiting_requirement_approval','claude-opus-5','draft-v1',$5,0)
     RETURNING id`,
    [project.rows[0].id, ISSUE, summary, description, hash],
  );
  requirementId = req.rows[0].id;

  const bodies = ['criterion one', 'criterion two'];
  criterionIds = [];
  for (const [i, body] of bodies.entries()) {
    const row = await pool.query(
      `INSERT INTO criterion (requirement_id, ordinal, body, content_hash, state_affecting)
       VALUES ($1,$2,$3,$4,false) RETURNING id`,
      [requirementId, i + 1, body, contentHash(body)],
    );
    criterionIds.push(row.rows[0].id);
  }

  return { hash };
}

async function criteriaRows() {
  const { rows } = await getPool().query(
    'SELECT ordinal, state FROM criterion WHERE requirement_id = $1 ORDER BY ordinal',
    [requirementId],
  );
  return rows as { ordinal: number; state: string }[];
}

async function requirementState(): Promise<string> {
  const { rows } = await getPool().query('SELECT state FROM requirement WHERE id = $1', [
    requirementId,
  ]);
  return rows[0].state;
}

async function presentCriteria(jira: FakeJira, hash: string) {
  const { rows } = await getPool().query(
    'SELECT id, ordinal, body, content_hash, state_affecting FROM criterion WHERE requirement_id = $1 ORDER BY ordinal',
    [requirementId],
  );
  return postCriteria(jira.client, {
    issueKey: ISSUE,
    requirementHash: hash,
    criteria: rows.map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      body: r.body,
      contentHash: r.content_hash,
      stateAffecting: r.state_affecting,
    })),
  });
}

describe('the post-drift lifecycle', () => {
  it('approve -> drift -> re-present -> re-approve ends with everything approved', async () => {
    const { hash } = await seed('members hold up to 3 books', 'a member may hold at most 3 books');
    const jira = fakeJira({
      key: ISSUE,
      summary: 'members hold up to 3 books',
      description: 'a member may hold at most 3 books',
      changelog: [],
    });

    // 1. Present, then approve.
    await presentCriteria(jira, hash);
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T09:00:00.000+0530');
    const firstClose = await reconcile(jira.client, ISSUE);
    assert.equal(firstClose.action, 'gate1_closed', firstClose.detail);
    assert.equal(firstClose.gate1?.criteriaClosed, 2);
    assert.deepEqual(
      (await criteriaRows()).map((r) => r.state),
      ['approved', 'approved'],
    );

    // 2. Drift: the requirement text changes after approval.
    jira.editSummary('members hold up to 5 books', '2026-09-11T09:30:00.000+0530');
    const drifted = await reconcile(jira.client, ISSUE);
    assert.equal(drifted.action, 'drift_detected', drifted.detail);
    assert.deepEqual(
      (await criteriaRows()).map((r) => r.state),
      ['stale', 'stale'],
    );
    assert.equal(await requirementState(), 'stale');

    // The failure this test exists to catch: re-approving from here must not
    // be a silent no-op, and the reconcile must not claim success while the
    // rows are untouched.
    const staleActor = await reconcile(jira.client, ISSUE, { dryRun: true });
    assert.notEqual(staleActor.action, 'gate1_closed', 'reported closed while still stale');

    // 3. Re-present against the new text, then re-approve.
    //
    // Updating requirement.source_text_hash after a redraft is its own
    // feature (Phase B / B1 - there is no route for it yet). Standing in for
    // it here with a direct update keeps this test scoped to what Phase A
    // actually fixes: whether re-approval works once the local state agrees
    // with Jira, not whether the redraft path itself exists.
    const newHash = contentHash('members hold up to 5 books\n\na member may hold at most 3 books');
    await getPool().query(
      `UPDATE requirement SET source_text_hash = $1, state = 'awaiting_requirement_approval' WHERE id = $2`,
      [newHash, requirementId],
    );
    const outcome = await presentCriteria(jira, newHash);
    assert.equal(outcome.wrote, true, 'did not re-post after drift');

    jira.setVerificationStatus('Criteria Drafted', '2026-09-11T10:05:00.000+0530');
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T10:10:00.000+0530');
    const secondClose = await reconcile(jira.client, ISSUE);

    // 4. Everything must actually be approved, and the reconcile must not
    // claim it happened unless it did.
    assert.equal(secondClose.action, 'gate1_closed', secondClose.detail);
    assert.equal(secondClose.gate1?.criteriaClosed, 2, 'reported closing criteria it did not close');
    assert.deepEqual(
      (await criteriaRows()).map((r) => r.state),
      ['approved', 'approved'],
      'criteria never recovered from stale',
    );
  });

  it('reconcile never reports gate1_closed unless every criterion is actually approved', async () => {
    const { hash } = await seed('t', 'body');
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'body', changelog: [] });
    await presentCriteria(jira, hash);

    // Approve while the presented-hash record is missing entirely (property
    // wiped, or never written) - there is no evidence the PO saw anything.
    jira.state.property = undefined;
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T09:00:00.000+0530');

    const result = await reconcile(jira.client, ISSUE);
    assert.equal(result.action, 'gate1_blocked', result.detail);
    assert.deepEqual(
      (await criteriaRows()).map((r) => r.state),
      ['proposed', 'proposed'],
      'approved a criterion with no presentation record behind it',
    );
  });

  it('an edit inside the posted-to-approved window is still caught after a property write', async () => {
    const { hash } = await seed('t2', 'body2');
    const jira = fakeJira({ key: ISSUE, summary: 't2', description: 'body2', changelog: [] });
    await presentCriteria(jira, hash);

    // Edited between posting and approving.
    jira.editSummary('t2 amended', '2026-09-11T09:15:00.000+0530');
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T09:20:00.000+0530');

    const result = await reconcile(jira.client, ISSUE);
    assert.notEqual(result.action, 'gate1_closed', 'honoured an approval made during an edit window');
  });
});
