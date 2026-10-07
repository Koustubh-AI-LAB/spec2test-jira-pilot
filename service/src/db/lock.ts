import type { PoolClient } from 'pg';
import { getPool } from './pool.ts';

/**
 * Serializes every read-then-write of one requirement's criterion/requirement
 * state behind a Postgres transaction-scoped advisory lock. `gates.ts::decide()`
 * already protects a single subject row via `SELECT ... FOR UPDATE`, but
 * several writes sit outside that: `markStale()`, the gate-2 rejection branch's
 * `criterion` update, and `reconcile()`'s own drift/approval decisions, all of
 * which read a snapshot with plain `SELECT`s and write blind. Two such writers
 * racing for the same requirement (e.g. a `reconcile()` marking stale while a
 * `gate2/decisions` rejection sets a criterion `uncovered`) can otherwise lose
 * one transition silently.
 *
 * `pg_advisory_xact_lock` releases automatically at COMMIT/ROLLBACK - no
 * manual unlock, no risk of a lock surviving a crashed connection.
 * `hashtext()` folds the uuid into the bigint key `pg_advisory_xact_lock`
 * expects; collisions between two different requirement ids are physically
 * possible but merely serialize unrelated requirements against each other
 * for the duration of one call, not a correctness bug.
 */
export async function withRequirementLock<T>(
  requirementId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [requirementId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
