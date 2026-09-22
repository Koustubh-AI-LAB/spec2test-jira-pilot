import { getPool } from './db/pool.ts';
import { reconcile } from './jira/reconcile.ts';
import type { ReconcileAction } from './jira/reconcile.ts';
import type { JiraClient } from './jira/client.ts';
import type { PipelineProperty } from './jira/read.ts';

/**
 * Where a ticket is in the pipeline, computed once, here, by the service.
 *
 * The skill switches on `stage` and never infers position from chat history or
 * from stitching several calls together - that is what makes a resume correct
 * after a session has been closed for days, and what stops the plugin and the
 * service disagreeing about where they are.
 *
 * Two rules shape everything below:
 *
 * 1. Local rows decide. The reconcile dry-run is consulted only for what Jira
 *    newly says (drift, a PO decision not yet applied), never for position.
 *    Once `postVerification` has written "Contract-Verified" onto the ticket,
 *    reconcile reads that as "waiting on the PO" - it only understands the two
 *    Gate 1 values - so treating its action as the stage would put a finished
 *    requirement back at Gate 1.
 * 2. Read-only. `computeVerification` writes `requirement.state`, so it is
 *    deliberately not called; the stored state is already recomputed after every
 *    state-changing step (gate decisions, drafts, verify).
 */

export type PipelineStage =
  /** Nothing drafted for this ticket. */
  | 'no_requirement'
  /** The requirement text moved after it was drafted or approved; redraft. */
  | 'stale'
  /** A requirement exists with no criteria yet. */
  | 'needs_criteria'
  /** The PO rejected the criteria; redraft with `rejectionReason` as context. */
  | 'criteria_rejected'
  /** Criteria are drafted but the current text has not been posted to Jira. */
  | 'needs_criteria_posting'
  /** Posted, waiting on the PO. */
  | 'awaiting_criteria_approval'
  /** The PO has decided in Jira; a real reconcile will apply (or refuse) it. */
  | 'gate1_decision_unapplied'
  /** Gate 1 closed; an approved criterion has no live test case. */
  | 'needs_tests'
  /** A drafted test case is waiting on Gate 2. */
  | 'awaiting_test_approval'
  /** Every test case is approved and none has been through `verify` yet. */
  | 'needs_verification'
  | 'verifying'
  | 'contract_verified'
  | 'weak'
  | 'failing';

export interface StageInputs {
  requirement: { state: string } | null;
  criteria: { id: string; state: string }[];
  testCases: { criterionId: string; state: string }[];
  /** See `criteriaArePosted`. */
  criteriaPosted: boolean;
  /** A `queued` or `running` job exists for this requirement. */
  jobActive: boolean;
  reconcileAction: ReconcileAction;
}

export interface StageResult {
  stage: PipelineStage;
  detail: string;
}

const UNAPPLIED_DECISION: ReadonlySet<ReconcileAction> = new Set([
  'gate1_closed',
  'gate1_partial',
  'gate1_rejected',
  'gate1_blocked',
]);

const TERMINAL_VERIFICATION = ['contract_verified', 'weak', 'failing'] as const;

export function computeStage(i: StageInputs): StageResult {
  if (!i.requirement) {
    return { stage: 'no_requirement', detail: 'no open pipeline instance for this ticket; draft one.' };
  }

  if (
    i.reconcileAction === 'drift_detected' ||
    i.reconcileAction === 'approval_unverifiable' ||
    i.requirement.state === 'stale' ||
    i.criteria.some((c) => c.state === 'stale')
  ) {
    return {
      stage: 'stale',
      detail: 'the requirement text changed after it was drafted; the criteria no longer match it. redraft.',
    };
  }

  if (i.criteria.length === 0) {
    return { stage: 'needs_criteria', detail: 'the requirement has no criteria yet; draft them.' };
  }

  if (i.criteria.some((c) => c.state === 'rejected')) {
    return { stage: 'criteria_rejected', detail: 'the PO rejected the criteria; redraft using the rejection reason.' };
  }

  if (i.criteria.some((c) => c.state === 'proposed')) {
    // Posting is checked BEFORE the unapplied-decision case, on purpose. After
    // a redraft the ticket can still read "Criteria Rejected" (or "Approved")
    // from the previous round until the new criteria are posted; reconcile
    // would report that as a decision to apply, but it was made against text
    // that no longer exists.
    if (!i.criteriaPosted) {
      return {
        stage: 'needs_criteria_posting',
        detail: 'the current criteria have not been posted to the ticket; preview the comment, then post it.',
      };
    }
    if (UNAPPLIED_DECISION.has(i.reconcileAction)) {
      return {
        stage: 'gate1_decision_unapplied',
        detail: 'the PO has decided in Jira but it has not been applied here; run reconcile.',
      };
    }
    return { stage: 'awaiting_criteria_approval', detail: 'posted; waiting on the PO to decide in Jira.' };
  }

  // Gate 1 is closed: every criterion is approved or uncovered.
  if (i.jobActive) {
    return { stage: 'verifying', detail: 'a verification job is queued or running.' };
  }

  const live = new Set(i.testCases.filter((t) => t.state !== 'rejected').map((t) => t.criterionId));
  const needTests = i.criteria.filter((c) => c.state === 'uncovered' || !live.has(c.id));
  if (needTests.length > 0) {
    return {
      stage: 'needs_tests',
      detail: `${needTests.length} approved criteri${needTests.length === 1 ? 'on has' : 'a have'} no live test case; draft one.`,
    };
  }

  if (i.testCases.some((t) => t.state === 'proposed')) {
    return { stage: 'awaiting_test_approval', detail: 'a drafted test case is waiting on Gate 2.' };
  }

  const terminal = TERMINAL_VERIFICATION.find((s) => s === i.requirement!.state);
  if (terminal) {
    return { stage: terminal, detail: `verification rolled up to ${terminal}.` };
  }

  return { stage: 'needs_verification', detail: 'every test case is approved; none has been verified yet.' };
}

/**
 * True only when the ticket carries exactly the criteria we have now. The
 * property records what the PO was actually shown, so this is the difference
 * between "posted" and "drafted locally, ticket still showing an older round".
 *
 * `coverage_state === 'stale'` is checked explicitly because `postDrift`
 * overwrites `requirement_hash` with the *new* text's hash without re-presenting
 * any criteria - so after drift plus a redraft the hash comparison alone would
 * pass for criteria that were never posted.
 */
export function criteriaArePosted(
  property: PipelineProperty | undefined,
  requirement: { source_text_hash: string },
  criteria: { id: string; content_hash: string }[],
): boolean {
  if (!property || property.coverage_state === 'stale') return false;
  if (property.requirement_hash !== requirement.source_text_hash) return false;
  const posted = property.criteria_posted;
  if (!posted) return false;
  return criteria.every((c) => posted[c.id] === c.content_hash);
}

export interface PipelineState {
  issueKey: string;
  stage: PipelineStage;
  detail: string;
  requirement: { id: string; state: string; title: string; sourceTextHash: string } | null;
  criteria: {
    id: string;
    ordinal: number;
    body: string;
    state: string;
    stateAffecting: boolean;
    contentHash: string;
  }[];
  testCases: {
    id: string;
    criterionId: string;
    name: string;
    state: string;
    contentHash: string;
    /**
     * True iff a falsification run has produced `fault_experiment` rows for
     * this test case. Not derivable from `state` alone - `test_case.state`'s
     * CHECK constraint has no certified/verified value; `certify.ts` records
     * the verdict on `requirement.state` only, by design, so a test case
     * reads `approved` both before and after verification. Without this
     * field the plugin CLI could not tell "not yet verified" from "verified
     * and rolled up," and `needs_verification` would re-verify forever.
     */
    verified: boolean;
  }[];
  /** Present only at `criteria_rejected`: the PO's own comment, for the redraft. */
  rejectionReason?: string;
  reconcile: { action: ReconcileAction; detail: string };
  jira: {
    verificationStatus: string | undefined;
    criteriaPosted: boolean;
    /** Verbatim from the ticket - see TicketSnapshot.summary/requirementText.
     *  The plugin CLI copies these into POST /requirements untouched, never
     *  paraphrased, so contentHash(requirementText) keeps matching what
     *  reconcile compares against on every later call. */
    summary: string;
    requirementText: string;
  };
}

/**
 * Gathers the inputs and computes the stage. Touches neither Jira nor Postgres
 * for writing: the reconcile runs as a dry run.
 */
export async function pipelineState(client: JiraClient, issueKey: string): Promise<PipelineState> {
  const pool = getPool();
  const result = await reconcile(client, issueKey, { dryRun: true });

  const { rows: reqRows } = await pool.query<{
    id: string;
    state: string;
    title: string;
    source_text_hash: string;
  }>(
    `SELECT id, state, title, source_text_hash FROM requirement
      WHERE jira_issue_key = $1 AND state <> 'closed' LIMIT 1`,
    [issueKey],
  );
  const requirement = reqRows[0] ?? null;

  const criteria = requirement
    ? (
        await pool.query<{
          id: string;
          ordinal: number;
          body: string;
          state: string;
          state_affecting: boolean;
          content_hash: string;
        }>(
          `SELECT id, ordinal, body, state, state_affecting, content_hash
             FROM criterion WHERE requirement_id = $1 ORDER BY ordinal`,
          [requirement.id],
        )
      ).rows
    : [];

  const testCases = requirement
    ? (
        await pool.query<{
          id: string;
          criterion_id: string;
          name: string;
          state: string;
          content_hash: string;
        }>(
          `SELECT tc.id, tc.criterion_id, tc.name, tc.state, tc.content_hash
             FROM test_case tc JOIN criterion c ON c.id = tc.criterion_id
            WHERE c.requirement_id = $1 ORDER BY tc.created_at`,
          [requirement.id],
        )
      ).rows
    : [];

  const jobActive = requirement
    ? (
        await pool.query(
          `SELECT 1 FROM job WHERE requirement_id = $1 AND state IN ('queued', 'running') LIMIT 1`,
          [requirement.id],
        )
      ).rows.length > 0
    : false;

  // Same join verification.ts's computeVerification uses per test case
  // (run -> fault_experiment), batched once per requirement rather than once
  // per test case. See the `verified` field's doc comment on PipelineState.
  const verifiedIds = requirement
    ? new Set(
        (
          await pool.query<{ test_case_id: string }>(
            `SELECT DISTINCT fe.test_case_id
               FROM run r JOIN fault_experiment fe ON fe.run_id = r.id
              WHERE r.requirement_id = $1 AND r.kind = 'falsification'`,
            [requirement.id],
          )
        ).rows.map((r) => r.test_case_id),
      )
    : new Set<string>();

  const criteriaPosted = requirement
    ? criteriaArePosted(result.ticket?.property, requirement, criteria)
    : false;

  const { stage, detail } = computeStage({
    requirement,
    criteria,
    testCases: testCases.map((t) => ({ criterionId: t.criterion_id, state: t.state })),
    criteriaPosted,
    jobActive,
    reconcileAction: result.action,
  });

  let rejectionReason: string | undefined;
  if (stage === 'criteria_rejected' && requirement) {
    const { rows } = await pool.query<{ reason: string }>(
      `SELECT a.reason
         FROM approval a JOIN criterion c ON c.id = a.subject_id
        WHERE a.subject_type = 'criterion' AND a.decision = 'rejected' AND c.requirement_id = $1
        ORDER BY a.created_at DESC LIMIT 1`,
      [requirement.id],
    );
    rejectionReason = rows[0]?.reason;
  }

  return {
    issueKey,
    stage,
    detail,
    requirement: requirement && {
      id: requirement.id,
      state: requirement.state,
      title: requirement.title,
      sourceTextHash: requirement.source_text_hash,
    },
    criteria: criteria.map((c) => ({
      id: c.id,
      ordinal: c.ordinal,
      body: c.body,
      state: c.state,
      stateAffecting: c.state_affecting,
      contentHash: c.content_hash,
    })),
    testCases: testCases.map((t) => ({
      id: t.id,
      criterionId: t.criterion_id,
      name: t.name,
      state: t.state,
      contentHash: t.content_hash,
      verified: verifiedIds.has(t.id),
    })),
    ...(rejectionReason !== undefined ? { rejectionReason } : {}),
    reconcile: { action: result.action, detail: result.detail },
    jira: {
      verificationStatus: result.ticket?.verificationStatus,
      criteriaPosted,
      summary: result.ticket?.summary ?? '',
      requirementText: result.ticket?.requirementText ?? '',
    },
  };
}
