import { spawnSync } from 'node:child_process';
import { relative, join } from 'node:path';

export interface PlaywrightRunResult {
  passed: boolean;
  output: string;
}

export interface PlaywrightStepResult {
  title: string;
  failed: boolean;
}

export interface PlaywrightStepRunResult {
  passed: boolean;
  /** Empty when Playwright itself never produced a parseable result (e.g. a
   *  crash before any test ran) - callers must treat that as its own
   *  failure mode, not as "zero steps ran and all passed." */
  steps: PlaywrightStepResult[];
  output: string;
}

/**
 * OS/toolchain plumbing the child process needs just to start and find
 * node/npm - never a project secret. Whatever this list omits simply isn't
 * visible to the spawned process.
 */
const PASSTHROUGH_ENV_KEYS = [
  'PATH',
  'Path',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
];

/**
 * What a generated test is actually meant to use, per apiClient.ts.
 * Everything else this process holds - JIRA_API_TOKEN, DATABASE_URL, etc. -
 * must never reach the spawned test process. Passing `...process.env`
 * wholesale was a real gap: those secrets were reachable from a generated
 * test's own `process.env` with no import needed to get at them.
 */
const TEST_ENV_KEYS = [
  'CONDUIT_BASE_URL',
  'TARGET_AUTH_TOKEN',
  'SPEC2TEST_TRANSCRIPT',
  'SPEC2TEST_FAULT',
  'SPEC2TEST_FAULT_RESULT',
  'SPEC2TEST_CAPTURE',
  'SPEC2TEST_TRANSCRIPT_CAPTURE',
];

/** Exported for direct testing - the actual guarantee ("secrets never reach
 *  the child") is easier to prove by inspecting this function's output than
 *  by asserting on a spawned process's behavior. */
export function scopedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...PASSTHROUGH_ENV_KEYS, ...TEST_ENV_KEYS]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * Spawns the target repo's own locally-installed playwright binary directly,
 * never `npx playwright` - npx's own relative module resolution breaks when
 * spawned with a cwd other than npm's own install directory (a real failure
 * hit while building this), and going straight to node_modules/.bin/ is also
 * more correct: it guarantees the exact @playwright/test that repo
 * installed, never something npx fetches fresh.
 */
function spawnPlaywright(cwd: string, args: string[], extraEnv: Record<string, string>) {
  const playwrightBin = join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
  const env = scopedEnv(extraEnv);

  // .cmd files can only be launched through a shell on Windows, and Node
  // deprecates shell:true combined with an args array (DEP0190 - the shell
  // doesn't escape them). Every argument here is a path this process
  // constructs itself, never external input, so a single pre-quoted command
  // string is the documented, warning-free way to do this.
  return process.platform === 'win32'
    ? spawnSync([playwrightBin, ...args].map((part) => `"${part}"`).join(' '), {
        cwd,
        env,
        encoding: 'utf8',
        shell: true,
      })
    : spawnSync(playwrightBin, args, { cwd, env, encoding: 'utf8' });
}

/**
 * Runs one generated test for real, via the target repo's own installed
 * @playwright/test and its own spec2test/playwright.config.ts - never
 * runner's own toolchain. `cwd` is the target repo root.
 */
export function runPlaywright(
  cwd: string,
  generatedFilePath: string,
  extraEnv: Record<string, string> = {},
): PlaywrightRunResult {
  const relativePath = relative(cwd, generatedFilePath).replace(/\\/g, '/');
  const result = spawnPlaywright(cwd, ['test', '--config=spec2test/playwright.config.ts', relativePath], extraEnv);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { passed: result.status === 0, output };
}

/**
 * Same run, but via Playwright's JSON reporter so each assertion's
 * test.step('assertion: <name>', ...) can be told apart - this is what makes
 * "failed at the named assertion" (KILL) distinguishable from "failed for
 * the wrong reason" (INCONCLUSIVE), which a bare exit code can't do.
 */
export function runPlaywrightSteps(
  cwd: string,
  generatedFilePath: string,
  extraEnv: Record<string, string> = {},
): PlaywrightStepRunResult {
  const relativePath = relative(cwd, generatedFilePath).replace(/\\/g, '/');
  const result = spawnPlaywright(
    cwd,
    ['test', '--config=spec2test/playwright.config.ts', '--reporter=json', relativePath],
    extraEnv,
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  const steps = extractSteps(result.stdout ?? '');
  return { passed: result.status === 0, steps, output };
}

function extractSteps(stdout: string): PlaywrightStepResult[] {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return [];
  }
  const suites = (report as { suites?: unknown[] }).suites ?? [];
  const steps: PlaywrightStepResult[] = [];

  // Playwright's JSON report is untyped input; walked defensively below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walkSuite = (suite: any): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          for (const step of result.steps ?? []) {
            steps.push({ title: step.title, failed: Boolean(step.error) });
          }
        }
      }
    }
    for (const nested of suite.suites ?? []) walkSuite(nested);
  };
  for (const suite of suites) walkSuite(suite);

  return steps;
}
