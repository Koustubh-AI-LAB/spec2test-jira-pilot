import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scopedEnv } from '../src/validator/runPlaywright.ts';

describe('scopedEnv', () => {
  const SECRET_KEYS = ['JIRA_API_TOKEN', 'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'JIRA_EMAIL'];
  const previous: Record<string, string | undefined> = {};

  before(() => {
    for (const key of SECRET_KEYS) {
      previous[key] = process.env[key];
      process.env[key] = `secret-value-for-${key}`;
    }
  });

  after(() => {
    for (const key of SECRET_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it('never lets a secret in the parent process env reach the child, even though it is present in process.env', () => {
    const env = scopedEnv({});
    for (const key of SECRET_KEYS) {
      assert.equal(env[key], undefined, `${key} leaked into the child process env`);
    }
  });

  it('still passes through what a spawned node/npm process needs to actually start', () => {
    const env = scopedEnv({});
    // PATH's exact casing varies by shell/OS - assert at least one form survived.
    assert.ok(env.PATH || env.Path, 'no PATH/Path in scoped env - child process would fail to launch npx/playwright');
  });

  it('passes through only the two vars a generated test is meant to use, and only if actually set', () => {
    process.env.CONDUIT_BASE_URL = 'http://localhost:3000';
    process.env.TARGET_AUTH_TOKEN = 'a-real-looking-token';
    try {
      const env = scopedEnv({});
      assert.equal(env.CONDUIT_BASE_URL, 'http://localhost:3000');
      assert.equal(env.TARGET_AUTH_TOKEN, 'a-real-looking-token');
    } finally {
      delete process.env.CONDUIT_BASE_URL;
      delete process.env.TARGET_AUTH_TOKEN;
    }
  });

  it('lets extraEnv (e.g. SPEC2TEST_TRANSCRIPT for replay) through even though it is not a passthrough key', () => {
    const env = scopedEnv({ SPEC2TEST_TRANSCRIPT: '/tmp/transcript.json' });
    assert.equal(env.SPEC2TEST_TRANSCRIPT, '/tmp/transcript.json');
  });

  it('extraEnv wins over an inherited value for the same key', () => {
    process.env.CONDUIT_BASE_URL = 'http://parent-value:3000';
    try {
      const env = scopedEnv({ CONDUIT_BASE_URL: 'http://override:3000' });
      assert.equal(env.CONDUIT_BASE_URL, 'http://override:3000');
    } finally {
      delete process.env.CONDUIT_BASE_URL;
    }
  });
});
