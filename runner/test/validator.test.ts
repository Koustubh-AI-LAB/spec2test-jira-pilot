import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkImportWhitelist } from '../src/validator/importWhitelist.ts';
import { checkAst } from '../src/validator/astChecks.ts';
import { typecheckFile } from '../src/validator/typecheck.ts';
import { initTargetRepo } from '../src/init.ts';
import { generate } from '../src/generator/index.ts';
import type { TestCaseSpec } from '../src/spec/types.ts';

const wellFormedSpec: TestCaseSpec = {
  criterionId: 'C-REGISTER-USER',
  name: 'register a new user',
  method: 'POST',
  path: '/api/users',
  auth: 'none',
  body: { user: { email: 'spec2test_{{unique}}@spec2test.dev', password: 'x' } },
  assertions: [
    { name: 'status_201', check: 'status === 201' },
    { name: 'has_token', check: 'body.user.token' },
  ],
};

/**
 * Scratch dirs live under runner/.tmp-test/, not the OS tmpdir -
 * @playwright/test must resolve via a real node_modules tree, which a
 * disconnected system tmp directory doesn't have.
 */
const TMP_TEST_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.tmp-test');

function freshTargetDir(): string {
  mkdirSync(TMP_TEST_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_TEST_ROOT, 'target-'));
}

describe('import whitelist', () => {
  it('rejects a generated test that imports node:fs', () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "import { readFileSync } from 'node:fs';",
      "import { apiClient } from '../client/apiClient';",
      "export const criterionId = 'C-X';",
      "test('x', async () => { readFileSync('/etc/passwd'); });",
      '',
    ].join('\n');
    const violations = checkImportWhitelist(source, 'x.spec.ts');
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.reason, /node:fs/);
  });

  it('rejects child_process even via a dynamic import() call', () => {
    const source = "const cp = await import('node:child_process');\n";
    const violations = checkImportWhitelist(source, 'x.spec.ts');
    assert.equal(violations.length, 1);
  });

  it('allows @playwright/test and a relative import under client/', () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "import { apiClient } from '../client/apiClient';",
      '',
    ].join('\n');
    assert.deepEqual(checkImportWhitelist(source, 'x.spec.ts'), []);
  });
});

describe('AST checks', () => {
  it('rejects a file with no criterionId declaration', () => {
    const source = "test('x', async () => {\n  expect(1).toBeTruthy();\n});\n";
    const failures = checkAst(source, 'x.spec.ts', wellFormedSpec);
    assert.ok(failures.some((f) => f.rule === 'criterion_id_present'));
  });

  it('rejects a file whose criterionId does not match the spec', () => {
    const source = "export const criterionId = 'WRONG-ID';\ntest('x', async () => {});\n";
    const failures = checkAst(source, 'x.spec.ts', wellFormedSpec);
    assert.ok(failures.some((f) => f.rule === 'criterion_id_present' && /WRONG-ID/.test(f.message)));
  });

  it('rejects a file that silently drops a declared assertion', () => {
    const source = [
      "export const criterionId = 'C-REGISTER-USER';",
      "test('x', async () => {",
      '  const { status } = await apiClient.request();',
      '  // assertion: status_201',
      '  expect(status === 201).toBeTruthy();',
      '  // has_token is declared in the spec but never checked here',
      '});',
      '',
    ].join('\n');
    const failures = checkAst(source, 'x.spec.ts', wellFormedSpec);
    assert.ok(failures.some((f) => f.rule === 'assertion_present' && /has_token/.test(f.message)));
  });

  it('accepts a well-formed generated file', () => {
    const { source } = generate(wellFormedSpec, freshTargetDir());
    assert.deepEqual(checkAst(source, 'x.spec.ts', wellFormedSpec), []);
  });
});

describe('typecheck', () => {
  it('a well-formed generated file, scaffolded into a real target dir, typechecks clean', () => {
    const targetRoot = freshTargetDir();
    try {
      initTargetRepo(targetRoot);
      const generatedDir = join(targetRoot, 'spec2test', 'generated');
      const { filePath } = generate(wellFormedSpec, generatedDir);

      const diagnostics = typecheckFile(filePath, join(targetRoot, 'spec2test'));
      assert.deepEqual(diagnostics, []);
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it('a file with a malformed assertion expression fails typecheck instead of throwing at runtime', () => {
    const targetRoot = freshTargetDir();
    try {
      initTargetRepo(targetRoot);
      const generatedDir = join(targetRoot, 'spec2test', 'generated');
      const brokenSpec: TestCaseSpec = {
        ...wellFormedSpec,
        assertions: [{ name: 'bad', check: 'status === ' }], // syntactically invalid expression
      };
      const { filePath } = generate(brokenSpec, generatedDir);

      const diagnostics = typecheckFile(filePath, join(targetRoot, 'spec2test'));
      assert.ok(diagnostics.length > 0);
    } finally {
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });
});
