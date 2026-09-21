/**
 * Live: proves a queued job reaches `done` with the right rows written,
 * end to end through the real HTTP routes (app.inject, same as gates.test.ts)
 * against the real self-hosted Conduit fork already used by runner/'s own
 * step 3/4 live tests. Skipped entirely when CONDUIT_BASE_URL is unset - same
 * opt-in discipline as runner/test/e2e.test.ts.
 *
 * Requires: docker compose up -d postgres, Conduit running, spec2test/
 * already scaffolded in CONDUIT_REPO_PATH (see runner/test/e2e.test.ts).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getPool, getAdminPool, closePool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { buildServer } from '../src/api/server.ts';
import { computeVerification } from '../src/verification.ts';

for (const path of ['../.env', '.env']) {
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
  break;
}

process.env.MIGRATION_DATABASE_URL ??= 'postgresql://spec2test:spec2test@localhost:5435/spec2test';
process.env.DATABASE_URL ??= 'postgresql://spec2test_app:spec2test_app@localhost:5435/spec2test';

const live = Boolean(process.env.CONDUIT_BASE_URL);
const targetRepoRoot = process.env.CONDUIT_REPO_PATH ?? '';
const spec2testDir = join(targetRepoRoot, 'spec2test');

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
  grounding_hash: 'worker-test-grounding',
  temperature: 0,
};

describe('worker: verify end to end (live)', { skip: !live && 'CONDUIT_BASE_URL not set' }, () => {
  let environmentId: string;

  before(async () => {
    if (!targetRepoRoot) throw new Error('CONDUIT_BASE_URL is set but CONDUIT_REPO_PATH is not');
    if (!existsSync(spec2testDir)) throw new Error(`${spec2testDir} does not exist - run runner's init first`);

    await migrate();
    await getAdminPool().query('TRUNCATE project, audit_event RESTART IDENTITY CASCADE');
    app = buildServer();
    await app.ready();

    const project = (await post('/projects', { key: 'P-WORKER', jira_project_key: 'PILOT', target_repo_path: targetRepoRoot })).body;
    const env = await post('/environments', {
      project_id: project.id,
      base_url: process.env.CONDUIT_BASE_URL,
      class: 'dedicated',
      openapi_url: join(spec2testDir, 'openapi.yml'),
    });
    environmentId = env.body.id;
  });

  after(async () => {
    await app?.close();
    await closePool();
  });

  async function seedApprovedTestCase(issueKey: string, spec: unknown) {
    const project = (await post('/projects', { key: `P-${issueKey}`, jira_project_key: 'PILOT', target_repo_path: targetRepoRoot })).body;
    const req = (
      await post('/requirements', {
        project_id: project.id,
        jira_issue_key: issueKey,
        title: 'a registration requirement',
        body: 'registering a new user must return a real auth token',
        ...PROVENANCE,
      })
    ).body.requirement;
    const criterion = (
      await post(`/requirements/${req.id}/criteria`, { criteria: [{ body: 'POST /api/users returns a token' }] })
    ).body.criteria[0];
    await post('/gate1/decisions', {
      subject_id: criterion.id,
      decision: 'approved',
      actor: 'po@example.com',
      channel: 'jira',
      seen_hash: criterion.content_hash,
    });
    const testCase = (
      await post('/test-cases', { criterion_id: criterion.id, name: `worker test ${issueKey}`, kind: 'api', spec, ...PROVENANCE })
    ).body;
    await post('/gate2/decisions', {
      subject_id: testCase.id,
      decision: 'approved',
      actor: 'dev@example.com',
      channel: 'claude-code',
      seen_hash: testCase.content_hash,
    });
    return { requirement: req, criterion, testCase };
  }

  it('certifies a genuine, well-formed test case: job reaches done, run/run_result/fault_experiment rows exist, requirement becomes contract_verified', async () => {
    const spec = {
      criterionId: 'C-WORKER-REGISTER',
      name: `worker register user ${Date.now()}`,
      method: 'POST',
      path: '/api/users',
      auth: 'none',
      body: {
        user: {
          username: 'spec2test_worker_{{unique}}',
          email: 'spec2test_worker_{{unique}}@spec2test.dev',
          password: 'Spec2Test!1',
        },
      },
      assertions: [
        { name: 'status_201', check: 'status === 201' },
        { name: 'has_token', check: 'body.user.token' },
      ],
    };
    const { requirement, testCase } = await seedApprovedTestCase('WORKER-OK', spec);

    const res = await post(`/test-cases/${testCase.id}/verify`, { environment_id: environmentId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'done', JSON.stringify(res.body));
    assert.equal(res.body.certify.verdict, 'certified', JSON.stringify(res.body.certify));
    assert.ok(res.body.falsification.verdicts.length > 0);

    const runs = await getPool().query(
      "SELECT kind, state FROM run WHERE requirement_id = $1 ORDER BY kind",
      [requirement.id],
    );
    assert.deepEqual(
      runs.rows.map((r) => r.kind).sort(),
      ['falsification', 'smoke'],
    );
    assert.ok(runs.rows.every((r) => r.state === 'complete'));

    const faultCount = await getPool().query(
      `SELECT count(*)::int AS n FROM fault_experiment fe JOIN run r ON r.id = fe.run_id WHERE r.requirement_id = $1`,
      [requirement.id],
    );
    assert.ok(faultCount.rows[0].n > 0);

    const runResultCount = await getPool().query(
      `SELECT count(*)::int AS n FROM run_result rr JOIN run r ON r.id = rr.run_id WHERE r.requirement_id = $1`,
      [requirement.id],
    );
    assert.ok(runResultCount.rows[0].n > 0);

    const updatedTestCase = await getPool().query('SELECT artifact_path, artifact_hash, state FROM test_case WHERE id = $1', [testCase.id]);
    assert.notEqual(updatedTestCase.rows[0].artifact_path, '');
    assert.notEqual(updatedTestCase.rows[0].artifact_hash, '');
    // Gate 2 approval is a historical fact and does not change because of
    // what falsification found - see service/src/verification.ts's comment.
    assert.equal(updatedTestCase.rows[0].state, 'approved');

    const updatedRequirement = await getPool().query('SELECT state FROM requirement WHERE id = $1', [requirement.id]);
    assert.equal(updatedRequirement.rows[0].state, 'contract_verified');
  });

  it('rejects a deliberately weak test (asserts only that the response is truthy) with a specific diagnostic, and the requirement stays uncertified', async () => {
    const spec = {
      criterionId: 'C-WORKER-WEAK',
      name: `worker weak assertion ${Date.now()}`,
      method: 'POST',
      path: '/api/users',
      auth: 'none',
      body: {
        user: {
          username: 'spec2test_weak_{{unique}}',
          email: 'spec2test_weak_{{unique}}@spec2test.dev',
          password: 'Spec2Test!1',
        },
      },
      // Deliberately weak: "body" alone (no field path) is unparseable by
      // deriveKillFaults, so this derives zero kill faults - the master
      // plan's own named example of a test that must be rejected.
      assertions: [{ name: 'has_response', check: 'body' }],
    };
    const { requirement, testCase } = await seedApprovedTestCase('WORKER-WEAK', spec);

    const res = await post(`/test-cases/${testCase.id}/verify`, { environment_id: environmentId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'done', JSON.stringify(res.body));
    assert.equal(res.body.certify.verdict, 'rejected');
    assert.match(res.body.certify.reason, /no kill faults/);

    const updatedRequirement = await getPool().query('SELECT state FROM requirement WHERE id = $1', [requirement.id]);
    assert.notEqual(updatedRequirement.rows[0].state, 'contract_verified');
  });

  it('refuses to verify a test case that has not passed gate 2', async () => {
    const project = (await post('/projects', { key: 'P-NOGATE2', jira_project_key: 'PILOT', target_repo_path: targetRepoRoot })).body;
    const req = (
      await post('/requirements', {
        project_id: project.id,
        jira_issue_key: 'NOGATE2-1',
        title: 't',
        body: 'b',
        ...PROVENANCE,
      })
    ).body.requirement;
    const criterion = (await post(`/requirements/${req.id}/criteria`, { criteria: [{ body: 'x' }] })).body.criteria[0];
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
        name: 'never approved',
        kind: 'api',
        spec: { criterionId: 'x', name: 'x', method: 'GET', path: '/api/articles', auth: 'none', assertions: [{ name: 'a', check: 'status === 200' }] },
        ...PROVENANCE,
      })
    ).body;

    const res = await post(`/test-cases/${testCase.id}/verify`, { environment_id: environmentId });
    assert.equal(res.status, 400);
    assert.equal(res.body.event, 'test_case_not_approved');
  });

  it('refuses a spec naming a route the schema does not document, before any file is written', async () => {
    const name = `worker ungrounded ${Date.now()}`;
    const { testCase } = await seedApprovedTestCase('WORKER-UNGROUNDED', {
      criterionId: 'C-WORKER-UNGROUNDED',
      name,
      method: 'POST',
      path: '/api/definitely-not-a-real-endpoint',
      auth: 'none',
      assertions: [{ name: 'responds', check: 'status === 201' }],
    });

    const res = await post(`/test-cases/${testCase.id}/verify`, { environment_id: environmentId });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'failed');
    assert.match(res.body.lastError, /spec_not_grounded/);

    // Grounding runs first precisely so this never happens: without it the
    // spec would be rendered to disk and only fail later as a puzzling 404
    // from the live smoke run.
    assert.equal(res.body.generate, undefined, 'generate must not have run');
    const wouldBeFile = join(spec2testDir, 'generated', `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.spec.ts`);
    assert.equal(existsSync(wouldBeFile), false, 'no file may be written for an ungrounded spec');
  });

  it('fails the job rather than leaving it running when the context cannot be loaded', async () => {
    const { requirement, testCase } = await seedApprovedTestCase('WORKER-BADENV', {
      criterionId: 'C-WORKER-BADENV',
      name: `worker bad env ${Date.now()}`,
      method: 'GET',
      path: '/api/articles',
      auth: 'none',
      assertions: [{ name: 'responds', check: 'status === 200' }],
    });

    // Well-formed but unresolvable: the verify route checks environment_id is
    // present, never that it exists, so loadContext is where this dies.
    const res = await post(`/test-cases/${testCase.id}/verify`, {
      environment_id: '00000000-0000-0000-0000-000000000000',
    });
    assert.equal(res.status, 404);

    const { rows } = await getPool().query<{ state: string }>(
      'SELECT state FROM job WHERE requirement_id = $1 ORDER BY created_at DESC LIMIT 1',
      [requirement.id],
    );
    assert.equal(rows[0]!.state, 'failed');

    // The real damage a stuck 'running' row does: hasRunningJob would report
    // true forever and pin the requirement here, with no retry able to clear it.
    const verification = await computeVerification(requirement.id);
    assert.notEqual(verification.state, 'verifying');
  });
});
