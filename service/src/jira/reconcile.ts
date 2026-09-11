import type { JiraClient } from './client.ts';
import { fetchTicket, loadFieldMap, VERIFICATION_STATUS } from './read.ts';
import type { FieldMap, TicketSnapshot, ChangelogEntry } from './read.ts';
import { decide } from '../gates/gates.ts';
import { getPool } from '../db/pool.ts';
import { audit } from '../audit.ts';
import { NotFoundError } from '../errors.ts';
import { byInstant, isBetween } from './time.ts';

/**
 * Pull reconcile: read the ticket's current state and work out what changed.
 *
 * Nothing here is told anything. There is no webhook, so approval is *detected*
 * by reading the ticket, which is what lets the service run on a laptop that is
 * switched off between sessions. The price is that this function has to answer
 * a question a webhook would have answered for free: not just "was it
 * approved?" but "what was the approver looking at when they did?".
 */

export type ReconcileAction =
  | 'no_local_instance'
  | 'drift_detected'
  | 'gate1_closed'
  | 'gate1_partial'
  | 'gate1_blocked'
  | 'gate1_pending'
  | 'approval_unverifiable'
  | 'up_to_date';

export interface ReconcileResult {
  issueKey: string;
  action: ReconcileAction;
  detail: string;
  requirementHash: string;
  localHash?: string;
  dryRun: boolean;
  gate1?: { actor: string; at: string; criteriaClosed: number; criteriaRejected: string[] };
  drift?: { approvedHash: string; currentHash: string };
  ticket?: TicketSnapshot;
}

export interface ReconcileOptions {
  /** Report what would happen; touch neither Postgres nor Jira. */
  dryRun?: boolean;
  fields?: FieldMap;
}

interface LocalRequirement {
  id: string;
  state: string;
  source_text_hash: string;
  jira_issue_key: string;
}

interface LocalCriterion {
  id: string;
  ordinal: number;
  content_hash: string;
  state: string;
}

/**
 * The changelog entry where the PO set Verification Status to Criteria
 * Approved. Latest wins: a ticket bounced Approved -> Drafted -> Approved is
 * governed by the most recent decision, not the first one ever made.
 */
function findApproval(changelog: ChangelogEntry[], fieldId: string): ChangelogEntry | undefined {
  return changelog
    .filter((e) => e.field === fieldId && e.to === VERIFICATION_STATUS.criteriaApproved)
    .sort(byInstant)
    .at(-1);
}

/** Requirement-text edits, which are what can invalidate an approval. */
function textEdits(changelog: ChangelogEntry[]): ChangelogEntry[] {
  return changelog.filter((e) => e.field === 'description' || e.field === 'summary');
}

export async function reconcile(
  client: JiraClient,
  issueKey: string,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const dryRun = options.dryRun ?? false;
  const fields = options.fields ?? loadFieldMap();
  const pool = getPool();

  const ticket = await fetchTicket(client, issueKey, fields);
  const base = {
    issueKey: ticket.key,
    requirementHash: ticket.requirementHash,
    dryRun,
    ticket,
  };

  const { rows } = await pool.query<LocalRequirement>(
    `SELECT id, state, source_text_hash, jira_issue_key
       FROM requirement
      WHERE jira_issue_key = $1 AND state <> 'closed'
      LIMIT 1`,
    [issueKey],
  );
  const local = rows[0];

  // Nothing drafted yet. The reconcile reports that; it does not draft, because
  // drafting is the plugin's job and needs an LLM this service never calls.
  if (!local) {
    return {
      ...base,
      action: 'no_local_instance',
      detail:
        `no open pipeline instance for ${issueKey}; nothing to reconcile. ` +
        'draft criteria first, then this call picks up the PO decision.',
    };
  }

  const { rows: criteria } = await pool.query<LocalCriterion>(
    `SELECT id, ordinal, content_hash, state
       FROM criterion WHERE requirement_id = $1 ORDER BY ordinal`,
    [local.id],
  );

  // Drift is checked BEFORE approval, and that order is the whole point: if the
  // requirement moved, an approval sitting on the ticket refers to text that no
  // longer exists, and must not be honoured just because it arrived first.
  if (local.source_text_hash !== ticket.requirementHash) {
    const drift = { approvedHash: local.source_text_hash, currentHash: ticket.requirementHash };
    if (!dryRun) await markStale(local.id, issueKey, drift);
    return {
      ...base,
      action: 'drift_detected',
      detail:
        'requirement text changed since it was drafted from ' +
        `(${local.source_text_hash.slice(0, 12)} -> ${ticket.requirementHash.slice(0, 12)}). ` +
        'criteria marked stale and gate 1 reopened; existing tests keep running but stop ' +
        'counting as certified until re-approved.',
      localHash: local.source_text_hash,
      drift,
    };
  }

  const approval = findApproval(ticket.changelog, fields.verificationStatus);

  if (!approval || ticket.verificationStatus !== VERIFICATION_STATUS.criteriaApproved) {
    return {
      ...base,
      action: 'gate1_pending',
      detail:
        'waiting on the PO: Verification Status is ' +
        `${ticket.verificationStatus ?? '(unset)'}, gate 1 closes when it reads ` +
        `"${VERIFICATION_STATUS.criteriaApproved}".`,
      localHash: local.source_text_hash,
    };
  }

  // What the PO saw is the criteria comment we posted, so Gate 1 binds to the
  // hashes recorded at posting time, not to whatever the rows say now. If the
  // text was edited between posting and approval we cannot reconstruct what was
  // on screen - and guessing is exactly what hash-binding exists to prevent.
  const postedAt = ticket.property?.criteria_posted_at;
  const edits = textEdits(ticket.changelog).filter((e) => isBetween(e.at, postedAt, approval.at));
  if (edits.length > 0) {
    if (!dryRun) {
      await markStale(local.id, issueKey, {
        approvedHash: local.source_text_hash,
        currentHash: ticket.requirementHash,
      });
    }
    return {
      ...base,
      action: 'approval_unverifiable',
      detail:
        `the requirement was edited at ${edits.map((e) => e.at).join(', ')}, between the ` +
        `criteria being posted (${postedAt}) and the approval (${approval.at}). ` +
        'what the approver saw cannot be reconstructed, so the approval is not honoured; ' +
        'criteria marked stale and gate 1 reopened.',
      localHash: local.source_text_hash,
    };
  }

  const pending = criteria.filter((c) => c.state !== 'approved');
  if (pending.length === 0 && criteria.length > 0) {
    return {
      ...base,
      action: 'up_to_date',
      detail: `gate 1 already closed for all ${criteria.length} criteria; nothing to do.`,
      localHash: local.source_text_hash,
    };
  }

  const actor = approvalActor(approval);
  const posted = ticket.property?.criteria_posted ?? {};
  const rejected: string[] = [];

  // Split up front, and never fall back to the row's current hash when no
  // presentation was recorded: the PO cannot have approved criteria that were
  // never shown to them, so honouring that with a guessed hash would defeat
  // the whole point of binding the approval to what was actually posted.
  const toApprove: { criterion: LocalCriterion; seenHash: string }[] = [];
  for (const criterion of pending) {
    const seenHash = posted[criterion.id];
    if (!seenHash) {
      rejected.push(`${criterion.id}: no presentation record - cannot confirm what the approver saw`);
      continue;
    }
    toApprove.push({ criterion, seenHash });
  }

  if (dryRun) {
    const action: ReconcileAction =
      toApprove.length === pending.length
        ? 'gate1_closed'
        : toApprove.length > 0
          ? 'gate1_partial'
          : 'gate1_blocked';
    return {
      ...base,
      action,
      detail:
        `would close gate 1 for ${toApprove.length} of ${pending.length} pending criteria, ` +
        `on ${actor}'s approval at ${approval.at}` +
        (rejected.length ? `; ${rejected.length} blocked: ${rejected.join('; ')}` : '') +
        '.',
      localHash: local.source_text_hash,
    };
  }

  // One PO action fans out to one decision per criterion, each bound to its
  // own hash. A single ticket-level flag would let a criterion reworded after
  // the comment went up inherit an approval it was never shown for.
  let closed = 0;
  for (const { criterion, seenHash } of toApprove) {
    try {
      const outcome = await decide(1, {
        subjectId: criterion.id,
        decision: 'approved',
        actor,
        channel: 'jira',
        reason: `Verification Status -> ${VERIFICATION_STATUS.criteriaApproved} on ${issueKey}`,
        seenHash,
      });
      if (outcome.recorded) closed++;
    } catch (err) {
      // One criterion whose text moved must not block the rest: record which
      // could not be honoured and let the caller re-present those.
      rejected.push(`${criterion.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await audit({
    event: 'jira_gate1_reconciled',
    subject: `requirement:${local.id}`,
    actor,
    detail: {
      issue_key: issueKey,
      approved_at: approval.at,
      criteria_closed: closed,
      criteria_rejected: rejected.length,
      requirement_hash: ticket.requirementHash,
      source: 'pull_reconcile',
    },
  });

  // The action reported (and, from the route, written back onto the ticket)
  // has to reflect what actually happened, not what was attempted - this is
  // what previously let a reconcile claim "gate1_closed" while every
  // criterion sat untouched. Re-read rather than trust the loop's own count.
  const { rows: finalStates } = await pool.query<{ state: string }>(
    'SELECT state FROM criterion WHERE requirement_id = $1',
    [local.id],
  );
  const allApproved = finalStates.length > 0 && finalStates.every((r) => r.state === 'approved');
  const action: ReconcileAction = allApproved
    ? 'gate1_closed'
    : closed > 0
      ? 'gate1_partial'
      : 'gate1_blocked';

  return {
    ...base,
    action,
    detail: allApproved
      ? `gate 1 closed for ${closed} criteria on ${actor}'s approval at ${approval.at}.`
      : `gate 1 ${closed > 0 ? 'partially closed' : 'blocked'}: ${closed} of ${pending.length} ` +
        `criteria approved on ${actor}'s approval at ${approval.at}` +
        (rejected.length ? `; ${rejected.length} blocked: ${rejected.join('; ')}` : '') +
        '.',
    localHash: local.source_text_hash,
    gate1: { actor, at: approval.at, criteriaClosed: closed, criteriaRejected: rejected },
  };
}

/**
 * Jira identifies people by accountId; the developer approving gate 2 from the
 * IDE is identified by their git email. The two channels will not produce the
 * same string for the same human, so the same-actor-both-gates flag in
 * gates.ts is best-effort until the plugin passes a Jira accountId through.
 * Noted as a Gate B item rather than papered over here.
 */
function approvalActor(entry: ChangelogEntry): string {
  return entry.authorAccountId ? `jira:${entry.authorAccountId}` : `jira:${entry.authorName}`;
}

async function markStale(
  requirementId: string,
  issueKey: string,
  drift: { approvedHash: string; currentHash: string },
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only proposed/approved criteria go stale. A rejected one stays rejected:
    // drift is not a reason to forget that someone turned it down.
    await client.query(
      `UPDATE criterion SET state = 'stale', updated_at = now()
        WHERE requirement_id = $1 AND state IN ('proposed', 'approved')`,
      [requirementId],
    );
    await client.query(
      `UPDATE requirement SET state = 'stale', updated_at = now() WHERE id = $1`,
      [requirementId],
    );
    await audit(
      {
        event: 'requirement_drift_detected',
        subject: `requirement:${requirementId}`,
        actor: 'system',
        detail: { issue_key: issueKey, ...drift, source: 'pull_reconcile' },
      },
      client,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function requireOpenRequirement(issueKey: string): Promise<LocalRequirement> {
  const { rows } = await getPool().query<LocalRequirement>(
    `SELECT id, state, source_text_hash, jira_issue_key
       FROM requirement WHERE jira_issue_key = $1 AND state <> 'closed' LIMIT 1`,
    [issueKey],
  );
  if (!rows[0]) throw new NotFoundError(`no open pipeline instance for ${issueKey}`);
  return rows[0];
}
