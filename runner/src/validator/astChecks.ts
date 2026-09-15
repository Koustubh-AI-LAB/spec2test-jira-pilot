import ts from 'typescript';
import type { TestCaseSpec } from '../spec/types.ts';

export interface AstCheckFailure {
  rule: string;
  message: string;
}

/**
 * Two checks, both load-bearing for the certification story later: the file
 * must declare the criterionId it claims to test, and every assertion the
 * spec declared must actually appear in the output - a generator bug (or a
 * hand-edit) that silently drops an assertion is exactly what this catches.
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

  // Every "// assertion: <name>" leading comment must be immediately
  // followed, in the same statement, by an expect(...) call. Walks every
  // ExpressionStatement anywhere in the tree - assertions live nested inside
  // the test()'s arrow-function body, not at the top level of the file.
  const declaredNames = new Set<string>();
  const fullText = sourceFile.getFullText();
  const visitForAssertions = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) {
      const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) ?? [];
      for (const range of ranges) {
        const commentText = fullText.slice(range.pos, range.end);
        const match = /\/\/\s*assertion:\s*(.+)/.exec(commentText);
        if (!match) continue;
        const name = match[1]!.trim();
        declaredNames.add(name);
        if (!statementCallsExpect(node)) {
          failures.push({
            rule: 'assertion_present',
            message: `assertion "${name}" has a comment but no expect(...) call follows it`,
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
        message: `spec declares assertion "${assertion.name}" but no matching "// assertion: ${assertion.name}" comment was found in the generated file`,
      });
    }
  }

  return failures;
}

function statementCallsExpect(node: ts.Node): boolean {
  if (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression)
  ) {
    const callee = node.expression.expression;
    // expect(x).toBeTruthy() -> callee is a PropertyAccessExpression whose
    // expression is a CallExpression to `expect`.
    if (ts.isPropertyAccessExpression(callee) && ts.isCallExpression(callee.expression)) {
      const inner = callee.expression.expression;
      return ts.isIdentifier(inner) && inner.text === 'expect';
    }
  }
  return false;
}
