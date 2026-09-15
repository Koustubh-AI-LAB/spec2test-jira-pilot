import { spawnSync } from 'node:child_process';
import { relative, join } from 'node:path';

export interface PlaywrightRunResult {
  passed: boolean;
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
const TEST_ENV_KEYS = ['CONDUIT_BASE_URL', 'TARGET_AUTH_TOKEN'];

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
  // Invoke the target repo's own locally-installed playwright binary
  // directly, never `npx playwright` - npx's own relative module resolution
  // breaks when spawned with a cwd other than npm's own install directory
  // (a real failure hit while building this), and going straight to
  // node_modules/.bin/ is also more correct: it guarantees the exact
  // @playwright/test that repo installed, never something npx fetches fresh.
  const playwrightBin = join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
  const args = ['test', '--config=spec2test/playwright.config.ts', relativePath];

  // .cmd files can only be launched through a shell on Windows, and Node
  // deprecates shell:true combined with an args array (DEP0190 - the shell
  // doesn't escape them). Every argument here is a path this process
  // constructs itself, never external input, so a single pre-quoted command
  // string is the documented, warning-free way to do this.
  const env = scopedEnv(extraEnv);
  const result = process.platform === 'win32'
    ? spawnSync([playwrightBin, ...args].map((part) => `"${part}"`).join(' '), {
        cwd,
        env,
        encoding: 'utf8',
        shell: true,
      })
    : spawnSync(playwrightBin, args, { cwd, env, encoding: 'utf8' });

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { passed: result.status === 0, output };
}
