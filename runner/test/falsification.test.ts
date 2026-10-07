/**
 * Live end-to-end proof of the actual thing this design exists for: a real
 * Kill Set fault genuinely fails a real generated test at its named
 * assertion, a real Immunity Set fault leaves a good test passing, and a
 * deliberately brittle assertion fails the Immunity Set - the check the
 * design doc calls out by name as proving the improvement over naive
 * mutation scoring. Skipped entirely when CONDUIT_BASE_URL is unset, same
 * pattern as e2e.test.ts.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenApiSchema } from '../src/spec/openapi.ts';
import { generate } from '../src/generator/index.ts';
import { runFalsification } from '../src/faultinjection/index.ts';
import type { TestCaseSpec } from '../src/spec/types.ts';

for (const path of ['../.env', '.env']) {
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
  break;
}

const live = Boolean(process.env.CONDUIT_BASE_URL);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');

describe('runFalsification (live)', { skip: !live && 'CONDUIT_BASE_URL not set' }, () => {
  const targetRepoRoot = process.env.CONDUIT_REPO_PATH ?? '';
  const spec2testDir = join(targetRepoRoot, 'spec2test');
  const schema = loadOpenApiSchema(join(FIXTURES, 'openapi', 'conduit.snapshot.yml'));

  before(() => {
    if (!targetRepoRoot || !existsSync(spec2testDir)) {
      throw new Error('CONDUIT_BASE_URL is set but CONDUIT_REPO_PATH / spec2test/ scaffold is missing');
    }
  });

  function loadSpec(name: string): TestCaseSpec {
    return JSON.parse(readFileSync(join(FIXTURES, 'specs', `${name}.json`), 'utf8')) as TestCaseSpec;
  }

  it('a real Kill Set fault genuinely kills register-user at its named assertion, and a real Immunity fault leaves it passing', () => {
    const spec = loadSpec('register-user');
    const { filePath } = generate(spec, join(spec2testDir, 'generated'), { force: true });

    const report = runFalsification({ spec, filePath, targetRepoRoot, schema });

    const statusKill = report.verdicts.find((v) => v.fault.targetAssertion === 'status_201');
    assert.equal(
      statusKill?.verdict,
      'KILL',
      `expected status_201's kill fault to score KILL, got ${statusKill?.verdict}: ${statusKill?.detail}`,
    );

    const immunityFaults = report.verdicts.filter((v) => v.fault.kind === 'immunity');
    assert.ok(immunityFaults.length > 0, 'expected at least one immunity fault to have been derived');
    for (const v of immunityFaults) {
      assert.equal(
        v.verdict,
        'SURVIVE',
        `expected immunity fault "${v.fault.id}" to hold (SURVIVE), got ${v.verdict}: ${v.detail}`,
      );
    }

    assert.ok(
      report.assertionSensitivity > 0,
      'a criterion with a real KILL and no immunity violations should have positive sensitivity',
    );
    assert.ok(report.runsExecuted > 0);
  });

  it("a deliberately brittle full-snapshot assertion fails the Immunity Set - the design doc's own headline check", () => {
    const spec = loadSpec('brittle-login-snapshot');
    const { filePath } = generate(spec, join(spec2testDir, 'generated'), { force: true });

    const report = runFalsification({ spec, filePath, targetRepoRoot, schema });

    const immunityFaults = report.verdicts.filter((v) => v.fault.kind === 'immunity');
    assert.ok(
      immunityFaults.length > 0,
      'expected at least one immunity fault to have been derived against the sampled response',
    );
    assert.ok(
      immunityFaults.some((v) => v.verdict === 'KILL'),
      `expected at least one immunity fault to catch the brittle assertion (verdict KILL); got: ${JSON.stringify(immunityFaults.map((v) => v.verdict))}`,
    );

    // Immunity violated -> Assertion Sensitivity is forced to 0, regardless
    // of the (empty, for this unparseable check) Kill Set.
    assert.equal(report.assertionSensitivity, 0);
  });
});
