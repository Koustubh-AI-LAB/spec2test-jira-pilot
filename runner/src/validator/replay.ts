import { runPlaywright, type PlaywrightRunResult } from './runPlaywright.ts';

/**
 * Runs the generated test with SPEC2TEST_TRANSCRIPT set, so apiClient.ts
 * serves a canned response instead of hitting the network - proves the
 * generated assertions evaluate correctly against a known-good shape with
 * zero network dependency, same offline discipline service/'s own suite
 * holds itself to.
 */
export function replay(cwd: string, generatedFilePath: string, transcriptPath: string): PlaywrightRunResult {
  return runPlaywright(cwd, generatedFilePath, { SPEC2TEST_TRANSCRIPT: transcriptPath });
}
