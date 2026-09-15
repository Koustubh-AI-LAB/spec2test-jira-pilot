import type { TestCaseSpec } from '../spec/types.ts';
import { checkImportWhitelist } from './importWhitelist.ts';
import { checkAst } from './astChecks.ts';
import { typecheckFile } from './typecheck.ts';
import { replay } from './replay.ts';
import { smoke } from './smoke.ts';

export type ValidationStage = 'import_whitelist' | 'ast_checks' | 'typecheck' | 'replay' | 'smoke';

export interface ValidationStageResult {
  stage: ValidationStage;
  ok: boolean;
  details: string[];
}

export interface ValidationReport {
  ok: boolean;
  stages: ValidationStageResult[];
}

export interface ValidateOptions {
  /** Absolute path to the already-written generated .spec.ts file. */
  filePath: string;
  source: string;
  spec: TestCaseSpec;
  /** The target app's repo root - cwd for `npx playwright test`. */
  targetRepoRoot: string;
  /** targetRepoRoot/spec2test - holds tsconfig.json and playwright.config.ts. */
  spec2testDir: string;
  /** Fixture transcript for the replay stage. */
  transcriptPath: string;
  /** Only true when CONDUIT_BASE_URL is set - the live-skip pattern. */
  runSmoke: boolean;
}

/**
 * Runs the chain in the order the plan specifies, stopping at the first
 * failing stage - a generator bug should never reach a live network call.
 */
export function validate(opts: ValidateOptions): ValidationReport {
  const stages: ValidationStageResult[] = [];

  const whitelistViolations = checkImportWhitelist(opts.source, opts.filePath);
  stages.push({
    stage: 'import_whitelist',
    ok: whitelistViolations.length === 0,
    details: whitelistViolations.map((v) => v.reason),
  });
  if (!stages.at(-1)!.ok) return { ok: false, stages };

  const astFailures = checkAst(opts.source, opts.filePath, opts.spec);
  stages.push({
    stage: 'ast_checks',
    ok: astFailures.length === 0,
    details: astFailures.map((f) => `${f.rule}: ${f.message}`),
  });
  if (!stages.at(-1)!.ok) return { ok: false, stages };

  const typeDiagnostics = typecheckFile(opts.filePath, opts.spec2testDir);
  stages.push({
    stage: 'typecheck',
    ok: typeDiagnostics.length === 0,
    details: typeDiagnostics.map((d) => (d.line ? `line ${d.line}: ${d.message}` : d.message)),
  });
  if (!stages.at(-1)!.ok) return { ok: false, stages };

  const replayResult = replay(opts.targetRepoRoot, opts.filePath, opts.transcriptPath);
  stages.push({
    stage: 'replay',
    ok: replayResult.passed,
    details: replayResult.passed ? [] : [replayResult.output],
  });
  if (!stages.at(-1)!.ok) return { ok: false, stages };

  if (opts.runSmoke) {
    const smokeResult = smoke(opts.targetRepoRoot, opts.filePath);
    stages.push({
      stage: 'smoke',
      ok: smokeResult.passed,
      details: smokeResult.passed ? [] : [smokeResult.output],
    });
    if (!stages.at(-1)!.ok) return { ok: false, stages };
  }

  return { ok: true, stages };
}
