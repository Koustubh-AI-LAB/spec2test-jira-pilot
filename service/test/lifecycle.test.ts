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
import type { FastifyInstance } from 'fastify';
import { getPool, getAdminPool, closePool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { buildServer } from '../src/api/server.ts';
import { contentHash } from '../src/hash.ts';
import { reconcile } from '../src/jira/reconcile.ts';
import { postCriteria } from '../src/jira/write.ts';
import { fakeJira } from './helpers/fake-jira.ts';
import type { FakeJira } from './helpers/fake-jira.ts';

process.env.MIGRATION_DATABASE_URL ??= 'postgresql://spec2test:spec2test@localhost:5435/spec2test';
process.env.DATABASE_URL ??= 'postgresql://spec2test_app:spec2test_app@localhost:5435/spec2test';

const ISSUE = 'FAKE-1';
const PROVENANCE = {
  drafted_by_model: 'claude-opus-5',
  prompt_version: 'draft-v1',
  grounding_hash: 'redraft-test',
  temperature: 0,
};
let requirementId: string;
let criterionIds: string[];
let app: FastifyInstance;

before(async () => {
  await migrate();
  app = buildServer();
  await app.ready();
});

beforeEach(async () => {
  await getAdminPool().query('TRUNCATE project, audit_event RESTART IDENTITY CASCADE');
});

after(async () => {
  await app?.close();
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

/** Calls the real POST /requirements/:id/redraft route via app.inject. */
async function redraft(title: string, body: string, criteria: string[]) {
  const res = await app.inject({
    method: 'POST',
    url: `/requirements/${requirementId}/redraft`,
    payload: { title, body, criteria: criteria.map((c) => ({ body: c })), ...PROVENANCE },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { requirement: { source_text_hash: string }; criteria: unknown[] };
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

    // 3. Redraft through the real route (B1), then re-present and re-approve.
    const redrafted = await redraft(
      'members hold up to 5 books',
      'members hold up to 5 books\n\na member may hold at most 3 books',
      ['criterion one', 'criterion two'],
    );
    const newHash = redrafted.requirement.source_text_hash;
    assert.deepEqual(
      (await criteriaRows()).map((r) => r.state),
      ['proposed', 'proposed'],
      'redraft did not reset criteria off stale',
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

  it('recovers from a crash between the comment landing and the property write', async () => {
    const { hash } = await seed('t3', 'body3');
    const jira = fakeJira({ key: ISSUE, summary: 't3', description: 'body3', changelog: [] });

    const first = await presentCriteria(jira, hash);
    assert.equal(first.wrote, true);
    assert.equal(jira.state.comments?.length, 1, 'first post did not create a comment');

    // The exact failure this guards against: the comment landed, but the
    // process died before the property write recorded it. Simulated by
    // wiping the property while leaving the comment (and its fingerprint
    // marker) sitting on the ticket, exactly where a crash would leave it.
    jira.state.property = undefined;

    const second = await presentCriteria(jira, hash);
    assert.equal(second.wrote, true);
    assert.match(second.reason, /recovered/, 'did not recognise the already-posted comment');
    assert.equal(
      jira.state.comments?.length,
      1,
      'posted a duplicate comment instead of recovering the existing one',
    );

    // The property is back, so the approval-window check has something to
    // measure against again.
    assert.ok(jira.state.property?.criteria_posted_at, 'did not recover criteria_posted_at');
  });
});

describe('gate 1 rejection', () => {
  it('rejects criteria, captures the PO comment as the reason, and returns the requirement to draft', async () => {
    const { hash } = await seed('t4', 'body4');
    const jira = fakeJira({ key: ISSUE, summary: 't4', description: 'body4', changelog: [] });
    await presentCriteria(jira, hash);

    jira.postComment(
      'These do not cover the negative case - please redraft with an explicit 401 check.',
      '2026-09-11T09:05:00.000+0530',
    );
    jira.setVerificationStatus('Criteria Rejected', '2026-09-11T09:10:00.000+0530');

    const result = await reconcile(jira.client, ISSUE);
    assert.equal(result.action, 'gate1_rejected', result.detail);
    assert.equal(result.gate1?.decision, 'rejected');
    assert.match(result.gate1?.reason ?? '', /negative case/);

    assert.deepEqual(
      (await criteriaRows()).map((r) => r.state),
      ['rejected', 'rejected'],
    );
    assert.equal(await requirementState(), 'draft');
  });

  it('is idempotent: a second reconcile does not re-reject', async () => {
    const { hash } = await seed('t5', 'body5');
    const jira = fakeJira({ key: ISSUE, summary: 't5', description: 'body5', changelog: [] });
    await presentCriteria(jira, hash);
    jira.postComment('no good', '2026-09-11T09:05:00.000+0530');
    jira.setVerificationStatus('Criteria Rejected', '2026-09-11T09:10:00.000+0530');
    await reconcile(jira.client, ISSUE);

    const countBefore = await getPool().query(`SELECT count(*)::int AS n FROM approval WHERE gate = 1`);
    const second = await reconcile(jira.client, ISSUE);
    assert.equal(second.action, 'up_to_date', second.detail);
    const countAfter = await getPool().query(`SELECT count(*)::int AS n FROM approval WHERE gate = 1`);
    assert.equal(countAfter.rows[0].n, countBefore.rows[0].n);
  });

  it('does not use a comment left before the rejection as the reason', async () => {
    const { hash } = await seed('t6', 'body6');
    const jira = fakeJira({ key: ISSUE, summary: 't6', description: 'body6', changelog: [] });
    await presentCriteria(jira, hash);

    // Left BEFORE the field changed - instructions, not an explanation.
    jira.postComment('drafting now, back soon', '2026-09-11T08:00:00.000+0530');
    jira.setVerificationStatus('Criteria Rejected', '2026-09-11T09:10:00.000+0530');

    const result = await reconcile(jira.client, ISSUE);
    assert.equal(result.action, 'gate1_rejected', result.detail);
    assert.equal(result.gate1?.reason, undefined, 'used a comment that predates the rejection');
  });

  it('never quotes its own comment back as the PO\'s reason', async () => {
    // The exact failure this guards against: in a pilot where the service
    // authenticates as the same Jira account as the human tester, a comment
    // the SERVICE posted (e.g. a refusal notice from an earlier attempt) is
    // otherwise indistinguishable by author from one the PO actually wrote -
    // and close in time, since both happen around the same decision.
    const { hash } = await seed('t8', 'body8');
    const jira = fakeJira({ key: ISSUE, summary: 't8', description: 'body8', changelog: [] });
    await presentCriteria(jira, hash);

    jira.postComment(
      'spec2test: rejection blocked: no presentation record found for these criteria.',
      '2026-09-11T09:09:00.000+0530',
      'acct-po', // same account the rejection itself comes from
    );
    jira.setVerificationStatus('Criteria Rejected', '2026-09-11T09:10:00.000+0530');

    const result = await reconcile(jira.client, ISSUE);
    assert.equal(result.action, 'gate1_rejected', result.detail);
    assert.equal(result.gate1?.reason, undefined, 'quoted its own comment back as the reason');
  });

  it('a rejection made during an edit window is not honoured either', async () => {
    const { hash } = await seed('t7', 'body7');
    const jira = fakeJira({ key: ISSUE, summary: 't7', description: 'body7', changelog: [] });
    await presentCriteria(jira, hash);

    jira.editSummary('t7 amended', '2026-09-11T09:15:00.000+0530');
    jira.setVerificationStatus('Criteria Rejected', '2026-09-11T09:20:00.000+0530');

    const result = await reconcile(jira.client, ISSUE);
    assert.notEqual(result.action, 'gate1_rejected', 'honoured a rejection made during an edit window');
  });
});
