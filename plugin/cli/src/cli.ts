/**
 * 0.0 smoke-test skeleton only - proves the invocation plumbing (npm link
 * shim, permission-matcher shape, --json-file argument passing) before any
 * real command is built. Mirrors runner/src/cli.ts's parseArgs/emit shape so
 * the real 5.3 CLI can grow from this without a rewrite.
 */
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

const [command, ...rest] = process.argv.slice(2);
const { positionals, flags } = parseArgs(rest);

if (!command) {
  usageError('usage: s2t <command> [...args]');
}

// Smoke-test stand-in: every command just echoes what it received, so 0.0
// can confirm the shim + permission matcher work before real commands exist.
emit({ ok: true, command, positionals, flags });
