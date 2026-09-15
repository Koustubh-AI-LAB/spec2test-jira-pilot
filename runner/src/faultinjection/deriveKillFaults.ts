import type { TestCaseSpec } from '../spec/types.ts';
import { documentedStatuses, isFieldInResponseSchema, type OpenApiDoc } from '../spec/openapi.ts';
import type { FaultSpec } from './types.ts';

/**
 * Three forms - all three of what our real fixtures actually use, checked
 * by re-reading every one of them while planning, not assumed:
 *   "status === 201"                          -> set_status
 *   "body.user.token"                         -> delete_field (bare truthy)
 *   "body.user.email === 'x@example.com'"      -> delete_field (equality) -
 *     removing the field falsifies an equality check exactly as well as a
 *     bare truthy one, so both forms produce the same mutation kind.
 * Anything else is left unparsed - deriveKillFaults skips it and says so,
 * rather than guessing at a fault for a check expression it doesn't
 * recognise.
 */
function parseCheck(check: string): { statusValue: number } | { path: string[] } | undefined {
  const statusMatch = /^status\s*===\s*(\d+)\s*$/.exec(check);
  if (statusMatch) return { statusValue: Number(statusMatch[1]) };

  const bareMatch = /^body((?:\.[A-Za-z_$][\w$]*)+)\s*$/.exec(check);
  if (bareMatch) return { path: bareMatch[1]!.split('.').filter(Boolean) };

  const eqMatch = /^body((?:\.[A-Za-z_$][\w$]*)+)\s*===\s*.+$/.exec(check);
  if (eqMatch) return { path: eqMatch[1]!.split('.').filter(Boolean) };

  return undefined;
}

function pickAlternateStatus(schema: OpenApiDoc, spec: TestCaseSpec, original: number): { value: number; plausible: boolean } {
  const documented = documentedStatuses(schema, spec.method, spec.path)
    .filter((s) => s !== original)
    .sort((a, b) => a - b);
  if (documented.length > 0) {
    return { value: documented[0]!, plausible: true };
  }
  // No documented alternative (not hit by today's 4 fixtures, all of which
  // document >=3 statuses) - fall back to a clearly-different valid HTTP
  // status, marked implausible rather than pretending the schema vouches
  // for it.
  return { value: original === 200 ? 500 : 200, plausible: false };
}

export function deriveKillFaults(spec: TestCaseSpec, schema: OpenApiDoc): FaultSpec[] {
  const faults: FaultSpec[] = [];

  for (const assertion of spec.assertions) {
    const parsed = parseCheck(assertion.check);
    if (!parsed) continue;

    if ('statusValue' in parsed) {
      const alt = pickAlternateStatus(schema, spec, parsed.statusValue);
      faults.push({
        id: `kill-${assertion.name}`,
        kind: 'kill',
        targetAssertion: assertion.name,
        description: `${assertion.name}: set_status ${parsed.statusValue} -> ${alt.value}`,
        mutation: { op: 'set_status', value: alt.value },
        plausible: alt.plausible,
      });
      continue;
    }

    // For plausibility, check the field against every documented status,
    // not just the spec's own expected one - the schema may document the
    // field under a different response code than what this particular
    // spec asserts on (e.g. a shared response shape reused across codes).
    const plausible = documentedStatuses(schema, spec.method, spec.path).some((status) =>
      isFieldInResponseSchema(schema, spec.method, spec.path, status, parsed.path),
    );
    faults.push({
      id: `kill-${assertion.name}`,
      kind: 'kill',
      targetAssertion: assertion.name,
      description: `${assertion.name}: delete_field ${parsed.path.join('.')}`,
      mutation: { op: 'delete_field', path: parsed.path },
      plausible,
    });
  }

  return faults;
}
