import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.ts';
import { audit } from '../audit.ts';
import { ServiceError } from '../errors.ts';
import { runRunnerCli } from './runnerCli.ts';
import { certifyTestCase } from '../certify.ts';
import type { CertifyResult } from '../certify.ts';
import { computeVerification } from '../verification.ts';
import type { VerificationResult } from '../verification.ts';
import type { FalsificationReport, GenerateResult, ValidationReport } from '../runner/types.ts';

/**
 * Processes exactly one job: generate -> validate -> falsify, all via the
 * runner CLI subprocess (never an import - see worker/runnerCli.ts), then
 * persists everything in one transaction. The job table (migration 001) and
 * this function are the real background-execution architecture the master
 * plan calls for; only the "return immediately" behaviour is deferred for
 * this step - `POST /test-cases/:id/verify` calls this inline and waits for
 * it, per the confirmed decision to keep step 5 synchronous. A future poller
 * calls the exact same function.
 */

export interface RunOnceResult {
  jobId: string;
  status: 'done' | 'failed';
  lastError?: string;
  generate?: GenerateResult;
  validation?: ValidationReport;
  falsification?: FalsificationReport;
  certify?: CertifyResult;
  verification: VerificationResult;
}

interface JobRow {
  id: string;
  kind: string;
  requirement_id: string;
  payload: { testCaseId: string; environmentId: string };
}

interface TestCaseContext {
  testCaseId: string;
  spec: unknown;
  criterionId: string;
  requirementId: string;
  targetRepoRoot: string;
  spec2testDir: string;
  generatedDir: string;
  openapiPath: string;
}

export async function runOnce(jobId: string): Promise<RunOnceResult> {
  const job = await claimJob(jobId);
  if (job.kind !== 'falsification') {
    // Only kind used in this step - see migration 001's CHECK constraint for
    // the other ('smoke'), which nothing enqueues yet.
    await failJob(job.id, `unsupported job kind: ${job.kind}`);
    throw new ServiceError('unsupported_job_kind', `job ${job.id} has unsupported kind "${job.kind}"`);
  }

  // Everything between claiming the job and the try/finally below has to be
  // able to fail the job on its way out. A throw here would otherwise leave
  // the row in 'running' with nothing to reclaim it, and `hasRunningJob` in
  // verification.ts counts 'running' - so one unresolvable environment id
  // would pin the requirement at `verifying` permanently, which no retry can
  // clear. Reachable today: POST /test-cases/:id/verify checks that
  // environment_id is present, never that it exists.
  let ctx: TestCaseContext;
  let workDir: string;
  let specPath: string;
  try {
    ctx = await loadContext(job);
    workDir = mkdtempSync(join(tmpdir(), 'spec2test-worker-'));
    specPath = join(workDir, 'spec.json');
    writeFileSync(specPath, JSON.stringify(ctx.spec), 'utf8');
  } catch (err) {
    await failJob(job.id, err instanceof Error ? err.message : String(err));
    throw err;
  }

  try {
    const generateRes = runRunnerCli<GenerateResult>(['generate', specPath, ctx.generatedDir]);
    if (!generateRes.ok) {
      const message = `generate crashed: ${generateRes.error?.message ?? 'unknown error'}`;
      await failJob(job.id, message);
      const verification = await computeVerification(ctx.requirementId);
      return { jobId: job.id, status: 'failed', lastError: message, verification };
    }
    const generateResult = generateRes.result!;
    if (!generateResult.ok) {
      const message = `${generateResult.event}: ${generateResult.message}`;
      await failJob(job.id, message);
      const verification = await computeVerification(ctx.requirementId);
      return { jobId: job.id, status: 'failed', lastError: message, generate: generateResult, verification };
    }
    const filePath = generateResult.filePath!;

    const validateRes = runRunnerCli<ValidationReport>([
      'validate',
      specPath,
      filePath,
      ctx.targetRepoRoot,
      ctx.spec2testDir,
    ]);
    if (!validateRes.ok) {
      const message = `validate crashed: ${validateRes.error?.message ?? 'unknown error'}`;
      await failJob(job.id, message);
      const verification = await computeVerification(ctx.requirementId);
      return { jobId: job.id, status: 'failed', lastError: message, generate: generateResult, verification };
    }
    const validation = validateRes.result!;

    if (!validation.ok) {
      const failingStage = validation.stages.find((s) => !s.ok);
      const message = `validation failed at ${failingStage?.stage}: ${failingStage?.details.join('; ')}`;
      await persistValidationOnly({ job, ctx, generateResult, validation, filePath });
      await failJob(job.id, message);
      const verification = await computeVerification(ctx.requirementId);
      return { jobId: job.id, status: 'failed', lastError: message, generate: generateResult, validation, verification };
    }

    const falsifyRes = runRunnerCli<FalsificationReport>([
      'falsify',
      specPath,
      filePath,
      ctx.targetRepoRoot,
      ctx.openapiPath,
    ]);
    if (!falsifyRes.ok) {
      const message = `falsify crashed mid-run: ${falsifyRes.error?.message ?? 'unknown error'}`;
      await persistIncompleteFalsification({ job, ctx, generateResult, validation, filePath });
      await failJob(job.id, message);
      const verification = await computeVerification(ctx.requirementId);
      return { jobId: job.id, status: 'failed', lastError: message, generate: generateResult, validation, verification };
    }
    const falsification = falsifyRes.result!;
    const certify = certifyTestCase(falsification);

    await persistComplete({ job, ctx, generateResult, validation, falsification, filePath });
    const verification = await computeVerification(ctx.requirementId);

    return { jobId: job.id, status: 'done', generate: generateResult, validation, falsification, certify, verification };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function claimJob(jobId: string): Promise<JobRow> {
  const { rows } = await getPool().query<JobRow>(
    `UPDATE job SET state = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id = $1 AND state = 'queued'
      RETURNING id, kind, requirement_id, payload`,
    [jobId],
  );
  const job = rows[0];
  if (!job) throw new ServiceError('job_not_queued', `job ${jobId} is not queued (already claimed or missing)`);
  return job;
}

async function failJob(jobId: string, lastError: string): Promise<void> {
  await getPool().query(`UPDATE job SET state = 'failed', last_error = $1, updated_at = now() WHERE id = $2`, [
    lastError,
    jobId,
  ]);
  await audit({ event: 'falsification_job_failed', subject: `job:${jobId}`, detail: { last_error: lastError } });
}

async function loadContext(job: JobRow): Promise<TestCaseContext> {
  const { rows } = await getPool().query(
    `SELECT tc.id AS test_case_id, tc.spec,
            c.id AS criterion_id, r.id AS requirement_id,
            p.target_repo_path
       FROM test_case tc
       JOIN criterion c ON c.id = tc.criterion_id
       JOIN requirement r ON r.id = c.requirement_id
       JOIN project p ON p.id = r.project_id
      WHERE tc.id = $1`,
    [job.payload.testCaseId],
  );
  const row = rows[0];
  if (!row) throw new ServiceError('not_found', `test case ${job.payload.testCaseId} not found`, 404);

  const { rows: envRows } = await getPool().query<{ openapi_url: string }>(
    'SELECT openapi_url FROM environment WHERE id = $1',
    [job.payload.environmentId],
  );
  const env = envRows[0];
  if (!env) throw new ServiceError('not_found', `environment ${job.payload.environmentId} not found`, 404);

  const targetRepoRoot: string = row.target_repo_path;
  const spec2testDir = join(targetRepoRoot, 'spec2test');
  return {
    testCaseId: row.test_case_id,
    spec: row.spec,
    criterionId: row.criterion_id,
    requirementId: row.requirement_id,
    targetRepoRoot,
    spec2testDir,
    generatedDir: join(spec2testDir, 'generated'),
    openapiPath: env.openapi_url,
  };
}

interface PersistArgs {
  job: JobRow;
  ctx: TestCaseContext;
  generateResult: GenerateResult;
  validation: ValidationReport;
  filePath: string;
}

/** Validation failed - persist the smoke run/run_result rows only, and mark
 *  the job failed at the call site. */
async function persistValidationOnly(args: PersistArgs): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await writeSmokeRun(client, args);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Falsify crashed mid-run - the smoke run is real and gets recorded, but the
 *  falsification attempt gets an `incomplete` run per the failure-mode table
 *  ("a half-finished Kill Set must never produce a sensitivity number"). */
async function persistIncompleteFalsification(args: PersistArgs): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await writeSmokeRun(client, args);
    await client.query(
      `INSERT INTO run (requirement_id, environment_id, kind, state, started_at, finished_at)
       VALUES ($1, $2, 'falsification', 'incomplete', now(), now())`,
      [args.ctx.requirementId, args.job.payload.environmentId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

interface PersistCompleteArgs extends PersistArgs {
  falsification: FalsificationReport;
}

async function persistComplete(args: PersistCompleteArgs): Promise<void> {
  const { job, ctx, falsification, generateResult } = args;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await writeSmokeRun(client, args);

    const { rows: runRows } = await client.query<{ id: string }>(
      `INSERT INTO run (requirement_id, environment_id, kind, state, started_at, finished_at)
       VALUES ($1, $2, 'falsification', 'complete', now(), now())
       RETURNING id`,
      [ctx.requirementId, job.payload.environmentId],
    );
    const falsificationRunId = runRows[0]!.id;

    for (const v of falsification.verdicts) {
      await client.query(
        `INSERT INTO fault_experiment
           (run_id, criterion_id, test_case_id, set_kind, tier, spec, plausible, verdict, detail)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8)`,
        [
          falsificationRunId,
          ctx.criterionId,
          ctx.testCaseId,
          v.fault.kind,
          JSON.stringify(v.fault),
          v.fault.plausible,
          v.verdict.toLowerCase(),
          v.detail,
        ],
      );
    }

    await client.query(
      `UPDATE test_case SET artifact_path = $1, artifact_hash = $2, updated_at = now() WHERE id = $3`,
      [args.filePath, generateResult.contentHash ?? '', ctx.testCaseId],
    );

    await client.query(`UPDATE job SET state = 'done', updated_at = now() WHERE id = $1`, [job.id]);

    await audit(
      {
        event: 'falsification_job_done',
        subject: `test_case:${ctx.testCaseId}`,
        detail: {
          job_id: job.id,
          run_id: falsificationRunId,
          faults: falsification.verdicts.length,
          quarantined: Boolean(falsification.criterionQuarantined),
        },
      },
      client,
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Shared by every persist path: the smoke run from `validate`'s own live
 *  run, with one run_result row per assertion when step-level detail is
 *  available (see validator/smoke.ts's switch to runPlaywrightSteps), or one
 *  coarse row when validation failed before smoke ever ran. */
async function writeSmokeRun(client: PoolClient, args: PersistArgs): Promise<void> {
  const { ctx, job, validation } = args;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO run (requirement_id, environment_id, kind, state, started_at, finished_at)
     VALUES ($1, $2, 'smoke', $3, now(), now())
     RETURNING id`,
    [ctx.requirementId, job.payload.environmentId, validation.ok ? 'complete' : 'incomplete'],
  );
  const runId = rows[0]!.id;

  const smokeStage = validation.stages.find((s) => s.stage === 'smoke');
  if (smokeStage?.steps?.length) {
    for (const step of smokeStage.steps) {
      await client.query(
        `INSERT INTO run_result (run_id, test_case_id, assertion, outcome, detail)
         VALUES ($1, $2, $3, $4, '')`,
        [runId, ctx.testCaseId, step.title.replace(/^assertion: /, ''), step.failed ? 'fail' : 'pass'],
      );
    }
    return;
  }

  const failingStage = validation.stages.find((s) => !s.ok);
  await client.query(
    `INSERT INTO run_result (run_id, test_case_id, assertion, outcome, detail)
     VALUES ($1, $2, '', $3, $4)`,
    [
      runId,
      ctx.testCaseId,
      validation.ok ? 'pass' : 'error',
      failingStage ? `${failingStage.stage}: ${failingStage.details.join('; ')}` : '',
    ],
  );
}
