/**
 * Zero coverage existed for spec/openapi.ts and spec/validateSpec.ts before
 * this file - the live e2e test only ever calls validateSpec() with specs
 * that are already grounded, so "Claude cannot invent a route" (the master
 * plan's own words for what this mechanism exists to guarantee) was trusted
 * by inspection, never actually proven by a test that gives it a bad spec.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenApiSchema, isGrounded, missingRequiredBodyFields } from '../src/spec/openapi.ts';
import { validateSpec } from '../src/spec/validateSpec.ts';
import { parseCheck, unparseableAssertionHints } from '../src/faultinjection/deriveKillFaults.ts';
import { RunnerError } from '../src/errors.ts';
import type { TestCaseSpec } from '../src/spec/types.ts';

const SCHEMA_PATH = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'fixtures',
  'openapi',
  'conduit.snapshot.yml',
);
const schema = loadOpenApiSchema(SCHEMA_PATH);

const grounded: TestCaseSpec = {
  criterionId: 'C-REGISTER-USER',
  name: 'register a new user',
  method: 'POST',
  path: '/api/users',
  auth: 'none',
  body: { user: { email: 'x@example.com', password: 'x', username: 'x' } },
  assertions: [{ name: 'status_201', check: 'status === 201' }],
};

describe('loadOpenApiSchema', () => {
  it('extracts the server base path from the schema servers[0].url', () => {
    assert.equal(schema.serverBasePath, '/api');
  });

  it('records a stable content hash of the schema file', () => {
    assert.match(schema.hash, /^[0-9a-f]{64}$/);
    assert.equal(schema.hash, loadOpenApiSchema(SCHEMA_PATH).hash);
  });

  it('lists the endpoints this pilot actually depends on', () => {
    assert.ok(schema.paths['/users']?.includes('POST'), 'schema is missing POST /users (-> /api/users)');
    assert.ok(schema.paths['/users/login']?.includes('POST'), 'schema is missing POST /users/login');
    assert.ok(schema.paths['/articles']?.includes('POST'), 'schema is missing POST /articles');
  });
});

describe('isGrounded', () => {
  it('is true for a real, documented endpoint, full request path (with /api) included', () => {
    assert.equal(isGrounded(schema, 'POST', '/api/users'), true);
    assert.equal(isGrounded(schema, 'POST', '/api/users/login'), true);
    assert.equal(isGrounded(schema, 'POST', '/api/articles'), true);
  });

  it('is false for a route the schema does not document at all', () => {
    assert.equal(isGrounded(schema, 'POST', '/api/nonexistent-endpoint'), false);
  });

  it('is false for a real route with the wrong HTTP method', () => {
    // /api/articles exists for POST, not for DELETE at the collection level.
    assert.equal(isGrounded(schema, 'DELETE', '/api/articles'), false);
  });

  it('matches a templated path parameter, e.g. /api/articles/{slug}', () => {
    assert.equal(isGrounded(schema, 'GET', '/api/articles/some-real-slug'), true);
  });
});

describe('missingRequiredBodyFields', () => {
  it('is empty for a body that satisfies every required field, including nested ones', () => {
    const missing = missingRequiredBodyFields(schema, 'POST', '/api/users', {
      user: { email: 'x@example.com', password: 'x', username: 'x' },
    });
    assert.deepEqual(missing, []);
  });

  it('reports a nested required field by its dotted path', () => {
    const missing = missingRequiredBodyFields(schema, 'POST', '/api/users', {
      user: { email: 'x@example.com', password: 'x' }, // username missing
    });
    assert.deepEqual(missing, ['user.username']);
  });

  it('reports the top-level wrapper key itself when it is missing entirely', () => {
    const missing = missingRequiredBodyFields(schema, 'POST', '/api/users', {});
    assert.deepEqual(missing, ['user']);
  });

  it('is empty for an endpoint with no documented requestBody (nothing to check)', () => {
    const missing = missingRequiredBodyFields(schema, 'GET', '/api/articles/some-slug', undefined);
    assert.deepEqual(missing, []);
  });
});

describe('validateSpec', () => {
  it('accepts a well-formed, grounded spec without throwing', () => {
    assert.doesNotThrow(() => validateSpec(grounded, schema));
  });

  it('rejects a spec for a route the schema does not document - the actual grounding guarantee', () => {
    const ungrounded: TestCaseSpec = { ...grounded, path: '/api/definitely-not-a-real-endpoint' };
    assert.throws(() => validateSpec(ungrounded, schema), (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      assert.equal(err.event, 'spec_not_grounded');
      return true;
    });
  });

  it('rejects a spec whose body is missing a field the endpoint requires - grounding covers shape, not just the route', () => {
    const incomplete: TestCaseSpec = {
      ...grounded,
      body: { user: { email: 'x@example.com', password: 'x' } }, // username missing
    };
    assert.throws(() => validateSpec(incomplete, schema), (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      assert.equal(err.event, 'spec_body_missing_required_fields');
      assert.match(err.message, /user\.username/);
      return true;
    });
  });

  it('grounds every setup step, not just the subject', () => {
    const badSetup: TestCaseSpec = {
      ...grounded,
      setup: [
        {
          name: 'invent a route',
          method: 'POST',
          path: '/api/definitely-not-a-real-endpoint',
          auth: 'none',
        },
      ],
    };
    assert.throws(() => validateSpec(badSetup, schema), (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      assert.equal(err.event, 'spec_not_grounded');
      assert.match(err.message, /setup step 1 \("invent a route"\)/);
      return true;
    });
  });

  it('rejects a reference to a capture no setup step produces', () => {
    const typo: TestCaseSpec = {
      ...grounded,
      setup: [
        {
          name: 'register',
          method: 'POST',
          path: '/api/users',
          auth: 'none',
          body: { user: { username: 'u', email: 'e@x.dev', password: 'p' } },
          capture: { token: ['user', 'token'] },
        },
      ],
      auth: 'user',
      authToken: '{{capture.tokne}}',
    };
    assert.throws(() => validateSpec(typo, schema), (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      assert.equal(err.event, 'spec_unknown_capture');
      assert.match(err.message, /available at this point: token/);
      return true;
    });
  });

  it('rejects a forward reference - a capture declared by a LATER step', () => {
    const forward: TestCaseSpec = {
      ...grounded,
      setup: [
        {
          name: 'uses it too early',
          method: 'POST',
          path: '/api/articles',
          auth: 'user',
          authToken: '{{capture.token}}',
          body: { article: { title: 't', description: 'd', body: 'b' } },
        },
        {
          name: 'declares it afterwards',
          method: 'POST',
          path: '/api/users',
          auth: 'none',
          body: { user: { username: 'u', email: 'e@x.dev', password: 'p' } },
          capture: { token: ['user', 'token'] },
        },
      ],
    };
    assert.throws(() => validateSpec(forward, schema), (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      assert.equal(err.event, 'spec_unknown_capture');
      assert.match(err.message, /no captures are declared before it/);
      return true;
    });
  });

  it('rejects two setup steps capturing the same name, which would silently shadow', () => {
    const step = {
      name: 'register',
      method: 'POST' as const,
      path: '/api/users',
      auth: 'none' as const,
      body: { user: { username: 'u', email: 'e@x.dev', password: 'p' } },
      capture: { token: ['user', 'token'] },
    };
    const duplicated: TestCaseSpec = { ...grounded, setup: [step, { ...step, name: 'register again' }] };
    assert.throws(() => validateSpec(duplicated, schema), (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      assert.equal(err.event, 'spec_duplicate_capture');
      return true;
    });
  });

  it('rejects an authToken on a request that is not auth: "user" - it would be silently ignored', () => {
    const ignored: TestCaseSpec = { ...grounded, auth: 'none', authToken: 'whatever' };
    assert.throws(() => validateSpec(ignored, schema), (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      assert.equal(err.event, 'spec_auth_token_without_user');
      return true;
    });
  });

  it('accepts a well-formed chain, including an interpolated subject path', () => {
    const chained: TestCaseSpec = {
      ...grounded,
      setup: [
        {
          name: 'register the author',
          method: 'POST',
          path: '/api/users',
          auth: 'none',
          body: { user: { username: 'u', email: 'e@x.dev', password: 'p' } },
          capture: { authorToken: ['user', 'token'] },
        },
        {
          name: 'create an article',
          method: 'POST',
          path: '/api/articles',
          auth: 'user',
          authToken: '{{capture.authorToken}}',
          body: { article: { title: 't', description: 'd', body: 'b' } },
          capture: { slug: ['article', 'slug'] },
        },
      ],
      method: 'PUT',
      path: '/api/articles/{{capture.slug}}',
      auth: 'user',
      authToken: '{{capture.authorToken}}',
      body: { article: { title: 'edited' } },
    };
    assert.doesNotThrow(() => validateSpec(chained, schema));
  });

  it('rejects a spec missing criterionId', () => {
    const bad: TestCaseSpec = { ...grounded, criterionId: '' };
    assert.throws(() => validateSpec(bad, schema), (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      assert.equal(err.event, 'spec_missing_criterion_id');
      return true;
    });
  });

  it('rejects a spec with no assertions', () => {
    const bad: TestCaseSpec = { ...grounded, assertions: [] };
    assert.throws(() => validateSpec(bad, schema), (err: unknown) => {
      assert.ok(err instanceof RunnerError);
      assert.equal(err.event, 'spec_missing_assertions');
      return true;
    });
  });
});

// See PLAN-5.3-5.7-WALKING-SKELETON.md 0.3: unparseableAssertionHints is what
// lets validate-spec (runner/src/cli.ts) surface, at draft time, an assertion
// that will silently derive zero kill faults - the same shape
// brittle-login-snapshot.json's own fixture exercises live, but never had a
// unit test naming why.
describe('unparseableAssertionHints', () => {
  it('is empty for every recognised check form', () => {
    const spec: TestCaseSpec = {
      ...grounded,
      assertions: [
        { name: 'status_201', check: 'status === 201' },
        { name: 'has_token', check: 'body.user.token' },
        { name: 'email_matches', check: "body.user.email === 'x@example.com'" },
      ],
    };
    assert.deepEqual(unparseableAssertionHints(spec), []);
  });

  it('names an assertion whose check parseCheck cannot parse, and says why', () => {
    const spec: TestCaseSpec = {
      ...grounded,
      assertions: [
        { name: 'status_201', check: 'status === 201' },
        { name: 'exact_snapshot', check: 'JSON.stringify(body) === "{}"' },
      ],
    };
    assert.equal(parseCheck('JSON.stringify(body) === "{}"'), undefined, 'premise: this form is unparseable');
    const hints = unparseableAssertionHints(spec);
    assert.equal(hints.length, 1);
    assert.match(hints[0]!, /"exact_snapshot"/);
    assert.match(hints[0]!, /cannot derive a kill fault/);
    assert.match(hints[0]!, /quarantined/);
  });

  it('names every unparseable assertion, not just the first', () => {
    const spec: TestCaseSpec = {
      ...grounded,
      assertions: [
        { name: 'a', check: 'JSON.stringify(body) === "{}"' },
        { name: 'b', check: 'body.user.token.length > 10' },
      ],
    };
    const hints = unparseableAssertionHints(spec);
    assert.equal(hints.length, 2);
    assert.ok(hints.some((h) => h.includes('"a"')));
    assert.ok(hints.some((h) => h.includes('"b"')));
  });
});
