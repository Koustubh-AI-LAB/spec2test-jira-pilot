import type { RequestStep, TestCaseSpec } from '../spec/types.ts';

const UNIQUE_TOKEN = '{{unique}}';
const CAPTURE_PATTERN = /\{\{capture\.([A-Za-z0-9_]+)\}\}/g;

/** Escapes the literal parts of a template literal - everything that would
 *  otherwise start a substitution or end the literal. */
function escapeTemplate(value: string): string {
  return value.replace(/[`$\\]/g, '\\$&');
}

/**
 * Renders a string to TypeScript source, turning interpolation tokens into
 * template-literal substitutions:
 *   {{unique}}       -> ${uniqueSuffix}, a value computed once at RUN time,
 *                       so the generated source stays byte-identical for the
 *                       same spec while each execution produces fresh data
 *                       (Conduit enforces email/username/slug uniqueness).
 *   {{capture.NAME}} -> ${captures["NAME"]}, a value pulled out of an earlier
 *                       setup step's response.
 * A string with no tokens renders as a plain quoted literal, so unchained
 * specs generate exactly what they did before.
 */
function renderString(value: string): string {
  const hasUnique = value.includes(UNIQUE_TOKEN);
  CAPTURE_PATTERN.lastIndex = 0;
  const hasCapture = CAPTURE_PATTERN.test(value);
  if (!hasUnique && !hasCapture) return JSON.stringify(value);

  let out = '';
  let index = 0;
  const tokens = [...value.matchAll(/\{\{unique\}\}|\{\{capture\.([A-Za-z0-9_]+)\}\}/g)];
  for (const match of tokens) {
    out += escapeTemplate(value.slice(index, match.index));
    out += match[1] === undefined ? '${uniqueSuffix}' : `\${captures[${JSON.stringify(match[1])}]}`;
    index = match.index + match[0].length;
  }
  out += escapeTemplate(value.slice(index));
  return '`' + out + '`';
}

function renderValue(value: unknown, indent: string): string {
  if (typeof value === 'string') return renderString(value);
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

function containsToken(value: unknown, token: string): boolean {
  if (typeof value === 'string') return value.includes(token);
  if (Array.isArray(value)) return value.some((v) => containsToken(v, token));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => containsToken(v, token));
  }
  return false;
}

/** Every string a request can interpolate into: path, authToken, and body. */
function interpolatableParts(step: RequestStep | TestCaseSpec): unknown[] {
  return [step.path, step.authToken, step.body];
}

function usesUnique(spec: TestCaseSpec): boolean {
  const all = [...(spec.setup ?? []), spec].flatMap(interpolatableParts);
  return all.some((part) => containsToken(part, UNIQUE_TOKEN));
}

function declaresCaptures(spec: TestCaseSpec): boolean {
  return (spec.setup ?? []).some((step) => Object.keys(step.capture ?? {}).length > 0);
}

/** `body?.["user"]?.["token"]` - optional at every hop so a missing branch
 *  yields undefined rather than throwing, which the explicit toBeDefined
 *  check below then reports against the step that should have produced it. */
function captureAccessor(segments: string[]): string {
  return `body${segments.map((segment) => `?.[${JSON.stringify(segment)}]`).join('')}`;
}

function renderRequestOptions(step: RequestStep | TestCaseSpec, hasBody: boolean, subject: boolean): string {
  const parts: string[] = [];
  if (hasBody) parts.push('body: requestBody');
  parts.push(`auth: ${JSON.stringify(step.auth)}`);
  if (step.authToken !== undefined) parts.push(`authToken: ${renderString(step.authToken)}`);
  if (subject) parts.push('subject: true');
  return `{ ${parts.join(', ')} }`;
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

  if (usesUnique(spec)) {
    lines.push('  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;');
  }
  if (declaresCaptures(spec)) {
    lines.push('  const captures: Record<string, any> = {};');
  }

  // Setup requests run in their own block scope so each can destructure
  // `status`/`body` without colliding with the subject request's.
  for (const step of spec.setup ?? []) {
    lines.push('');
    lines.push(`  // setup: ${step.name}`);
    lines.push('  {');
    const hasBody = step.body !== undefined;
    if (hasBody) lines.push(`    const requestBody = ${renderValue(step.body, '    ')};`);
    lines.push(
      `    const { status, body } = await apiClient.request(${JSON.stringify(step.method)}, ${renderString(step.path)}, ${renderRequestOptions(step, hasBody, false)});`,
    );
    // Outside any test.step on purpose: a broken setup is a broken control,
    // and must score INCONCLUSIVE rather than being attributed to an
    // assertion that never got the chance to run.
    lines.push(
      `    expect(status, ${JSON.stringify(`setup step "${step.name}" failed`)}).toBeLessThan(400);`,
    );
    for (const [name, segments] of Object.entries(step.capture ?? {})) {
      lines.push(`    captures[${JSON.stringify(name)}] = ${captureAccessor(segments)};`);
      lines.push(
        `    expect(captures[${JSON.stringify(name)}], ${JSON.stringify(`setup step "${step.name}" did not produce capture "${name}"`)}).toBeDefined();`,
      );
    }
    lines.push('  }');
  }

  if (spec.setup?.length) lines.push('');

  const hasBody = spec.body !== undefined;
  if (hasBody) lines.push(`  const requestBody = ${renderValue(spec.body, '  ')};`);
  lines.push(
    `  const { status, body } = await apiClient.request(${JSON.stringify(spec.method)}, ${renderString(spec.path)}, ${renderRequestOptions(spec, hasBody, true)});`,
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
