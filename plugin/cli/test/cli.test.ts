/**
 * One test per command against the stub HTTP service (helpers/stub-service.ts) -
 * zero network, no Postgres, no Jira. Asserts, per command: the request the
 * CLI actually sent, the stdout envelope shape, and the exit code.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startStubService } from './helpers/stub-service.ts';
import type { StubService } from './helpers/stub-service.ts';
import { runCli } from './helpers/run-cli.ts';

let stub: StubService;

before(async () => {
  stub = await startStubService();
});

after(async () => {
  await stub.close();
});

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SPEC2TEST_SERVICE_URL: stub.url,
    SPEC2TEST_PROJECT_KEY: 'S2T-PILOT',
    SPEC2TEST_ACTOR: 'dev@example.com',
    CONDUIT_BASE_URL: 'http://localhost:3000',
    CONDUIT_REPO_PATH: 'C:\\fake\\conduit',
    ...overrides,
  };
}

const PROJECT = { id: 'proj-1', key: 'S2T-PILOT', jira_project_key: 'S2T', target_repo_path: 'C:\\fake\\conduit' };
const ENVIRONMENT = {
  id: 'env-1',
  project_id: 'proj-1',
  base_url: 'http://localhost:3000',
  class: 'ephemeral',
  openapi_url: 'x.yml',
  capabilities: { tier1Injection: true, tier2StateSeeding: true, tier3ConfigFlip: true, smokeOnly: false },
};

/** Only this test's own requests, not any earlier test's. */
function since(count: number) {
  return stub.requests.slice(count);
}

describe('s2t status', () => {
  it('returns the pipeline state plus the three derived lists', async () => {
    const pipeline = {
      issueKey: 'S2T-1',
      stage: 'awaiting_test_approval',
      detail: 'd',
      requirement: { id: 'req-1', state: 'awaiting_test_approval', title: 't', sourceTextHash: 'h' },
      criteria: [
        { id: 'c1', ordinal: 1, body: 'rule', state: 'approved', stateAffecting: false, contentHash: 'ch1' },
      ],
      testCases: [
        { id: 'tc1', criterionId: 'c1', name: 'case', state: 'proposed', contentHash: 'tch1', verified: false },
      ],
      reconcile: { action: 'up_to_date', detail: 'd' },
      jira: { verificationStatus: 'Criteria Approved', criteriaPosted: true, summary: 's', requirementText: 'r' },
    };
    stub.respond('GET', '/pipeline/S2T-1', { status: 200, body: pipeline });

    const before_ = stub.requests.length;
    const res = await runCli(['status', '--issue', 'S2T-1'], env());
    assert.equal(res.status, 0);
    const body = res.stdout as { ok: boolean; stage: string; pendingTestCases: unknown[]; uncoveredCriteria: unknown[] };
    assert.equal(body.ok, true);
    assert.equal(body.stage, 'awaiting_test_approval');
    assert.equal(body.pendingTestCases.length, 1, 'the proposed test case should be pending');
    assert.equal(body.uncoveredCriteria.length, 0);
    assert.equal(since(before_)[0]?.path, '/pipeline/S2T-1');
  });

  it('requires --issue', async () => {
    const res = await runCli(['status'], env());
    assert.equal(res.status, 1);
    assert.equal((res.stderr as { event: string }).event, 'usage_error');
  });
});

describe('s2t reconcile', () => {
  it('defaults to dry_run: true, and --confirm flips it', async () => {
    stub.respond('POST', '/jira/S2T-1/reconcile', { status: 200, body: { action: 'up_to_date', detail: 'd' } });

    let n = stub.requests.length;
    await runCli(['reconcile', '--issue', 'S2T-1'], env());
    assert.equal((since(n)[0]?.body as { dry_run: boolean }).dry_run, true);

    n = stub.requests.length;
    await runCli(['reconcile', '--issue', 'S2T-1', '--confirm'], env());
    assert.equal((since(n)[0]?.body as { dry_run: boolean }).dry_run, false);
  });
});

describe('s2t draft-requirement', () => {
  it('drafts with provenance when no open requirement exists, title/body copied verbatim', async () => {
    stub.respond('GET', '/projects/S2T-PILOT', { status: 200, body: PROJECT });
    stub.respond('GET', '/pipeline/S2T-1', {
      status: 200,
      body: {
        issueKey: 'S2T-1',
        stage: 'no_requirement',
        detail: 'd',
        requirement: null,
        criteria: [],
        testCases: [],
        reconcile: { action: 'no_local_instance', detail: 'd' },
        jira: { verificationStatus: undefined, criteriaPosted: false, summary: 'a loan rule', requirementText: 'a loan rule\n\nfull text' },
      },
    });
    stub.respond('POST', '/requirements', { status: 200, body: { resumed: false, requirement: { id: 'req-1' } } });

    const n = stub.requests.length;
    const res = await runCli(['draft-requirement', '--issue', 'S2T-1', '--model', 'claude-opus-5'], env());
    assert.equal(res.status, 0, JSON.stringify(res.stdout));
    const body = res.stdout as { ok: boolean; requirement: { id: string } };
    assert.equal(body.ok, true);
    assert.equal(body.requirement.id, 'req-1');

    const postReq = since(n).find((r) => r.path === '/requirements');
    const sent = postReq!.body as { title: string; body: string; drafted_by_model: string; prompt_version: string };
    assert.equal(sent.title, 'a loan rule', 'title must be the ticket summary verbatim');
    assert.equal(sent.body, 'a loan rule\n\nfull text', 'body must be the ticket text verbatim');
    assert.equal(sent.drafted_by_model, 'claude-opus-5');
    assert.match(sent.prompt_version, /^criteria\.v1@[0-9a-f]{12}$/);
  });

  it('resumes without needing --model at all', async () => {
    stub.respond('GET', '/projects/S2T-PILOT', { status: 200, body: PROJECT });
    stub.respond('GET', '/pipeline/S2T-1', {
      status: 200,
      body: {
        issueKey: 'S2T-1',
        stage: 'needs_criteria',
        detail: 'd',
        requirement: { id: 'req-1', state: 'awaiting_requirement_approval', title: 't', sourceTextHash: 'h' },
        criteria: [],
        testCases: [],
        reconcile: { action: 'no_local_instance', detail: 'd' },
        jira: { verificationStatus: undefined, criteriaPosted: false, summary: 't', requirementText: 't\n\nb' },
      },
    });
    stub.respond('POST', '/requirements', { status: 200, body: { resumed: true, requirement: { id: 'req-1' } } });

    const res = await runCli(['draft-requirement', '--issue', 'S2T-1'], env());
    assert.equal(res.status, 0, JSON.stringify(res.stdout));
    assert.equal((res.stdout as { requirement: { id: string } }).requirement.id, 'req-1');
  });

  it('refuses a model id that does not look like claude-*', async () => {
    stub.respond('GET', '/projects/S2T-PILOT', { status: 200, body: PROJECT });
    stub.respond('GET', '/pipeline/S2T-1', {
      status: 200,
      body: {
        issueKey: 'S2T-1',
        stage: 'no_requirement',
        detail: 'd',
        requirement: null,
        criteria: [],
        testCases: [],
        reconcile: { action: 'no_local_instance', detail: 'd' },
        jira: { verificationStatus: undefined, criteriaPosted: false, summary: 't', requirementText: 't\n\nb' },
      },
    });

    const res = await runCli(['draft-requirement', '--issue', 'S2T-1', '--model', 'gpt-4'], env());
    assert.equal(res.status, 0);
    const body = res.stdout as { ok: boolean; event: string };
    assert.equal(body.ok, false);
    assert.equal(body.event, 'model_id_invalid');
  });
});

describe('s2t draft-criteria', () => {
  it('posts criteria from --json-file, sends no provenance fields (the route accepts none)', async () => {
    stub.respond('GET', '/requirements/req-1', {
      status: 200,
      body: { requirement: { id: 'req-1', jira_issue_key: 'S2T-1', body: 't\n\nfull text', state: 'awaiting_requirement_approval' } },
    });
    stub.respond('POST', '/requirements/req-1/criteria', {
      status: 200,
      body: { criteria: [{ id: 'c1', ordinal: 1, body: 'rule', state: 'proposed' }] },
    });

    const n = stub.requests.length;
    const res = await runCli(
      ['draft-criteria', '--requirement-id', 'req-1', '--model', 'claude-opus-5', '--json-file', '-'],
      env(),
      JSON.stringify([{ body: 'rule', state_affecting: false }]),
    );
    assert.equal(res.status, 0, JSON.stringify(res.stdout));
    assert.equal((res.stdout as { ok: boolean }).ok, true);

    const posted = since(n).find((r) => r.path === '/requirements/req-1/criteria');
    const sent = posted!.body as { criteria: unknown[]; drafted_by_model?: string };
    assert.equal(sent.criteria.length, 1);
    assert.equal(sent.drafted_by_model, undefined, 'criterion has no provenance columns - nothing should be sent');
  });
});

describe('s2t redraft', () => {
  it('looks up the ticket via the requirement own jira_issue_key, no --issue flag needed', async () => {
    stub.respond('GET', '/requirements/req-1', {
      status: 200,
      body: { requirement: { id: 'req-1', jira_issue_key: 'S2T-1', body: 'old', state: 'stale' } },
    });
    stub.respond('GET', '/pipeline/S2T-1', {
      status: 200,
      body: {
        issueKey: 'S2T-1',
        stage: 'stale',
        detail: 'd',
        requirement: { id: 'req-1', state: 'stale', title: 't', sourceTextHash: 'h' },
        criteria: [],
        testCases: [],
        reconcile: { action: 'drift_detected', detail: 'd' },
        jira: { verificationStatus: undefined, criteriaPosted: false, summary: 't2', requirementText: 't2\n\nnew text' },
      },
    });
    stub.respond('POST', '/requirements/req-1/redraft', {
      status: 200,
      body: { requirement: { id: 'req-1' }, criteria: [] },
    });

    const n = stub.requests.length;
    const res = await runCli(
      ['redraft', '--requirement-id', 'req-1', '--model', 'claude-opus-5', '--reason', 'drifted', '--json-file', '-'],
      env(),
      JSON.stringify([{ body: 'rule', state_affecting: false }]),
    );
    assert.equal(res.status, 0, JSON.stringify(res.stdout));

    const posted = since(n).find((r) => r.path === '/requirements/req-1/redraft');
    const sent = posted!.body as { body: string; reason: string };
    assert.equal(sent.body, 't2\n\nnew text', 'redraft must adopt the CURRENT ticket text, not the stale one');
    assert.equal(sent.reason, 'drifted');
  });
});

describe('s2t grounding', () => {
  it('summarizes routes from the OpenAPI text, omitting text unless --full', async () => {
    stub.respond('GET', '/projects/S2T-PILOT', { status: 200, body: PROJECT });
    stub.respond('GET', '/environments/resolve', { status: 200, body: ENVIRONMENT });
    stub.respond('GET', '/environments/env-1/grounding', {
      status: 200,
      body: { environmentId: 'env-1', source: 'x.yml', text: 'openapi: 3.0.0\npaths:\n  /api/articles:\n    get: {}\n', contentHash: 'h' },
    });

    const res = await runCli(['grounding'], env());
    assert.equal(res.status, 0, JSON.stringify(res.stdout));
    const body = res.stdout as { routes: string[]; text?: string };
    assert.deepEqual(body.routes, ['GET /api/articles']);
    assert.equal(body.text, undefined);

    const full = await runCli(['grounding', '--full'], env());
    assert.equal((full.stdout as { text: string }).text.includes('openapi'), true);
  });
});

describe('s2t post-criteria', () => {
  it('requires exactly one of --preview/--confirm', async () => {
    const neither = await runCli(['post-criteria', '--issue', 'S2T-1', '--requirement-id', 'req-1'], env());
    assert.equal(neither.status, 1);
    const both = await runCli(
      ['post-criteria', '--issue', 'S2T-1', '--requirement-id', 'req-1', '--preview', '--confirm'],
      env(),
    );
    assert.equal(both.status, 1);
  });

  it('--preview sends dry_run: true', async () => {
    stub.respond('POST', '/jira/S2T-1/criteria', {
      status: 200,
      body: { wrote: false, reason: 'preview: would post 1 criteria', fingerprint: 'fp', dryRun: true, preview: { comment: {}, fields: {} } },
    });
    const n = stub.requests.length;
    const res = await runCli(['post-criteria', '--issue', 'S2T-1', '--requirement-id', 'req-1', '--preview'], env());
    assert.equal(res.status, 0);
    assert.equal((since(n)[0]?.body as { dry_run: boolean }).dry_run, true);
  });
});

describe('s2t draft-test-case', () => {
  const grounded = {
    environmentId: 'env-1',
    source: 'x.yml',
    text: 'openapi: 3.0.0\npaths:\n  /api/articles:\n    get: {}\n',
    contentHash: 'gh',
  };
  const spec = {
    criterionId: 'c1',
    name: 'list articles',
    method: 'GET',
    path: '/api/articles',
    auth: 'none',
    assertions: [{ name: 'status_200', check: 'status === 200' }],
  };

  it('validates before drafting, surfaces hints, never POSTs an ungrounded spec', async () => {
    stub.respond('GET', '/projects/S2T-PILOT', { status: 200, body: PROJECT });
    stub.respond('GET', '/environments/resolve', { status: 200, body: ENVIRONMENT });
    stub.respond('GET', '/environments/env-1/grounding', { status: 200, body: grounded });
    stub.respond('POST', '/specs/validate', { status: 200, body: { ok: true, hints: ['assertion "x" ...'] } });
    stub.respond('POST', '/test-cases', { status: 200, body: { id: 'tc1', criterion_id: 'c1', state: 'proposed' } });

    const n = stub.requests.length;
    const res = await runCli(
      ['draft-test-case', '--criterion-id', 'c1', '--model', 'claude-opus-5', '--json-file', '-'],
      env(),
      JSON.stringify(spec),
    );
    assert.equal(res.status, 0, JSON.stringify(res.stdout));
    const body = res.stdout as { ok: boolean; hints: string[]; id: string };
    assert.equal(body.ok, true);
    assert.equal(body.hints.length, 1);
    assert.equal(body.id, 'tc1');

    const paths = since(n).map((r) => r.path);
    assert.ok(paths.includes('/specs/validate'));
    assert.ok(paths.includes('/test-cases'));
  });

  it('refuses when spec.criterionId does not match --criterion-id, before any HTTP call to /test-cases', async () => {
    stub.respond('GET', '/projects/S2T-PILOT', { status: 200, body: PROJECT });
    stub.respond('GET', '/environments/resolve', { status: 200, body: ENVIRONMENT });

    const n = stub.requests.length;
    const res = await runCli(
      ['draft-test-case', '--criterion-id', 'c1', '--model', 'claude-opus-5', '--json-file', '-'],
      env(),
      JSON.stringify({ ...spec, criterionId: 'wrong' }),
    );
    assert.equal(res.status, 0);
    const body = res.stdout as { ok: boolean; event: string };
    assert.equal(body.ok, false);
    assert.equal(body.event, 'criterion_id_mismatch');
    assert.ok(!since(n).some((r) => r.path === '/test-cases'));
  });

  it('refuses when /specs/validate rejects the spec, never reaching /test-cases', async () => {
    stub.respond('GET', '/projects/S2T-PILOT', { status: 200, body: PROJECT });
    stub.respond('GET', '/environments/resolve', { status: 200, body: ENVIRONMENT });
    stub.respond('GET', '/environments/env-1/grounding', { status: 200, body: grounded });
    stub.respond('POST', '/specs/validate', {
      status: 200,
      body: { ok: false, event: 'spec_not_grounded', message: 'not documented' },
    });

    const n = stub.requests.length;
    const res = await runCli(
      ['draft-test-case', '--criterion-id', 'c1', '--model', 'claude-opus-5', '--json-file', '-'],
      env(),
      JSON.stringify({ ...spec, path: '/api/not-real' }),
    );
    assert.equal(res.status, 0);
    const body = res.stdout as { ok: boolean; event: string };
    assert.equal(body.ok, false);
    assert.equal(body.event, 'spec_not_grounded');
    assert.ok(!since(n).some((r) => r.path === '/test-cases'));
  });
});

describe('s2t approve-test-case', () => {
  it('approves with exactly one id and the seen hash', async () => {
    stub.respond('POST', '/gate2/decisions', { status: 200, body: { recorded: true, state: 'approved', sameActorBothGates: false } });
    const n = stub.requests.length;
    const res = await runCli(
      ['approve-test-case', '--test-case-id', 'tc1', '--seen-hash', 'h1', '--actor', 'dev@example.com'],
      env(),
    );
    assert.equal(res.status, 0, JSON.stringify(res.stdout));
    const sent = since(n)[0]!.body as { subject_id: string; decision: string; seen_hash: string };
    assert.equal(sent.subject_id, 'tc1');
    assert.equal(sent.decision, 'approved');
    assert.equal(sent.seen_hash, 'h1');
  });

  it('falls back to SPEC2TEST_ACTOR when --actor is not given', async () => {
    stub.respond('POST', '/gate2/decisions', { status: 200, body: { recorded: true, state: 'approved', sameActorBothGates: false } });
    const n = stub.requests.length;
    await runCli(['approve-test-case', '--test-case-id', 'tc1', '--seen-hash', 'h1'], env());
    assert.equal((since(n)[0]!.body as { actor: string }).actor, 'dev@example.com');
  });

  it('rejects with a reason', async () => {
    stub.respond('POST', '/gate2/decisions', { status: 200, body: { recorded: true, state: 'rejected', sameActorBothGates: false } });
    const n = stub.requests.length;
    await runCli(
      ['approve-test-case', '--test-case-id', 'tc1', '--seen-hash', 'h1', '--reject', '--reason', 'wrong assertion'],
      env(),
    );
    const sent = since(n)[0]!.body as { decision: string; reason: string };
    assert.equal(sent.decision, 'rejected');
    assert.equal(sent.reason, 'wrong assertion');
  });

  it('--all is not a real flag - there is no way to approve more than one test case', async () => {
    // No --test-case-id given at all: --all does nothing, and the missing
    // required flag is what actually fails this, which is the point - the
    // structural guarantee is that no flag exists to name more than one id.
    const res = await runCli(['approve-test-case', '--all', '--seen-hash', 'h1'], env());
    assert.equal(res.status, 1);
    assert.equal((res.stderr as { event: string }).event, 'usage_error');
  });

  it('refuses a missing --seen-hash', async () => {
    const res = await runCli(['approve-test-case', '--test-case-id', 'tc1'], env());
    assert.equal(res.status, 1);
    assert.equal((res.stderr as { event: string }).event, 'usage_error');
  });

  it('--reject without --reason is a usage error', async () => {
    const res = await runCli(['approve-test-case', '--test-case-id', 'tc1', '--seen-hash', 'h1', '--reject'], env());
    assert.equal(res.status, 1);
  });
});

describe('s2t verify', () => {
  it('resolves the environment, posts to /test-cases/:id/verify, and distills a summary', async () => {
    stub.respond('GET', '/projects/S2T-PILOT', { status: 200, body: PROJECT });
    stub.respond('GET', '/environments/resolve', { status: 200, body: ENVIRONMENT });
    stub.respond('POST', '/test-cases/tc1/verify', {
      status: 200,
      body: { jobId: 'job-1', status: 'done', verification: { state: 'contract_verified', criteria: [] } },
    });

    const n = stub.requests.length;
    const res = await runCli(['verify', '--test-case-id', 'tc1'], env());
    assert.equal(res.status, 0, JSON.stringify(res.stdout));
    const body = res.stdout as { summary: string };
    assert.equal(body.summary, 'verified: contract_verified');
    const sent = since(n).find((r) => r.path === '/test-cases/tc1/verify');
    assert.equal((sent!.body as { environment_id: string }).environment_id, 'env-1');
  });
});

describe('s2t sync', () => {
  it('requires exactly one of --preview/--confirm, and sends dry_run accordingly', async () => {
    stub.respond('POST', '/jira/S2T-1/verification', {
      status: 200,
      body: { verification: { state: 'contract_verified', criteria: [] }, jira: { wrote: true, reason: 'posted', fingerprint: 'fp' } },
    });
    const n = stub.requests.length;
    const res = await runCli(['sync', '--issue', 'S2T-1', '--requirement-id', 'req-1', '--confirm'], env());
    assert.equal(res.status, 0, JSON.stringify(res.stdout));
    assert.equal((since(n)[0]!.body as { dry_run: boolean }).dry_run, false);
  });
});

describe('a service the CLI cannot reach', () => {
  it('is reported as service_unreachable, never a crash', async () => {
    const res = await runCli(['status', '--issue', 'S2T-1'], env({ SPEC2TEST_SERVICE_URL: 'http://127.0.0.1:1' }));
    assert.equal(res.status, 0, 'a down service must be data (exit 0), not a crash (exit 1)');
    const body = res.stdout as { ok: boolean; event: string };
    assert.equal(body.ok, false);
    assert.equal(body.event, 'service_unreachable');
  });
});

describe('config validation', () => {
  it('reports every missing required var at once', async () => {
    const bare = {
      SPEC2TEST_SERVICE_URL: stub.url,
      // everything else deliberately absent
    };
    const res = await runCli(['status', '--issue', 'S2T-1'], bare);
    assert.equal(res.status, 0);
    const body = res.stdout as { ok: boolean; event: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.event, 'config_missing');
    for (const name of ['SPEC2TEST_PROJECT_KEY', 'SPEC2TEST_ACTOR', 'CONDUIT_BASE_URL', 'CONDUIT_REPO_PATH']) {
      assert.match(body.message, new RegExp(name));
    }
  });
});
