import { runPlaywright, type PlaywrightRunResult } from './runPlaywright.ts';

/**
 * Runs the generated test for real, against the live target - the last and
 * only stage that actually touches the network. SPEC2TEST_TRANSCRIPT is
 * deliberately not set here.
 */
export function smoke(cwd: string, generatedFilePath: string): PlaywrightRunResult {
  return runPlaywright(cwd, generatedFilePath, {});
}
