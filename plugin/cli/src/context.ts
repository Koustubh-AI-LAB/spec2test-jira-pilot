import { readFileSync } from 'node:fs';
import { ConfigError, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { buildProvenance, ModelIdInvalidError } from './provenance.ts';
import type { Provenance } from './provenance.ts';
import { PromptHashMismatchError } from './prompts.ts';
import { emitFailure } from './output.ts';

/** Shared by every command: load config, or fail loud the same way
 *  everywhere rather than each command re-deriving the message. */
export async function requireConfig(command: string): Promise<Config> {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      emitFailure(command, err.event, err.message, 'set the missing variable(s) in .env, then retry');
    }
    throw err;
  }
}

/** Shared by every drafting command (draft-requirement, draft-criteria,
 *  redraft, draft-test-case): builds provenance or fails loud on a bad
 *  --model or a stale prompt lock. */
export function requireProvenance(command: string, args: Parameters<typeof buildProvenance>[0]): Provenance {
  try {
    return buildProvenance(args);
  } catch (err) {
    if (err instanceof ModelIdInvalidError || err instanceof PromptHashMismatchError) {
      emitFailure(command, err.event, err.message);
    }
    throw err;
  }
}

/** How long `--json-file -` waits for stdin before failing loud. Overridable
 *  so a test can shorten it rather than actually waiting out the default. */
const STDIN_TIMEOUT_MS = Number(process.env.S2T_STDIN_TIMEOUT_MS ?? 5000);

/**
 * Reads stdin to completion, or fails loud with `stdin_timeout` if nothing
 * arrives within `STDIN_TIMEOUT_MS`. This CLI is spawned headless by
 * `Bash(s2t:*)` - never at an interactive terminal a human is watching - so
 * `process.stdin.isTTY` cannot distinguish "a real pipe is coming" from "no
 * one piped anything"; both read as non-TTY. A bounded async read is the
 * only way to turn "forgot to pipe JSON" into a clear error instead of a
 * silent hang, which is what a blocking `readFileSync(0, ...)` produced.
 */
function readStdin(command: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      emitFailure(
        command,
        'stdin_timeout',
        `no data received on --json-file - within ${STDIN_TIMEOUT_MS}ms; did you forget to pipe JSON into this command?`,
      );
    }, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      emitFailure(command, 'json_file_unreadable', `could not read --json-file "-": ${err.message}`);
    });
  });
}

/** `--json-file <path>` - see PLAN-5.3-5.7-WALKING-SKELETON.md 5.3 for why
 *  this replaced a stdin heredoc or an inline --json blob. `-` reads stdin,
 *  so this CLI's own tests need no temp files. */
export async function readJsonFile(command: string, path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = path === '-' ? await readStdin(command) : readFileSync(path, 'utf8');
  } catch (err) {
    emitFailure(
      command,
      'json_file_unreadable',
      `could not read --json-file "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    emitFailure(
      command,
      'json_file_invalid',
      `--json-file "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
