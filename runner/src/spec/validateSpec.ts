import { RunnerError } from '../errors.ts';
import type { TestCaseSpec } from './types.ts';
import { isGrounded, missingRequiredBodyFields, type OpenApiDoc } from './openapi.ts';

/**
 * Grounding check, before a single line of code is generated: a test cannot
 * be drafted for an endpoint the schema doesn't document. Same principle as
 * TestForge's validate_actions_against_catalog, ported as an idea, not code.
 *
 * Grounding has two parts, not one: the route has to exist (isGrounded), and
 * the spec's body has to actually carry what that route's schema requires
 * (missingRequiredBodyFields) - route existence alone doesn't catch a spec
 * sending the wrong shape to a real endpoint. This is a presence check on
 * `required` fields, not full JSON-schema validation (types/formats/enums) -
 * proving grounding means more than "the route exists" without pulling in a
 * schema validator for a pilot's handful of fixtures.
 */
export function validateSpec(spec: TestCaseSpec, schema: OpenApiDoc): void {
  if (!spec.criterionId.trim()) {
    throw new RunnerError('spec_missing_criterion_id', 'a test-case spec must declare criterionId');
  }
  if (spec.assertions.length === 0) {
    throw new RunnerError('spec_missing_assertions', `${spec.name}: a test case must declare at least one assertion`);
  }
  if (!isGrounded(schema, spec.method, spec.path)) {
    throw new RunnerError(
      'spec_not_grounded',
      `${spec.method} ${spec.path} is not documented in the OpenAPI schema - cannot generate a test for an endpoint the schema doesn't list`,
    );
  }

  const missing = missingRequiredBodyFields(schema, spec.method, spec.path, spec.body);
  if (missing.length > 0) {
    throw new RunnerError(
      'spec_body_missing_required_fields',
      `${spec.method} ${spec.path} requires ${missing.join(', ')}, which this spec's body does not provide`,
    );
  }
}
