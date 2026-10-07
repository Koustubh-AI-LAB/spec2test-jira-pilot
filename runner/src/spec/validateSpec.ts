import { RunnerError } from '../errors.ts';
import type { RequestStep, TestCaseSpec } from './types.ts';
import { isGrounded, missingRequiredBodyFields, type OpenApiDoc } from './openapi.ts';

const CAPTURE_REF = /\{\{capture\.([A-Za-z0-9_]+)\}\}/g;

/**
 * Grounding check, before a single line of code is generated: a test cannot
 * be drafted for an endpoint the schema doesn't document.
 *
 * Grounding has two parts, not one: the route has to exist (isGrounded), and
 * the spec's body has to actually carry what that route's schema requires
 * (missingRequiredBodyFields) - route existence alone doesn't catch a spec
 * sending the wrong shape to a real endpoint. This is a presence check on
 * `required` fields, not full JSON-schema validation (types/formats/enums) -
 * proving grounding means more than "the route exists" without pulling in a
 * schema validator for a pilot's handful of fixtures.
 *
 * Every request in the chain is checked, not just the subject: a setup step
 * that invents a route is exactly as wrong as a subject that does, and it
 * fails later and more confusingly (as a live 404 mid-chain) if left to the
 * smoke run to find.
 */
export function validateSpec(spec: TestCaseSpec, schema: OpenApiDoc): void {
  if (!spec.criterionId.trim()) {
    throw new RunnerError('spec_missing_criterion_id', 'a test-case spec must declare criterionId');
  }
  if (spec.assertions.length === 0) {
    throw new RunnerError('spec_missing_assertions', `${spec.name}: a test case must declare at least one assertion`);
  }

  // Templating is applied to path/authToken/body only. A `{{...}}` inside an
  // assertion `check` is compared as a literal string at run time - found the
  // hard way when a drafted `body.article.slug === '{{capture.slug}}'` failed
  // its own smoke run against a perfectly correct response.
  for (const assertion of spec.assertions) {
    if (assertion.check.includes('{{')) {
      throw new RunnerError(
        'spec_template_in_check',
        `${spec.name}: assertion "${assertion.name}" uses a {{...}} placeholder inside its check - ` +
          `placeholders are only substituted in path, authToken and body, never in a check, so it ` +
          `would be compared as the literal text. Assert on a value that does not depend on a ` +
          `placeholder (e.g. \`body.article.slug\` bare-truthy, or a fixed literal).`,
      );
    }
  }

  // Walked in order so a capture must be declared by an EARLIER step than the
  // one referencing it - a forward reference would render `undefined` into a
  // URL and fail as a puzzling 404 rather than as the typo it is.
  const declared = new Set<string>();
  (spec.setup ?? []).forEach((step, index) => {
    const label = `setup step ${index + 1} ("${step.name}")`;
    checkRequest(label, step, schema, declared);
    for (const name of Object.keys(step.capture ?? {})) {
      if (declared.has(name)) {
        throw new RunnerError(
          'spec_duplicate_capture',
          `${label}: re-declares capture "${name}", which an earlier setup step already captured - ` +
            `the later value would silently shadow the earlier one`,
        );
      }
      declared.add(name);
    }
  });

  checkRequest('the subject request', spec, schema, declared);
}

function checkRequest(
  label: string,
  request: RequestStep | TestCaseSpec,
  schema: OpenApiDoc,
  declared: Set<string>,
): void {
  if (request.authToken !== undefined && request.auth !== 'user') {
    throw new RunnerError(
      'spec_auth_token_without_user',
      `${label}: authToken is set but auth is "${request.auth}" - apiClient only sends an ` +
        `Authorization header when auth is "user", so the token would be silently ignored and ` +
        `the request would run unauthenticated`,
    );
  }

  // The replay stage matches recorded responses by method+path. `{{unique}}`
  // is fresh on every run, so a path containing it can never match the
  // transcript the capture run recorded - the test then fails at replay for a
  // reason that has nothing to do with the target. (`{{capture.x}}` is fine:
  // replay serves the recorded response, so the captured value is stable.)
  if (request.path.includes('{{unique}}')) {
    throw new RunnerError(
      'spec_unique_in_path',
      `${label}: path contains {{unique}}, which changes every run and can never match the ` +
        `recorded replay transcript. Use {{unique}} only in body/authToken; for a "does not exist" ` +
        `path use a fixed literal that cannot exist (e.g. /articles/no-such-article-slug).`,
    );
  }

  for (const name of captureRefs(request)) {
    if (!declared.has(name)) {
      throw new RunnerError(
        'spec_unknown_capture',
        `${label}: references {{capture.${name}}}, which no earlier setup step captures` +
          (declared.size > 0
            ? ` (available at this point: ${[...declared].join(', ')})`
            : ' (no captures are declared before it)'),
      );
    }
  }

  if (!isGrounded(schema, request.method, request.path)) {
    throw new RunnerError(
      'spec_not_grounded',
      `${label}: ${request.method} ${request.path} is not documented in the OpenAPI schema - ` +
        `cannot generate a test for an endpoint the schema doesn't list`,
    );
  }

  const missing = missingRequiredBodyFields(schema, request.method, request.path, request.body);
  if (missing.length > 0) {
    throw new RunnerError(
      'spec_body_missing_required_fields',
      `${label}: ${request.method} ${request.path} requires ${missing.join(', ')}, ` +
        `which this spec's body does not provide`,
    );
  }
}

/**
 * Every `{{capture.NAME}}` a request can interpolate: its path, its authToken,
 * and any string nested anywhere in its body.
 *
 * Note the interpolated value lands in a single path segment. `isGrounded`,
 * `documentedStatuses` and `isFieldInResponseSchema` all match the raw,
 * un-interpolated path against the schema's template, which works only because
 * `pathToRegExp` maps `{slug}` to `[^/]+` and a `{{capture.x}}` token contains
 * no "/". A capture whose value spanned a slash would stop matching its
 * template and every derived fault would silently be labelled implausible.
 */
function captureRefs(request: RequestStep | TestCaseSpec): string[] {
  const found: string[] = [];
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(CAPTURE_REF)) found.push(match[1]!);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    if (value !== null && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(scan);
    }
  };
  scan(request.path);
  scan(request.authToken);
  scan(request.body);
  return found;
}
