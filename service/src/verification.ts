import { getPool } from './db/pool.ts';
import { certifyTestCase } from './certify.ts';
import type { FalsificationReport, FaultVerdict } from './runner/types.ts';

/**
 * The single place `requirement.state` gets written from step 5 onward.
 *
 * Neither `criterion.state` nor `test_case.state` has a slot for a
 * certification verdict (checked against the actual CHECK constraints in
 * migration 001 before writing this - see service/src/certify.ts's own
 * comment). Certification is read back on demand from `fault_experiment` via
 * `latestFalsificationReport` below, and the only state that changes as a
 * result is `requirement.state` - computed fresh every time, not
 * incrementally maintained, so there is exactly one source of truth for the
 * rollup instead of several call sites that can drift out of sync with each
 * other. Called after every state-changing step: gate 1 reconcile, a test
 * case being drafted, a gate 2 decision, and `verify`.
 *
 * Kept deliberately simple for this step - happy path plus the one named
 * reject path. The fuller failure-mode nuance (partial Jira sync, flaky
 * quarantine handling at the rollup level, etc.) is step 6's job.
 */

interface CriterionRow {
  id: string;
  state: string;
  state_affecting: boolean;
}

interface TestCaseRow {
  id: string;
}

export type RequirementVerificationState =
  'awaiting_test_approval' | 'verifying' | 'contract_verified' | 'weak' | 'failing';

export interface VerificationResult {
  state: RequirementVerificationState | 'unchanged';
  criteria: {
    id: string;
    stateAffecting: boolean;
    covered: boolean;
  }[];
}

/**
 * The most recent falsification run's verdicts for one test case, shaped
 * like the report runner/src/cli.ts's `falsify` command prints - reads it
 * back from `fault_experiment`/`run` rather than storing a derived verdict
 * anywhere, per the note above. Undefined when this test case has never
 * been through `verify`.
 */
export async function latestFalsificationReport(testCaseId: string): Promise<FalsificationReport | undefined> {
  const pool = getPool();
  const { rows: runRows } = await pool.query<{ id: string; criterion_id: string }>(
    `SELECT r.id, fe.criterion_id
       FROM run r
       JOIN fault_experiment fe ON fe.run_id = r.id
      WHERE fe.test_case_id = $1 AND r.kind = 'falsification'
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [testCaseId],
  );
  const latest = runRows[0];
  if (!latest) return undefined;

  const { rows: faultRows } = await pool.query<{
    spec: FaultVerdict['fault'];
    verdict: string;
    detail: string;
  }>(`SELECT spec, verdict, detail FROM fault_experiment WHERE run_id = $1 AND test_case_id = $2`, [
    latest.id,
    testCaseId,
  ]);

  return {
    criterionId: latest.criterion_id,
    verdicts: faultRows.map((row) => ({
      fault: row.spec,
      verdict: row.verdict.toUpperCase() as FaultVerdict['verdict'],
      detail: row.detail,
    })),
    assertionSensitivity: 0,
    runsExecuted: 0,
  };
}

async function hasRunningJob(requirementId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM job WHERE requirement_id = $1 AND state IN ('queued', 'running') LIMIT 1`,
    [requirementId],
  );
  return rows.length > 0;
}

/**
 * Every test case under `requirementId` that has ever been through a
 * falsification run - not "certified" (see `coverageForCriterion` below,
 * which is a stricter, different question). Shared so `pipeline.ts`'s
 * `testCases[].verified` field can't independently drift from what this
 * module considers "attempted."
 */
export async function verifiedTestCaseIds(requirementId: string): Promise<Set<string>> {
  const { rows } = await getPool().query<{ test_case_id: string }>(
    `SELECT DISTINCT fe.test_case_id
       FROM run r JOIN fault_experiment fe ON fe.run_id = r.id
      WHERE r.requirement_id = $1 AND r.kind = 'falsification'`,
    [requirementId],
  );
  return new Set(rows.map((r) => r.test_case_id));
}

interface CoverageDetail {
  covered: boolean;
  /**
   * True when this criterion is not covered, but every test case that has
   * been through `verify` came back `'quarantined'` (environment unstable -
   * most commonly the target being unreachable, see
   * runFalsification.ts's control-run health check) with no genuine
   * `'rejected'` verdict anywhere. A quarantined run proves nothing either
   * way; `decideVerificationState` below must never let it read as a
   * regression. False whenever nothing has been attempted yet, or the
   * criterion is `'uncovered'` (no live test case at all - a different,
   * non-quarantine reason for having no coverage).
   */
  quarantinedOnly: boolean;
}

async function coverageForCriterion(criterionId: string): Promise<CoverageDetail> {
  const { rows: testCases } = await getPool().query<TestCaseRow>(
    `SELECT id FROM test_case WHERE criterion_id = $1 AND state = 'approved'`,
    [criterionId],
  );
  let anyAttempted = false;
  let anyQuarantined = false;
  let anyNonQuarantined = false;
  for (const tc of testCases) {
    const report = await latestFalsificationReport(tc.id);
    if (!report) continue;
    anyAttempted = true;
    const verdict = certifyTestCase(report).verdict;
    if (verdict === 'certified') return { covered: true, quarantinedOnly: false };
    if (verdict === 'quarantined') anyQuarantined = true;
    else anyNonQuarantined = true;
  }
  return { covered: false, quarantinedOnly: anyAttempted && anyQuarantined && !anyNonQuarantined };
}

export interface CriterionCoverage {
  id: string;
  stateAffecting: boolean;
  covered: boolean;
  quarantinedOnly: boolean;
}

/**
 * The actual rollup decision, pure and exported for direct testing - the
 * same reasoning runFalsification.ts's `aggregate`/`computeAssertionSensitivity`
 * are exported for: the branching here is easier to prove correct against
 * synthetic inputs than by spawning Postgres for every combination.
 * `computeVerification` below is the thin DB-orchestration wrapper around it.
 */
export function decideVerificationState(input: {
  nonRejectedCriteriaCount: number;
  gate1Closed: boolean;
  hasRunningJob: boolean;
  coverage: CriterionCoverage[];
  anyVerificationAttempted: boolean;
  wasEverCertified: boolean;
}): RequirementVerificationState | 'unchanged' {
  // Nothing to roll up yet, or every criterion was rejected - gate 1's own
  // reconcile owns the pre-approval states, this function has nothing to add.
  if (input.nonRejectedCriteriaCount === 0) return 'unchanged';
  if (!input.gate1Closed) return 'unchanged';
  if (input.hasRunningJob) return 'verifying';
  if (!input.anyVerificationAttempted) return 'awaiting_test_approval';

  const allCovered = input.coverage.every((c) => c.covered);
  if (allCovered) return 'contract_verified';

  // A target outage (or any environment instability) that quarantines every
  // fault this run tried proves nothing either way - it must never read as a
  // regression. Only fall through to failing/weak once at least one
  // uncovered criterion has a genuine, non-quarantine shortfall (a real
  // 'rejected' verdict, or a criterion that has simply never been attempted
  // at all). Per the failure-mode table: re-verifying a
  // Contract-Verified requirement while the target happens to be down must
  // preserve that state, not silently report Failing for a run that proved
  // nothing.
  const uncovered = input.coverage.filter((c) => !c.covered);
  if (uncovered.length > 0 && uncovered.every((c) => c.quarantinedOnly)) return 'unchanged';

  // "failing" (a regression) vs "weak" (never fully covered) is read off the
  // requirement's own current state, rather than a separate history column -
  // it already remembers whether full coverage was ever reached.
  return input.wasEverCertified ? 'failing' : 'weak';
}

export async function computeVerification(requirementId: string): Promise<VerificationResult> {
  const pool = getPool();
  const { rows: reqRows } = await pool.query<{ state: string }>('SELECT state FROM requirement WHERE id = $1', [
    requirementId,
  ]);
  const requirement = reqRows[0];
  if (!requirement) return { state: 'unchanged', criteria: [] };

  const { rows: criteria } = await pool.query<CriterionRow>(
    `SELECT id, state, state_affecting FROM criterion WHERE requirement_id = $1 ORDER BY ordinal`,
    [requirementId],
  );
  const nonRejected = criteria.filter((c) => c.state !== 'rejected');
  const gate1Closed =
    nonRejected.length > 0 && nonRejected.every((c) => c.state === 'approved' || c.state === 'uncovered');
  const runningJob = gate1Closed && (await hasRunningJob(requirementId));

  const coverage: CriterionCoverage[] =
    gate1Closed && !runningJob
      ? await Promise.all(
          nonRejected.map(async (c) => {
            const detail: CoverageDetail =
              c.state === 'uncovered' ? { covered: false, quarantinedOnly: false } : await coverageForCriterion(c.id);
            return { id: c.id, stateAffecting: c.state_affecting, ...detail };
          }),
        )
      : [];

  const anyVerificationAttempted = gate1Closed && !runningJob ? await hasAnyFalsificationRun(requirementId) : false;
  const wasEverCertified = requirement.state === 'contract_verified' || requirement.state === 'failing';

  const state = decideVerificationState({
    nonRejectedCriteriaCount: nonRejected.length,
    gate1Closed,
    hasRunningJob: runningJob,
    coverage,
    anyVerificationAttempted,
    wasEverCertified,
  });

  if (state !== 'unchanged') await setState(requirementId, state);
  return { state, criteria: coverage };
}

async function hasAnyFalsificationRun(requirementId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM run WHERE requirement_id = $1 AND kind = 'falsification' LIMIT 1`,
    [requirementId],
  );
  return rows.length > 0;
}

async function setState(requirementId: string, state: RequirementVerificationState): Promise<void> {
  await getPool().query(`UPDATE requirement SET state = $1, updated_at = now() WHERE id = $2`, [state, requirementId]);
}
