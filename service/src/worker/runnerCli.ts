import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one place service/ shells out to runner/ - see runner/src/errors.ts
 * and the master plan's "the worker shells out to runner/": the two
 * workspaces are wired together through this subprocess boundary, never
 * through a shared TypeScript import. `node.exe` itself (not a `.cmd`
 * wrapper) is spawned directly, so - unlike runner's own `playwright.cmd`
 * invocation - no shell-quoting dance is needed here.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_CLI = join(HERE, '..', '..', '..', 'runner', 'src', 'cli.ts');

export interface RunnerCliResult<T = unknown> {
  /** True when the subprocess ran to completion (exit 0) and printed
   *  parseable JSON - note this is NOT the same as the *result* being a
   *  success; a `{ ok: false, ... }` report is still `ok: true` here. False
   *  means the subprocess itself crashed or produced garbage. */
  ok: boolean;
  result?: T;
  error?: { event: string; message: string };
}

export function runRunnerCli<T = unknown>(args: string[]): RunnerCliResult<T> {
  const spawned = spawnSync(process.execPath, ['--experimental-strip-types', RUNNER_CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (spawned.status === 0) {
    try {
      return { ok: true, result: JSON.parse(spawned.stdout) as T };
    } catch {
      return {
        ok: false,
        error: { event: 'runner_cli_unparseable_output', message: (spawned.stdout ?? '').slice(0, 2000) },
      };
    }
  }

  try {
    return { ok: false, error: JSON.parse(spawned.stderr) };
  } catch {
    return {
      ok: false,
      error: {
        event: 'runner_cli_crashed',
        message: spawned.stderr || spawned.error?.message || `runner CLI exited ${spawned.status}`,
      },
    };
  }
}
