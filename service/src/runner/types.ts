/**
 * Mirrors the JSON shapes runner/'s CLI prints (runner/src/faultinjection/types.ts,
 * runner/src/validator/index.ts). Not imported across the workspace boundary
 * on purpose, same reasoning as runner/src/errors.ts: service/ and runner/
 * are wired together through a subprocess (the worker shells out to
 * `runner/src/cli.ts`), never through shared TypeScript - so this is the
 * service-side declaration of what that subprocess's stdout parses into.
 */

export type FaultKind = 'kill' | 'immunity';
export type FaultVerdictKind = 'KILL' | 'SURVIVE' | 'INCONCLUSIVE' | 'QUARANTINED';

export interface FaultSpec {
  id: string;
  kind: FaultKind;
  targetAssertion?: string;
  description: string;
  mutation: unknown;
  plausible: boolean;
}

export interface FaultVerdict {
  fault: FaultSpec;
  verdict: FaultVerdictKind;
  detail: string;
}

export interface FalsificationReport {
  criterionId: string;
  verdicts: FaultVerdict[];
  assertionSensitivity: number;
  runsExecuted: number;
  criterionQuarantined?: string;
}

export type ValidationStage = 'import_whitelist' | 'ast_checks' | 'typecheck' | 'replay' | 'smoke';

export interface PlaywrightStepResult {
  title: string;
  failed: boolean;
}

export interface ValidationStageResult {
  stage: ValidationStage;
  ok: boolean;
  details: string[];
  steps?: PlaywrightStepResult[];
}

export interface ValidationReport {
  ok: boolean;
  stages: ValidationStageResult[];
}

export interface GenerateResult {
  ok: boolean;
  filePath?: string;
  fileName?: string;
  contentHash?: string;
  event?: string;
  message?: string;
}

/** What `runner validate-spec` prints: the OpenAPI grounding check, which
 *  runs before anything is generated.
 *
 *  `hints` (added for step 5.3's plugin CLI, populated once runner/'s
 *  validate-spec exports `parseCheck` - see PLAN-5.3-5.7-WALKING-SKELETON.md
 *  0.3) names every assertion whose `check` can't derive a kill fault: the
 *  spec would still pass grounding and generate a green-looking test, but the
 *  criterion can never be certified - falsification would quarantine it with
 *  no assertion ever having run. Surfacing this at draft time, rather than
 *  minutes later after a full generate/validate/falsify round-trip, is the
 *  whole reason this field exists. Absent or empty until 0.3 lands. */
export interface SpecValidationResult {
  ok: boolean;
  event?: string;
  message?: string;
  hints?: string[];
}
