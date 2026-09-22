/**
 * Spawns the real CLI as a subprocess - same reasoning as
 * runner/test/cli.test.ts: this proves argv parsing, JSON framing and the
 * exit-code contract, which an in-process function call cannot.
 *
 * Uses async `spawn`, not `spawnSync`, on purpose: the stub HTTP service
 * (stub-service.ts) runs IN-PROCESS, in this same test runner. `spawnSync`
 * blocks this process's event loop until the child exits - but that event
 * loop is also what the stub server needs to accept and answer the child's
 * incoming connection. A synchronous spawn here is a real self-deadlock
 * (confirmed empirically: reproduced it standalone before this fix), not a
 * sandbox or network restriction - the child can never get a response
 * because the parent can never run the code that would send one.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(HERE, '..', '..', 'src', 'cli.ts');

export interface CliResult {
  status: number | null;
  stdout: unknown;
  stderr: unknown;
}

export function runCli(args: string[], env: Record<string, string>, input?: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', CLI, ...args], {
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (status) => {
      let parsedOut: unknown;
      let parsedErr: unknown;
      try {
        parsedOut = JSON.parse(stdout);
      } catch {
        parsedOut = stdout;
      }
      try {
        parsedErr = JSON.parse(stderr);
      } catch {
        parsedErr = stderr;
      }
      resolve({ status, stdout: parsedOut, stderr: parsedErr });
    });

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}
