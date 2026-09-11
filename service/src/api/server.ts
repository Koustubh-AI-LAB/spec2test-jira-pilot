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
import { reconcile } from '../jira/reconcile.ts';
import { loadFieldMap, validateFieldMap } from '../jira/read.ts';
import { postCriteria, postDrift, postRefusal } from '../jira/write.ts';
import type { CriterionView } from '../jira/write.ts';

/**
 * Bumped whenever the plugin-facing contract changes. The skill checks this at
 * preflight and refuses to run on a mismatch: a cached older plugin talking to
 * a newer schema is a way to corrupt state quietly.
 */
export const API_VERSION = 1;

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

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });
  const pool = getPool();

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

  app.post('/requirements', async (req) => {
    const b = req.body as {
      project_id: string;
      jira_issue_key: string;
      title: string;
      body: string;
    } & Partial<Provenance>;
    const p = requireProvenance(b);

    const existing = await pool.query(
      `SELECT * FROM requirement
        WHERE project_id = $1 AND jira_issue_key = $2 AND state <> 'closed'`,
      [b.project_id, b.jira_issue_key],
    );
    // Resume, never duplicate. This is the first thing any invocation does.
    if (existing.rows[0]) {
      return { resumed: true, requirement: existing.rows[0] };
    }

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
    const serialised = JSON.stringify(b.spec);
    const { rows } = await pool.query(
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
    return rows[0];
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
      return decide(gate, {
        subjectId: b.subject_id,
        decision: b.decision,
        actor: b.actor,
        channel: b.channel,
        reason: b.reason,
        seenHash: b.seen_hash,
      });
    });
  }

  // --- Jira -------------------------------------------------------------
  // The service owns all Jira I/O. Nothing is reachable *from* Jira: every
  // route here pulls the ticket's current state and reconciles against it.

  app.get('/jira/preflight', async () => {
    const client = jiraClient();
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
    const client = jiraClient();
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

  /** Push drafted criteria onto the ticket. No-op when nothing changed. */
  app.post('/jira/:issueKey/criteria', async (req) => {
    const { issueKey } = req.params as { issueKey: string };
    const body = req.body as { requirement_id: string; force?: boolean };

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
      jiraClient(),
      { issueKey, criteria, requirementHash: rows[0].source_text_hash },
      { force: body.force },
    );
    return outcome;
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
