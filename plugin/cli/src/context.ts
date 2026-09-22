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

/** `--json-file <path>` - see PLAN-5.3-5.7-WALKING-SKELETON.md 5.3 for why
 *  this replaced a stdin heredoc or an inline --json blob. `-` reads stdin,
 *  so this CLI's own tests need no temp files. */
export function readJsonFile(command: string, path: string): unknown {
  let raw: string;
  try {
    raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
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
