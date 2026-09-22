/**
 * Mirrors the JSON shapes the State Service's HTTP routes return
 * (service/src/pipeline.ts, service/src/jira/write.ts, service/src/api/server.ts).
 * Not imported across the workspace boundary - same reasoning as
 * service/src/runner/types.ts vs runner/src/errors.ts: this CLI and the
 * service are wired together through HTTP, never through shared TypeScript.
 */

export interface PipelineState {
  issueKey: string;
  stage: string;
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
    verified: boolean;
  }[];
  rejectionReason?: string;
  reconcile: { action: string; detail: string };
  jira: {
    verificationStatus: string | undefined;
    criteriaPosted: boolean;
    summary: string;
    requirementText: string;
  };
}

/** The three lists `status` derives, so the skill never joins criteria[]
 *  against testCases[] itself - see PLAN-5.3-5.7-WALKING-SKELETON.md 5.3. */
export interface DerivedLists {
  uncoveredCriteria: PipelineState['criteria'];
  pendingTestCases: PipelineState['testCases'];
  unverifiedTestCases: PipelineState['testCases'];
}

export interface WritePreview {
  comment: unknown;
  fields: Record<string, unknown>;
}

export interface WriteOutcome {
  wrote: boolean;
  reason: string;
  fingerprint: string;
  dryRun?: boolean;
  preview?: WritePreview;
}

export interface RequirementRow {
  id: string;
  jira_issue_key: string;
  title: string;
  body: string;
  source_text_hash: string;
  state: string;
}

export interface CriterionRow {
  id: string;
  requirement_id: string;
  ordinal: number;
  body: string;
  content_hash: string;
  state: string;
  state_affecting: boolean;
}

export interface TestCaseRow {
  id: string;
  criterion_id: string;
  name: string;
  kind: string;
  spec: unknown;
  content_hash: string;
  state: string;
}

export interface DecisionOutcome {
  recorded: boolean;
  state: string;
  sameActorBothGates: boolean;
}

export interface GroundingResult {
  environmentId: string;
  source: string;
  text: string;
  contentHash: string;
}

export interface SpecValidationResult {
  ok: boolean;
  event?: string;
  message?: string;
  hints?: string[];
}

export interface VerificationResult {
  state: string;
  criteria: { id: string; stateAffecting: boolean; covered: boolean }[];
}

export interface RunOnceResult {
  jobId: string;
  status: 'done' | 'failed';
  lastError?: string;
  verification: VerificationResult;
  [key: string]: unknown;
}

/** Derives the three lists from a PipelineState - see DerivedLists's doc
 *  comment. Pulled out as its own function so `status` and any future
 *  caller compute them identically. */
export function deriveLists(state: PipelineState): DerivedLists {
  const liveByCriterion = new Set(state.testCases.filter((t) => t.state !== 'rejected').map((t) => t.criterionId));
  const uncoveredCriteria = state.criteria.filter((c) => c.state === 'uncovered' || !liveByCriterion.has(c.id));
  const pendingTestCases = state.testCases.filter((t) => t.state === 'proposed');
  const unverifiedTestCases = state.testCases.filter((t) => t.state === 'approved' && !t.verified);
  return { uncoveredCriteria, pendingTestCases, unverifiedTestCases };
}
