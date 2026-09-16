import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initTargetRepo } from './init.ts';
import { generate } from './generator/index.ts';
import { validate } from './validator/index.ts';
import { validateSpec } from './spec/validateSpec.ts';
import { loadOpenApiSchema } from './spec/openapi.ts';
import { runFalsification } from './faultinjection/runFalsification.ts';
import { runPlaywright } from './validator/runPlaywright.ts';
import type { TestCaseSpec } from './spec/types.ts';
import { RunnerError } from './errors.ts';

/**
 * The subprocess boundary between service/ and runner/ - see
 * runner/src/errors.ts: the two workspaces are wired together through the
 * State Service's HTTP API, not shared code, and this CLI is the runner-side
 * half of that (service/'s worker shells out here, never `import`s
 * runner/src/*.ts directly).
 *
 * Every command prints exactly one JSON object to stdout and exits 0, even
 * when the *result* is a failure (a report with `ok: false`, a SURVIVE
 * verdict, a grounding rejection) - that is data, not a crash. Only a
 * genuine crash (bad usage, an unexpected exception) exits 1 with an error
 * object on stderr, so a caller can tell "the test failed" from "the runner
 * itself broke" by exit code alone, without parsing stdout to find out.
 */

function readSpec(path: string): TestCaseSpec {
  return JSON.parse(readFileSync(path, 'utf8')) as TestCaseSpec;
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function emit(payload: unknown): never {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

function usageError(message: string): never {
  console.error(JSON.stringify({ event: 'usage_error', message }));
  process.exit(1);
}

/** Runs `fn`; a RunnerError becomes a structured `{ ok: false }` result
 *  (data), anything else propagates to the top-level handler (a crash). */
function asResult<T extends { ok: boolean }>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RunnerError) {
      return { ok: false, event: err.event, message: err.message } as unknown as T;
    }
    throw err;
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);

  switch (command) {
    case 'init': {
      const [targetPath] = positionals;
      if (!targetPath) usageError('usage: runner init <target-repo-path>');
      initTargetRepo(targetPath);
      emit({ ok: true, message: `spec2test/ scaffolded in ${targetPath}` });
      break;
    }

    case 'validate-spec': {
      const [specPath, openapiPath] = positionals;
      if (!specPath || !openapiPath) {
        usageError('usage: runner validate-spec <specPath.json> <openapiPath>');
      }
      const spec = readSpec(specPath);
      const schema = loadOpenApiSchema(openapiPath);
      emit(
        asResult(() => {
          validateSpec(spec, schema);
          return { ok: true };
        }),
      );
      break;
    }

    case 'generate': {
      const [specPath, outDir] = positionals;
      if (!specPath || !outDir) usageError('usage: runner generate <specPath.json> <outDir> [--force]');
      const spec = readSpec(specPath);
      emit(
        asResult(() => {
          const result = generate(spec, outDir, { force: Boolean(flags.force) });
          return { ok: true, filePath: result.filePath, fileName: result.fileName, contentHash: result.contentHash };
        }),
      );
      break;
    }

    case 'validate': {
      const [specPath, filePath, targetRepoRoot, spec2testDir] = positionals;
      if (!specPath || !filePath || !targetRepoRoot || !spec2testDir) {
        usageError(
          'usage: runner validate <specPath.json> <filePath> <targetRepoRoot> <spec2testDir> [--transcript <path>]',
        );
      }
      const spec = readSpec(specPath);
      const source = readFileSync(filePath, 'utf8');

      let transcriptPath = typeof flags.transcript === 'string' ? flags.transcript : undefined;
      let workDir: string | undefined;
      try {
        if (!transcriptPath) {
          // No hand-authored fixture transcript exists for a real
          // Claude-drafted test - synthesize one from a live run, reusing
          // the exact capture side-channel runFalsification.ts already
          // relies on for the same purpose.
          workDir = mkdtempSync(join(tmpdir(), 'spec2test-transcript-'));
          const capturePath = join(workDir, 'capture.json');
          const captureRun = runPlaywright(targetRepoRoot, filePath, { SPEC2TEST_CAPTURE: capturePath });
          if (!captureRun.passed) {
            emit({
              ok: false,
              stages: [
                {
                  stage: 'smoke',
                  ok: false,
                  details: [
                    'the live run to synthesize a transcript failed before validation could proceed',
                    captureRun.output,
                  ],
                },
              ],
            });
          }
          // The capture file is one flat {status, body} for the single
          // request that ran; the transcript format apiClient.ts's
          // transcriptTransport expects is keyed by "METHOD path" (see
          // runner/src/client/apiClient.ts) - wrapping is required, the two
          // shapes are not interchangeable.
          const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
          transcriptPath = join(workDir, 'transcript.json');
          writeFileSync(transcriptPath, JSON.stringify({ [`${spec.method} ${spec.path}`]: captured }), 'utf8');
        }

        const report = validate({
          filePath,
          source,
          spec,
          targetRepoRoot,
          spec2testDir,
          transcriptPath,
          runSmoke: true,
        });
        emit(report);
      } finally {
        if (workDir) rmSync(workDir, { recursive: true, force: true });
      }
      break;
    }

    case 'falsify': {
      const [specPath, filePath, targetRepoRoot, openapiPath] = positionals;
      if (!specPath || !filePath || !targetRepoRoot || !openapiPath) {
        usageError('usage: runner falsify <specPath.json> <filePath> <targetRepoRoot> <openapiPath>');
      }
      const spec = readSpec(specPath);
      const schema = loadOpenApiSchema(openapiPath);
      const report = runFalsification({ spec, filePath, targetRepoRoot, schema });
      emit(report);
      break;
    }

    default:
      usageError('usage: runner <init|validate-spec|generate|validate|falsify> ...');
  }
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const event = err instanceof RunnerError ? err.event : 'unexpected_error';
  console.error(JSON.stringify({ event, message }));
  process.exit(1);
}
