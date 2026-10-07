import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestCaseSpec } from '../spec/types.ts';
import type { OpenApiDoc } from '../spec/openapi.ts';
import { runPlaywright, runPlaywrightSteps } from '../validator/runPlaywright.ts';
import { deriveKillFaults } from './deriveKillFaults.ts';
import { deriveImmunityFaults } from './deriveImmunityFaults.ts';
import type { FalsificationReport, FaultSpec, FaultVerdict, Verdict } from './types.ts';

const ATTEMPTS_PER_FAULT = 3;

export interface RunFalsificationOptions {
  spec: TestCaseSpec;
  filePath: string;
  targetRepoRoot: string;
  schema: OpenApiDoc;
}

export interface FaultAttempt {
  /** The real exit-code-based pass/fail, independent of step parsing - a
   *  crash outside any test.step (an unhandled exception, a Playwright-level
   *  error) leaves failedStep undefined too, and must never be read as "the
   *  test passed." This is the primary signal; failedStep only refines
   *  *which* step failed, for the kill-fault "right assertion" check. */
  testPassed: boolean;
  failedStep: string | undefined;
  applied: boolean;
}

/**
 * Kill Set + Immunity Set falsification for one generated test, against a
 * real running target. Tier-1 only: every request is real, every mutation is
 * applied to a genuine response by apiClient's fault transport.
 */
export function runFalsification(opts: RunFalsificationOptions): FalsificationReport {
  const { spec, filePath, targetRepoRoot, schema } = opts;
  const workDir = mkdtempSync(join(tmpdir(), 'spec2test-falsify-'));
  let runsExecuted = 0;

  try {
    const killFaults = deriveKillFaults(spec, schema);

    // Sample a real response, through the actual generated test, before any
    // immunity fault can be picked - and use this same run as a pre-flight
    // health check: if the target can't even complete one healthy run,
    // nothing downstream can be trusted either.
    const capturePath = join(workDir, 'capture.json');
    const captureRun = runPlaywright(targetRepoRoot, filePath, { SPEC2TEST_CAPTURE: capturePath });
    runsExecuted++;

    const quarantineReason =
      'the initial healthy control failed before any fault could be tried - environment unstable';
    if (!captureRun.passed) {
      return quarantinedReport(spec.criterionId, killFaults, runsExecuted, quarantineReason);
    }

    let captured: { status: number; body: unknown };
    try {
      captured = JSON.parse(readFileSync(capturePath, 'utf8')) as { status: number; body: unknown };
    } catch {
      // The control run reported success, but the capture file it was
      // supposed to write is missing or unreadable - can't be trusted to
      // derive immunity faults from, and treating it as "zero candidates,
      // proceed anyway" would silently understate what the criterion was
      // actually checked against.
      return quarantinedReport(
        spec.criterionId,
        killFaults,
        runsExecuted,
        'the healthy control passed but its captured response could not be read - cannot derive immunity faults',
      );
    }
    const immunityFaults = deriveImmunityFaults(spec, captured.status, captured.body, schema);

    const verdicts: FaultVerdict[] = [];
    for (const fault of [...killFaults, ...immunityFaults]) {
      const result = runFaultSequence(spec, targetRepoRoot, filePath, fault, workDir);
      runsExecuted += result.runsExecuted;
      verdicts.push({ fault, verdict: result.verdict, detail: result.detail });
    }

    return {
      criterionId: spec.criterionId,
      verdicts,
      assertionSensitivity: computeAssertionSensitivity(verdicts),
      runsExecuted,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * A whole-criterion quarantine, before any fault could even be attempted.
 * Attaches the QUARANTINED verdict to every derived kill fault so the
 * signal is visible per-fault - and sets `criterionQuarantined` at the
 * report level too, since a spec whose assertions derive zero kill faults
 * (e.g. brittle-login-snapshot's single unparseable check) would otherwise
 * report an empty verdicts array indistinguishable from "nothing to check."
 * Exported for direct testing, same reasoning as aggregate().
 */
export function quarantinedReport(
  criterionId: string,
  killFaults: FaultSpec[],
  runsExecuted: number,
  reason: string,
): FalsificationReport {
  const verdicts: FaultVerdict[] = killFaults.map((fault) => ({
    fault,
    verdict: 'QUARANTINED' as Verdict,
    detail: reason,
  }));
  return { criterionId, verdicts, assertionSensitivity: 0, runsExecuted, criterionQuarantined: reason };
}

/**
 * 4 controls interleaved around 3 fault attempts
 * [control, fault, control, fault, control, fault, control]. Any control
 * failure quarantines this fault immediately - an unstable environment
 * can't produce a trustworthy verdict, so the remaining attempts aren't
 * worth running.
 */
function runFaultSequence(
  spec: TestCaseSpec,
  targetRepoRoot: string,
  filePath: string,
  fault: FaultSpec,
  workDir: string,
): { verdict: Verdict; detail: string; runsExecuted: number } {
  const faultPath = join(workDir, `fault-${fault.id}.json`);
  const faultResultPath = join(workDir, `fault-result-${fault.id}.json`);
  writeFileSync(faultPath, JSON.stringify({ method: spec.method, path: spec.path, mutation: fault.mutation }));

  let runsExecuted = 0;
  const attempts: FaultAttempt[] = [];

  for (let round = 0; round < ATTEMPTS_PER_FAULT + 1; round++) {
    const control = runPlaywrightSteps(targetRepoRoot, filePath);
    runsExecuted++;
    if (!control.passed) {
      return { verdict: 'QUARANTINED', detail: `healthy control failed on round ${round + 1}`, runsExecuted };
    }

    if (round === ATTEMPTS_PER_FAULT) break; // trailing control after the last attempt, no fault run after it

    const attemptRun = runPlaywrightSteps(targetRepoRoot, filePath, {
      SPEC2TEST_FAULT: faultPath,
      SPEC2TEST_FAULT_RESULT: faultResultPath,
    });
    runsExecuted++;

    const failedStep = attemptRun.steps.find((s) => s.failed)?.title;
    const applied = readAppliedFlag(faultResultPath);
    attempts.push({ testPassed: attemptRun.passed, failedStep, applied });
  }

  return { ...aggregate(fault, attempts), runsExecuted };
}

function readAppliedFlag(path: string): boolean {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { applied: boolean }).applied;
  } catch {
    return false;
  }
}

/** Exported for direct testing - verdict logic is easier to prove correct
 *  against synthetic attempt sequences than by spawning real processes for
 *  every combination. */
export function aggregate(fault: FaultSpec, attempts: FaultAttempt[]): { verdict: Verdict; detail: string } {
  const targetStep = fault.targetAssertion ? `assertion: ${fault.targetAssertion}` : undefined;
  const allPassed = attempts.every((a) => a.testPassed);
  const allFailed = attempts.every((a) => !a.testPassed);
  const describeAttempts = () =>
    attempts.map((a) => (a.testPassed ? '(passed)' : (a.failedStep ?? '(failed, no step recorded)'))).join(', ');

  if (fault.kind === 'kill') {
    // testPassed is the real exit code, checked first: a crash outside any
    // test.step also leaves failedStep undefined, and must score the same
    // as "failed for the wrong reason" (INCONCLUSIVE), never as "passed."
    if (allFailed && attempts.every((a) => a.failedStep === targetStep)) {
      return { verdict: 'KILL', detail: `all ${attempts.length} attempts failed at "${targetStep}"` };
    }
    if (allPassed) {
      if (attempts.every((a) => a.applied)) {
        return { verdict: 'SURVIVE', detail: 'the mutation applied but the test still passed' };
      }
      return {
        verdict: 'INCONCLUSIVE',
        detail: 'the mutation never applied (target path/status not present in the real response)',
      };
    }
    return {
      verdict: 'INCONCLUSIVE',
      detail: `attempts disagreed or failed for the wrong reason: ${describeAttempts()}`,
    };
  }

  // immunity: any real failure at all - at a step or not - counts as
  // violated. Immunity has no "right step" to check against, so testPassed
  // alone decides it.
  if (allPassed) {
    return { verdict: 'SURVIVE', detail: 'immunity holds - the test still passed with an unrelated field changed' };
  }
  if (allFailed) {
    return {
      verdict: 'KILL',
      detail: `immunity violated - the test broke on an unrelated change (${attempts[0]!.failedStep ?? 'failed, no step recorded'})`,
    };
  }
  return {
    verdict: 'INCONCLUSIVE',
    detail: `attempts disagreed on whether the unrelated change broke the test: ${describeAttempts()}`,
  };
}

/** Exported for direct testing, same reasoning as aggregate(). */
export function computeAssertionSensitivity(verdicts: FaultVerdict[]): number {
  const immunityViolated = verdicts.some((v) => v.fault.kind === 'immunity' && v.verdict === 'KILL');
  if (immunityViolated) return 0;

  const killResults = verdicts.filter((v) => v.fault.kind === 'kill');
  const kills = killResults.filter((v) => v.verdict === 'KILL').length;
  const survivals = killResults.filter((v) => v.verdict === 'SURVIVE').length;
  if (kills + survivals === 0) return 0;
  return kills / (kills + survivals);
}
