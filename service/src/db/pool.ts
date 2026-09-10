import { Pool } from 'pg';

// connect_timeout is not optional here. TestForge hit exactly this: with no
// timeout, an unreachable Postgres hangs the TCP handshake for minutes and the
// caller looks stuck rather than broken.
const CONNECT_TIMEOUT_MS = 5_000;

let appPool: Pool | undefined;
let adminPool: Pool | undefined;

/**
 * The application's own connection, as a role that cannot rewrite audit_event.
 * Everything the service does at runtime goes through here.
 */
export function getPool(): Pool {
  if (!appPool) {
    appPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
  }
  return appPool;
}

/**
 * Owner connection, for migrations and test fixtures only. Kept separate so the
 * append-only guarantee on audit_event is a real privilege boundary rather than
 * a convention the app could step over.
 */
export function getAdminPool(): Pool {
  if (!adminPool) {
    adminPool = new Pool({
      connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
  }
  return adminPool;
}

export async function closePool(): Promise<void> {
  await appPool?.end();
  await adminPool?.end();
  appPool = undefined;
  adminPool = undefined;
}
