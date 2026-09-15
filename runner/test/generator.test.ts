import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, kebabCase } from '../src/generator/render.ts';
import { generate } from '../src/generator/index.ts';
import type { TestCaseSpec } from '../src/spec/types.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registerSpec: TestCaseSpec = {
  criterionId: 'C-REGISTER-USER',
  name: 'register a new user',
  method: 'POST',
  path: '/api/users',
  auth: 'none',
  body: {
    user: {
      username: 'spec2test_{{unique}}',
      email: 'spec2test_{{unique}}@spec2test.dev',
      password: 'Spec2Test!1',
    },
  },
  assertions: [
    { name: 'status_201', check: 'status === 201' },
    { name: 'has_token', check: 'body.user.token' },
  ],
};

describe('generator determinism', () => {
  it('renders the same spec to byte-identical source, twice', () => {
    assert.equal(render(registerSpec), render(registerSpec));
  });

  it('renders {{unique}} as a runtime-computed template literal, not a baked-in value', () => {
    const source = render(registerSpec);
    assert.match(source, /const uniqueSuffix = `\$\{Date\.now\(\)\}_\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 8\)\}`;/);
    assert.match(source, /`spec2test_\$\{uniqueSuffix\}`/);
    assert.doesNotMatch(source, /spec2test_\{\{unique\}\}/);
  });

  it('emits an exported criterionId literal and one commented assertion per declared check', () => {
    const source = render(registerSpec);
    assert.match(source, /export const criterionId = "C-REGISTER-USER";/);
    assert.match(source, /\/\/ assertion: status_201\s*\n\s*expect\(status === 201\)\.toBeTruthy\(\);/);
    assert.match(source, /\/\/ assertion: has_token\s*\n\s*expect\(body\.user\.token\)\.toBeTruthy\(\);/);
  });

  it('imports only @playwright/test and the relative client wrapper', () => {
    const source = render(registerSpec);
    assert.match(source, /^import \{ test, expect \} from '@playwright\/test';$/m);
    assert.match(source, /^import \{ apiClient \} from '\.\.\/client\/apiClient';$/m);
  });

  it('omits requestBody entirely when the spec has no body', () => {
    const noBodySpec: TestCaseSpec = {
      criterionId: 'C-GET-ARTICLES',
      name: 'list articles',
      method: 'GET',
      path: '/api/articles',
      auth: 'none',
      assertions: [{ name: 'status_200', check: 'status === 200' }],
    };
    const source = render(noBodySpec);
    assert.doesNotMatch(source, /requestBody/);
    assert.match(source, /apiClient\.request\("GET", "\/api\/articles", \{ auth: "none" \}\)/);
  });
});

describe('kebabCase', () => {
  it('turns a spec name into a filename-safe slug', () => {
    assert.equal(kebabCase('register a new user'), 'register-a-new-user');
    assert.equal(kebabCase('  Weird---Spacing!! '), 'weird-spacing');
  });
});

describe('generate()', () => {
  it('writes the rendered file to outDir and returns a stable content hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec2test-runner-'));
    try {
      const first = generate(registerSpec, dir);
      const written = readFileSync(first.filePath, 'utf8');
      assert.equal(written, first.source);
      assert.equal(first.fileName, 'register-a-new-user.spec.ts');

      // Re-generating the identical spec into a fresh directory must produce
      // the identical hash - determinism is the whole point.
      const dir2 = mkdtempSync(join(tmpdir(), 'spec2test-runner-'));
      try {
        const second = generate(registerSpec, dir2);
        assert.equal(first.contentHash, second.contentHash);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
