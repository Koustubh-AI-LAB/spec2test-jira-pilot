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

process.env.MIGRATION_DATABASE_URL ??= 'postgresql://spec2test:spec2test@localhost:5435/spec2test';
process.env.DATABASE_URL ??= 'postgresql://spec2test_app:spec2test_app@localhost:5435/spec2test';

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
    const res = await send('GET', `/pipeline/${ISSUE}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.stage, 'no_requirement');
    assert.equal(res.body.requirement, null);
    assert.equal(jira.writes.length, 0);
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

    const res = await send('GET', `/pipeline/${ISSUE}`);
    assert.equal(res.body.stage, 'needs_criteria_posting');
    assert.equal(res.body.criteria.length, 1);
    assert.equal(res.body.criteria[0].contentHash, contentHash('rule'));
    assert.equal(res.body.criteria[0].stateAffecting, true);
    assert.equal(res.body.jira.criteriaPosted, false);
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
});
