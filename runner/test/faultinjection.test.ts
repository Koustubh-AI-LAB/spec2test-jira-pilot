import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenApiSchema, type OpenApiDoc } from '../src/spec/openapi.ts';
import { deriveKillFaults } from '../src/faultinjection/deriveKillFaults.ts';
import { deriveImmunityFaults } from '../src/faultinjection/deriveImmunityFaults.ts';
import { applyMutation } from '../src/client/apiClient.ts';
import { aggregate, computeAssertionSensitivity, quarantinedReport, type FaultAttempt } from '../src/faultinjection/runFalsification.ts';
import type { FaultSpec, FaultVerdict, ResponseMutation } from '../src/faultinjection/types.ts';
import type { TestCaseSpec } from '../src/spec/types.ts';

/** Immunity faults are always delete_field, but the type is a union -
 *  narrow once here instead of casting at every call site. */
function pathOf(mutation: ResponseMutation): string[] {
  return mutation.op === 'set_status' ? [] : mutation.path;
}

const SCHEMA_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'openapi', 'conduit.snapshot.yml');
const schema: OpenApiDoc = loadOpenApiSchema(SCHEMA_PATH);

const registerSpec: TestCaseSpec = {
  criterionId: 'C-REGISTER-USER',
  name: 'register a new user',
  method: 'POST',
  path: '/api/users',
  auth: 'none',
  body: { user: { email: 'x@example.com', password: 'x', username: 'x' } },
  assertions: [
    { name: 'status_201', check: 'status === 201' },
    { name: 'has_token', check: 'body.user.token' },
  ],
};

describe('deriveKillFaults', () => {
  it('parses "status === N" into a set_status mutation to a different, schema-documented code', () => {
    const [statusFault] = deriveKillFaults(registerSpec, schema);
    assert.equal(statusFault!.targetAssertion, 'status_201');
    assert.deepEqual(statusFault!.mutation, { op: 'set_status', value: 409 });
    assert.equal(statusFault!.plausible, true);
  });

  it('parses a bare truthy "body.x.y" into a delete_field mutation at that exact path', () => {
    const [, tokenFault] = deriveKillFaults(registerSpec, schema);
    assert.equal(tokenFault!.targetAssertion, 'has_token');
    assert.deepEqual(tokenFault!.mutation, { op: 'delete_field', path: ['user', 'token'] });
  });

  it('parses "body.x.y === <literal>" (the third form, login-user\'s own correct_email) the same as a bare truthy check', () => {
    const loginSpec: TestCaseSpec = {
      ...registerSpec,
      path: '/api/users/login',
      assertions: [{ name: 'correct_email', check: "body.user.email === 'x@example.com'" }],
    };
    const [emailFault] = deriveKillFaults(loginSpec, schema);
    assert.deepEqual(emailFault!.mutation, { op: 'delete_field', path: ['user', 'email'] });
  });

  it('skips an assertion in none of the three forms, rather than guessing', () => {
    const oddSpec: TestCaseSpec = {
      ...registerSpec,
      assertions: [{ name: 'weird', check: 'body.user.roles.includes("admin")' }],
    };
    assert.deepEqual(deriveKillFaults(oddSpec, schema), []);
  });

  it('produces a real, correctly-shaped fault for every assertion across all 4 real fixtures - proven, not assumed', () => {
    const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'specs');
    const names = ['register-user', 'login-user', 'login-wrong-password', 'create-article'];
    for (const name of names) {
      const spec = JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')) as TestCaseSpec;
      const faults = deriveKillFaults(spec, schema);
      assert.equal(faults.length, spec.assertions.length, `${name}: expected one kill fault per assertion`);
      for (const fault of faults) {
        assert.equal(fault.plausible, true, `${name}/${fault.id} expected to be plausible against the real schema`);
      }
    }
  });
});

describe('deriveImmunityFaults', () => {
  const sampleBody = {
    user: { id: 1, email: 'x@example.com', username: 'x', bio: null, image: 'https://x', token: 'abc' },
  };

  it('excludes a referenced leaf ("user.token") and returns unreferenced ones, capped at 2', () => {
    const faults = deriveImmunityFaults(registerSpec, 201, sampleBody, schema);
    assert.equal(faults.length, 2);
    for (const fault of faults) {
      assert.ok(!['token'].includes(pathOf(fault.mutation).at(-1) as string));
    }
  });

  it('does not exclude a candidate merely because its leaf name is the substring "body" - the bug caught while planning', () => {
    const articleSpec: TestCaseSpec = {
      criterionId: 'C-X',
      name: 'x',
      method: 'POST',
      path: '/api/articles',
      auth: 'user',
      assertions: [{ name: 'has_slug', check: 'body.article.slug' }],
    };
    // article.body is a real Conduit field whose leaf NAME happens to be
    // "body" - the same word every check string starts with as its
    // destructured variable. A naive substring match on the leaf name alone
    // would always find "body" inside "body.article.slug" and wrongly treat
    // article.body as referenced. Only 2 leaves here (well under the cap of
    // 2) so the cap can't be what excludes it - isolates the actual bug.
    const sample = { article: { slug: 'x', body: 'the article text' } };
    const faults = deriveImmunityFaults(articleSpec, 201, sample, schema);
    assert.ok(faults.some((f) => pathOf(f.mutation).join('.') === 'article.body'));
  });

  it('finds nested leaf candidates, not just top-level keys - the top-level-only bug caught while planning', () => {
    // Conduit wraps every response in one top-level key ("user"); a
    // top-level-only scan finds zero candidates for every real fixture.
    const faults = deriveImmunityFaults(registerSpec, 201, sampleBody, schema);
    assert.ok(faults.length > 0);
    assert.ok(faults.every((f) => pathOf(f.mutation).length > 1));
  });
});

describe('applyMutation', () => {
  it('set_status: reports applied:false when the status is already the target value', () => {
    const { response, applied } = applyMutation({ status: 200, body: {} }, { op: 'set_status', value: 200 });
    assert.equal(applied, false);
    assert.equal(response.status, 200);
  });

  it('set_status: reports applied:true and changes the status otherwise', () => {
    const { response, applied } = applyMutation({ status: 201, body: {} }, { op: 'set_status', value: 200 });
    assert.equal(applied, true);
    assert.equal(response.status, 200);
  });

  it('delete_field: reports applied:false when the path is not present in this response', () => {
    const { response, applied } = applyMutation(
      { status: 200, body: { user: {} } },
      { op: 'delete_field', path: ['user', 'token'] },
    );
    assert.equal(applied, false);
    assert.deepEqual(response.body, { user: {} });
  });

  it('delete_field: reports applied:true and removes the field otherwise, without mutating the input', () => {
    const original = { status: 200, body: { user: { token: 'abc' } } };
    const { response, applied } = applyMutation(original, { op: 'delete_field', path: ['user', 'token'] });
    assert.equal(applied, true);
    assert.deepEqual(response.body, { user: {} });
    assert.deepEqual(original.body, { user: { token: 'abc' } }); // untouched
  });

  it('set_field: reports applied correctly and updates the value', () => {
    const { response, applied } = applyMutation(
      { status: 200, body: { user: { bio: 'x' } } },
      { op: 'set_field', path: ['user', 'bio'], value: 'y' },
    );
    assert.equal(applied, true);
    assert.equal(response.body.user.bio, 'y');
  });
});

describe('aggregate (verdict logic)', () => {
  const killFault: FaultSpec = {
    id: 'kill-status_201',
    kind: 'kill',
    targetAssertion: 'status_201',
    description: 'x',
    mutation: { op: 'set_status', value: 200 },
    plausible: true,
  };
  const immunityFault: FaultSpec = {
    id: 'immunity-user.bio',
    kind: 'immunity',
    description: 'x',
    mutation: { op: 'delete_field', path: ['user', 'bio'] },
    plausible: true,
  };

  it('kill: all attempts fail at the target step -> KILL', () => {
    const attempts: FaultAttempt[] = [
      { testPassed: false, failedStep: 'assertion: status_201', applied: true },
      { testPassed: false, failedStep: 'assertion: status_201', applied: true },
      { testPassed: false, failedStep: 'assertion: status_201', applied: true },
    ];
    assert.equal(aggregate(killFault, attempts).verdict, 'KILL');
  });

  it('kill: no failure anywhere, mutation applied -> SURVIVE', () => {
    const attempts: FaultAttempt[] = [
      { testPassed: true, failedStep: undefined, applied: true },
      { testPassed: true, failedStep: undefined, applied: true },
      { testPassed: true, failedStep: undefined, applied: true },
    ];
    assert.equal(aggregate(killFault, attempts).verdict, 'SURVIVE');
  });

  it('kill: no failure anywhere, but the mutation never applied -> INCONCLUSIVE, never SURVIVE (the TestForge lesson)', () => {
    const attempts: FaultAttempt[] = [
      { testPassed: true, failedStep: undefined, applied: false },
      { testPassed: true, failedStep: undefined, applied: false },
      { testPassed: true, failedStep: undefined, applied: false },
    ];
    assert.equal(aggregate(killFault, attempts).verdict, 'INCONCLUSIVE');
  });

  it('kill: fails, but at the wrong step -> INCONCLUSIVE', () => {
    const attempts: FaultAttempt[] = [
      { testPassed: false, failedStep: 'assertion: has_token', applied: true },
      { testPassed: false, failedStep: 'assertion: has_token', applied: true },
      { testPassed: false, failedStep: 'assertion: has_token', applied: true },
    ];
    assert.equal(aggregate(killFault, attempts).verdict, 'INCONCLUSIVE');
  });

  it('kill: attempts disagree with each other -> INCONCLUSIVE', () => {
    const attempts: FaultAttempt[] = [
      { testPassed: false, failedStep: 'assertion: status_201', applied: true },
      { testPassed: true, failedStep: undefined, applied: true },
      { testPassed: false, failedStep: 'assertion: status_201', applied: true },
    ];
    assert.equal(aggregate(killFault, attempts).verdict, 'INCONCLUSIVE');
  });

  it('kill: the process crashes outside any test.step (no step recorded) -> INCONCLUSIVE, never read as "passed" - the gap found and fixed in this same review pass', () => {
    // failedStep is undefined here too (no step ever ran), which is exactly
    // why testPassed - the real exit code - has to be the primary signal:
    // a naive "did any step fail?" check would misread this as a pass.
    const attempts: FaultAttempt[] = [
      { testPassed: false, failedStep: undefined, applied: false },
      { testPassed: false, failedStep: undefined, applied: false },
      { testPassed: false, failedStep: undefined, applied: false },
    ];
    assert.equal(aggregate(killFault, attempts).verdict, 'INCONCLUSIVE');
  });

  it('immunity: no failure anywhere -> SURVIVE (immunity holds)', () => {
    const attempts: FaultAttempt[] = [
      { testPassed: true, failedStep: undefined, applied: true },
      { testPassed: true, failedStep: undefined, applied: true },
      { testPassed: true, failedStep: undefined, applied: true },
    ];
    assert.equal(aggregate(immunityFault, attempts).verdict, 'SURVIVE');
  });

  it('immunity: fails every time -> KILL (immunity violated - the brittle-test case)', () => {
    const attempts: FaultAttempt[] = [
      { testPassed: false, failedStep: 'assertion: status_201', applied: true },
      { testPassed: false, failedStep: 'assertion: status_201', applied: true },
      { testPassed: false, failedStep: 'assertion: status_201', applied: true },
    ];
    assert.equal(aggregate(immunityFault, attempts).verdict, 'KILL');
  });

  it('immunity: the process crashes outside any test.step -> still counted as violated (KILL), not silently as immunity holding', () => {
    const attempts: FaultAttempt[] = [
      { testPassed: false, failedStep: undefined, applied: false },
      { testPassed: false, failedStep: undefined, applied: false },
      { testPassed: false, failedStep: undefined, applied: false },
    ];
    assert.equal(aggregate(immunityFault, attempts).verdict, 'KILL');
  });
});

describe('computeAssertionSensitivity', () => {
  const kill = (verdict: FaultVerdict['verdict']): FaultVerdict => ({
    fault: { id: 'k', kind: 'kill', description: 'x', mutation: { op: 'set_status', value: 1 }, plausible: true },
    verdict,
    detail: '',
  });
  const immunity = (verdict: FaultVerdict['verdict']): FaultVerdict => ({
    fault: { id: 'i', kind: 'immunity', description: 'x', mutation: { op: 'delete_field', path: ['x'] }, plausible: true },
    verdict,
    detail: '',
  });

  it('2 kills, 0 survivals -> 1.0', () => {
    assert.equal(computeAssertionSensitivity([kill('KILL'), kill('KILL')]), 1);
  });

  it('1 kill, 1 survival -> 0.5', () => {
    assert.equal(computeAssertionSensitivity([kill('KILL'), kill('SURVIVE')]), 0.5);
  });

  it('forced to 0 when any immunity fault is violated (KILL), regardless of kill-set results', () => {
    assert.equal(computeAssertionSensitivity([kill('KILL'), kill('KILL'), immunity('KILL')]), 0);
  });

  it('excludes INCONCLUSIVE/QUARANTINED faults from both terms', () => {
    // 1 real kill, 1 inconclusive (excluded) -> sensitivity is 1.0, not 0.5
    assert.equal(computeAssertionSensitivity([kill('KILL'), kill('INCONCLUSIVE')]), 1);
  });

  it('is 0 when there is nothing to compute from', () => {
    assert.equal(computeAssertionSensitivity([]), 0);
  });
});

describe('quarantinedReport', () => {
  it('carries the quarantine reason at the report level even with zero kill faults - the reporting gap found in this review pass', () => {
    // brittle-login-snapshot's own shape: an unparseable check means
    // deriveKillFaults returns []. Without criterionQuarantined, this would
    // report an empty verdicts array indistinguishable from "nothing
    // needed checking."
    const report = quarantinedReport('C-BRITTLE-LOGIN-SNAPSHOT', [], 1, 'environment unstable');
    assert.deepEqual(report.verdicts, []);
    assert.equal(report.criterionQuarantined, 'environment unstable');
    assert.equal(report.assertionSensitivity, 0);
  });

  it('also attaches QUARANTINED to every derived kill fault when there are some', () => {
    const fault: FaultSpec = {
      id: 'kill-status_201',
      kind: 'kill',
      targetAssertion: 'status_201',
      description: 'x',
      mutation: { op: 'set_status', value: 200 },
      plausible: true,
    };
    const report = quarantinedReport('C-X', [fault], 1, 'environment unstable');
    assert.equal(report.verdicts.length, 1);
    assert.equal(report.verdicts[0]!.verdict, 'QUARANTINED');
    assert.equal(report.criterionQuarantined, 'environment unstable');
  });
});
