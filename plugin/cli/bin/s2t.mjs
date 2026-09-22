#!/usr/bin/env node
/**
 * The `spec2test` binary the skill invokes via `Bash(spec2test:*)`.
 *
 * Does not run the TypeScript itself - re-spawns process.execPath against
 * src/cli.ts with --experimental-strip-types, mirroring
 * service/src/worker/runnerCli.ts's subprocess pattern for the runner CLI
 * and for the same reason: npm/node shims on Windows have historically lost
 * exit codes, so this process must forward the child's exit code exactly,
 * never swallow it into 0.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(HERE, '..', 'src', 'cli.ts');
const REPO_ROOT = join(HERE, '..', '..', '..');
const ENV_FILE = join(REPO_ROOT, '.env');

const nodeArgs = ['--experimental-strip-types'];
if (existsSync(ENV_FILE)) {
  nodeArgs.push(`--env-file-if-exists=${ENV_FILE}`);
}
nodeArgs.push(CLI_ENTRY, ...process.argv.slice(2));

const result = spawnSync(process.execPath, nodeArgs, { stdio: 'inherit' });

if (result.error) {
  console.error(JSON.stringify({ event: 'shim_spawn_failed', message: result.error.message }));
  process.exit(1);
}

process.exit(result.status ?? 1);
