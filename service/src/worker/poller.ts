import { getPool } from '../db/pool.ts';
import { runOnce } from './index.ts';

export interface PollerHandle {
  stop(): void;
}

/**
 * One tick: claim at most one queued job (via `job_queue_idx`, migration
 * 001) and run it to completion through the existing `runOnce`. Returns
 * whether a job was found, so a test can assert real progress without
 * waiting on `setInterval`'s clock - `startPoller` below is the only caller
 * that needs the timer itself.
 */
export async function pollOnce(): Promise<boolean> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM job WHERE state = 'queued' ORDER BY created_at LIMIT 1`,
  );
  const job = rows[0];
  if (!job) return false;
  await runOnce(job.id);
  return true;
}

/**
 * Starts the background polling loop that makes `POST /test-cases/:id/verify`
 * (server.ts) genuinely non-blocking - the job row and `runOnce` were already
 * real; only "return immediately" was deferred, per that route's own history.
 *
 * Single-flight by design: one queued job runs at a time, matching the
 * existing implicit single-concurrency assumption (concurrent falsification
 * runs would contend for the same shared target sandbox). `claimJob`
 * (worker/index.ts) is a compare-and-swap `UPDATE ... WHERE state='queued'`,
 * so this stays correct even if a second poller instance is ever run
 * alongside this one - the busy-guard here is a cheap avoidance of redundant
 * ticks, not the actual correctness mechanism.
 *
 * Only ever started from the real listen path (`server.ts`'s
 * `process.argv[1]?.endsWith('server.ts')` guard) - never from
 * `buildServer()` itself, so `app.inject()`-based tests never leak a timer.
 */
export function startPoller(intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 3000)): PollerHandle {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    pollOnce()
      .catch((err) => {
        console.error('worker poller tick failed:', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
