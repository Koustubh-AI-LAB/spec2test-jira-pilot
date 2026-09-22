import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.ts';
import { audit } from '../audit.ts';
import { contentHash } from '../hash.ts';
import { decide } from '../gates/gates.ts';
import type { Channel, Decision, Gate } from '../gates/gates.ts';
import { capabilitiesFor, isEnvironmentClass } from '../env/capabilities.ts';
import { EnvironmentNotAllowedError, ServiceError } from '../errors.ts';
import { jiraClient } from '../jira/client.ts';
import type { JiraClient } from '../jira/client.ts';
import { reconcile } from '../jira/reconcile.ts';
import { loadFieldMap, validateFieldMap } from '../jira/read.ts';
import { postCriteria, postDrift, postRefusal, postVerification } from '../jira/write.ts';
import type { CriterionView } from '../jira/write.ts';
import { runOnce } from '../worker/index.ts';
import { runRunnerCli } from '../worker/runnerCli.ts';
import type { SpecValidationResult } from '../runner/types.ts';
import { computeVerification } from '../verification.ts';
import { pipelineState } from '../pipeline.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id would otherwise reach Postgres and come back as a 500. */
function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Bumped whenever the plugin-facing contract changes. The skill checks this at
 * preflight and refuses to run on a mismatch: a cached older plugin talking to
 * a newer schema is a way to corrupt state quietly.
 *
 * 2: adds GET /pipeline/:issueKey, GET /environments/:id/grounding,
 *    GET /jobs/:id and the `dry_run` flag on POST /jira/:issueKey/criteria and
 *    /verification; POST /requirements no longer demands provenance on a
 *    resume; POST /test-cases accepts an `uncovered` criterion. (Two routes -
 *    /jira/:issueKey/verification and /test-cases/:id/verify - were added to
 *    version 1 without a bump, which is why this jumps rather than tracking
 *    each one.)
 * 3: adds GET /projects/:key, POST /specs/validate, and two fields the
 *    plugin CLI needs on GET /pipeline/:issueKey's response -
 *    jira.summary/jira.requirementText (so the CLI can post the ticket's
 *    text to POST /requirements verbatim, never paraphrased) and
 *    testCases[].verified (not derivable from testCases[].state - see
 *    PipelineState's doc comment in pipeline.ts).
 */
export const API_VERSION = 3;

interface Provenance {
  drafted_by_model: string;
  prompt_version: string;
  grounding_hash: string;
  temperature?: number;
}

function requireProvenance(body: Partial<Provenance>): Provenance {
  const { drafted_by_model, prompt_version, grounding_hash } = body;
  if (!drafted_by_model || !prompt_version || !grounding_hash) {
    throw new ServiceError(
      'provenance_required',
      'drafted_by_model, prompt_version and grounding_hash are required - ' +
        'provenance cannot be backfilled, so a draft without it is refused',
    );
  }
  return { drafted_by_model, prompt_version, grounding_hash, temperature: body.temperature };
}

export interface ServerOptions {
  /** Supplies the Jira client. Defaults to the env-configured singleton; tests inject a fake. */
  jira?: () => JiraClient;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const pool = getPool();
  const getJira = options.jira ?? jiraClient;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ServiceError) {
      return reply.status(err.status).send({ event: err.event, message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ event: 'internal_error', message });
  });

  app.get('/version', async () => ({ service: 'spec2test-state-service', apiVersion: API_VERSION }));

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.post('/projects', async (req) => {
    const b = req.body as { key: string; jira_project_key: string; target_repo_path?: string };
    const { rows } = await pool.query(
      `INSERT INTO project (key, jira_project_key, target_repo_path)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET jira_project_key = EXCLUDED.jira_project_key
       RETURNING *`,
      [b.key, b.jira_project_key, b.target_repo_path ?? ''],
    );
    return rows[0];
  });

  /**
   * A read, so a CLI resolving the project uuid it needs for
   * POST /requirements and GET /environments/resolve never has to go through
   * POST /projects - that route is an upsert, and a read must not require a
   * write.
   */
  app.get('/projects/:key', async (req) => {
    const { key } = req.params as { key: string };
    const { rows } = await pool.query('SELECT * FROM project WHERE key = $1', [key]);
    if (!rows[0]) throw new ServiceError('not_found', `project "${key}" not found`, 404);
    return rows[0];
  });

  app.post('/environments', async (req) => {
    const b = req.body as { project_id: string; base_url: string; class: string; openapi_url?: string };
    if (!isEnvironmentClass(b.class)) {
      throw new ServiceError('unknown_environment_class', `unknown environment class: ${b.class}`);
    }
    const { rows } = await pool.query(
      `INSERT INTO environment (project_id, base_url, class, openapi_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, base_url) DO UPDATE SET class = EXCLUDED.class
       RETURNING *`,
      [b.project_id, b.base_url, b.class, b.openapi_url ?? ''],
    );
    await audit({ event: 'environment_registered', subject: b.base_url, detail: { class: b.class } });
    return { ...rows[0], capabilities: capabilitiesFor(b.class) };
  });

  // The allowlist check itself. An unregistered URL is refused, not warned about.
  app.get('/environments/resolve', async (req) => {
    const { project_id, base_url } = req.query as { project_id: string; base_url: string };
    const { rows } = await pool.query(
      'SELECT * FROM environment WHERE project_id = $1 AND base_url = $2',
      [project_id, base_url],
    );
    const env = rows[0];
    if (!env) {
      throw new EnvironmentNotAllowedError(
        `${base_url} is not a registered environment for this project - register it with a class first`,
      );
    }
    return { ...env, capabilities: capabilitiesFor(env.class) };
  });

  /**
   * The OpenAPI document an environment's specs are grounded against, plus its
   * hash. The service owns both so the plugin never hashes its own copy: the
   * `grounding_hash` recorded as draft provenance is then always the hash of
   * what the service itself would validate against - one hash, one owner.
   *
   * `openapi_url` is a local file path in practice, not a URL - the runner
   * reads it with `readFileSync` - so it is read the same way here.
   */
  app.get('/environments/:id/grounding', async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new ServiceError('not_found', `environment ${id} not found`, 404);

    const { rows } = await pool.query<{ openapi_url: string }>(
      'SELECT openapi_url FROM environment WHERE id = $1',
      [id],
    );
    const env = rows[0];
    if (!env) throw new ServiceError('not_found', `environment ${id} not found`, 404);
    if (!env.openapi_url) {
      throw new ServiceError(
        'openapi_not_configured',
        `environment ${id} has no openapi_url - register it with the path to the target's OpenAPI document`,
        409,
      );
    }

    let text: string;
    try {
      text = readFileSync(env.openapi_url, 'utf8');
    } catch (err) {
      throw new ServiceError(
        'openapi_unreadable',
        `cannot read the OpenAPI document at "${env.openapi_url}" (it must be a local file path): ` +
          (err instanceof Error ? err.message : String(err)),
        500,
      );
    }
    return { environmentId: id, source: env.openapi_url, text, contentHash: contentHash(text) };
  });

  /**
   * Grounds a drafted TestCaseSpec before it becomes a test_case row sitting
   * at Gate 2 - the same `validate-spec` stage `runOnce` (worker/index.ts)
   * runs first, exposed standalone so the plugin CLI's `draft-test-case` can
   * refuse an ungrounded spec at draft time rather than discovering it as a
   * puzzling failure minutes later. Never writes to Postgres; this route is
   * a pure check.
   */
  app.post('/specs/validate', async (req) => {
    const b = req.body as { environment_id: string; spec: unknown };
    if (!isUuid(b.environment_id)) {
      throw new ServiceError('not_found', `environment ${b.environment_id} not found`, 404);
    }

    const { rows } = await pool.query<{ openapi_url: string }>(
      'SELECT openapi_url FROM environment WHERE id = $1',
      [b.environment_id],
    );
    const env = rows[0];
    if (!env) throw new ServiceError('not_found', `environment ${b.environment_id} not found`, 404);
    if (!env.openapi_url) {
      throw new ServiceError(
        'openapi_not_configured',
        `environment ${b.environment_id} has no openapi_url - register it with the path to the target's OpenAPI document`,
        409,
      );
    }

    const workDir = mkdtempSync(join(tmpdir(), 'spec2test-validate-'));
    try {
      const specPath = join(workDir, 'spec.json');
      writeFileSync(specPath, JSON.stringify(b.spec), 'utf8');
      const res = runRunnerCli<SpecValidationResult>(['validate-spec', specPath, env.openapi_url]);
      if (!res.ok) {
        throw new ServiceError(
          res.error?.event ?? 'runner_cli_crashed',
          res.error?.message ?? 'validate-spec crashed with no message',
          502,
        );
      }
      return res.result!;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  app.post('/requirements', async (req) => {
    const b = req.body as {
      project_id: string;
      jira_issue_key: string;
      title: string;
      body: string;
    } & Partial<Provenance>;

    const existing = await pool.query(
      `SELECT * FROM requirement
        WHERE project_id = $1 AND jira_issue_key = $2 AND state <> 'closed'`,
      [b.project_id, b.jira_issue_key],
    );
    // Resume, never duplicate. This is the first thing any invocation does.
    if (existing.rows[0]) {
      return { resumed: true, requirement: existing.rows[0] };
    }

    // Checked only once we know a draft is actually being created. A resuming
    // caller is not drafting anything, so it has no model id or prompt hash to
    // supply - requiring them here would force it to invent both.
    const p = requireProvenance(b);

    const { rows } = await pool.query(
      `INSERT INTO requirement
         (project_id, jira_issue_key, title, body, source_text_hash,
          state, drafted_by_model, prompt_version, grounding_hash, temperature)
       VALUES ($1, $2, $3, $4, $5, 'awaiting_requirement_approval', $6, $7, $8, $9)
       RETURNING *`,
      [
        b.project_id, b.jira_issue_key, b.title, b.body, contentHash(b.body),
        p.drafted_by_model, p.prompt_version, p.grounding_hash, p.temperature ?? null,
      ],
    );
    await audit({
      event: 'requirement_drafted',
      subject: b.jira_issue_key,
      detail: { model: p.drafted_by_model, prompt_version: p.prompt_version },
    });
    return { resumed: false, requirement: rows[0] };
  });

  app.post('/requirements/:id/criteria', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { criteria: { body: string; state_affecting?: boolean }[] };
    const created = [];
    // 1-based, to match every other ordinal in the codebase (reconcile.ts,
    // the redraft route below, every test fixture). This route used to start
    // at 0, which is harmless on its own but meant a criterion's ordinal here
    // and its ordinal after a redraft could refer to different criteria -
    // exactly the kind of drift the redraft route otherwise exists to catch.
    for (const [i, c] of b.criteria.entries()) {
      const { rows } = await pool.query(
        `INSERT INTO criterion (requirement_id, ordinal, body, content_hash, state_affecting)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (requirement_id, ordinal) DO UPDATE
           SET body = EXCLUDED.body, content_hash = EXCLUDED.content_hash, updated_at = now()
         RETURNING *`,
        [id, i + 1, c.body, contentHash(c.body), c.state_affecting ?? false],
      );
      created.push(rows[0]);
    }
    return { criteria: created };
  });

  /**
   * Redraft a requirement whose text moved out from under an approval - the
   * path drift and Gate 1 rejection both land on. Before this route existed,
   * a requirement the reconcile marked `stale` had no way back: the local
   * hash never changed, so every future reconcile reported drift again,
   * forever. This is a Postgres-only mutation; the caller still has to POST
   * the result to /jira/:issueKey/criteria to push it back onto the ticket,
   * the same as an original draft would.
   */
  app.post('/requirements/:id/redraft', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as {
      title?: string;
      body: string;
      criteria: { body: string; state_affecting?: boolean }[];
      reason?: string;
    } & Partial<Provenance>;
    const p = requireProvenance(b);

    const existing = (await pool.query('SELECT * FROM requirement WHERE id = $1', [id])).rows[0];
    if (!existing) throw new ServiceError('not_found', `requirement ${id} not found`, 404);
    if (existing.state === 'closed') {
      throw new ServiceError(
        'requirement_closed',
        `requirement ${id} is closed and cannot be redrafted`,
      );
    }

    const newHash = contentHash(b.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: reqRows } = await client.query(
        `UPDATE requirement
            SET title = $1, body = $2, source_text_hash = $3,
                state = 'awaiting_requirement_approval',
                drafted_by_model = $4, prompt_version = $5, grounding_hash = $6, temperature = $7,
                updated_at = now()
          WHERE id = $8
          RETURNING *`,
        [
          b.title ?? existing.title, b.body, newHash,
          p.drafted_by_model, p.prompt_version, p.grounding_hash, p.temperature ?? null,
          id,
        ],
      );

      // Criterion ids are kept stable across a redraft rather than deleted
      // and recreated, on purpose: existing approval rows point at these ids
      // by subject_id, and reusing them keeps that history attached to the
      // same criterion instead of orphaning it. State resets to 'proposed'
      // regardless of what it was - stale or approved - because the text
      // underneath it is new either way.
      const criteria = [];
      for (const [i, c] of b.criteria.entries()) {
        const { rows } = await client.query(
          `INSERT INTO criterion (requirement_id, ordinal, body, content_hash, state_affecting, state)
           VALUES ($1, $2, $3, $4, $5, 'proposed')
           ON CONFLICT (requirement_id, ordinal) DO UPDATE
             SET body = EXCLUDED.body, content_hash = EXCLUDED.content_hash,
                 state_affecting = EXCLUDED.state_affecting, state = 'proposed', updated_at = now()
           RETURNING *`,
          [id, i + 1, c.body, contentHash(c.body), c.state_affecting ?? false],
        );
        criteria.push(rows[0]);
      }
      // A redraft with fewer criteria than the last one leaves the extra
      // ordinals behind otherwise - drop them explicitly rather than let a
      // stale criterion linger with no corresponding entry in the new draft.
      await client.query('DELETE FROM criterion WHERE requirement_id = $1 AND ordinal > $2', [
        id,
        b.criteria.length,
      ]);

      await audit(
        {
          event: 'requirement_redrafted',
          subject: `requirement:${id}`,
          detail: {
            jira_issue_key: existing.jira_issue_key,
            previous_hash: existing.source_text_hash,
            new_hash: newHash,
            reason: b.reason ?? '',
            criteria: criteria.length,
          },
        },
        client,
      );

      await client.query('COMMIT');
      return { requirement: reqRows[0], criteria };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/requirements/:id', async (req) => {
    const { id } = req.params as { id: string };
    const requirement = (await pool.query('SELECT * FROM requirement WHERE id = $1', [id])).rows[0];
    if (!requirement) throw new ServiceError('not_found', `requirement ${id} not found`, 404);
    const criteria = (
      await pool.query('SELECT * FROM criterion WHERE requirement_id = $1 ORDER BY ordinal', [id])
    ).rows;
    const cases = (
      await pool.query(
        `SELECT tc.* FROM test_case tc
           JOIN criterion c ON c.id = tc.criterion_id
          WHERE c.requirement_id = $1 ORDER BY tc.created_at`,
        [id],
      )
    ).rows;
    return { requirement, criteria, test_cases: cases };
  });

  app.post('/test-cases', async (req) => {
    const b = req.body as {
      criterion_id: string;
      name: string;
      kind: 'api' | 'ui';
      spec: unknown;
    } & Partial<Provenance>;
    const p = requireProvenance(b);

    // Defense in depth: a test case must never be drafted against a
    // criterion gate 1 hasn't actually closed on - found while wiring step
    // 5, this route previously accepted one against any criterion state.
    const { rows: criterionRows } = await pool.query<{ state: string }>(
      'SELECT state FROM criterion WHERE id = $1',
      [b.criterion_id],
    );
    if (!criterionRows[0]) throw new ServiceError('not_found', `criterion ${b.criterion_id} not found`, 404);
    // `uncovered` is Gate 1 having approved the criterion and Gate 2 having
    // then rejected every test case for it (see the gate 2 route below). It is
    // the state a redraft has to start from, so it must be draftable - refusing
    // it left the criterion with no way back to being covered.
    const criterionState = criterionRows[0].state;
    if (criterionState !== 'approved' && criterionState !== 'uncovered') {
      throw new ServiceError(
        'criterion_not_approved',
        `criterion ${b.criterion_id} is "${criterionState}", not "approved" - gate 1 must close on ` +
          'this criterion before a test case can be drafted against it',
      );
    }

    const serialised = JSON.stringify(b.spec);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO test_case
           (criterion_id, name, kind, spec, content_hash,
            drafted_by_model, prompt_version, grounding_hash, temperature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          b.criterion_id, b.name, b.kind, serialised, contentHash(serialised),
          p.drafted_by_model, p.prompt_version, p.grounding_hash, p.temperature ?? null,
        ],
      );
      // `uncovered` was defined as "no non-rejected test case", and there is
      // one again. Gate 1's approval never went away, so the criterion goes
      // back to `approved` rather than staying stuck in a derived state.
      if (criterionState === 'uncovered') {
        await client.query(`UPDATE criterion SET state = 'approved', updated_at = now() WHERE id = $1`, [
          b.criterion_id,
        ]);
      }
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  for (const gate of [1, 2] as Gate[]) {
    app.post(`/gate${gate}/decisions`, async (req) => {
      const b = req.body as {
        subject_id: string;
        decision: Decision;
        actor: string;
        channel: Channel;
        reason?: string;
        seen_hash: string;
      };
      const outcome = await decide(gate, {
        subjectId: b.subject_id,
        decision: b.decision,
        actor: b.actor,
        channel: b.channel,
        reason: b.reason,
        seenHash: b.seen_hash,
      });

      // Gate 2 rejection: if this test case's criterion now has zero
      // non-rejected test cases, it's Uncovered - information the PO's
      // dashboard should show, not a gap that silently vanishes. A redraft
      // needs no new endpoint: the skill just POSTs a new test case against
      // the same criterion; the old rejected row stays for audit history,
      // same as a rejected criterion is never deleted.
      let requirementId: string | undefined;
      if (gate === 2) {
        const { rows } = await pool.query<{ criterion_id: string; requirement_id: string }>(
          `SELECT tc.criterion_id, c.requirement_id
             FROM test_case tc JOIN criterion c ON c.id = tc.criterion_id
            WHERE tc.id = $1`,
          [b.subject_id],
        );
        const row = rows[0];
        if (row) {
          requirementId = row.requirement_id;
          if (b.decision === 'rejected') {
            const { rows: remaining } = await pool.query(
              `SELECT 1 FROM test_case WHERE criterion_id = $1 AND state <> 'rejected' LIMIT 1`,
              [row.criterion_id],
            );
            if (remaining.length === 0) {
              await pool.query(`UPDATE criterion SET state = 'uncovered', updated_at = now() WHERE id = $1`, [
                row.criterion_id,
              ]);
            }
          }
        }
      } else if (outcome.recorded) {
        const { rows } = await pool.query<{ requirement_id: string }>(
          'SELECT requirement_id FROM criterion WHERE id = $1',
          [b.subject_id],
        );
        requirementId = rows[0]?.requirement_id;
      }
      if (requirementId) await computeVerification(requirementId);

      return outcome;
    });
  }

  /**
   * Codegen -> validate -> falsify for one approved test case, all
   * server-side via the runner CLI subprocess (see worker/runnerCli.ts).
   * Synchronous for this step - see the master plan's step 5 notes: the
   * `job` row is real and the code path is the one a future background
   * poller would use, only "return immediately" is deferred.
   */
  app.post('/test-cases/:id/verify', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { environment_id: string };
    if (!b.environment_id) {
      throw new ServiceError('environment_id_required', 'environment_id is required - resolve it via GET /environments/resolve first');
    }

    const { rows } = await pool.query<{ state: string; criterion_id: string }>(
      'SELECT state, criterion_id FROM test_case WHERE id = $1',
      [id],
    );
    const testCase = rows[0];
    if (!testCase) throw new ServiceError('not_found', `test case ${id} not found`, 404);
    if (testCase.state !== 'approved') {
      throw new ServiceError(
        'test_case_not_approved',
        `test case ${id} is "${testCase.state}", not "approved" - gate 2 must have closed before it can be verified`,
      );
    }

    const { rows: reqRows } = await pool.query<{ requirement_id: string }>(
      'SELECT requirement_id FROM criterion WHERE id = $1',
      [testCase.criterion_id],
    );
    const requirementId = reqRows[0]?.requirement_id;
    if (!requirementId) throw new ServiceError('not_found', `criterion ${testCase.criterion_id} not found`, 404);

    const { rows: jobRows } = await pool.query<{ id: string }>(
      `INSERT INTO job (kind, requirement_id, payload)
       VALUES ('falsification', $1, $2)
       RETURNING id`,
      [requirementId, JSON.stringify({ testCaseId: id, environmentId: b.environment_id })],
    );

    return runOnce(jobRows[0]!.id);
  });

  /**
   * A job's state, for the skill to poll. `verify` is synchronous today, so a
   * job is already `done` or `failed` by the time anyone can ask - but this is
   * the contract the skill polls once the worker loop makes `verify` return
   * immediately, so `SKILL.md` will not need rewriting when that lands.
   */
  app.get('/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new ServiceError('not_found', `job ${id} not found`, 404);

    const { rows } = await pool.query(
      `SELECT id, kind, requirement_id, payload, state, attempts, last_error, created_at, updated_at
         FROM job WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new ServiceError('not_found', `job ${id} not found`, 404);
    return rows[0];
  });

  // --- Jira -------------------------------------------------------------
  // The service owns all Jira I/O. Nothing is reachable *from* Jira: every
  // route here pulls the ticket's current state and reconciles against it.

  /**
   * The single stage-detection query. Read-only: the reconcile inside it is a
   * dry run. The skill switches on `stage` rather than reconstructing position
   * from several calls, so it cannot disagree with the service about where it is.
   */
  app.get('/pipeline/:issueKey', async (req) => {
    const { issueKey } = req.params as { issueKey: string };
    return pipelineState(getJira(), issueKey);
  });

  app.get('/jira/preflight', async () => {
    const client = getJira();
    const me = await client.preflight();
    // Auth succeeding says nothing about whether the configured field ids are
    // real - that failure is otherwise silent (see validateFieldMap), so a
    // caller relying on preflight to mean "this Jira setup actually works"
    // needs this checked here, not discovered later as a pipeline stuck at
    // gate1_pending with no explanation.
    const fields = loadFieldMap();
    await validateFieldMap(client, fields);
    return { ok: true, ...me, fields };
  });

  /**
   * Read a ticket and report what the pipeline would do. `dry_run=1` touches
   * neither Postgres nor Jira, which makes it safe to call from anywhere while
   * still being the same code path that does the real work.
   */
  app.post('/jira/:issueKey/reconcile', async (req) => {
    const { issueKey } = req.params as { issueKey: string };
    const { dry_run } = (req.body ?? {}) as { dry_run?: boolean };
    const client = getJira();
    const result = await reconcile(client, issueKey, { dryRun: dry_run ?? false });

    // Any outcome the PO would otherwise not see is reported back onto the
    // ticket, not just drift - a refused or partially-closed approval leaves
    // "Criteria Approved" sitting on the ticket looking closed, and the PO has
    // no other way to learn it was not honoured.
    if (!result.dryRun && result.action === 'drift_detected' && result.drift) {
      await postDrift(client, issueKey, result.drift);
    } else if (
      !result.dryRun &&
      (result.action === 'approval_unverifiable' ||
        result.action === 'gate1_partial' ||
        result.action === 'gate1_blocked')
    ) {
      await postRefusal(client, issueKey, result);
    }
    const { ticket, ...rest } = result;
    return { ...rest, ticket: ticket && { summary: ticket.summary, status: ticket.status,
      verificationStatus: ticket.verificationStatus, labels: ticket.labels } };
  });

  /**
   * Push drafted criteria onto the ticket. No-op when nothing changed.
   * `dry_run` returns the comment and field values a confirmed call would send
   * (built by the same code, same fingerprint) and writes nothing to Jira.
   */
  app.post('/jira/:issueKey/criteria', async (req) => {
    const { issueKey } = req.params as { issueKey: string };
    const body = req.body as { requirement_id: string; force?: boolean; dry_run?: boolean };

    const { rows } = await pool.query(
      `SELECT c.id, c.ordinal, c.body, c.content_hash, c.state_affecting, r.source_text_hash
         FROM criterion c JOIN requirement r ON r.id = c.requirement_id
        WHERE c.requirement_id = $1 ORDER BY c.ordinal`,
      [body.requirement_id],
    );
    if (rows.length === 0) {
      throw new ServiceError('no_criteria', `requirement ${body.requirement_id} has no criteria`);
    }

    const criteria: CriterionView[] = rows.map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      body: r.body,
      contentHash: r.content_hash,
      stateAffecting: r.state_affecting,
    }));

    const outcome = await postCriteria(
      getJira(),
      { issueKey, criteria, requirementHash: rows[0].source_text_hash },
      { force: body.force, dryRun: body.dry_run },
    );
    return outcome;
  });

  /**
   * Push the verification rollup onto the ticket. The master plan's "ask
   * before syncing" convention is enforced by the skill, which confirms
   * with the developer before ever calling this - not by the route itself.
   */
  app.post('/jira/:issueKey/verification', async (req) => {
    const { issueKey } = req.params as { issueKey: string };
    const body = req.body as { requirement_id: string; dry_run?: boolean };

    const verification = await computeVerification(body.requirement_id);
    if (verification.state === 'unchanged' || verification.criteria.length === 0) {
      throw new ServiceError(
        'nothing_to_verify',
        `requirement ${body.requirement_id} has nothing to report yet - gate 1 must close first`,
      );
    }

    const { rows } = await pool.query<{ source_text_hash: string }>(
      'SELECT source_text_hash FROM requirement WHERE id = $1',
      [body.requirement_id],
    );
    const requirementHash = rows[0]?.source_text_hash;
    if (!requirementHash) throw new ServiceError('not_found', `requirement ${body.requirement_id} not found`, 404);

    const { rows: criterionRows } = await pool.query<{ id: string; body: string }>(
      `SELECT id, body FROM criterion WHERE requirement_id = $1`,
      [body.requirement_id],
    );
    const bodyById = new Map(criterionRows.map((c) => [c.id, c.body]));

    // `dry_run` leaves Jira untouched. It still runs computeVerification above,
    // which refreshes the derived `requirement.state` in Postgres - that is a
    // deterministic recompute of what the rows already say, not a decision, and
    // every other state-changing step does the same.
    const outcome = await postVerification(
      getJira(),
      {
        issueKey,
        requirementHash,
        state: verification.state,
        criteria: verification.criteria.map((c) => ({
          id: c.id,
          body: bodyById.get(c.id) ?? '',
          stateAffecting: c.stateAffecting,
          covered: c.covered,
        })),
      },
      { dryRun: body.dry_run },
    );
    return { verification, jira: outcome };
  });

  app.get('/audit', async (req) => {
    const { limit } = req.query as { limit?: string };
    const { rows } = await pool.query(
      'SELECT * FROM audit_event ORDER BY created_at DESC, id DESC LIMIT $1',
      [Math.min(Number(limit ?? 100), 1000)],
    );
    return { events: rows };
  });

  return app;
}

if (process.argv[1]?.endsWith('server.ts')) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 8787);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`state service listening on http://127.0.0.1:${port}`);
}
