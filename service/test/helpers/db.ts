/**
 * Every test file's Postgres target: a dedicated `spec2test_test` database,
 * never `spec2test` - the database a manual live session also writes to.
 *
 * Before this existed, every test file's DATABASE_URL/MIGRATION_DATABASE_URL
 * fallback pointed at the same `spec2test` database a developer's live
 * session uses, and `worker.test.ts`/`jira.test.ts` load real `.env` values
 * for their live parts - which meant a real `.env` with the real dev
 * DATABASE_URL silently won, since their env-loading loop only sets a
 * variable when it is not already set. That is how six stray `P-WORKER*`
 * project rows ended up sitting in the same database `S2T-1`'s real local
 * requirement lives in.
 */
import { Client } from 'pg';
import { existsSync, readFileSync } from 'node:fs';

export const TEST_MIGRATION_DATABASE_URL = 'postgresql://spec2test:spec2test@localhost:5435/spec2test_test';
export const TEST_DATABASE_URL = 'postgresql://spec2test_app:spec2test_app@localhost:5435/spec2test_test';

/** The admin DSN, pointed at `spec2test` (not `_test`) - the database
 *  docker-compose.yml's POSTGRES_DB guarantees exists, used only to run
 *  `CREATE DATABASE` for the one that might not. */
const BOOTSTRAP_DSN = 'postgresql://spec2test:spec2test@localhost:5435/spec2test';

let ensured = false;

/**
 * Creates `spec2test_test` if it does not exist yet. Idempotent and cheap
 * (one query on a hit); called once per process via `useTestDatabase()`, not
 * per test file, so a full `npm test` run does this at most once.
 *
 * `CREATE DATABASE` cannot run inside a transaction block - this issues a
 * single statement on a fresh client, not through the shared pool, so it
 * never risks running inside one.
 */
async function ensureTestDatabaseExists(): Promise<void> {
  if (ensured) return;
  const client = new Client({ connectionString: BOOTSTRAP_DSN, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', ['spec2test_test']);
    if (!rowCount) {
      await client.query('CREATE DATABASE spec2test_test');
    }
  } finally {
    await client.end();
  }
  ensured = true;
}

/**
 * Points DATABASE_URL/MIGRATION_DATABASE_URL at the dedicated test database,
 * unconditionally - never `??=`. A developer's shell, or `.env`, may already
 * have the real ones exported; a test file must not silently honour that.
 * Creates the database first if this is the first call in the process.
 */
export async function useTestDatabase(): Promise<void> {
  await ensureTestDatabaseExists();
  process.env.MIGRATION_DATABASE_URL = TEST_MIGRATION_DATABASE_URL;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
}

/**
 * For the test files that need real credentials from `.env` for their live
 * parts (JIRA_*, CONDUIT_*) - same only-if-unset loading those files already
 * had, except DATABASE_URL/MIGRATION_DATABASE_URL are skipped entirely so
 * .env's real values can never leak in, then forced to the test database
 * regardless of what .env said.
 */
export async function loadDotEnvExceptDatabase(): Promise<void> {
  for (const path of ['../.env', '.env']) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      if (match[1] === 'DATABASE_URL' || match[1] === 'MIGRATION_DATABASE_URL') continue;
      if (!process.env[match[1]]) process.env[match[1]] = match[2];
    }
    break;
  }
  await useTestDatabase();
}
