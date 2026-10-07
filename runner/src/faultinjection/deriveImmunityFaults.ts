import type { TestCaseSpec } from '../spec/types.ts';
import { documentedStatuses, isFieldInResponseSchema, type OpenApiDoc } from '../spec/openapi.ts';
import type { FaultSpec } from './types.ts';

const MAX_IMMUNITY_FAULTS = 2;

/** Every leaf path (arrays included, indexed by position) in `value`. */
function leafPaths(value: unknown, prefix: string[] = []): string[][] {
  if (value === null || typeof value !== 'object') {
    return prefix.length > 0 ? [prefix] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => leafPaths(item, [...prefix, String(i)]));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => leafPaths(v, [...prefix, key]));
}

/**
 * A candidate path is "referenced" only if the FULL accessor
 * "body.<path>" appears in some assertion's check string - not if the bare
 * leaf name does. Every check string starts with the destructured variable
 * "body", so a bare-leaf-name match would always hit and silently exclude
 * every real candidate whose name happens to be a common word (e.g.
 * article.body itself, since "body" is a substring of "body.article.slug").
 */
function isReferenced(path: string[], spec: TestCaseSpec): boolean {
  const accessor = `body.${path.join('.')}`;
  return spec.assertions.some((a) => a.check.includes(accessor));
}

/**
 * (spec, sampledResponseBody) -> up to MAX_IMMUNITY_FAULTS FaultSpecs, one
 * delete_field per genuinely-unreferenced leaf path. The cap bounds live-run
 * cost: each fault costs 7 live runs (see runFalsification), and an
 * uncapped scan of a typical Conduit response (5-6 leaf fields, usually only
 * 1 referenced) would produce far more faults than a pilot should be paying
 * for per criterion.
 */
export function deriveImmunityFaults(
  spec: TestCaseSpec,
  sampledStatus: number,
  sampledBody: unknown,
  schema: OpenApiDoc,
): FaultSpec[] {
  const candidates = leafPaths(sampledBody).filter((path) => !isReferenced(path, spec));
  const documented = documentedStatuses(schema, spec.method, spec.path);

  return candidates.slice(0, MAX_IMMUNITY_FAULTS).map((path) => {
    const plausible =
      isFieldInResponseSchema(schema, spec.method, spec.path, sampledStatus, path) ||
      documented.some((status) => isFieldInResponseSchema(schema, spec.method, spec.path, status, path));
    return {
      id: `immunity-${path.join('.')}`,
      kind: 'immunity',
      description: `delete_field ${path.join('.')} (unreferenced by any assertion)`,
      mutation: { op: 'delete_field', path },
      plausible,
    };
  });
}
