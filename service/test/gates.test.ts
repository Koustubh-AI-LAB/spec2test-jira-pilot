/**
 * Gate tests run against a REAL Postgres, not a mock.
 *
 * Deliberate: the things most worth proving
 * here are SQL-level - a partial unique index, a REVOKE, an ON CONFLICT, a
 * transaction boundary. A mocked client cannot prove any of them, and a green
 * suite that proved none of them would be worse than no suite.
 *
 * Requires: docker compose up -d postgres
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool, getAdminPool, closePool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { buildServer } from '../src/api/server.ts';
import { contentHash } from '../src/hash.ts';
import type { FastifyInstance } from 'fastify';
import { useTestDatabase } from './helpers/db.ts';

await useTestDatabase();

let app: FastifyInstance;

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
}

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

const PROVENANCE = {
  drafted_by_model: 'claude-opus-5',
  prompt_version: 'draft-v1',
  grounding_hash: 'abc123',
  temperature: 0,
};

before(async () => {
  await migrate();
  // Fixtures use the owner connection: the app role deliberately cannot
  // truncate audit_event, which is the point of the privilege split.
  await getAdminPool().query('TRUNCATE project, audit_event RESTART IDENTITY CASCADE');
  app = buildServer();
  await app.ready();
});

after(async () => {
  await app?.close();
  await closePool();
});

async function seedRequirement(issueKey: string) {
  const project = (await post('/projects', { key: `P-${issueKey}`, jira_project_key: 'PILOT' })).body;
  const req = await post('/requirements', {
    project_id: project.id,
    jira_issue_key: issueKey,
    title: 'Members may hold at most 3 books',
    body: 'A member may hold at most 3 books at once. A 4th request returns 400 LOAN_LIMIT.',
    ...PROVENANCE,
  });
  return { project, requirement: req.body.requirement, resumed: req.body.resumed };
}

describe('version handshake', () => {
  it('reports an api version the plugin can check at preflight', async () => {
    const { body } = await get('/version');
    assert.equal(typeof body.apiVersion, 'number');
  });
});

describe('provenance', () => {
  it('refuses a draft with no provenance, because it cannot be backfilled', async () => {
    const project = (await post('/projects', { key: 'P-NOPROV', jira_project_key: 'PILOT' })).body;
    const res = await post('/requirements', {
      project_id: project.id,
      jira_issue_key: 'NOPROV-1',
      title: 't',
      body: 'b',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.event, 'provenance_required');
  });

  it('stores model and prompt version with the draft', async () => {
    const { requirement } = await seedRequirement('PROV-1');
    assert.equal(requirement.drafted_by_model, 'claude-opus-5');
    assert.equal(requirement.prompt_version, 'draft-v1');
  });
});

describe('per-ticket idempotency', () => {
  it('resumes an open instance instead of drafting a second one', async () => {
    const first = await seedRequirement('DUP-1');
    assert.equal(first.resumed, false);

    const again = await post('/requirements', {
      project_id: first.project.id,
      jira_issue_key: 'DUP-1',
      title: 'different title',
      body: 'different body',
      ...PROVENANCE,
    });
    assert.equal(again.body.resumed, true);
    assert.equal(again.body.requirement.id, first.requirement.id);
  });

  // A resuming skill is not making a draft, so it has no model id or prompt
  // hash to give. Provenance only guards a draft that is actually being
  // created; demanding it on a resume would force the caller to invent values
  // for a draft that never happens.
  it('resumes without provenance, since nothing is being drafted', async () => {
    const first = await seedRequirement('DUP-2');

    const again = await post('/requirements', {
      project_id: first.project.id,
      jira_issue_key: 'DUP-2',
      title: 'ignored on resume',
      body: 'ignored on resume',
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.resumed, true);
    assert.equal(again.body.requirement.id, first.requirement.id);
  });

  it('still refuses provenance-less input when it would create a new draft', async () => {
    const project = (await post('/projects', { key: 'P-DUP-3', jira_project_key: 'PILOT' })).body;
    const res = await post('/requirements', {
      project_id: project.id,
      jira_issue_key: 'DUP-3',
      title: 't',
      body: 'b',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.event, 'provenance_required');
  });

  it('enforces one open instance per issue at the database level', async () => {
    const { project } = await seedRequirement('IDX-1');
    await assert.rejects(
      getPool().query(
        `INSERT INTO requirement
           (project_id, jira_issue_key, title, body, source_text_hash,
            drafted_by_model, prompt_version, grounding_hash)
         VALUES ($1, 'IDX-1', 't', 'b', 'h', 'm', 'p', 'g')`,
        [project.id],
      ),
      /one_open_requirement_per_issue/,
    );
  });
});

describe('gate 1', () => {
  it('approves a criterion and records who, when and what hash', async () => {
    const { requirement } = await seedRequirement('G1-1');
    const criteria = (
      await post(`/requirements/${requirement.id}/criteria`, {
        criteria: [{ body: 'A 4th loan returns 400 with code LOAN_LIMIT', state_affecting: true }],
      })
    ).body.criteria;
    const criterion = criteria[0];

    const res = await post('/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });

    assert.equal(res.body.recorded, true);
    assert.equal(res.body.state, 'approved');

    const approvals = await getPool().query(
      "SELECT * FROM approval WHERE subject_id = $1 AND gate = 1",
      [criterion.id],
    );
    assert.equal(approvals.rowCount, 1);
    assert.equal(approvals.rows[0].actor, 'po@example.com');
    assert.equal(approvals.rows[0].channel, 'jira');
  });

  it('re-applying the same decision is a no-op, not a duplicate audit line', async () => {
    const { requirement } = await seedRequirement('G1-2');
    const criterion = (
      await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'unchanged rule' }] })
    ).body.criteria[0];

    const payload = {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    };
    const first = await post('/gate1/decisions', payload);
    const second = await post('/gate1/decisions', payload);

    assert.equal(first.body.recorded, true);
    assert.equal(second.body.recorded, false);

    const approvals = await getPool().query('SELECT * FROM approval WHERE subject_id = $1', [criterion.id]);
    assert.equal(approvals.rowCount, 1);
  });

  it('refuses a decision made against content that has since changed', async () => {
    const { requirement } = await seedRequirement('G1-3');
    const criterion = (
      await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'original wording' }] })
    ).body.criteria[0];

    // The criterion is re-drafted after the PO was shown the original.
    await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'reworded, materially different' }] });

    const res = await post('/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.event, 'stale_decision');
  });
});

describe('gate 2 and segregation of duties', () => {
  it('flags when one actor satisfies both gates', async () => {
    const { requirement } = await seedRequirement('SOD-1');
    const criterion = (
      await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'some rule' }] })
    ).body.criteria[0];

    await post('/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'same.person@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });

    const testCase = (
      await post('/test-cases', {
        criterion_id: criterion.id,
        name: 'rejects a 4th loan',
        kind: 'api',
        spec: { method: 'POST', path: '/loans', expect: { status: 400 } },
        ...PROVENANCE,
      })
    ).body;

    const gate2 = await post('/gate2/decisions', {
      subject_id: testCase.id,
      decision: 'approved',
      actor: 'same.person@example.com',
      channel: 'claude-code',
      seen_hash: testCase.content_hash,
    });

    assert.equal(gate2.body.sameActorBothGates, true);
  });

  it('does not flag when the two gates had different actors', async () => {
    const { requirement } = await seedRequirement('SOD-2');
    const criterion = (
      await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'another rule' }] })
    ).body.criteria[0];

    await post('/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });

    const testCase = (
      await post('/test-cases', {
        criterion_id: criterion.id,
        name: 'a case',
        kind: 'api',
        spec: { method: 'GET', path: '/loans' },
        ...PROVENANCE,
      })
    ).body;

    const gate2 = await post('/gate2/decisions', {
      subject_id: testCase.id,
      decision: 'approved',
      actor: 'dev@example.com',
      channel: 'claude-code',
      seen_hash: testCase.content_hash,
    });

    assert.equal(gate2.body.sameActorBothGates, false);
  });
});

// A sequence, not a single transition: rejecting a criterion's only test case
// marks the criterion `uncovered`, and the route's own comment promises the
// way back is "just POST a new test case against the same criterion". That
// promise was never exercised - the draft guard only accepted `approved`, so
// the criterion was stuck `uncovered` with no route to getting it covered.
describe('gate 2 rejection and redraft', () => {
  async function seedApprovedCriterion(issueKey: string) {
    const { requirement } = await seedRequirement(issueKey);
    const criterion = (
      await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'some rule' }] })
    ).body.criteria[0];
    await post('/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });
    return criterion as { id: string; content_hash: string };
  }

  async function draftCase(criterionId: string, name: string) {
    return post('/test-cases', {
      criterion_id: criterionId,
      name,
      kind: 'api',
      spec: { method: 'GET', path: '/loans' },
      ...PROVENANCE,
    });
  }

  async function criterionState(id: string): Promise<string> {
    const { rows } = await getPool().query<{ state: string }>('SELECT state FROM criterion WHERE id = $1', [id]);
    return rows[0]!.state;
  }

  it('lets a new test case be drafted after the only one was rejected, and re-approves the criterion', async () => {
    const criterion = await seedApprovedCriterion('RD2-1');

    const first = (await draftCase(criterion.id, 'first attempt')).body;
    await post('/gate2/decisions', {
      subject_id: first.id,
      decision: 'rejected',
      actor: 'dev@example.com',
      channel: 'claude-code',
      reason: 'asserts the wrong status',
      seen_hash: first.content_hash,
    });
    assert.equal(await criterionState(criterion.id), 'uncovered');

    const second = await draftCase(criterion.id, 'second attempt');
    assert.equal(second.status, 200, JSON.stringify(second.body));
    // Gate 1's approval is still valid - `uncovered` only ever meant "no live
    // test case", and there is one again.
    assert.equal(await criterionState(criterion.id), 'approved');
  });

  it('still refuses a draft against a criterion gate 1 has not approved', async () => {
    const { requirement } = await seedRequirement('RD2-2');
    const criterion = (
      await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'unapproved rule' }] })
    ).body.criteria[0];

    const res = await draftCase(criterion.id, 'too early');
    assert.equal(res.status, 400);
    assert.equal(res.body.event, 'criterion_not_approved');
  });
});

describe('environment allowlist', () => {
  it('refuses an unregistered base url rather than warning about it', async () => {
    const project = (await post('/projects', { key: 'P-ENV', jira_project_key: 'PILOT' })).body;
    const res = await get(
      `/environments/resolve?project_id=${project.id}&base_url=${encodeURIComponent('https://prod.example.com')}`,
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.event, 'environment_not_allowed');
  });

  it('never grants state-mutating capability to a production environment', async () => {
    const project = (await post('/projects', { key: 'P-PROD', jira_project_key: 'PILOT' })).body;
    const registered = await post('/environments', {
      project_id: project.id,
      base_url: 'https://prod.example.com',
      class: 'production',
    });
    assert.equal(registered.body.capabilities.tier2StateSeeding, false);
    assert.equal(registered.body.capabilities.tier1Injection, false);
    assert.equal(registered.body.capabilities.smokeOnly, true);
  });

  it('allows tier-1 but not tier-2 on shared staging', async () => {
    const project = (await post('/projects', { key: 'P-STG', jira_project_key: 'PILOT' })).body;
    const registered = await post('/environments', {
      project_id: project.id,
      base_url: 'https://staging.example.com',
      class: 'shared-staging',
    });
    assert.equal(registered.body.capabilities.tier1Injection, true);
    assert.equal(registered.body.capabilities.tier2StateSeeding, false);
  });
});

describe('audit ledger', () => {
  it('records the lineage of a decision without needing logs', async () => {
    const { requirement } = await seedRequirement('AUD-1');
    const criterion = (
      await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'auditable rule' }] })
    ).body.criteria[0];

    await post('/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });

    const { body } = await get('/audit?limit=50');
    const events = body.events.map((e: { event: string }) => e.event);
    assert.ok(events.includes('gate1_approved'));
    assert.ok(events.includes('requirement_drafted'));
  });
});

describe('content hashing', () => {
  it('ignores line-ending and trailing-whitespace differences', () => {
    assert.equal(contentHash('a rule\r\n'), contentHash('a rule'));
  });

  it('does not ignore a real wording change', () => {
    assert.notEqual(contentHash('at most 3 books'), contentHash('at most 4 books'));
  });
});

describe('audit ledger is append-only at the privilege level', () => {
  it('lets the application insert audit rows', async () => {
    const before = await getPool().query('SELECT count(*)::int AS n FROM audit_event');
    await seedRequirement('APPEND-1');
    const after = await getPool().query('SELECT count(*)::int AS n FROM audit_event');
    assert.ok(after.rows[0].n > before.rows[0].n);
  });

  it('refuses an UPDATE from the application role', async () => {
    await assert.rejects(
      getPool().query("UPDATE audit_event SET actor = 'tampered'"),
      /permission denied/i,
    );
  });

  it('refuses a DELETE from the application role', async () => {
    await assert.rejects(getPool().query('DELETE FROM audit_event'), /permission denied/i);
  });
});

describe('redraft', () => {
  it('updates the hash, resets criteria off stale, and keeps criterion ids stable', async () => {
    const { requirement } = await seedRequirement('REDRAFT-1');
    const c1 = (
      await post(`/requirements/${requirement.id}/criteria`, {
        criteria: [{ body: 'first criterion' }, { body: 'second criterion' }],
      })
    ).body.criteria;

    // Simulate what drift does: mark everything stale, the way reconcile.ts's
    // markStale would after the requirement text changed under an approval.
    await getPool().query(
      `UPDATE criterion SET state = 'stale' WHERE requirement_id = $1`,
      [requirement.id],
    );
    await getPool().query(`UPDATE requirement SET state = 'stale' WHERE id = $1`, [requirement.id]);

    const res = await post(`/requirements/${requirement.id}/redraft`, {
      title: 'Members may hold at most 5 books',
      body: 'A member may hold at most 5 books at once. A 6th request returns 400 LOAN_LIMIT.',
      criteria: [{ body: 'first criterion, restated' }, { body: 'second criterion' }],
      ...PROVENANCE,
      reason: 'requirement text changed after approval',
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.notEqual(res.body.requirement.source_text_hash, requirement.source_text_hash);
    assert.equal(res.body.requirement.state, 'awaiting_requirement_approval');
    assert.ok(res.body.criteria.every((c: { state: string }) => c.state === 'proposed'));

    // Ordinal 1 kept its id: a criterion reworded in a redraft is still the
    // same criterion for approval-history purposes, not a new row.
    assert.equal(
      res.body.criteria.find((c: { ordinal: number }) => c.ordinal === 1).id,
      c1[0].id,
    );
  });

  it('drops criteria beyond the new count rather than leaving them behind', async () => {
    const { requirement } = await seedRequirement('REDRAFT-2');
    await post(`/requirements/${requirement.id}/criteria`, {
      criteria: [{ body: 'one' }, { body: 'two' }, { body: 'three' }],
    });

    await post(`/requirements/${requirement.id}/redraft`, {
      body: 'a shorter requirement now',
      criteria: [{ body: 'one, revised' }],
      ...PROVENANCE,
    });

    const { rows } = await getPool().query(
      'SELECT ordinal FROM criterion WHERE requirement_id = $1 ORDER BY ordinal',
      [requirement.id],
    );
    assert.deepEqual(rows.map((r) => r.ordinal), [1]);
  });

  it('refuses to redraft a requirement that is already closed', async () => {
    const { requirement } = await seedRequirement('REDRAFT-3');
    await getPool().query(`UPDATE requirement SET state = 'closed' WHERE id = $1`, [requirement.id]);

    const res = await post(`/requirements/${requirement.id}/redraft`, {
      body: 'anything',
      criteria: [],
      ...PROVENANCE,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.event, 'requirement_closed');
  });

  it('requires provenance, same as an original draft', async () => {
    const { requirement } = await seedRequirement('REDRAFT-4');
    const res = await post(`/requirements/${requirement.id}/redraft`, {
      body: 'anything',
      criteria: [],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.event, 'provenance_required');
  });
});

describe('generated-file hash drift reopens gate 2 (Step 6)', () => {
  async function seedApprovedTestCase(issueKey: string) {
    const { requirement } = await seedRequirement(issueKey);
    const criterion = (
      await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'some rule' }] })
    ).body.criteria[0];
    await post('/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });
    const testCase = (
      await post('/test-cases', {
        criterion_id: criterion.id,
        name: 'n',
        kind: 'api',
        spec: { method: 'GET', path: '/x' },
        ...PROVENANCE,
      })
    ).body;
    await post('/gate2/decisions', {
      subject_id: testCase.id,
      decision: 'approved',
      actor: 'dev@example.com',
      channel: 'claude-code',
      seen_hash: testCase.content_hash,
    });
    return { requirement, criterion, testCase };
  }

  /** What worker/index.ts's persistComplete writes after a real `verify` -
   *  simulated directly here so this test needs no live target/runner CLI. */
  async function simulateVerifiedArtifact(testCaseId: string, filePath: string, fileContent: string) {
    await getPool().query(`UPDATE test_case SET artifact_path = $1, artifact_hash = $2 WHERE id = $3`, [
      filePath,
      contentHash(fileContent),
      testCaseId,
    ]);
  }

  async function testCaseState(id: string): Promise<string> {
    const { rows } = await getPool().query<{ state: string }>('SELECT state FROM test_case WHERE id = $1', [id]);
    return rows[0]!.state;
  }

  it('reopens gate 2 (flips approved back to proposed) when the on-disk generated file no longer matches artifact_hash', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'spec2test-gates-drift-'));
    const filePath = join(scratch, 'generated.spec.ts');
    const original = "test('x', async () => {});\n";
    writeFileSync(filePath, original, 'utf8');

    const { testCase } = await seedApprovedTestCase('DRIFT-1');
    await simulateVerifiedArtifact(testCase.id, filePath, original);
    assert.equal(await testCaseState(testCase.id), 'approved', 'premise: gate 2 is closed before the hand-edit');

    // The hand-edit: someone changed the generated file after it was verified.
    writeFileSync(filePath, "test('x', async () => { /* edited by hand */ });\n", 'utf8');

    const res = await post(`/test-cases/${testCase.id}/verify`, { environment_id: '00000000-0000-4000-8000-000000000000' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.event, 'test_case_not_approved');
    assert.equal(await testCaseState(testCase.id), 'proposed', 'gate 2 was not reopened');

    const audit = await getPool().query(
      `SELECT event FROM audit_event WHERE subject = $1 ORDER BY created_at DESC LIMIT 1`,
      [`test_case:${testCase.id}`],
    );
    assert.equal(audit.rows[0]?.event, 'test_case_artifact_drift_reopened_gate2');
  });

  it('does not reopen gate 2 when the on-disk file is untouched - a matching hash is not drift', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'spec2test-gates-nodrift-'));
    const filePath = join(scratch, 'generated.spec.ts');
    const content = "test('x', async () => {});\n";
    writeFileSync(filePath, content, 'utf8');

    const { testCase } = await seedApprovedTestCase('DRIFT-2');
    await simulateVerifiedArtifact(testCase.id, filePath, content);

    const res = await post(`/test-cases/${testCase.id}/verify`, { environment_id: '00000000-0000-4000-8000-000000000000' });
    // Reaches the real enqueue path now (state is still 'approved') - status
    // 200/queued, not the 400 the drift case produces.
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'queued');
    assert.equal(await testCaseState(testCase.id), 'approved');
  });

  it('a test case that has never been verified (no artifact_path yet) is left alone', async () => {
    const { testCase } = await seedApprovedTestCase('DRIFT-3');
    assert.equal(await testCaseState(testCase.id), 'approved');

    const res = await post(`/test-cases/${testCase.id}/verify`, { environment_id: '00000000-0000-4000-8000-000000000000' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'queued');
  });
});

describe('GET /test-cases/:id/verify-result (Step 6 gap fix: verify no longer returns this inline)', () => {
  async function seedApprovedTestCase(issueKey: string) {
    const { requirement } = await seedRequirement(issueKey);
    const criterion = (
      await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'some rule' }] })
    ).body.criteria[0];
    await post('/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });
    const testCase = (
      await post('/test-cases', {
        criterion_id: criterion.id,
        name: 'n',
        kind: 'api',
        spec: { method: 'GET', path: '/x' },
        ...PROVENANCE,
      })
    ).body;
    return { requirement, criterion, testCase };
  }

  async function seedEnvironment(projectId: string) {
    return (
      await post('/environments', { project_id: projectId, base_url: 'http://localhost:5000', class: 'ephemeral' })
    ).body as { id: string };
  }

  /** What worker/index.ts's persistComplete writes into run/fault_experiment
   *  after a real `verify` - seeded directly so this needs no live target. */
  async function seedFalsificationRun(
    requirementId: string,
    environmentId: string,
    criterionId: string,
    testCaseId: string,
    faults: { kind: 'kill' | 'immunity'; verdict: 'kill' | 'survive' | 'inconclusive' | 'quarantined'; detail: string }[],
  ) {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO run (requirement_id, environment_id, kind, state) VALUES ($1,$2,'falsification','complete') RETURNING id`,
      [requirementId, environmentId],
    );
    for (const [i, f] of faults.entries()) {
      await getPool().query(
        `INSERT INTO fault_experiment (run_id, criterion_id, test_case_id, set_kind, spec, verdict, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          rows[0]!.id,
          criterionId,
          testCaseId,
          f.kind,
          JSON.stringify({ id: `f${i}`, kind: f.kind, description: `fault ${i}`, targetAssertion: 'status_check' }),
          f.verdict,
          f.detail,
        ],
      );
    }
  }

  it('reports hasRun: false, certify: null for a test case that has never been verified', async () => {
    const { testCase } = await seedApprovedTestCase('VR-1');
    const res = await get(`/test-cases/${testCase.id}/verify-result`);
    assert.equal(res.status, 200);
    assert.equal(res.body.hasRun, false);
    assert.equal(res.body.certify, null);
  });

  it('reports the certify verdict and a reason mentioning the surviving fault, for a rejected kill fault', async () => {
    const { requirement, criterion, testCase } = await seedApprovedTestCase('VR-2');
    const env = await seedEnvironment(requirement.project_id);
    await seedFalsificationRun(requirement.id, env.id, criterion.id, testCase.id, [
      { kind: 'kill', verdict: 'survive', detail: 'the mutated response still passed the assertion' },
    ]);

    const res = await get(`/test-cases/${testCase.id}/verify-result`);
    assert.equal(res.status, 200);
    assert.equal(res.body.hasRun, true);
    assert.equal(res.body.certify.verdict, 'rejected');
    assert.match(res.body.certify.reason, /survived/);
    assert.match(res.body.certify.reason, /mutated response still passed/);
  });

  it('reports certified for a test case whose faults all came back as expected', async () => {
    const { requirement, criterion, testCase } = await seedApprovedTestCase('VR-3');
    const env = await seedEnvironment(requirement.project_id);
    await seedFalsificationRun(requirement.id, env.id, criterion.id, testCase.id, [
      { kind: 'kill', verdict: 'kill', detail: 'the assertion correctly caught the mutation' },
    ]);

    const res = await get(`/test-cases/${testCase.id}/verify-result`);
    assert.equal(res.body.certify.verdict, 'certified');
  });

  it('reports quarantined, not rejected, when the environment was unstable', async () => {
    const { requirement, criterion, testCase } = await seedApprovedTestCase('VR-4');
    const env = await seedEnvironment(requirement.project_id);
    await seedFalsificationRun(requirement.id, env.id, criterion.id, testCase.id, [
      { kind: 'kill', verdict: 'quarantined', detail: 'the initial healthy control failed - environment unstable' },
    ]);

    const res = await get(`/test-cases/${testCase.id}/verify-result`);
    assert.equal(res.body.certify.verdict, 'quarantined');
    assert.match(res.body.certify.reason, /environment unstable/);
  });

  it('404s an unknown test case and a malformed id', async () => {
    assert.equal((await get('/test-cases/00000000-0000-4000-8000-000000000000/verify-result')).status, 404);
    assert.equal((await get('/test-cases/nope/verify-result')).status, 404);
  });
});

describe('GET /test-cases/:id (Step 6 gap fix: status.testCases[] never carries spec)', () => {
  it('returns the full row, spec included, for a drafted test case', async () => {
    const { requirement } = await seedRequirement('GTC-1');
    const criterion = (
      await post(`/requirements/${requirement.id}/criteria`, { criteria: [{ body: 'some rule' }] })
    ).body.criteria[0];
    await post('/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });
    const spec = { method: 'GET', path: '/api/loans', assertions: [{ name: 'a', check: 'status === 200' }] };
    const testCase = (
      await post('/test-cases', { criterion_id: criterion.id, name: 'n', kind: 'api', spec, ...PROVENANCE })
    ).body;

    const res = await get(`/test-cases/${testCase.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, testCase.id);
    assert.equal(res.body.name, 'n');
    assert.equal(res.body.state, 'proposed');
    assert.deepEqual(res.body.spec, spec);
    assert.equal(res.body.content_hash, testCase.content_hash);
  });

  it('404s an unknown test case and a malformed id', async () => {
    assert.equal((await get('/test-cases/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await get('/test-cases/nope')).status, 404);
  });
});
