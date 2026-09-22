/**
 * The dispatcher the skill drives via `Bash(s2t:*)`. Mirrors
 * runner/src/cli.ts's parseArgs/emit/usageError shape; see output.ts for how
 * the envelope itself diverges (always {ok, command, ...} - this CLI's only
 * consumer is an LLM reading the output, so uniformity is the whole point).
 */
import { writeSync } from 'node:fs';
import { usageError } from './output.ts';
import { runPreflight } from './commands/preflight.ts';
import { runStatus } from './commands/status.ts';
import { runReconcile } from './commands/reconcile.ts';
import { runDraftRequirement } from './commands/draft-requirement.ts';
import { runDraftCriteria } from './commands/draft-criteria.ts';
import { runRedraft } from './commands/redraft.ts';
import { runGrounding } from './commands/grounding.ts';
import { runPostCriteria } from './commands/post-criteria.ts';
import { runDraftTestCase } from './commands/draft-test-case.ts';
import { runApproveTestCase } from './commands/approve-test-case.ts';
import { runVerify } from './commands/verify.ts';
import { runSync } from './commands/sync.ts';

export interface ParsedArgs {
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

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<never>> = {
  preflight: runPreflight,
  status: runStatus,
  reconcile: runReconcile,
  'draft-requirement': runDraftRequirement,
  'draft-criteria': runDraftCriteria,
  redraft: runRedraft,
  grounding: runGrounding,
  'post-criteria': runPostCriteria,
  'draft-test-case': runDraftTestCase,
  'approve-test-case': runApproveTestCase,
  verify: runVerify,
  sync: runSync,
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    usageError('(none)', `usage: s2t <${Object.keys(COMMANDS).join('|')}> ...`);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    usageError(command, `unknown command "${command}" - usage: s2t <${Object.keys(COMMANDS).join('|')}> ...`);
  }

  await handler(parseArgs(rest));
}

try {
  await main();
} catch (err) {
  // A genuine crash - anything a command handler did not turn into an
  // emit()/emitFailure() call itself. Exit 1 on stderr, same as
  // runner/src/cli.ts's top-level catch. writeSync, not console.error - see
  // output.ts's doc comment on emit() for why.
  writeSync(
    2,
    `${JSON.stringify({ event: 'unexpected_error', message: err instanceof Error ? err.message : String(err) })}\n`,
  );
  process.exit(1);
}
