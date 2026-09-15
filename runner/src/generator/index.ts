import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { TestCaseSpec } from '../spec/types.ts';
import { kebabCase, render } from './render.ts';

export interface GenerateResult {
  filePath: string;
  fileName: string;
  source: string;
  /** Same normalisation as service/src/hash.ts's contentHash, kept as a
   *  local copy rather than a cross-workspace import - see errors.ts. */
  contentHash: string;
}

export function generate(spec: TestCaseSpec, outDir: string): GenerateResult {
  const source = render(spec);
  const fileName = `${kebabCase(spec.name)}.spec.ts`;
  const filePath = join(outDir, fileName);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(filePath, source, 'utf8');

  const normalised = source.replace(/\r\n/g, '\n').trim();
  const contentHash = createHash('sha256').update(normalised, 'utf8').digest('hex');

  return { filePath, fileName, source, contentHash };
}
