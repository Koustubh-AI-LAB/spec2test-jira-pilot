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
  flags: Record<string, string | boolean>;
}

/**
 * `switches` names this command's boolean flags: presence alone sets them
 * `true`, absence leaves them `false`/unset - they never consume a value
 * token. This is what stops `--confirm false`/`--reject false`/`--full
 * false` from being silently read as `Boolean("false") === true` (every
 * caller here used to cast a flag's raw value with `Boolean(...)`, which
 * cannot tell "the string false" from "present"). Every other `--key`
 * requires an explicit value: a missing one, or one that itself starts with
 * `--`, is a usage error rather than a silently-wrong `true` - use
 * `--key=value` for a value that legitimately starts with `--`.
 */
function parseArgs(command: string, args: string[], switches: ReadonlySet<string>): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      usageError(command, `unexpected argument "${arg}" - every argument must be a --flag`);
    }
    const key = arg.slice(2);
    const eq = key.indexOf('=');
    if (eq !== -1) {
      const name = key.slice(0, eq);
      if (switches.has(name)) {
        usageError(command, `--${name} is a switch and takes no value; pass it bare, without "="`);
      }
      flags[name] = key.slice(eq + 1);
      continue;
    }
    if (switches.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      usageError(command, `--${key} requires a value`);
    }
    flags[key] = next;
    i++;
  }
  return { flags };
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

/** Which of each command's flags are switches (Findings 1/6). */
const BOOLEAN_FLAGS: Record<string, ReadonlySet<string>> = {
  reconcile: new Set(['confirm']),
  'post-criteria': new Set(['preview', 'confirm', 'force']),
  sync: new Set(['preview', 'confirm']),
  grounding: new Set(['full']),
  'approve-test-case': new Set(['reject']),
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

  await handler(parseArgs(command, rest, BOOLEAN_FLAGS[command] ?? new Set()));
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
