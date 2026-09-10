import type { PoolClient } from 'pg';
import { getPool } from './db/pool.ts';

export interface AuditEntry {
  event: string;
  subject?: string;
  actor?: string;
  detail?: Record<string, unknown>;
}

/**
 * The append-only ledger. Every state transition writes here, and the whole
 * lineage of a ticket is answerable from this table alone - no log grepping.
 * The app role has no UPDATE/DELETE on it (see migration 001).
 */
export async function audit(entry: AuditEntry, client?: PoolClient): Promise<void> {
  const runner = client ?? getPool();
  await runner.query(
    'INSERT INTO audit_event (event, subject, actor, detail) VALUES ($1, $2, $3, $4)',
    [entry.event, entry.subject ?? '', entry.actor ?? '', JSON.stringify(entry.detail ?? {})],
  );
}
