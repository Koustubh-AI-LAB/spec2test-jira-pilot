/**
 * Step 6 hardening: `withRequirementLock` (src/db/lock.ts) is the primitive
 * that protects every read-then-blind-write of a requirement's
 * criterion/requirement state (reconcile.ts's markStale() and its own
 * requirement-state clears, the gate-2 rejection branch in server.ts) from
 * racing a concurrent writer for the same requirement. Tested here in
 * isolation against real Postgres, rather than only through the application
 * routes that use it, since the branching that matters - does it actually
 * serialize? does a different key run concurrently? does a failure release
 * the lock instead of leaking it? - is a property of the primitive, and
 * provable directly.
 *
 * Requires: docker compose up -d postgres
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db/pool.ts';
import { withRequirementLock } from '../src/db/lock.ts';
import { useTestDatabase } from './helpers/db.ts';

await useTestDatabase();

after(async () => {
  await closePool();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('withRequirementLock', () => {
  it('serializes two concurrent callers for the same requirement id - the second only starts once the first commits', async () => {
    const requirementId = 'req-lock-test-same';
    const order: string[] = [];

    const first = withRequirementLock(requirementId, async () => {
      order.push('first-start');
      await sleep(200);
      order.push('first-end');
    });
    await sleep(20); // give `first` time to actually acquire the lock first
    const second = withRequirementLock(requirementId, async () => {
      order.push('second-start');
    });

    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
  });

  it('does not serialize two different requirement ids - unrelated requirements must not contend', async () => {
    const order: string[] = [];

    const a = withRequirementLock('req-lock-test-a', async () => {
      order.push('a-start');
      await sleep(200);
      order.push('a-end');
    });
    await sleep(20);
    const b = withRequirementLock('req-lock-test-b', async () => {
      order.push('b-start');
    });

    await Promise.all([a, b]);
    assert.ok(
      order.indexOf('b-start') < order.indexOf('a-end'),
      `expected b to run while a was still in progress, got order: ${order.join(', ')}`,
    );
  });

  it('releases the lock on a thrown error - a failed call must not deadlock the next one for the same requirement', async () => {
    const requirementId = 'req-lock-test-error';

    await assert.rejects(
      withRequirementLock(requirementId, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );

    // If the lock had leaked (held open past ROLLBACK), this would hang for
    // the whole test file's timeout rather than resolving.
    let ran = false;
    await withRequirementLock(requirementId, async () => {
      ran = true;
    });
    assert.equal(ran, true, 'the lock from the failed call was never released');
  });

  it("returns the callback's own return value", async () => {
    const result = await withRequirementLock('req-lock-test-return', async () => 'the-value');
    assert.equal(result, 'the-value');
  });
});
