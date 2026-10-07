import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, kebabCase } from '../src/generator/render.ts';
import { generate } from '../src/generator/index.ts';
import type { TestCaseSpec } from '../src/spec/types.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    assert.match(
      source,
      /const uniqueSuffix = `\$\{Date\.now\(\)\}_\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 8\)\}`;/,
    );
    assert.match(source, /`spec2test_\$\{uniqueSuffix\}`/);
    assert.doesNotMatch(source, /spec2test_\{\{unique\}\}/);
  });

  it('emits an exported criterionId literal and one named test.step per declared check', () => {
    const source = render(registerSpec);
    assert.match(source, /export const criterionId = "C-REGISTER-USER";/);
    assert.match(
      source,
      /await test\.step\("assertion: status_201", async \(\) => \{\s*\n\s*expect\(status === 201\)\.toBeTruthy\(\);\s*\n\s*\}\);/,
    );
    assert.match(
      source,
      /await test\.step\("assertion: has_token", async \(\) => \{\s*\n\s*expect\(body\.user\.token\)\.toBeTruthy\(\);\s*\n\s*\}\);/,
    );
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
    assert.match(source, /apiClient\.request\("GET", "\/api\/articles", \{ auth: "none", subject: true \}\)/);
  });
});

const chainedSpec: TestCaseSpec = {
  criterionId: 'C-AUTHOR-ONLY',
  name: 'only the author may edit an article',
  setup: [
    {
      name: 'register the author',
      method: 'POST',
      path: '/api/users',
      auth: 'none',
      body: { user: { username: 'author_{{unique}}' } },
      capture: { authorToken: ['user', 'token'] },
    },
    {
      name: 'the author creates an article',
      method: 'POST',
      path: '/api/articles',
      auth: 'user',
      authToken: '{{capture.authorToken}}',
      body: { article: { title: 'Ownership {{unique}}' } },
      capture: { slug: ['article', 'slug'] },
    },
  ],
  method: 'PUT',
  path: '/api/articles/{{capture.slug}}',
  auth: 'user',
  authToken: '{{capture.authorToken}}',
  body: { article: { title: 'hijacked' } },
  assertions: [{ name: 'non_author_is_refused', check: 'status === 403' }],
};

describe('generator: chained specs', () => {
  it('renders each setup request in its own block scope, in declaration order', () => {
    const source = render(chainedSpec);
    assert.match(source, /\/\/ setup: register the author/);
    assert.match(source, /\/\/ setup: the author creates an article/);
    assert.ok(
      source.indexOf('// setup: register the author') < source.indexOf('// setup: the author creates an article'),
      'setup steps must render in the order they are declared',
    );
    // Block scoping is what lets every step destructure status/body without
    // colliding with the subject request's own declaration.
    assert.equal(source.match(/const \{ status, body \} = await apiClient\.request/g)?.length, 3);
  });

  it('extracts each capture with optional access and asserts it was actually produced', () => {
    const source = render(chainedSpec);
    assert.match(source, /captures\["authorToken"\] = body\?\.\["user"\]\?\.\["token"\];/);
    assert.match(
      source,
      /expect\(captures\["authorToken"\], "setup step \\"register the author\\" did not produce capture \\"authorToken\\""\)\.toBeDefined\(\);/,
    );
  });

  it('fails a setup step outside any named assertion, so a broken control cannot score as a KILL', () => {
    const source = render(chainedSpec);
    const setupFailure = /expect\(status, "setup step \\"register the author\\" failed"\)\.toBeLessThan\(400\);/;
    assert.match(source, setupFailure);
    // The guard must not sit inside a test.step - Playwright attributes a
    // named step's failure to that assertion, and a broken setup is not an
    // assertion failing.
    const stepBlocks = source.slice(source.indexOf('await test.step('));
    assert.doesNotMatch(stepBlocks, setupFailure);
  });

  it('interpolates {{capture.X}} into the path and the auth token', () => {
    const source = render(chainedSpec);
    assert.match(source, /apiClient\.request\("PUT", `\/api\/articles\/\$\{captures\["slug"\]\}`/);
    assert.match(source, /authToken: `\$\{captures\["authorToken"\]\}`/);
    assert.doesNotMatch(source, /\{\{capture\./);
  });

  it('marks exactly one request as the subject - the fault-injection seam', () => {
    const source = render(chainedSpec);
    assert.equal(source.match(/subject: true/g)?.length, 1);
    // ...and it is the last request, not a setup step.
    assert.ok(source.indexOf('subject: true') > source.lastIndexOf('// setup:'));
  });

  it('renders a chained spec byte-identically twice', () => {
    assert.equal(render(chainedSpec), render(chainedSpec));
  });

  it('declares no captures object for an unchained spec', () => {
    const source = render(registerSpec);
    assert.doesNotMatch(source, /const captures/);
    assert.doesNotMatch(source, /\/\/ setup:/);
  });

  it('escapes backticks and ${ in a string that also interpolates', () => {
    const nasty: TestCaseSpec = {
      ...chainedSpec,
      body: { article: { title: 'a `backtick` and ${notASubstitution} {{capture.slug}}' } },
    };
    const source = render(nasty);
    assert.match(source, /\\`backtick\\`/);
    assert.match(source, /\\\$\{notASubstitution\}/);
    assert.match(source, /\$\{captures\["slug"\]\}/);
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

  it('re-generating the same unchanged spec into the same directory is a silent no-op, not a refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec2test-runner-'));
    try {
      generate(registerSpec, dir);
      assert.doesNotThrow(() => generate(registerSpec, dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to clobber a hand-edited file - the mechanism gate-2 approval will eventually rely on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec2test-runner-'));
    try {
      const { filePath } = generate(registerSpec, dir);
      writeFileSync(filePath, readFileSync(filePath, 'utf8') + '\n// hand-edited\n', 'utf8');

      assert.throws(() => generate(registerSpec, dir), /already exists with different content/);

      // force: true is the deliberate escape hatch.
      const forced = generate(registerSpec, dir, { force: true });
      assert.equal(readFileSync(filePath, 'utf8'), forced.source);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when two different specs kebab-case to the same filename, instead of silently overwriting one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec2test-runner-'));
    try {
      const collidingSpec: TestCaseSpec = {
        ...registerSpec,
        criterionId: 'C-SOMETHING-ELSE',
        // Same rendered filename ("register-a-new-user.spec.ts") as registerSpec,
        // different content - the case a bare filename check would miss.
        name: 'Register A New User',
        method: 'GET',
      };
      assert.equal(kebabCase(collidingSpec.name), kebabCase(registerSpec.name));

      generate(registerSpec, dir);
      assert.throws(() => generate(collidingSpec, dir), /already exists with different content/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
