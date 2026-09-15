import type { TestCaseSpec } from '../spec/types.ts';

const UNIQUE_TOKEN = '{{unique}}';

/**
 * Renders a JSON value to TypeScript source. A string containing the literal
 * "{{unique}}" becomes a template literal referencing `uniqueSuffix` (a value
 * computed once, at the top of the generated test, at RUN time) instead of a
 * plain string literal - the generated *source* stays byte-identical for the
 * same spec, while each *execution* produces fresh data. Conduit enforces
 * email/username/slug uniqueness, so a fixed value would pass once and fail
 * every run after.
 */
function renderValue(value: unknown, indent: string): string {
  if (typeof value === 'string') {
    if (value.includes(UNIQUE_TOKEN)) {
      const parts = value.split(UNIQUE_TOKEN);
      const escaped = parts.map((p) => p.replace(/[`$\\]/g, '\\$&'));
      return '`' + escaped.join('${uniqueSuffix}') + '`';
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => `${indent}  ${renderValue(item, indent + '  ')},`).join('\n');
    return `[\n${items}\n${indent}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const lines = entries
      .map(([key, v]) => `${indent}  ${JSON.stringify(key)}: ${renderValue(v, indent + '  ')},`)
      .join('\n');
    return `{\n${lines}\n${indent}}`;
  }
  throw new Error(`cannot render value of type ${typeof value} into a test-case spec body`);
}

function usesUnique(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(UNIQUE_TOKEN);
  if (Array.isArray(value)) return value.some(usesUnique);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(usesUnique);
  }
  return false;
}

/** Pure, deterministic: the same spec always renders to the same source. */
export function render(spec: TestCaseSpec): string {
  const lines: string[] = [];
  lines.push("import { test, expect } from '@playwright/test';");
  lines.push("import { apiClient } from '../client/apiClient';");
  lines.push('');
  lines.push(`export const criterionId = ${JSON.stringify(spec.criterionId)};`);
  lines.push('');
  lines.push(`test(${JSON.stringify(spec.name)}, async () => {`);

  if (spec.body !== undefined && usesUnique(spec.body)) {
    lines.push('  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;');
  }
  if (spec.body !== undefined) {
    lines.push(`  const requestBody = ${renderValue(spec.body, '  ')};`);
  }

  const requestOpts = spec.body !== undefined
    ? `{ body: requestBody, auth: ${JSON.stringify(spec.auth)} }`
    : `{ auth: ${JSON.stringify(spec.auth)} }`;
  lines.push(
    `  const { status, body } = await apiClient.request(${JSON.stringify(spec.method)}, ${JSON.stringify(spec.path)}, ${requestOpts});`,
  );
  lines.push('');

  for (const assertion of spec.assertions) {
    const stepName = `assertion: ${assertion.name}`;
    lines.push(`  await test.step(${JSON.stringify(stepName)}, async () => {`);
    lines.push(`    expect(${assertion.check}).toBeTruthy();`);
    lines.push('  });');
  }

  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

export function kebabCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
