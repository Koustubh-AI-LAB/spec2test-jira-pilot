/**
 * Gate tests run against a REAL Postgres, not a mock.
 *
 * Deliberate, and the same call TestForge made: the things most worth proving
 * here are SQL-level - a partial unique index, a REVOKE, an ON CONFLICT, a
 * transaction boundary. A mocked client cannot prove any of them, and a green
 * suite that proved none of them would be worse than no suite.
 *
 * Requires: docker compose up -d postgres
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPool, getAdminPool, closePool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { buildServer } from '../src/api/server.ts';
import { contentHash } from '../src/hash.ts';
import type { FastifyInstance } from 'fastify';

process.env.MIGRATION_DATABASE_URL ??= 'postgresql://spec2test:spec2test@localhost:5435/spec2test';
process.env.DATABASE_URL ??= 'postgresql://spec2test_app:spec2test_app@localhost:5435/spec2test';

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
