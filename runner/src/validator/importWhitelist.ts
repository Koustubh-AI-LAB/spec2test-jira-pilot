import ts from 'typescript';
import { posix } from 'node:path';

const ALLOWED_MODULES = new Set(['@playwright/test']);

/**
 * Every generated test lives at spec2test/generated/<file>.spec.ts, and the
 * only thing outside @playwright/test it may reach is spec2test/client/ -
 * checked by actually resolving the specifier (with its ".." segments
 * collapsed), not by a string-prefix guess. A prefix check alone lets
 * "../client/../../../fs" through: it starts with "client/" after stripping
 * one leading "../", but really resolves outside spec2test/ entirely once
 * the remaining ".." segments are applied - this is a real bypass that was
 * found and is fixed here, not a hypothetical one.
 */
function isAllowedRelativeImport(specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const resolved = posix.normalize(posix.join('/spec2test/generated', specifier));
  return resolved === '/spec2test/client' || resolved.startsWith('/spec2test/client/');
}

/**
 * Capabilities reachable with zero import at all - Node/browser globals a
 * generated test has no legitimate reason to touch. The import whitelist
 * alone doesn't stop `fetch(...)`, `process.env.X`, `process.exit()`,
 * `eval(...)`, or `new Function(...)`, none of which require an import
 * statement - apiClient wraps fetch internally, so a generated test that
 * calls fetch directly is bypassing the fault-injection/auth-injection seam
 * entirely, not just breaking a style rule.
 */
const FORBIDDEN_GLOBALS = new Set([
  'process',
  'fetch',
  'eval',
  'Function',
  'require',
  'global',
  'globalThis',
  'Buffer',
  '__dirname',
  '__filename',
  'XMLHttpRequest',
  'WebSocket',
]);

export interface WhitelistViolation {
  specifier: string;
  reason: string;
}

function checkModuleSpecifiers(sourceFile: ts.SourceFile): WhitelistViolation[] {
  const violations: WhitelistViolation[] = [];

  const flag = (specifier: string): void => {
    const ok = ALLOWED_MODULES.has(specifier) || isAllowedRelativeImport(specifier);
    if (!ok) {
      violations.push({
        specifier,
        reason: `"${specifier}" is not on the import whitelist (@playwright/test, or a relative import resolving under spec2test/client/)`,
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // Covers both `import ... from 'x'` and re-exports like
      // `export { readFileSync } from 'node:fs'`, which import-only checks
      // never looked at.
      flag(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      flag(node.arguments[0].text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      flag(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/** True when `node` is a name being *declared* (a binding, a property key,
 *  a member name) rather than a value being *referenced* - so declaring a
 *  local called e.g. `Buffer` isn't flagged, only using the global one. */
function isDeclarationPosition(node: ts.Identifier, parent: ts.Node): boolean {
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  return false;
}

function checkForbiddenGlobals(sourceFile: ts.SourceFile): WhitelistViolation[] {
  const violations: WhitelistViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && node.parent) {
      if (!isDeclarationPosition(node, node.parent)) {
        violations.push({
          specifier: node.text,
          reason: `"${node.text}" is a global capability with no import - reachable without ever appearing on the import whitelist, so it's blocked outright (apiClient.ts is the only place fetch/env access is legitimate)`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function checkImportWhitelist(source: string, fileName: string): WhitelistViolation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  return [...checkModuleSpecifiers(sourceFile), ...checkForbiddenGlobals(sourceFile)];
}
