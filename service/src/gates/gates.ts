import { getPool } from '../db/pool.ts';
import { audit } from '../audit.ts';
import { contentHash } from '../hash.ts';
import { GateError, NotFoundError } from '../errors.ts';

export type Gate = 1 | 2;
export type Decision = 'approved' | 'rejected';
export type Channel = 'jira' | 'claude-code' | 'cli';

export interface DecisionInput {
  subjectId: string;
  decision: Decision;
  actor: string;
  channel: Channel;
  reason?: string;
  /** The exact content the decider saw. A mismatch means they approved something else. */
  seenHash: string;
}

export interface DecisionOutcome {
  recorded: boolean;
  state: string;
  /** True when this actor has now satisfied both gates for the same requirement. */
  sameActorBothGates: boolean;
}

const SUBJECT = {
  1: { table: 'criterion', type: 'criterion' },
  2: { table: 'test_case', type: 'test_case' },
} as const;

/**
 * Record a decision at one gate, for exactly one subject.
 *
 * Three properties this function is responsible for, all of them load-bearing:
 *   - the decision is bound to the content hash the decider actually saw;
 *   - re-applying the identical decision is a no-op, not a duplicate audit line;
 *   - nothing reaches an approved state by any other path.
 */
export async function decide(gate: Gate, input: DecisionInput): Promise<DecisionOutcome> {
  const { table, type } = SUBJECT[gate];
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, content_hash, state FROM ${table} WHERE id = $1 FOR UPDATE`,
      [input.subjectId],
    );
    const subject = rows[0];
    if (!subject) throw new NotFoundError(`${type} ${input.subjectId} not found`);

    if (subject.content_hash !== input.seenHash) {
      throw new GateError(
        'stale_decision',
        `content changed since it was presented (approved ${input.seenHash.slice(0, 12)}, ` +
          `current ${subject.content_hash.slice(0, 12)}) - re-read and decide again`,
      );
    }

    const nextState = input.decision === 'approved' ? 'approved' : 'rejected';

    const { rows: priorRows } = await client.query(
      `SELECT decision, subject_hash FROM approval
        WHERE subject_type = $1 AND subject_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [type, input.subjectId],
    );
    const prior = priorRows[0];
    // The prior approval row matching is not enough on its own: drift (or any
    // other path) can move the subject itself to a different state - stale,
    // say - while the last APPROVAL row still reads "approved" against the
    // same hash. Without also checking the subject's current state, a
    // re-approval after drift reads as "unchanged" and silently does nothing,
    // leaving the row stuck stale forever with the decision reported as a
    // no-op rather than applied.
    const unchanged =
      prior &&
      prior.decision === input.decision &&
      prior.subject_hash === input.seenHash &&
      subject.state === nextState;

    if (unchanged) {
      await client.query('COMMIT');
      return { recorded: false, state: subject.state, sameActorBothGates: false };
    }
    await client.query(
      `UPDATE ${table} SET state = $1, updated_at = now() WHERE id = $2`,
      [nextState, input.subjectId],
    );
    await client.query(
      `INSERT INTO approval (subject_type, subject_id, subject_hash, gate, decision, actor, channel, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [type, input.subjectId, input.seenHash, gate, input.decision, input.actor, input.channel, input.reason ?? ''],
    );

    const sameActorBothGates = await detectSameActorBothGates(client, gate, input);

    await audit(
      {
        event: `gate${gate}_${input.decision}`,
        subject: `${type}:${input.subjectId}`,
        actor: input.actor,
        detail: {
          gate,
          channel: input.channel,
          hash: input.seenHash,
          reason: input.reason ?? '',
          same_actor_both_gates: sameActorBothGates,
        },
      },
      client,
    );

    await client.query('COMMIT');
    return { recorded: true, state: nextState, sameActorBothGates };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Segregation of duties, visibility only for now: one person satisfying both
 * gates voids the point of having two. The pilot flags it rather than blocking
 * it, because a single-developer pilot would otherwise be unable to proceed -
 * enforcement is a Gate B item.
 */
async function detectSameActorBothGates(
  client: import('pg').PoolClient,
  gate: Gate,
  input: DecisionInput,
): Promise<boolean> {
  if (input.decision !== 'approved') return false;
  const otherGate = gate === 1 ? 2 : 1;

  const { rows } = await client.query(
    `WITH req AS (
       SELECT CASE $1::int
                WHEN 1 THEN (SELECT requirement_id FROM criterion WHERE id = $2)
                ELSE (SELECT c.requirement_id FROM test_case tc
                       JOIN criterion c ON c.id = tc.criterion_id
                      WHERE tc.id = $2)
              END AS requirement_id
     )
     SELECT 1
       FROM approval a
       JOIN req ON true
      WHERE a.gate = $3
        AND a.decision = 'approved'
        AND a.actor = $4
        AND (
          (a.subject_type = 'criterion'
             AND a.subject_id IN (SELECT id FROM criterion WHERE requirement_id = req.requirement_id))
          OR
          (a.subject_type = 'test_case'
             AND a.subject_id IN (SELECT tc.id FROM test_case tc
                                    JOIN criterion c ON c.id = tc.criterion_id
                                   WHERE c.requirement_id = req.requirement_id))
        )
      LIMIT 1`,
    [gate, input.subjectId, otherGate, input.actor],
  );
  return rows.length > 0;
}

/**
 * Is the currently-approved content still the content on record? Used to reopen
 * a gate when a criterion is edited or a generated test file is changed on disk.
 */
export async function approvalIsCurrent(
  subjectType: 'criterion' | 'test_case',
  subjectId: string,
  currentContent: string,
): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT subject_hash FROM approval
      WHERE subject_type = $1 AND subject_id = $2 AND decision = 'approved'
      ORDER BY created_at DESC LIMIT 1`,
    [subjectType, subjectId],
  );
  const approved = rows[0];
  return Boolean(approved) && approved.subject_hash === contentHash(currentContent);
}
