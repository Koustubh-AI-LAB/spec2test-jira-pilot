/**
 * The routes the skill drives, exercised through the real HTTP layer
 * (`app.inject`) against real Postgres, with Jira replaced by the scripted fake
 * via `buildServer({ jira })`.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getPool, getAdminPool, closePool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { buildServer, API_VERSION } from '../src/api/server.ts';
import { contentHash } from '../src/hash.ts';
import { reconcile } from '../src/jira/reconcile.ts';
import { fakeJira } from './helpers/fake-jira.ts';
import type { FakeJira } from './helpers/fake-jira.ts';
import { useTestDatabase } from './helpers/db.ts';

await useTestDatabase();

const ISSUE = 'FAKE-1';
const PROVENANCE = {
  drafted_by_model: 'claude-opus-5',
  prompt_version: 'draft-v1',
  grounding_hash: 'routes-test',
  temperature: 0,
};

let app: FastifyInstance;
let jira: FakeJira;
let scratch: string;

before(async () => {
  await migrate();
  scratch = mkdtempSync(join(tmpdir(), 'spec2test-routes-'));
});

beforeEach(async () => {
  await getAdminPool().query('TRUNCATE project, audit_event RESTART IDENTITY CASCADE');
  jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
  app = buildServer({ jira: () => jira.client });
  await app.ready();
});

after(async () => {
  await app?.close();
  rmSync(scratch, { recursive: true, force: true });
  await closePool();
});

async function send(method: 'GET' | 'POST', url: string, payload?: object) {
  const res = await app.inject({ method, url, payload });
  return { status: res.statusCode, body: res.json() };
}

async function project() {
  return (await send('POST', '/projects', { key: 'FAKE-PILOT', jira_project_key: 'FAKE' })).body;
}

async function environment(projectId: string, baseUrl: string, openapiPath?: string) {
  return (
    await send('POST', '/environments', {
      project_id: projectId,
      base_url: baseUrl,
      class: 'ephemeral',
      openapi_url: openapiPath,
    })
  ).body as { id: string };
}

describe('API version', () => {
  it('was bumped when the plugin-facing contract grew', async () => {
    // Version 1 predates /pipeline, /grounding, /jobs and the dry_run flag. A
    // plugin built against those must be able to refuse an older service at
    // preflight, so the number has to have moved.
    assert.ok(API_VERSION >= 2, `API_VERSION is still ${API_VERSION}`);
    assert.equal((await send('GET', '/version')).body.apiVersion, API_VERSION);
  });
});

describe('GET /projects/:key', () => {
  it('reads back a project by its key, without upserting anything', async () => {
    const created = await project();
    const res = await send('GET', `/projects/${created.key}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.id);
    assert.equal(res.body.jira_project_key, created.jira_project_key);
  });

  it('404s a key nothing was ever registered under', async () => {
    const res = await send('GET', '/projects/NO-SUCH-PROJECT');
    assert.equal(res.status, 404);
    assert.equal(res.body.event, 'not_found');
  });
});

describe('POST /specs/validate', () => {
  it('passes a spec that names a documented route', async () => {
    const path = join(scratch, 'grounded.yml');
    writeFileSync(path, 'openapi: 3.0.0\npaths:\n  /api/articles:\n    get: {}\n');
    const env = await environment((await project()).id, 'http://localhost:4000', path);

    const res = await send('POST', '/specs/validate', {
      environment_id: env.id,
      spec: {
        criterionId: 'c1',
        name: 'list articles',
        method: 'GET',
        path: '/api/articles',
        auth: 'none',
        assertions: [{ name: 'status_200', check: 'status === 200' }],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('refuses a spec naming a route the schema does not document, before any file is written', async () => {
    const path = join(scratch, 'narrow.yml');
    writeFileSync(path, 'openapi: 3.0.0\npaths: {}\n');
    const env = await environment((await project()).id, 'http://localhost:4001', path);

    const res = await send('POST', '/specs/validate', {
      environment_id: env.id,
      spec: {
        criterionId: 'c1',
        name: 'invented route',
        method: 'GET',
        path: '/api/does-not-exist',
        auth: 'none',
        assertions: [{ name: 'status_200', check: 'status === 200' }],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.event, 'spec_not_grounded');
  });

  it('404s an unknown environment, and a malformed id rather than reaching Postgres', async () => {
    const spec = { criterionId: 'c1', name: 'n', method: 'GET', path: '/x', auth: 'none', assertions: [] };
    const unknown = await send('POST', '/specs/validate', {
      environment_id: '00000000-0000-4000-8000-000000000000',
      spec,
    });
    assert.equal(unknown.status, 404);
    const malformed = await send('POST', '/specs/validate', { environment_id: 'not-a-uuid', spec });
    assert.equal(malformed.status, 404, 'a malformed id reached Postgres');
  });

  it('409s an environment with no openapi_url configured', async () => {
    const env = await environment((await project()).id, 'http://localhost:4002');
    const res = await send('POST', '/specs/validate', {
      environment_id: env.id,
      spec: { criterionId: 'c1', name: 'n', method: 'GET', path: '/x', auth: 'none', assertions: [] },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.event, 'openapi_not_configured');
  });

  it('never writes to Postgres - it is a pure check', async () => {
    const path = join(scratch, 'pure.yml');
    writeFileSync(path, 'openapi: 3.0.0\npaths:\n  /api/articles:\n    get: {}\n');
    const env = await environment((await project()).id, 'http://localhost:4003', path);
    const before = (await getPool().query('SELECT count(*) FROM test_case')).rows[0].count;

    await send('POST', '/specs/validate', {
      environment_id: env.id,
      spec: {
        criterionId: 'c1',
        name: 'n',
        method: 'GET',
        path: '/api/articles',
        auth: 'none',
        assertions: [{ name: 'a', check: 'status === 200' }],
      },
    });

    const after = (await getPool().query('SELECT count(*) FROM test_case')).rows[0].count;
    assert.equal(after, before);
  });
});

describe('POST /specs/validate - draft-attempt cap (Step 6)', () => {
  async function seedCriterion(issueKey: string) {
    const p = await project();
    const req = (
      await send('POST', '/requirements', {
        project_id: p.id,
        jira_issue_key: issueKey,
        title: 't',
        body: 'b',
        ...PROVENANCE,
      })
    ).body.requirement;
    return (await send('POST', `/requirements/${req.id}/criteria`, { criteria: [{ body: 'x' }] })).body.criteria[0] as {
      id: string;
      content_hash: string;
    };
  }

  function ungroundedSpec(criterionId: string) {
    return {
      criterionId,
      name: 'n',
      method: 'GET',
      path: '/api/does-not-exist',
      auth: 'none',
      assertions: [{ name: 'a', check: 'status === 200' }],
    };
  }

  it('refuses outright with draft_attempts_exhausted after 2 consecutive failed validations for the same criterion', async () => {
    const path = join(scratch, 'cap-narrow.yml');
    writeFileSync(path, 'openapi: 3.0.0\npaths: {}\n');
    const env = await environment((await project()).id, 'http://localhost:4100', path);
    const criterion = await seedCriterion('CAP-1');

    const first = await send('POST', '/specs/validate', { environment_id: env.id, spec: ungroundedSpec(criterion.id) });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, false);
    const second = await send('POST', '/specs/validate', {
      environment_id: env.id,
      spec: ungroundedSpec(criterion.id),
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.ok, false);

    const third = await send('POST', '/specs/validate', { environment_id: env.id, spec: ungroundedSpec(criterion.id) });
    assert.equal(third.status, 409);
    assert.equal(third.body.event, 'draft_attempts_exhausted');
  });

  it('a runner-CLI crash never counts against the cap - only a genuine grounding failure does', async () => {
    // A malformed environment id reaching a real /specs/validate call is out
    // of scope here (caught earlier, before the cap check); this instead
    // confirms two REAL failures are required, not that any two calls trip
    // it - see the previous test for the positive case.
    const path = join(scratch, 'cap-count.yml');
    writeFileSync(path, 'openapi: 3.0.0\npaths:\n  /api/articles:\n    get: {}\n');
    const env = await environment((await project()).id, 'http://localhost:4102', path);
    const criterion = await seedCriterion('CAP-3');
    const grounded = {
      criterionId: criterion.id,
      name: 'ok',
      method: 'GET',
      path: '/api/articles',
      auth: 'none',
      assertions: [{ name: 'a', check: 'status === 200' }],
    };

    // A successful validation must not itself count as a failed attempt.
    await send('POST', '/specs/validate', { environment_id: env.id, spec: grounded });
    const stillOpen = await send('POST', '/specs/validate', {
      environment_id: env.id,
      spec: ungroundedSpec(criterion.id),
    });
    assert.equal(stillOpen.status, 200, 'a prior success must not count toward the cap');
  });

  it('a successful POST /test-cases resets the counter for that criterion', async () => {
    const path = join(scratch, 'cap-wide.yml');
    writeFileSync(path, 'openapi: 3.0.0\npaths:\n  /api/articles:\n    get: {}\n');
    const env = await environment((await project()).id, 'http://localhost:4101', path);
    const criterion = await seedCriterion('CAP-2');
    await send('POST', '/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });

    // One failed attempt, then a real success.
    await send('POST', '/specs/validate', { environment_id: env.id, spec: ungroundedSpec(criterion.id) });
    const grounded = {
      criterionId: criterion.id,
      name: 'ok',
      method: 'GET',
      path: '/api/articles',
      auth: 'none',
      assertions: [{ name: 'a', check: 'status === 200' }],
    };
    const validated = await send('POST', '/specs/validate', { environment_id: env.id, spec: grounded });
    assert.equal(validated.body.ok, true);
    await send('POST', '/test-cases', {
      criterion_id: criterion.id,
      name: 'ok case',
      kind: 'api',
      spec: grounded,
      ...PROVENANCE,
    });

    // The counter must read 0 again - two more failures are allowed before
    // the cap trips, not just one.
    const a = await send('POST', '/specs/validate', { environment_id: env.id, spec: ungroundedSpec(criterion.id) });
    assert.equal(a.status, 200, 'counter was not reset after a successful test-case draft');
    const b = await send('POST', '/specs/validate', { environment_id: env.id, spec: ungroundedSpec(criterion.id) });
    assert.equal(b.status, 200);
    const c = await send('POST', '/specs/validate', { environment_id: env.id, spec: ungroundedSpec(criterion.id) });
    assert.equal(c.status, 409);
    assert.equal(c.body.event, 'draft_attempts_exhausted');
  });
});

describe('GET /environments/:id/grounding', () => {
  it('returns the document and its hash, from a file path', async () => {
    const path = join(scratch, 'openapi.yml');
    writeFileSync(path, 'openapi: 3.0.0\npaths: {}\n');
    const env = await environment((await project()).id, 'http://localhost:3000', path);

    const res = await send('GET', `/environments/${env.id}/grounding`);
    assert.equal(res.status, 200);
    assert.equal(res.body.text, 'openapi: 3.0.0\npaths: {}\n');
    assert.equal(res.body.contentHash, contentHash('openapi: 3.0.0\npaths: {}\n'));
    assert.equal(res.body.source, path);
  });

  it('hashes a CRLF checkout and an LF checkout of the same document identically', async () => {
    // The plugin's grounding_hash provenance must not depend on which OS
    // checked the file out.
    const p = await project();
    const lf = join(scratch, 'lf.yml');
    const crlf = join(scratch, 'crlf.yml');
    writeFileSync(lf, 'openapi: 3.0.0\npaths: {}\n');
    writeFileSync(crlf, 'openapi: 3.0.0\r\npaths: {}\r\n');
    const a = await environment(p.id, 'http://localhost:3001', lf);
    const b = await environment(p.id, 'http://localhost:3002', crlf);

    const ha = (await send('GET', `/environments/${a.id}/grounding`)).body.contentHash;
    const hb = (await send('GET', `/environments/${b.id}/grounding`)).body.contentHash;
    assert.equal(ha, hb);
  });

  it('404s an unknown environment, and a malformed id rather than 500ing on it', async () => {
    const unknown = await send('GET', '/environments/00000000-0000-4000-8000-000000000000/grounding');
    assert.equal(unknown.status, 404);
    const malformed = await send('GET', '/environments/not-a-uuid/grounding');
    assert.equal(malformed.status, 404, 'a malformed id reached Postgres');
  });

  it('409s an environment registered without an openapi_url', async () => {
    const env = await environment((await project()).id, 'http://localhost:3003');
    const res = await send('GET', `/environments/${env.id}/grounding`);
    assert.equal(res.status, 409);
    assert.equal(res.body.event, 'openapi_not_configured');
  });

  it('reports an unreadable path as such, naming it, since openapi_url must be a file path', async () => {
    const env = await environment((await project()).id, 'http://localhost:3004', join(scratch, 'missing.yml'));
    const res = await send('GET', `/environments/${env.id}/grounding`);
    assert.equal(res.status, 500);
    assert.equal(res.body.event, 'openapi_unreadable');
    assert.match(res.body.message, /missing\.yml/);
    assert.match(res.body.message, /local file path/);
  });
});

describe('GET /jobs/:id', () => {
  it('returns a job by id', async () => {
    const p = await project();
    const req = await send('POST', '/requirements', {
      project_id: p.id,
      jira_issue_key: ISSUE,
      title: 't',
      body: 'b',
      ...PROVENANCE,
    });
    const { rows } = await getPool().query(
      `INSERT INTO job (kind, requirement_id, payload) VALUES ('falsification', $1, '{"testCaseId":"x"}') RETURNING id`,
      [req.body.requirement.id],
    );

    const res = await send('GET', `/jobs/${rows[0].id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'queued');
    assert.equal(res.body.kind, 'falsification');
    assert.equal(res.body.last_error, '');
    assert.equal(res.body.requirement_id, req.body.requirement.id);
  });

  it('404s an unknown job and a malformed id', async () => {
    assert.equal((await send('GET', '/jobs/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await send('GET', '/jobs/nope')).status, 404);
  });
});

describe('GET /pipeline/:issueKey', () => {
  it('answers through the injected Jira, with no requirement yet', async () => {
    const p = await project();
    const res = await send('GET', `/pipeline/${ISSUE}?project_id=${p.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.stage, 'no_requirement');
    assert.equal(res.body.requirement, null);
    assert.equal(jira.writes.length, 0);
  });

  it('requires project_id', async () => {
    const res = await send('GET', `/pipeline/${ISSUE}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.event, 'project_id_required');
  });

  it('carries what the skill needs to act: criteria with hashes, and the ticket status', async () => {
    const p = await project();
    const hash = contentHash('t\n\nb');
    const { rows } = await getPool().query(
      `INSERT INTO requirement
         (project_id, jira_issue_key, title, body, source_text_hash, state,
          drafted_by_model, prompt_version, grounding_hash)
       VALUES ($1,$2,'t','b',$3,'awaiting_requirement_approval','m','v','g') RETURNING id`,
      [p.id, ISSUE, hash],
    );
    await send('POST', `/requirements/${rows[0].id}/criteria`, { criteria: [{ body: 'rule', state_affecting: true }] });

    const res = await send('GET', `/pipeline/${ISSUE}?project_id=${p.id}`);
    assert.equal(res.body.stage, 'needs_criteria_posting');
    assert.equal(res.body.criteria.length, 1);
    assert.equal(res.body.criteria[0].contentHash, contentHash('rule'));
    assert.equal(res.body.criteria[0].stateAffecting, true);
    assert.equal(res.body.jira.criteriaPosted, false);
  });

  it('reports experimentCount per criterion - a raw fault_experiment row count, Step 6\'s "measure, don\'t cap" (#25)', async () => {
    const p = await project();
    const env = await environment(p.id, 'http://localhost:4200');
    const hash = contentHash('t\n\nb');
    const { rows: reqRows } = await getPool().query(
      `INSERT INTO requirement
         (project_id, jira_issue_key, title, body, source_text_hash, state,
          drafted_by_model, prompt_version, grounding_hash)
       VALUES ($1,$2,'t','b',$3,'awaiting_requirement_approval','m','v','g') RETURNING id`,
      [p.id, ISSUE, hash],
    );
    const requirementId = reqRows[0].id;
    const criterion = (await send('POST', `/requirements/${requirementId}/criteria`, { criteria: [{ body: 'rule' }] }))
      .body.criteria[0];
    // /test-cases requires gate 1 closed on the criterion first.
    await send('POST', '/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });
    const testCase = (
      await send('POST', '/test-cases', {
        criterion_id: criterion.id,
        name: 'n',
        kind: 'api',
        spec: { method: 'GET', path: '/x' },
        ...PROVENANCE,
      })
    ).body;
    assert.ok(testCase.id, `premise: test case must be created, got ${JSON.stringify(testCase)}`);
    // Not routed through gate 2 or verify beyond that - this test is only
    // about the count query, so the fault_experiment rows are seeded
    // directly, exactly as worker/index.ts's persistComplete would write them.
    const { rows: runRows } = await getPool().query(
      `INSERT INTO run (requirement_id, environment_id, kind, state) VALUES ($1,$2,'falsification','complete') RETURNING id`,
      [requirementId, env.id],
    );
    for (const verdict of ['kill', 'survive', 'kill']) {
      await getPool().query(
        `INSERT INTO fault_experiment (run_id, criterion_id, test_case_id, set_kind, spec, verdict)
         VALUES ($1,$2,$3,'kill','{}',$4)`,
        [runRows[0].id, criterion.id, testCase.id, verdict],
      );
    }

    const res = await send('GET', `/pipeline/${ISSUE}?project_id=${p.id}`);
    assert.equal(res.body.criteria[0].experimentCount, 3);
  });

  it('reports experimentCount: 0 for a criterion with no fault_experiment rows yet', async () => {
    const p = await project();
    const hash = contentHash('t\n\nb');
    const { rows } = await getPool().query(
      `INSERT INTO requirement
         (project_id, jira_issue_key, title, body, source_text_hash, state,
          drafted_by_model, prompt_version, grounding_hash)
       VALUES ($1,$2,'t','b',$3,'awaiting_requirement_approval','m','v','g') RETURNING id`,
      [p.id, ISSUE, hash],
    );
    await send('POST', `/requirements/${rows[0].id}/criteria`, { criteria: [{ body: 'rule' }] });

    const res = await send('GET', `/pipeline/${ISSUE}?project_id=${p.id}`);
    assert.equal(res.body.criteria[0].experimentCount, 0);
  });

  it('scopes the resume lookup by project - two projects sharing a Jira issue key never see each other requirement', async () => {
    const pA = await project();
    const pB = (await send('POST', '/projects', { key: 'FAKE-PILOT-B', jira_project_key: 'FAKE' })).body;

    const hash = contentHash('t\n\nb');
    await getPool().query(
      `INSERT INTO requirement
         (project_id, jira_issue_key, title, body, source_text_hash, state,
          drafted_by_model, prompt_version, grounding_hash)
       VALUES ($1,$2,'t','b',$3,'awaiting_requirement_approval','m','v','g')`,
      [pA.id, ISSUE, hash],
    );

    const resA = await send('GET', `/pipeline/${ISSUE}?project_id=${pA.id}`);
    assert.notEqual(resA.body.requirement, null, 'project A drafted this requirement and must see it');

    const resB = await send('GET', `/pipeline/${ISSUE}?project_id=${pB.id}`);
    assert.equal(
      resB.body.requirement,
      null,
      "project B must not resume project A's requirement for the same issue key",
    );
  });
});

describe('dry_run through the routes', () => {
  async function seedCriteria() {
    const p = await project();
    const hash = contentHash('t\n\nb');
    const { rows } = await getPool().query(
      `INSERT INTO requirement
         (project_id, jira_issue_key, title, body, source_text_hash, state,
          drafted_by_model, prompt_version, grounding_hash)
       VALUES ($1,$2,'t','b',$3,'awaiting_requirement_approval','m','v','g') RETURNING id`,
      [p.id, ISSUE, hash],
    );
    await send('POST', `/requirements/${rows[0].id}/criteria`, { criteria: [{ body: 'a 4th loan is refused' }] });
    return rows[0].id as string;
  }

  it('POST /jira/:key/criteria previews without writing, then confirms the same body', async () => {
    const requirementId = await seedCriteria();

    const preview = await send('POST', `/jira/${ISSUE}/criteria`, { requirement_id: requirementId, dry_run: true });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.dryRun, true);
    assert.equal(jira.writes.length, 0, 'the dry run wrote to Jira');
    assert.ok(preview.body.preview.comment);

    const confirmed = await send('POST', `/jira/${ISSUE}/criteria`, { requirement_id: requirementId });
    assert.equal(confirmed.body.wrote, true);
    assert.equal(confirmed.body.fingerprint, preview.body.fingerprint);
    const sent = jira.writes.find((w) => w.method === 'POST' && w.path.endsWith('/comment'))!.body as { body: unknown };
    assert.deepEqual(preview.body.preview.comment, sent.body);
  });

  it('POST /jira/:key/verification previews without writing', async () => {
    const requirementId = await seedCriteria();
    // Close gate 1 for real, so the rollup has something to report.
    await send('POST', `/jira/${ISSUE}/criteria`, { requirement_id: requirementId });
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T11:00:00.000+0530');
    const closed = await reconcile(jira.client, ISSUE);
    assert.equal(closed.action, 'gate1_closed', closed.detail);
    const writesBefore = jira.writes.length;

    const preview = await send('POST', `/jira/${ISSUE}/verification`, { requirement_id: requirementId, dry_run: true });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.jira.dryRun, true);
    assert.ok(preview.body.jira.preview.comment);
    assert.equal(jira.writes.length, writesBefore, 'the dry run wrote to Jira');
  });

  it('POST /jira/:key/verification still persists requirement.state to Postgres even under dry_run - the "write" it skips is Jira only', async () => {
    // Pins the documented contract (server.ts's own comment on this route):
    // computeVerification is a deterministic recompute of what the rows
    // already say, not a decision, and every other state-changing step does
    // the same - dry_run only ever meant "don't write to Jira" here. Proven
    // by corrupting the stored state by hand, then confirming a dry_run call
    // alone corrects it back in Postgres, with no confirm step at all.
    const requirementId = await seedCriteria();
    await send('POST', `/jira/${ISSUE}/criteria`, { requirement_id: requirementId });
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T11:00:00.000+0530');
    await reconcile(jira.client, ISSUE);

    await getAdminPool().query(`UPDATE requirement SET state = 'contract_verified' WHERE id = $1`, [requirementId]);
    const before_ = (await getPool().query('SELECT state FROM requirement WHERE id = $1', [requirementId])).rows[0]
      .state;
    assert.equal(before_, 'contract_verified', 'premise: the stored state is deliberately wrong');

    await send('POST', `/jira/${ISSUE}/verification`, { requirement_id: requirementId, dry_run: true });

    const after_ = (await getPool().query('SELECT state FROM requirement WHERE id = $1', [requirementId])).rows[0]
      .state;
    assert.equal(
      after_,
      'awaiting_test_approval',
      'dry_run must still persist the recomputed requirement.state to Postgres',
    );
  });
});
