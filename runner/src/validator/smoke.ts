import { runPlaywrightSteps, type PlaywrightStepRunResult } from './runPlaywright.ts';

/**
 * Runs the generated test for real, against the live target - the last and
 * only stage that actually touches the network. SPEC2TEST_TRANSCRIPT is
 * deliberately not set here.
 *
 * Uses the JSON-reporter variant (per-step results, same mechanism
 * runFalsification.ts uses for kill/immunity attribution) rather than the
 * plain pass/fail runner, so a caller that wants per-assertion detail (the
 * worker, writing one run_result row per assertion) can have it - existing
 * callers that only read `.passed`/`.output` are unaffected, `steps` is
 * additive.
 */
export function smoke(cwd: string, generatedFilePath: string): PlaywrightStepRunResult {
  return runPlaywrightSteps(cwd, generatedFilePath, {});
}
