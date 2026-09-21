import ts from 'typescript';
import type { TestCaseSpec } from '../spec/types.ts';

export interface AstCheckFailure {
  rule: string;
  message: string;
}

/**
 * Three checks, all load-bearing for the certification story later: the file
 * must declare the criterionId it claims to test, every assertion the spec
 * declared must actually appear in the output - a generator bug (or a
 * hand-edit) that silently drops an assertion is exactly what this catches -
 * and exactly one request must be marked as the subject.
 */
export function checkAst(source: string, fileName: string, spec: TestCaseSpec): AstCheckFailure[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2023, true);
  const failures: AstCheckFailure[] = [];

  let declaredCriterionId: string | undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === 'criterionId' && decl.initializer && ts.isStringLiteral(decl.initializer)) {
        declaredCriterionId = decl.initializer.text;
      }
    }
  }

  if (declaredCriterionId === undefined) {
    failures.push({ rule: 'criterion_id_present', message: 'no `export const criterionId = "..."` declaration found' });
  } else if (declaredCriterionId !== spec.criterionId) {
    failures.push({
      rule: 'criterion_id_present',
      message: `criterionId is "${declaredCriterionId}", expected "${spec.criterionId}"`,
    });
  }

  // Every assertion is a `test.step('assertion: <name>', async () => {...})`
  // call - the step's own name string is the single source of truth for
  // "which assertion is this" (readable statically here, and reportable at
  // runtime by Playwright's own JSON reporter - the mechanism step 4's
  // fault-injection attribution depends on). A leading comment was step 3's
  // original design; it couldn't carry runtime attribution, so it's gone.
  const declaredNames = new Set<string>();
  const visitForAssertions = (node: ts.Node): void => {
    const step = matchTestStepCall(node);
    if (step) {
      const match = /^assertion:\s*(.+)$/.exec(step.title);
      if (match) {
        const name = match[1]!.trim();
        declaredNames.add(name);
        if (!callbackCallsExpect(step.callback)) {
          failures.push({
            rule: 'assertion_present',
            message: `test.step("${step.title}", ...) has no expect(...) call in its callback`,
          });
        }
      }
    }
    ts.forEachChild(node, visitForAssertions);
  };
  visitForAssertions(sourceFile);

  for (const assertion of spec.assertions) {
    if (!declaredNames.has(assertion.name)) {
      failures.push({
        rule: 'assertion_present',
        message: `spec declares assertion "${assertion.name}" but no matching test.step("assertion: ${assertion.name}", ...) was found in the generated file`,
      });
    }
  }

  const subjectCount = countSubjectRequests(sourceFile);
  if (subjectCount !== 1) {
    failures.push({
      rule: 'subject_request_marked',
      message:
        subjectCount === 0
          ? 'no apiClient.request(...) call is marked `subject: true` - the fault transport only mutates the subject request, so every falsification attempt would run against an unmutated response and score INCONCLUSIVE rather than KILL'
          : `${subjectCount} apiClient.request(...) calls are marked \`subject: true\` - exactly one must be, or which request a fault targets is ambiguous`,
    });
  }

  return failures;
}

/**
 * Counts `apiClient.request(m, p, { ..., subject: true })` calls.
 *
 * This is the fault-injection seam made statically checkable. A chained test
 * makes several requests and only the subject is ever faulted or sampled; if a
 * generator change dropped the flag, nothing at runtime would complain - the
 * suite would stay green while falsification quietly stopped proving anything.
 * That is the same false-negative shape as a mutation that never fires, which
 * this project already decided must never pass silently.
 */
function countSubjectRequests(sourceFile: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isApiClientRequest(node.expression)) {
      const opts = node.arguments[2];
      if (opts && ts.isObjectLiteralExpression(opts) && hasSubjectTrue(opts)) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function isApiClientRequest(callee: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'apiClient' &&
    callee.name.text === 'request'
  );
}

function hasSubjectTrue(opts: ts.ObjectLiteralExpression): boolean {
  return opts.properties.some(
    (prop) =>
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      prop.name.text === 'subject' &&
      prop.initializer.kind === ts.SyntaxKind.TrueKeyword,
  );
}

/** Matches `test.step('<title>', <callback>)` (with or without a leading
 *  `await`) and returns the title text and the callback body, or undefined
 *  if `node` isn't that shape. */
function matchTestStepCall(node: ts.Node): { title: string; callback: ts.Node } | undefined {
  const expr = ts.isExpressionStatement(node)
    ? (ts.isAwaitExpression(node.expression) ? node.expression.expression : node.expression)
    : undefined;
  if (!expr || !ts.isCallExpression(expr)) return undefined;

  const callee = expr.expression;
  const isTestStep =
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'test' &&
    callee.name.text === 'step';
  if (!isTestStep) return undefined;

  const [titleArg, callbackArg] = expr.arguments;
  if (!titleArg || !ts.isStringLiteral(titleArg) || !callbackArg) return undefined;
  return { title: titleArg.text, callback: callbackArg };
}

/** True if an expect(...).method(...) call appears anywhere inside `node`. */
function callbackCallsExpect(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isCallExpression(n.expression.expression) &&
      ts.isIdentifier(n.expression.expression.expression) &&
      n.expression.expression.expression.text === 'expect'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}
