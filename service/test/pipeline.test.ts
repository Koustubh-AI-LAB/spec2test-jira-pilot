/**
 * `stage` is the one value the skill switches on, so it has to be right in the
 * places a one-transition test never reaches: after a redraft, after drift,
 * once Jira has been written past the two Gate 1 values, and above all while
 * remaining strictly read-only. Hence three layers - the pure table, the one
 * helper with a known trap, and full sequences over real Postgres and a
 * scripted fake Jira.
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
import { computeStage, criteriaArePosted, pipelineState } from '../src/pipeline.ts';
import type { StageInputs } from '../src/pipeline.ts';
import { fakeJira } from './helpers/fake-jira.ts';
import type { FakeJira } from './helpers/fake-jira.ts';

import { useTestDatabase } from './helpers/db.ts';

await useTestDatabase();

// --- the pure table -------------------------------------------------------

/** A fully verified requirement; each test perturbs exactly one thing. */
function inputs(overrides: Partial<StageInputs> = {}): StageInputs {
  return {
    requirement: { state: 'contract_verified' },
    criteria: [{ id: 'c1', state: 'approved' }],
    testCases: [{ criterionId: 'c1', state: 'approved' }],
    criteriaPosted: true,
    jobActive: false,
    reconcileAction: 'up_to_date',
    ...overrides,
  };
}

const stageOf = (o: Partial<StageInputs>) => computeStage(inputs(o)).stage;

describe('computeStage', () => {
  it('no open requirement', () => {
    assert.equal(stageOf({ requirement: null, criteria: [], testCases: [] }), 'no_requirement');
  });

  it('a requirement with no criteria', () => {
    assert.equal(
      stageOf({ requirement: { state: 'awaiting_requirement_approval' }, criteria: [], testCases: [] }),
      'needs_criteria',
    );
  });

  it('drift wins over everything, whether Jira or the rows report it', () => {
    assert.equal(stageOf({ reconcileAction: 'drift_detected' }), 'stale');
    assert.equal(stageOf({ reconcileAction: 'approval_unverifiable' }), 'stale');
    assert.equal(stageOf({ requirement: { state: 'stale' } }), 'stale');
    assert.equal(stageOf({ criteria: [{ id: 'c1', state: 'stale' }] }), 'stale');
  });

  it('rejected criteria', () => {
    assert.equal(stageOf({ criteria: [{ id: 'c1', state: 'rejected' }], testCases: [] }), 'criteria_rejected');
  });

  describe('gate 1', () => {
    const proposed = { criteria: [{ id: 'c1', state: 'proposed' }], testCases: [] };

    it('criteria not yet on the ticket', () => {
      assert.equal(stageOf({ ...proposed, criteriaPosted: false }), 'needs_criteria_posting');
    });

    it('posted, waiting on the PO', () => {
      assert.equal(stageOf({ ...proposed, reconcileAction: 'gate1_pending' }), 'awaiting_criteria_approval');
    });

    it('the PO has decided in Jira but it is not applied here', () => {
      for (const reconcileAction of ['gate1_closed', 'gate1_partial', 'gate1_rejected', 'gate1_blocked'] as const) {
        assert.equal(stageOf({ ...proposed, reconcileAction }), 'gate1_decision_unapplied', reconcileAction);
      }
    });

    it('a decision left on the ticket from an older round is NOT reported as unapplied', () => {
      // After a redraft the ticket still reads Approved/Rejected until the new
      // criteria are posted. That decision was made against text that no
      // longer exists, so the stage must be "post it", not "apply it".
      assert.equal(
        stageOf({ ...proposed, criteriaPosted: false, reconcileAction: 'gate1_rejected' }),
        'needs_criteria_posting',
      );
    });
  });

  describe('after gate 1 closes', () => {
    it('an approved criterion with no test case', () => {
      assert.equal(stageOf({ requirement: { state: 'awaiting_requirement_approval' }, testCases: [] }), 'needs_tests');
    });

    it('a criterion whose only test case was rejected counts as having none', () => {
      assert.equal(stageOf({ testCases: [{ criterionId: 'c1', state: 'rejected' }] }), 'needs_tests');
    });

    it('an uncovered criterion needs tests even though gate 1 is closed', () => {
      assert.equal(stageOf({ criteria: [{ id: 'c1', state: 'uncovered' }], testCases: [] }), 'needs_tests');
    });

    it('needs_tests reports if ANY criterion lacks one, not just the first', () => {
      assert.equal(
        stageOf({
          criteria: [
            { id: 'c1', state: 'approved' },
            { id: 'c2', state: 'approved' },
          ],
          testCases: [{ criterionId: 'c1', state: 'approved' }],
        }),
        'needs_tests',
      );
    });

    it('a drafted test case waits on gate 2', () => {
      assert.equal(stageOf({ testCases: [{ criterionId: 'c1', state: 'proposed' }] }), 'awaiting_test_approval');
    });

    it('everything approved but never verified', () => {
      assert.equal(stageOf({ requirement: { state: 'awaiting_test_approval' } }), 'needs_verification');
    });

    it('a queued or running job means verifying, ahead of everything below it', () => {
      assert.equal(stageOf({ jobActive: true, testCases: [] }), 'verifying');
    });

    it('reads the rolled-up verdict from the requirement', () => {
      for (const state of ['contract_verified', 'weak', 'failing'] as const) {
        assert.equal(stageOf({ requirement: { state } }), state);
      }
    });

    it('does not fall back to gate 1 when Jira has been written past the gate 1 values', () => {
      // reconcile only understands Approved/Rejected, so once postVerification
      // has written "Contract-Verified" it reports gate1_pending. That must
      // not drag a finished requirement back to waiting on the PO.
      assert.equal(stageOf({ reconcileAction: 'gate1_pending' }), 'contract_verified');
    });
  });
});

// --- criteriaArePosted ----------------------------------------------------

describe('criteriaArePosted', () => {
  const requirement = { source_text_hash: 'req-hash' };
  const criteria = [
    { id: 'c1', content_hash: 'h1' },
    { id: 'c2', content_hash: 'h2' },
  ];
  const property = {
    coverage_state: 'criteria_drafted',
    fingerprint: 'fp',
    requirement_hash: 'req-hash',
    criteria_posted: { c1: 'h1', c2: 'h2' },
    updated_at: '2026-09-11T10:00:00.000Z',
  };

  it('is true when the ticket carries exactly the current criteria', () => {
    assert.equal(criteriaArePosted(property, requirement, criteria), true);
  });

  it('is false with no property at all', () => {
    assert.equal(criteriaArePosted(undefined, requirement, criteria), false);
  });

  it('is false when a criterion was reworded since it was posted', () => {
    assert.equal(
      criteriaArePosted(property, requirement, [criteria[0]!, { id: 'c2', content_hash: 'changed' }]),
      false,
    );
  });

  it('is false when a criterion was never posted', () => {
    assert.equal(criteriaArePosted(property, requirement, [...criteria, { id: 'c3', content_hash: 'h3' }]), false);
  });

  it('is false when the requirement moved on', () => {
    assert.equal(criteriaArePosted(property, { source_text_hash: 'other' }, criteria), false);
  });

  it('is false after drift even though postDrift copied in the new requirement hash', () => {
    // postDrift writes requirement_hash = the NEW text's hash without
    // re-presenting anything. After a redraft that keeps criterion wording,
    // every hash comparison above would pass for criteria that were never
    // posted - only coverage_state tells the difference.
    assert.equal(criteriaArePosted({ ...property, coverage_state: 'stale' }, requirement, criteria), false);
  });
});

// --- sequences against real Postgres and a fake Jira ----------------------

const ISSUE = 'FAKE-1';
const PROVENANCE = {
  drafted_by_model: 'claude-opus-5',
  prompt_version: 'draft-v1',
  grounding_hash: 'pipeline-test',
  temperature: 0,
};
let app: FastifyInstance;
let requirementId: string;
let projectId: string;

before(async () => {
  await migrate();
  app = buildServer();
  await app.ready();
});

beforeEach(async () => {
  await getAdminPool().query('TRUNCATE project, audit_event RESTART IDENTITY CASCADE');
  // Every pipelineState call below is scoped by project - see pipeline.ts's
  // doc comment on why the resume lookup must not be a bare jira_issue_key
  // match. Created once per test, before anything else, so `stage(jira)` can
  // be called even before a requirement exists.
  const project = await call('POST', '/projects', { key: 'FAKE-PILOT', jira_project_key: 'FAKE' });
  projectId = project.id;
});

after(async () => {
  await app?.close();
  await closePool();
});

async function call(method: 'GET' | 'POST', url: string, payload?: object) {
  const res = await app.inject({ method, url, payload });
  assert.equal(res.statusCode, 200, `${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res.json();
}

/** A requirement drafted from the fake ticket's own text, so hashes line up. */
async function seedRequirement(summary: string, description: string) {
  const hash = contentHash(`${summary}\n\n${description}`);
  const { rows } = await getPool().query(
    `INSERT INTO requirement
       (project_id, jira_issue_key, title, body, source_text_hash, state,
        drafted_by_model, prompt_version, grounding_hash, temperature)
     VALUES ($1,$2,$3,$4,$5,'awaiting_requirement_approval','claude-opus-5','draft-v1',$5,0)
     RETURNING id`,
    [projectId, ISSUE, summary, description, hash],
  );
  requirementId = rows[0].id;
  return hash;
}

async function addCriteria(bodies: string[]) {
  return (await call('POST', `/requirements/${requirementId}/criteria`, { criteria: bodies.map((body) => ({ body })) }))
    .criteria as { id: string; content_hash: string }[];
}

async function present(jira: FakeJira, requirementHash: string) {
  const { rows } = await getPool().query(
    'SELECT id, ordinal, body, content_hash, state_affecting FROM criterion WHERE requirement_id = $1 ORDER BY ordinal',
    [requirementId],
  );
  return postCriteria(jira.client, {
    issueKey: ISSUE,
    requirementHash,
    criteria: rows.map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      body: r.body,
      contentHash: r.content_hash,
      stateAffecting: r.state_affecting,
    })),
  });
}

async function draftCase(criterionId: string, name: string) {
  return call('POST', '/test-cases', {
    criterion_id: criterionId,
    name,
    kind: 'api',
    spec: { method: 'GET', path: '/loans' },
    ...PROVENANCE,
  }) as Promise<{ id: string; content_hash: string }>;
}

async function gate2(testCase: { id: string; content_hash: string }, decision: 'approved' | 'rejected') {
  return call('POST', '/gate2/decisions', {
    subject_id: testCase.id,
    decision,
    actor: 'dev@example.com',
    channel: 'claude-code',
    reason: decision === 'rejected' ? 'wrong status asserted' : undefined,
    seen_hash: testCase.content_hash,
  });
}

const stage = async (jira: FakeJira) => (await pipelineState(jira.client, ISSUE, projectId)).stage;

describe('pipelineState: the happy path, one stage at a time', () => {
  it('walks from nothing to needs_verification, and never writes while looking', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 'loans', description: 'a member may hold 3 books', changelog: [] });

    assert.equal(await stage(jira), 'no_requirement');

    const hash = await seedRequirement('loans', 'a member may hold 3 books');
    assert.equal(await stage(jira), 'needs_criteria');

    const [criterion] = await addCriteria(['a 4th loan is refused']);
    assert.equal(await stage(jira), 'needs_criteria_posting');

    await present(jira, hash);
    assert.equal(await stage(jira), 'awaiting_criteria_approval');

    // The PO approves in Jira. Looking at the pipeline must NOT apply it.
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T11:00:00.000+0530');
    const writesBefore = jira.writes.length;
    const observed = await pipelineState(jira.client, ISSUE, projectId);
    assert.equal(observed.stage, 'gate1_decision_unapplied', observed.reconcile.detail);
    assert.equal(jira.writes.length, writesBefore, 'looking at the pipeline wrote to Jira');
    assert.equal(observed.criteria[0]!.state, 'proposed', 'looking at the pipeline mutated a criterion');

    const applied = await reconcile(jira.client, ISSUE);
    assert.equal(applied.action, 'gate1_closed', applied.detail);
    assert.equal(await stage(jira), 'needs_tests');

    const testCase = await draftCase(criterion!.id, 'a 4th loan is refused');
    assert.equal(await stage(jira), 'awaiting_test_approval');

    await gate2(testCase, 'approved');
    assert.equal(await stage(jira), 'needs_verification');
  });
});

describe('pipelineState: sequences that broke elsewhere', () => {
  it('after Jira is written past Criteria Approved, a finished requirement stays finished', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    const hash = await seedRequirement('t', 'b');
    const [criterion] = await addCriteria(['rule']);
    await present(jira, hash);
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T11:00:00.000+0530');
    await reconcile(jira.client, ISSUE);
    const testCase = await draftCase(criterion!.id, 'case');
    await gate2(testCase, 'approved');

    // What postVerification does to the live ticket, and the roll-up it reflects.
    jira.setVerificationStatus('Contract-Verified', '2026-09-11T12:00:00.000+0530');
    await getAdminPool().query(`UPDATE requirement SET state = 'contract_verified' WHERE id = $1`, [requirementId]);

    const observed = await pipelineState(jira.client, ISSUE, projectId);
    assert.equal(observed.reconcile.action, 'gate1_pending', 'premise: reconcile misreads a post-gate-1 status');
    assert.equal(observed.stage, 'contract_verified');
  });

  it('drift is reported without being applied, then a redraft is a post away from the PO again', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 'v1', description: 'body', changelog: [] });
    const hash = await seedRequirement('v1', 'body');
    await addCriteria(['rule']);
    await present(jira, hash);
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T11:00:00.000+0530');
    await reconcile(jira.client, ISSUE);

    jira.editSummary('v2', '2026-09-11T12:00:00.000+0530');
    const observed = await pipelineState(jira.client, ISSUE, projectId);
    assert.equal(observed.stage, 'stale');
    assert.equal(observed.criteria[0]!.state, 'approved', 'looking at drift mutated the criterion');

    // Really apply it (marks stale, posts the drift notice), then redraft with
    // wording UNCHANGED - the case where every hash comparison would pass.
    await reconcile(jira.client, ISSUE);
    assert.equal(await stage(jira), 'stale');

    const redrafted = await call('POST', `/requirements/${requirementId}/redraft`, {
      title: 'v2',
      body: 'v2\n\nbody',
      criteria: [{ body: 'rule' }],
      ...PROVENANCE,
    });
    assert.equal(
      await stage(jira),
      'needs_criteria_posting',
      'unchanged criterion wording made a never-posted draft look posted',
    );

    await present(jira, redrafted.requirement.source_text_hash);
    // The real postCriteria PUTs Verification Status back to "Criteria
    // Drafted"; the fake ignores field writes, so do what Jira would.
    jira.setVerificationStatus('Criteria Drafted', '2026-09-11T12:30:00.000+0530');
    assert.equal(await stage(jira), 'awaiting_criteria_approval');
  });

  it('a rejection surfaces the PO reason, and a redraft is "post it", not "apply the old rejection"', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    const hash = await seedRequirement('t', 'b');
    await addCriteria(['rule one']);
    await present(jira, hash);
    jira.postComment('please add an explicit 401 check', '2026-09-11T10:05:00.000+0530');
    jira.setVerificationStatus('Criteria Rejected', '2026-09-11T10:10:00.000+0530');
    await reconcile(jira.client, ISSUE);

    const rejected = await pipelineState(jira.client, ISSUE, projectId);
    assert.equal(rejected.stage, 'criteria_rejected');
    assert.match(rejected.rejectionReason ?? '', /401/);

    await call('POST', `/requirements/${requirementId}/redraft`, {
      body: 't\n\nb',
      criteria: [{ body: 'rule one, plus a 401 check' }],
      ...PROVENANCE,
    });
    // Jira still says "Criteria Rejected" here.
    const afterRedraft = await pipelineState(jira.client, ISSUE, projectId);
    assert.equal(afterRedraft.jira.verificationStatus, 'Criteria Rejected', 'premise');
    assert.equal(afterRedraft.stage, 'needs_criteria_posting');
    assert.equal(afterRedraft.rejectionReason, undefined, 'a stale rejection reason leaked into a later stage');
  });

  it('rejecting the only test case returns to needs_tests, and a redraft goes back to gate 2', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    const hash = await seedRequirement('t', 'b');
    const [criterion] = await addCriteria(['rule']);
    await present(jira, hash);
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T11:00:00.000+0530');
    await reconcile(jira.client, ISSUE);

    const first = await draftCase(criterion!.id, 'first attempt');
    await gate2(first, 'rejected');
    assert.equal(await stage(jira), 'needs_tests');

    await draftCase(criterion!.id, 'second attempt');
    assert.equal(await stage(jira), 'awaiting_test_approval');
  });

  it('a queued job reports verifying', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    const hash = await seedRequirement('t', 'b');
    const [criterion] = await addCriteria(['rule']);
    await present(jira, hash);
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T11:00:00.000+0530');
    await reconcile(jira.client, ISSUE);
    const testCase = await draftCase(criterion!.id, 'case');
    await gate2(testCase, 'approved');

    await getAdminPool().query(`INSERT INTO job (kind, requirement_id, payload) VALUES ('falsification', $1, '{}')`, [
      requirementId,
    ]);
    assert.equal(await stage(jira), 'verifying');
  });
});

// --- fields the plugin CLI needs (5.3-5.7 step 0.2) ------------------------

describe('pipelineState: jira.summary and jira.requirementText', () => {
  it('carries the ticket text verbatim, not the drafted requirement title/body', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 'loans', description: 'a member may hold 3 books', changelog: [] });
    await seedRequirement('a different drafted title', 'a different drafted body');

    const observed = await pipelineState(jira.client, ISSUE, projectId);
    // The CLI posts these fields verbatim to POST /requirements - if this ever
    // read from the local requirement row instead of the live ticket, a
    // paraphrase could drift from contentHash(ticket.requirementText) on the
    // very next reconcile without anyone noticing until Gate 1 mysteriously
    // reopened.
    assert.equal(observed.jira.summary, 'loans');
    assert.equal(observed.jira.requirementText, 'loans\n\na member may hold 3 books');
  });

  it('is an empty string, not undefined, for a ticket with no summary or description', async () => {
    // requirementText() filters out blank parts before joining (adf.ts), so
    // this is '' rather than '\n\n' - asserted here because pipeline.ts's own
    // `?? ''` fallback would otherwise mask either behavior identically.
    const jira = fakeJira({ key: ISSUE, summary: '', description: '', changelog: [] });
    const observed = await pipelineState(jira.client, ISSUE, projectId);
    assert.equal(observed.jira.summary, '');
    assert.equal(observed.jira.requirementText, '');
  });
});

describe('pipelineState: testCases[].verified', () => {
  async function registerEnvironment() {
    const project = await call('POST', '/projects', { key: 'FAKE-PILOT', jira_project_key: 'FAKE' });
    return call('POST', '/environments', {
      project_id: project.id,
      base_url: 'http://localhost:9999',
      class: 'ephemeral',
    }) as Promise<{ id: string }>;
  }

  it('is false for an approved test case no falsification run has touched', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    const hash = await seedRequirement('t', 'b');
    const [criterion] = await addCriteria(['rule']);
    await present(jira, hash);
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T11:00:00.000+0530');
    await reconcile(jira.client, ISSUE);
    const testCase = await draftCase(criterion!.id, 'case');
    await gate2(testCase, 'approved');

    const observed = await pipelineState(jira.client, ISSUE, projectId);
    assert.equal(observed.testCases[0]!.verified, false);
  });

  it('is true once a falsification run has produced fault_experiment rows for it - not derivable from state alone', async () => {
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    const hash = await seedRequirement('t', 'b');
    const [criterion] = await addCriteria(['rule']);
    await present(jira, hash);
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T11:00:00.000+0530');
    await reconcile(jira.client, ISSUE);
    const testCase = await draftCase(criterion!.id, 'case');
    await gate2(testCase, 'approved');

    const env = await registerEnvironment();
    // Same shape persistComplete (worker/index.ts) writes on a real
    // certified run - inserted directly here so this test exercises the
    // pipeline route's read-side derivation without needing a live target.
    const { rows: runRows } = await getPool().query<{ id: string }>(
      `INSERT INTO run (requirement_id, environment_id, kind, state, started_at, finished_at)
       VALUES ($1, $2, 'falsification', 'complete', now(), now())
       RETURNING id`,
      [requirementId, env.id],
    );
    await getPool().query(
      `INSERT INTO fault_experiment
         (run_id, criterion_id, test_case_id, set_kind, tier, spec, plausible, verdict, detail)
       VALUES ($1, $2, $3, 'kill', 1, '{}', true, 'kill', 'ok')`,
      [runRows[0]!.id, criterion!.id, testCase.id],
    );

    const observed = await pipelineState(jira.client, ISSUE, projectId);
    // state is untouched by verification (see certify.ts's doc comment) -
    // this assertion is the whole point of the field.
    assert.equal(observed.testCases[0]!.state, 'approved');
    assert.equal(observed.testCases[0]!.verified, true);
  });

  it('is per-test-case, not per-criterion - a mix of verified and never-run test cases on the same criterion never blur together', async () => {
    // Pins verification.ts's verifiedTestCaseIds, the helper pipeline.ts was
    // extracted to call instead of independently duplicating this join - a
    // fixture with one certified case and one never-run case on the SAME
    // criterion is exactly the shape that would expose the two
    // implementations disagreeing if they ever drifted apart again.
    const jira = fakeJira({ key: ISSUE, summary: 't', description: 'b', changelog: [] });
    const hash = await seedRequirement('t', 'b');
    const [criterion] = await addCriteria(['rule']);
    await present(jira, hash);
    jira.setVerificationStatus('Criteria Approved', '2026-09-11T11:00:00.000+0530');
    await reconcile(jira.client, ISSUE);

    const verifiedCase = await draftCase(criterion!.id, 'verified case');
    await gate2(verifiedCase, 'approved');
    const neverRunCase = await draftCase(criterion!.id, 'never-run case');
    await gate2(neverRunCase, 'approved');

    const env = await registerEnvironment();
    const { rows: runRows } = await getPool().query<{ id: string }>(
      `INSERT INTO run (requirement_id, environment_id, kind, state, started_at, finished_at)
       VALUES ($1, $2, 'falsification', 'complete', now(), now())
       RETURNING id`,
      [requirementId, env.id],
    );
    await getPool().query(
      `INSERT INTO fault_experiment
         (run_id, criterion_id, test_case_id, set_kind, tier, spec, plausible, verdict, detail)
       VALUES ($1, $2, $3, 'kill', 1, '{}', true, 'kill', 'ok')`,
      [runRows[0]!.id, criterion!.id, verifiedCase.id],
    );

    const observed = await pipelineState(jira.client, ISSUE, projectId);
    const byId = new Map(observed.testCases.map((t) => [t.id, t]));
    assert.equal(byId.get(verifiedCase.id)!.verified, true);
    assert.equal(byId.get(neverRunCase.id)!.verified, false);
  });
});
