import { RunnerError } from '../errors.ts';
import type { TestCaseSpec } from './types.ts';
import { isGrounded, type OpenApiDoc } from './openapi.ts';

/**
 * Grounding check, before a single line of code is generated: a test cannot
 * be drafted for an endpoint the schema doesn't document. Same principle as
 * TestForge's validate_actions_against_catalog, ported as an idea, not code.
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
}
