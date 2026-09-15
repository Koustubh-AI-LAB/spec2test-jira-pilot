import ts from 'typescript';

const ALLOWED_MODULES = new Set(['@playwright/test']);

/** Anything not '@playwright/test' must be a relative import resolving
 *  under spec2test/client/ - never 'fs', 'child_process', 'net', 'http',
 *  'process', or anything else a generated test has no business touching. */
function isAllowedRelativeImport(specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const normalised = specifier.replace(/^\.\//, '').replace(/^\.\.\//, '');
  return normalised.startsWith('client/');
}

export interface WhitelistViolation {
  specifier: string;
  reason: string;
}

export function checkImportWhitelist(source: string, fileName: string): WhitelistViolation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2023, true);
  const violations: WhitelistViolation[] = [];

  const visit = (node: ts.Node): void => {
    let specifier: string | undefined;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    }

    if (specifier !== undefined) {
      const ok = ALLOWED_MODULES.has(specifier) || isAllowedRelativeImport(specifier);
      if (!ok) {
        violations.push({
          specifier,
          reason: `"${specifier}" is not on the import whitelist (@playwright/test, or a relative import under client/)`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}
