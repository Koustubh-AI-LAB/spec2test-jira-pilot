import type { JiraClient } from './client.ts';
import { fetchTicket, loadFieldMap, VERIFICATION_STATUS } from './read.ts';
import type { FieldMap, TicketSnapshot, ChangelogEntry } from './read.ts';
import { decide } from '../gates/gates.ts';
import type { Decision } from '../gates/gates.ts';
import { getPool } from '../db/pool.ts';
import { audit } from '../audit.ts';
import { NotFoundError } from '../errors.ts';
import { byInstant, isBetween, instant } from './time.ts';

/**
 * Pull reconcile: read the ticket's current state and work out what changed.
 *
 * Nothing here is told anything. There is no webhook, so a decision is
 * *detected* by reading the ticket, which is what lets the service run on a
 * laptop that is switched off between sessions. The price is that this
 * function has to answer a question a webhook would have answered for free:
 * not just "what did the PO decide?" but "what were they looking at when they
 * decided it?".
 */

export type ReconcileAction =
  | 'no_local_instance'
  | 'drift_detected'
  | 'gate1_closed'
  | 'gate1_partial'
  | 'gate1_blocked'
  | 'gate1_rejected'
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
  gate1?: {
    actor: string;
    at: string;
    decision: Decision;
    criteriaClosed: number;
    criteriaRejected: string[];
    /**
     * The PO's own comment, for a rejection - the plan's own language:
     * "the next developer session picks up the rejection reason and
     * redrafts with it as context." Undefined for an approval, and for a
     * rejection where no explanatory comment could be found.
     */
    reason?: string;
  };
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

type Base = { issueKey: string; requirementHash: string; dryRun: boolean; ticket: TicketSnapshot };

/**
 * The changelog entry where the PO last set Verification Status to a given
 * value. Latest wins: a ticket bounced Approved -> Rejected -> Approved is
 * governed by the most recent decision, not the first one ever made - and
 * since ticket.verificationStatus already tells us which value is CURRENT,
 * the caller only ever asks for the entry matching that current value.
 */
function findStatusChange(
  changelog: ChangelogEntry[],
  fieldId: string,
  value: string,
): ChangelogEntry | undefined {
  return changelog
    .filter((e) => e.field === fieldId && e.to === value)
    .sort(byInstant)
    .at(-1);
}

/** Requirement-text edits, which are what can invalidate a decision. */
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
  const base: Base = {
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

  // Drift is checked BEFORE either decision, and that order is the whole
  // point: if the requirement moved, a decision sitting on the ticket refers
  // to text that no longer exists and must not be honoured just because it
  // arrived first.
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

  if (ticket.verificationStatus === VERIFICATION_STATUS.criteriaApproved) {
    const change = findStatusChange(
      ticket.changelog,
      fields.verificationStatus,
      VERIFICATION_STATUS.criteriaApproved,
    );
    if (!change) {
      return {
        ...base,
        action: 'gate1_pending',
        detail:
          'Verification Status reads "Criteria Approved" but no changelog entry explains ' +
          'when - refusing to guess who approved this or when.',
        localHash: local.source_text_hash,
      };
    }
    return applyGate1Decision(local, criteria, ticket, change, 'approved', issueKey, dryRun, base);
  }

  if (ticket.verificationStatus === VERIFICATION_STATUS.criteriaRejected) {
    const change = findStatusChange(
      ticket.changelog,
      fields.verificationStatus,
      VERIFICATION_STATUS.criteriaRejected,
    );
    if (!change) {
      return {
        ...base,
        action: 'gate1_pending',
        detail:
          'Verification Status reads "Criteria Rejected" but no changelog entry explains ' +
          'when - refusing to guess who rejected this or when.',
        localHash: local.source_text_hash,
      };
    }
    return applyGate1Decision(local, criteria, ticket, change, 'rejected', issueKey, dryRun, base);
  }

  return {
    ...base,
    action: 'gate1_pending',
    detail:
      'waiting on the PO: Verification Status is ' +
      `${ticket.verificationStatus ?? '(unset)'}, gate 1 closes on ` +
      `"${VERIFICATION_STATUS.criteriaApproved}" or "${VERIFICATION_STATUS.criteriaRejected}".`,
    localHash: local.source_text_hash,
  };
}

/**
 * Applies one PO decision (approve or reject) to every pending criterion,
 * bound to the hash each one was actually presented at. Shared by both
 * branches above because the mechanics are identical - what differs is only
 * which state counts as "already done" and, for a rejection, that the reason
 * comes from the PO's own comment rather than a fixed string, per the plan:
 * "the next developer session picks up the rejection reason and redrafts
 * with it as context."
 */
async function applyGate1Decision(
  local: LocalRequirement,
  criteria: LocalCriterion[],
  ticket: TicketSnapshot,
  change: ChangelogEntry,
  decision: Decision,
  issueKey: string,
  dryRun: boolean,
  base: Base,
): Promise<ReconcileResult> {
  const pool = getPool();
  const alreadyDone = decision === 'approved' ? 'approved' : 'rejected';

  // What the PO saw is the criteria comment we posted, so this binds to the
  // hashes recorded at posting time, not to whatever the rows say now. If the
  // text was edited between posting and the decision we cannot reconstruct
  // what was on screen - and guessing is exactly what hash-binding prevents.
  const postedAt = ticket.property?.criteria_posted_at;
  const edits = textEdits(ticket.changelog).filter((e) => isBetween(e.at, postedAt, change.at));
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
        `criteria being posted (${postedAt}) and the ${decision === 'approved' ? 'approval' : 'rejection'} ` +
        `(${change.at}). what the reviewer saw cannot be reconstructed, so the decision is not ` +
        'honoured; criteria marked stale and gate 1 reopened.',
      localHash: local.source_text_hash,
    };
  }

  const pending = criteria.filter((c) => c.state !== alreadyDone);
  if (pending.length === 0 && criteria.length > 0) {
    return {
      ...base,
      action: 'up_to_date',
      detail: `gate 1 already ${alreadyDone} for all ${criteria.length} criteria; nothing to do.`,
      localHash: local.source_text_hash,
    };
  }

  const actor = changeActor(change);
  const posted = ticket.property?.criteria_posted ?? {};
  const failed: string[] = [];

  // Never fall back to the row's current hash when no presentation was
  // recorded: the PO cannot have decided on criteria never shown to them, so
  // honouring that with a guessed hash would defeat the whole point of
  // binding the decision to what was actually posted.
  const toDecide: { criterion: LocalCriterion; seenHash: string }[] = [];
  for (const criterion of pending) {
    const seenHash = posted[criterion.id];
    if (!seenHash) {
      failed.push(`${criterion.id}: no presentation record - cannot confirm what the reviewer saw`);
      continue;
    }
    toDecide.push({ criterion, seenHash });
  }

  if (dryRun) {
    const action: ReconcileAction =
      decision === 'approved'
        ? toDecide.length === pending.length
          ? 'gate1_closed'
          : toDecide.length > 0
            ? 'gate1_partial'
            : 'gate1_blocked'
        : toDecide.length > 0
          ? 'gate1_rejected'
          : 'gate1_blocked';
    return {
      ...base,
      action,
      detail:
        `would ${decision} ${toDecide.length} of ${pending.length} pending criteria, ` +
        `on ${actor}'s decision at ${change.at}` +
        (failed.length ? `; ${failed.length} blocked: ${failed.join('; ')}` : '') +
        '.',
      localHash: local.source_text_hash,
    };
  }

  // Only a rejection needs a reason, and only Jira's own record of one - the
  // PO's comment - counts.
  const reason = decision === 'rejected' ? findRejectionReason(ticket, change) : undefined;

  // One PO action fans out to one decision per criterion, each bound to its
  // own hash. A single ticket-level flag would let a criterion reworded after
  // the comment went up inherit a decision it was never shown for.
  let done = 0;
  for (const { criterion, seenHash } of toDecide) {
    try {
      const outcome = await decide(1, {
        subjectId: criterion.id,
        decision,
        actor,
        channel: 'jira',
        reason:
          decision === 'approved'
            ? `Verification Status -> ${VERIFICATION_STATUS.criteriaApproved} on ${issueKey}`
            : (reason ?? `Verification Status -> ${VERIFICATION_STATUS.criteriaRejected} on ${issueKey}`),
        seenHash,
      });
      if (outcome.recorded) done++;
    } catch (err) {
      // One criterion whose text moved must not block the rest: record which
      // could not be honoured and let the caller re-present those.
      failed.push(`${criterion.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A rejection sends the requirement back to the developer, not forward -
  // "Draft" in the plan's own language - because nothing here can redraft on
  // its own; there is no LLM call in this service. An approval never touches
  // requirement.state here: it only ever moves forward via the criteria.
  if (decision === 'rejected' && done > 0) {
    await pool.query(`UPDATE requirement SET state = 'draft', updated_at = now() WHERE id = $1`, [
      local.id,
    ]);
  }

  await audit({
    event: 'jira_gate1_reconciled',
    subject: `requirement:${local.id}`,
    actor,
    detail: {
      issue_key: issueKey,
      decision,
      decided_at: change.at,
      criteria_done: done,
      criteria_failed: failed.length,
      reason: reason ?? '',
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

  let action: ReconcileAction;
  let detail: string;
  if (decision === 'approved') {
    const allApproved = finalStates.length > 0 && finalStates.every((r) => r.state === 'approved');
    action = allApproved ? 'gate1_closed' : done > 0 ? 'gate1_partial' : 'gate1_blocked';
    detail = allApproved
      ? `gate 1 closed for ${done} criteria on ${actor}'s approval at ${change.at}.`
      : `gate 1 ${done > 0 ? 'partially closed' : 'blocked'}: ${done} of ${pending.length} ` +
        `criteria approved on ${actor}'s approval at ${change.at}` +
        (failed.length ? `; ${failed.length} blocked: ${failed.join('; ')}` : '') +
        '.';
  } else {
    action = done > 0 ? 'gate1_rejected' : 'gate1_blocked';
    detail =
      done > 0
        ? `gate 1 rejected for ${done} criteria on ${actor}'s decision at ${change.at}` +
          (reason ? ` - reason: ${reason}` : ' - no explanatory comment found') +
          '. requirement returned to draft for redrafting.'
        : `rejection blocked: ${failed.join('; ')}`;
  }

  return {
    ...base,
    action,
    detail,
    localHash: local.source_text_hash,
    gate1: { actor, at: change.at, decision, criteriaClosed: done, criteriaRejected: failed, reason },
  };
}

/**
 * A PO explaining a rejection might type the comment and then change the
 * field, or the reverse - there is no reliable way to know which, so this
 * looks on both sides of the change and takes whichever comment by the same
 * person landed closest to it. Bounded to REASON_WINDOW_MS specifically so an
 * unrelated comment from hours earlier (a status update, a question about
 * something else entirely) is never mistaken for an explanation of a
 * decision it had nothing to do with.
 */
const REASON_WINDOW_MS = 30 * 60 * 1000;

/**
 * The PO's own explanation for a rejection, per the plan: rejection reason
 * comes from their comment, not a Jira status value (a select field has no
 * free-text slot for one).
 */
function findRejectionReason(ticket: TicketSnapshot, change: ChangelogEntry): string | undefined {
  const comments = ticket.comments ?? [];
  const changeMs = instant(change.at);
  const byProximity = comments
    .filter((c) => c.authorAccountId === change.authorAccountId)
    .map((c) => ({ c, distance: Math.abs(instant(c.created) - changeMs) }))
    .filter(({ distance }) => Number.isFinite(distance) && distance <= REASON_WINDOW_MS)
    .sort((a, b) => a.distance - b.distance);
  return byProximity[0]?.c.text;
}

/**
 * Jira identifies people by accountId; the developer approving gate 2 from the
 * IDE is identified by their git email. The two channels will not produce the
 * same string for the same human, so the same-actor-both-gates flag in
 * gates.ts is best-effort until the plugin passes a Jira accountId through.
 * Noted as a Gate B item rather than papered over here.
 */
function changeActor(entry: ChangelogEntry): string {
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
