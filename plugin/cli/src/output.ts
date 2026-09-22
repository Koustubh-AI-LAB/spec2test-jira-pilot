import { writeSync } from 'node:fs';
import type { ApiFailure } from './http.ts';

/**
 * The uniform envelope every command emits. Diverges from runner/src/cli.ts's
 * CLI on purpose: the runner has no single envelope shape across its five
 * commands (falsify's report has no `ok` field at all). This CLI's only
 * consumer is an LLM reading the output, so uniformity - always `ok`, always
 * `command` - is the whole point.
 *
 * exit 0 even for a business failure (`ok: false`); exit 1, on stderr, only
 * for a genuine crash or a usage error - same discipline as the runner CLI.
 *
 * Writes via `writeSync(1, ...)`/`writeSync(2, ...)`, not `console.log`/
 * `console.error`, before calling `process.exit()` - belt-and-suspenders
 * alongside the real fix in http.ts (`agent: false`, no pooled socket left
 * open at exit time). `writeSync` is a blocking syscall, so the write is
 * guaranteed complete before `exit()` runs regardless of whether stdout is
 * a pipe or a TTY; cheap insurance against the same class of exit-time race
 * even if some future change reintroduces an open handle. See http.ts's
 * doc comment for the actual root cause this CLI's test suite exposed
 * (garbage exit code `3221226505` / `0xC0000409` on multi-request commands,
 * traced to a lingering undici keep-alive socket racing process teardown on
 * Windows - reproduced, fixed, and confirmed stable over five consecutive
 * full test runs before this comment was written).
 */
export function emit(payload: { ok: boolean; command: string; [key: string]: unknown }): never {
  writeSync(1, `${JSON.stringify(payload)}\n`);
  process.exit(0);
}

export function usageError(command: string, message: string): never {
  writeSync(2, `${JSON.stringify({ event: 'usage_error', command, message })}\n`);
  process.exit(1);
}

export function emitFailure(command: string, event: string, message: string, remedy?: string): never {
  emit({ ok: false, command, event, message, ...(remedy !== undefined ? { remedy } : {}) });
}

/** The common case: a service call came back as an ApiFailure - forward its
 *  event/message under this command's envelope rather than re-deriving them. */
export function emitApiFailure(command: string, failure: ApiFailure): never {
  emitFailure(command, failure.event, failure.message);
}
