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
