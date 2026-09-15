import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { TestCaseSpec } from '../spec/types.ts';
import { kebabCase, render } from './render.ts';
import { RunnerError } from '../errors.ts';

export interface GenerateResult {
  filePath: string;
  fileName: string;
  source: string;
  /** Same normalisation as service/src/hash.ts's contentHash, kept as a
   *  local copy rather than a cross-workspace import - see errors.ts. */
  contentHash: string;
}

export interface GenerateOptions {
  /** Overwrite an existing file even though its content doesn't match what
   *  this spec would render. Off by default - see the refusal below. */
  force?: boolean;
}

function normalise(source: string): string {
  return source.replace(/\r\n/g, '\n').trim();
}

function hashOf(source: string): string {
  return createHash('sha256').update(normalise(source), 'utf8').digest('hex');
}

export function generate(spec: TestCaseSpec, outDir: string, opts: GenerateOptions = {}): GenerateResult {
  const source = render(spec);
  const fileName = `${kebabCase(spec.name)}.spec.ts`;
  const filePath = join(outDir, fileName);

  if (!opts.force && existsSync(filePath)) {
    const onDisk = readFileSync(filePath, 'utf8');
    if (normalise(onDisk) !== normalise(source)) {
      // Covers two real situations with one check: (1) this spec changed
      // since the file was last generated, and (2) two different specs
      // kebab-case to the same filename and would otherwise silently
      // overwrite each other. Once step 5 wires up gate approval, this same
      // refusal is what stops a hand-edited, already-approved file from
      // being clobbered by a routine re-generate - the mechanism needs to
      // exist before the gate does, not be retrofitted after a file gets
      // silently lost.
      throw new RunnerError(
        'generated_file_would_be_overwritten',
        `${filePath} already exists with different content than this spec renders - ` +
          `either it was hand-edited, this spec changed, or another spec's name collides ` +
          `with this one's filename. Pass { force: true } to overwrite deliberately.`,
      );
    }
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(filePath, source, 'utf8');

  return { filePath, fileName, source, contentHash: hashOf(source) };
}
