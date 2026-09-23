import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubService } from './helpers/stub-service.ts';
import type { StubService } from './helpers/stub-service.ts';
import { runCli } from './helpers/run-cli.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..'); // plugin/cli/test -> plugin/cli -> plugin -> repo root
const CANONICAL_CLIENT = join(REPO_ROOT, 'runner', 'src', 'client', 'apiClient.ts');
const CANONICAL_TEXT = readFileSync(CANONICAL_CLIENT, 'utf8');

let stub: StubService;
let scratch: string;

before(async () => {
  stub = await startStubService();
  scratch = mkdtempSync(join(tmpdir(), 'spec2test-preflight-'));
});

after(async () => {
  await stub.close();
  rmSync(scratch, { recursive: true, force: true });
});

function scaffoldTarget(clientText: string): string {
  const repoPath = join(scratch, `target-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(repoPath, 'spec2test', 'client'), { recursive: true });
  writeFileSync(join(repoPath, 'spec2test', 'client', 'apiClient.ts'), clientText, 'utf8');
  return repoPath;
}

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SPEC2TEST_SERVICE_URL: stub.url,
    SPEC2TEST_PROJECT_KEY: 'S2T-PILOT',
    SPEC2TEST_ACTOR: 'dev@example.com',
    CONDUIT_BASE_URL: 'http://localhost:3000',
    CONDUIT_REPO_PATH: scaffoldTarget(CANONICAL_TEXT),
    ...overrides,
  };
}

const PROJECT = { id: 'proj-1', key: 'S2T-PILOT', jira_project_key: 'S2T', target_repo_path: 'x' };
const ENVIRONMENT = {
  id: 'env-1',
  project_id: 'proj-1',
  base_url: 'http://localhost:3000',
  class: 'ephemeral',
  openapi_url: 'x.yml',
  capabilities: {},
};

function programHappyPath(): void {
  stub.respond('GET', '/version', { status: 200, body: { service: 's', apiVersion: 4 } });
  stub.respond('GET', '/jira/preflight', {
    status: 200,
    body: { ok: true, accountId: 'a', displayName: 'd', base: 'https://x', fields: {} },
  });
  stub.respond('GET', '/projects/S2T-PILOT', { status: 200, body: PROJECT });
  stub.respond('GET', '/environments/resolve', { status: 200, body: ENVIRONMENT });
  stub.respond('GET', '/environments/env-1/grounding', {
    status: 200,
    body: { environmentId: 'env-1', source: 'x', text: 'x', contentHash: 'h' },
  });
}

describe('s2t preflight', () => {
  it('passes all ten checks against a fully-configured stack', async () => {
    programHappyPath();
    const res = await runCli(['preflight'], env());
    assert.equal(res.status, 0, JSON.stringify(res.stdout));
    assert.equal((res.stdout as { ok: boolean }).ok, true);
  });

  it('fails loud on config_missing before making any HTTP call at all', async () => {
    const n = stub.requests.length;
    const res = await runCli(['preflight'], { SPEC2TEST_SERVICE_URL: stub.url });
    assert.equal(res.status, 0);
    assert.equal((res.stdout as { event: string }).event, 'config_missing');
    assert.equal(stub.requests.length, n, 'no HTTP call should happen before config is validated');
  });

  it('fails loud when the service is unreachable', async () => {
    const res = await runCli(['preflight'], env({ SPEC2TEST_SERVICE_URL: 'http://127.0.0.1:1' }));
    assert.equal(res.status, 0);
    assert.equal((res.stdout as { event: string }).event, 'service_unreachable');
  });

  it('fails loud on an API version mismatch', async () => {
    stub.respond('GET', '/version', { status: 200, body: { service: 's', apiVersion: 1 } });
    const res = await runCli(['preflight'], env());
    assert.equal(res.status, 0);
    assert.equal((res.stdout as { event: string }).event, 'api_version_mismatch');
  });

  it('propagates a Jira preflight failure', async () => {
    stub.respond('GET', '/version', { status: 200, body: { service: 's', apiVersion: 4 } });
    stub.respond('GET', '/jira/preflight', {
      status: 400,
      body: { event: 'jira_field_not_found', message: 'customfield_10107 does not exist' },
    });
    const res = await runCli(['preflight'], env());
    assert.equal(res.status, 0);
    assert.equal((res.stdout as { event: string }).event, 'jira_field_not_found');
  });

  it('fails loud when the target base URL is not in the environment allowlist', async () => {
    stub.respond('GET', '/version', { status: 200, body: { service: 's', apiVersion: 4 } });
    stub.respond('GET', '/jira/preflight', {
      status: 200,
      body: { ok: true, accountId: 'a', displayName: 'd', base: 'https://x', fields: {} },
    });
    stub.respond('GET', '/projects/S2T-PILOT', { status: 200, body: PROJECT });
    stub.respond('GET', '/environments/resolve', {
      status: 403,
      body: { event: 'environment_not_allowed', message: 'not registered' },
    });
    const res = await runCli(['preflight'], env());
    assert.equal(res.status, 0);
    assert.equal((res.stdout as { event: string }).event, 'environment_not_allowed');
  });

  it('fails loud when the target repo has no spec2test/ scaffolded', async () => {
    programHappyPath();
    const bareRepo = join(scratch, `bare-${Date.now()}`);
    mkdirSync(bareRepo, { recursive: true });
    const res = await runCli(['preflight'], env({ CONDUIT_REPO_PATH: bareRepo }));
    assert.equal(res.status, 0);
    assert.equal((res.stdout as { event: string }).event, 'target_repo_missing');
  });

  it('fails loud when the vendored client has drifted from runner/src/client/apiClient.ts - the check not in the original list', async () => {
    programHappyPath();
    const staleRepo = scaffoldTarget(`${CANONICAL_TEXT}\n// stale edit, never re-vendored\n`);
    const res = await runCli(['preflight'], env({ CONDUIT_REPO_PATH: staleRepo }));
    assert.equal(res.status, 0);
    const body = res.stdout as { event: string; message: string };
    assert.equal(body.event, 'vendored_client_stale');
    assert.match(body.message, /subject: true/);
  });
});
