/**
 * Live Jira tests. These talk to the real site and the real S2T-1 fixture.
 *
 * Deliberately not mocked, for the same reason the gate tests use a real
 * Postgres: the things worth proving here are Jira's actual behaviour - that a
 * changelog records a field change the way we think it does, that an issue
 * property round-trips, that a second write really is a no-op. A stubbed Jira
 * would prove only that our stub matches our assumptions.
 *
 * Skipped automatically when JIRA_API_TOKEN is absent, so the suite still runs
 * on a machine with no credentials.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { getPool, getAdminPool, closePool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { JiraClient, loadConfig } from '../src/jira/client.ts';
import { fetchTicket, loadFieldMap, VERIFICATION_STATUS } from '../src/jira/read.ts';
import { reconcile } from '../src/jira/reconcile.ts';
import { postCriteria, readProperty } from '../src/jira/write.ts';
import { contentHash } from '../src/hash.ts';

// .env is the only place the token lives; it is gitignored.
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

const ISSUE = process.env.JIRA_TEST_ISSUE ?? 'S2T-1';
const live = Boolean(process.env.JIRA_API_TOKEN);
const fields = loadFieldMap();

let client: JiraClient;
let requirementId: string;
let criterionIds: string[] = [];

/** Put the fixture back to a clean slate so the suite is re-runnable. */
async function resetTicket(): Promise<void> {
  await client.request('PUT', `/rest/api/3/issue/${ISSUE}`, {
    fields: {
      [fields.verificationStatus]: null,
      [fields.criteriaCertified]: null,
      [fields.criteriaTotal]: null,
      [fields.lastVerified]: null,
    },
  });
  await client
    .request('DELETE', `/rest/api/3/issue/${ISSUE}/properties/spec2test`)
    .catch(() => undefined);
  const comments = await client.get<{ comments: { id: string }[] }>(
    `/rest/api/3/issue/${ISSUE}/comment`,
  );
  for (const c of comments.comments) {
    await client.request('DELETE', `/rest/api/3/issue/${ISSUE}/comment/${c.id}`);
  }
}

before(async () => {
  if (!live) return;
  client = new JiraClient(loadConfig());
  await migrate();
  await getAdminPool().query('TRUNCATE project, audit_event RESTART IDENTITY CASCADE');
  await resetTicket();
});

after(async () => {
  if (live) await resetTicket().catch(() => undefined);
  await closePool();
});

/** Seed Postgres as if the plugin had just drafted against the live ticket. */
async function seedFromTicket(): Promise<string> {
  const ticket = await fetchTicket(client, ISSUE, fields);
  const pool = getPool();

  const project = await pool.query(
    `INSERT INTO project (key, jira_project_key) VALUES ('S2T-PILOT', 'S2T')
     ON CONFLICT (key) DO UPDATE SET jira_project_key = EXCLUDED.jira_project_key
     RETURNING id`,
  );

  const req = await pool.query(
    `INSERT INTO requirement
       (project_id, jira_issue_key, title, body, source_text_hash,
        state, drafted_by_model, prompt_version, grounding_hash, temperature)
     VALUES ($1, $2, $3, $4, $5, 'awaiting_requirement_approval',
             'claude-opus-5', 'draft-v1', $5, 0)
     RETURNING id`,
    [project.rows[0].id, ISSUE, ticket.summary, ticket.requirementText, ticket.requirementHash],
  );
  requirementId = req.rows[0].id;

  const bodies = [
    'Favouriting an already-favourited article does not increment the count again.',
    'Unfavouriting an article never favourited leaves the count unchanged and non-negative.',
    'An anonymous favourite request is rejected with 401 and does not change the count.',
    'One user favouriting does not alter the button state shown to another user.',
  ];
  criterionIds = [];
  for (const [i, body] of bodies.entries()) {
    const row = await pool.query(
      `INSERT INTO criterion (requirement_id, ordinal, body, content_hash, state_affecting)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [requirementId, i + 1, body, contentHash(body), i < 2],
    );
    criterionIds.push(row.rows[0].id);
  }
  return ticket.requirementHash;
}

describe('jira client', { skip: !live && 'JIRA_API_TOKEN not set' }, () => {
  it('authenticates and reports which host it resolved to', async () => {
    const me = await client.preflight();
    assert.ok(me.accountId, 'no accountId returned');
    assert.match(me.base, /^https:\/\//);
  });

  it('reads the ticket and derives a stable requirement hash', async () => {
    const first = await fetchTicket(client, ISSUE, fields);
    const second = await fetchTicket(client, ISSUE, fields);
    assert.equal(first.requirementHash, second.requirementHash, 'hash differs between reads');
    assert.equal(first.requirementHash, contentHash(first.requirementText));
    assert.match(first.requirementText, /favourit/i);
  });
});

describe('pull reconcile', { skip: !live && 'JIRA_API_TOKEN not set' }, () => {
  it('reports no local instance before anything is drafted', async () => {
    const result = await reconcile(client, ISSUE, { dryRun: true });
    assert.equal(result.action, 'no_local_instance');
  });

  it('waits on the PO once criteria exist but nothing is approved', async () => {
    await seedFromTicket();
    const result = await reconcile(client, ISSUE, { dryRun: true });
    assert.equal(result.action, 'gate1_pending');
  });

  it('posts criteria to the ticket and records what was presented', async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, ordinal, body, content_hash, state_affecting FROM criterion
        WHERE requirement_id = $1 ORDER BY ordinal`,
      [requirementId],
    );
    const ticket = await fetchTicket(client, ISSUE, fields);

    const outcome = await postCriteria(client, {
      issueKey: ISSUE,
      requirementHash: ticket.requirementHash,
      criteria: rows.map((r) => ({
        id: r.id,
        ordinal: r.ordinal,
        body: r.body,
        contentHash: r.content_hash,
        stateAffecting: r.state_affecting,
      })),
    });

    assert.equal(outcome.wrote, true);
    const prop = await readProperty(client, ISSUE);
    assert.equal(Object.keys(prop?.criteria_posted ?? {}).length, 4);
    assert.ok(prop?.criteria_posted_at, 'no posting timestamp recorded');
  });

  it('writes nothing on a second identical call', async () => {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, ordinal, body, content_hash, state_affecting FROM criterion
        WHERE requirement_id = $1 ORDER BY ordinal`,
      [requirementId],
    );
    const ticket = await fetchTicket(client, ISSUE, fields);
    const before = await client.get<{ comments: unknown[] }>(
      `/rest/api/3/issue/${ISSUE}/comment`,
    );

    const outcome = await postCriteria(client, {
      issueKey: ISSUE,
      requirementHash: ticket.requirementHash,
      criteria: rows.map((r) => ({
        id: r.id,
        ordinal: r.ordinal,
        body: r.body,
        contentHash: r.content_hash,
        stateAffecting: r.state_affecting,
      })),
    });

    assert.equal(outcome.wrote, false, 're-posted an unchanged comment');
    const after = await client.get<{ comments: unknown[] }>(`/rest/api/3/issue/${ISSUE}/comment`);
    assert.equal(after.comments.length, before.comments.length, 'comment count grew');
  });

  it('picks up the PO approval from the field, with no webhook', async () => {
    // Exactly what a PO does in the UI: set Verification Status.
    await client.request('PUT', `/rest/api/3/issue/${ISSUE}`, {
      fields: { [fields.verificationStatus]: { value: VERIFICATION_STATUS.criteriaApproved } },
    });

    const result = await reconcile(client, ISSUE);
    assert.equal(result.action, 'gate1_closed', result.detail);
    assert.equal(result.gate1?.criteriaClosed, 4);
    assert.equal(result.gate1?.criteriaRejected.length, 0, result.gate1?.criteriaRejected.join('; '));
    assert.match(result.gate1?.actor ?? '', /^jira:/);

    const { rows } = await getPool().query(
      `SELECT state FROM criterion WHERE requirement_id = $1`,
      [requirementId],
    );
    assert.ok(rows.every((r) => r.state === 'approved'), 'not every criterion was approved');
  });

  it('records the approval in the audit ledger with its Jira lineage', async () => {
    const { rows } = await getPool().query(
      `SELECT actor, detail FROM audit_event
        WHERE event = 'jira_gate1_reconciled' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].actor, /^jira:/);
    assert.equal(rows[0].detail.issue_key, ISSUE);
    assert.equal(rows[0].detail.source, 'pull_reconcile');
  });

  it('is idempotent: a second reconcile adds no second approval', async () => {
    const countBefore = await getPool().query(
      `SELECT count(*)::int AS n FROM approval WHERE gate = 1`,
    );
    const result = await reconcile(client, ISSUE);
    assert.equal(result.action, 'up_to_date', result.detail);
    const countAfter = await getPool().query(
      `SELECT count(*)::int AS n FROM approval WHERE gate = 1`,
    );
    assert.equal(countAfter.rows[0].n, countBefore.rows[0].n);
  });

  it('detects drift when the requirement is edited after approval', async () => {
    const original = (await fetchTicket(client, ISSUE, fields)).summary;
    try {
      await client.request('PUT', `/rest/api/3/issue/${ISSUE}`, {
        fields: { summary: `${original} (amended)` },
      });

      const result = await reconcile(client, ISSUE);
      assert.equal(result.action, 'drift_detected', result.detail);
      assert.notEqual(result.drift?.approvedHash, result.drift?.currentHash);

      const { rows } = await getPool().query(
        `SELECT state FROM criterion WHERE requirement_id = $1`,
        [requirementId],
      );
      assert.ok(rows.every((r) => r.state === 'stale'), 'criteria were not marked stale');
    } finally {
      await client.request('PUT', `/rest/api/3/issue/${ISSUE}`, {
        fields: { summary: original },
      });
    }
  });
});
