import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { certifyTestCase } from '../src/certify.ts';
import type { FalsificationReport, FaultVerdict } from '../src/runner/types.ts';

const kill = (verdict: FaultVerdict['verdict'], overrides: Partial<FaultVerdict> = {}): FaultVerdict => ({
  fault: {
    id: 'k1',
    kind: 'kill',
    targetAssertion: 'status_201',
    description: 'flip status to 200',
    mutation: { op: 'set_status', value: 200 },
    plausible: true,
  },
  verdict,
  detail: 'all 3 attempts failed at "assertion: status_201"',
  ...overrides,
});

const immunity = (verdict: FaultVerdict['verdict'], overrides: Partial<FaultVerdict> = {}): FaultVerdict => ({
  fault: {
    id: 'i1',
    kind: 'immunity',
    description: 'change an unrelated field',
    mutation: { op: 'set_field', path: ['user', 'bio'], value: 'x' },
    plausible: true,
  },
  verdict,
  detail: 'immunity holds',
  ...overrides,
});

function report(verdicts: FaultVerdict[], overrides: Partial<FalsificationReport> = {}): FalsificationReport {
  return { criterionId: 'C-1', verdicts, assertionSensitivity: 1, runsExecuted: verdicts.length * 4, ...overrides };
}

describe('certifyTestCase', () => {
  it('certifies when every kill fault was killed and every immunity fault survived', () => {
    const result = certifyTestCase(report([kill('KILL'), immunity('SURVIVE')]));
    assert.equal(result.verdict, 'certified');
  });

  it('rejects when a kill fault survived - the test does not actually catch the bug', () => {
    const result = certifyTestCase(report([kill('SURVIVE'), immunity('SURVIVE')]));
    assert.equal(result.verdict, 'rejected');
    assert.match(result.reason, /survived/);
    assert.match(result.reason, /status_201/);
  });

  it('rejects when an immunity fault was killed - the test is brittle', () => {
    const result = certifyTestCase(report([kill('KILL'), immunity('KILL')]));
    assert.equal(result.verdict, 'rejected');
    assert.match(result.reason, /brittle/);
  });

  it('rejects an inconclusive verdict rather than certifying on ambiguous evidence', () => {
    const result = certifyTestCase(report([kill('INCONCLUSIVE')]));
    assert.equal(result.verdict, 'rejected');
    assert.match(result.reason, /inconclusive/);
  });

  it('quarantines rather than certifying or rejecting when a fault was quarantined - environment instability, not a test problem', () => {
    const result = certifyTestCase(report([kill('QUARANTINED'), immunity('SURVIVE')]));
    assert.equal(result.verdict, 'quarantined');
  });

  it('quarantines at the report level even with an empty verdicts array', () => {
    const result = certifyTestCase(report([], { criterionQuarantined: 'healthy control failed' }));
    assert.equal(result.verdict, 'quarantined');
    assert.equal(result.reason, 'healthy control failed');
  });

  it('a survived kill fault takes priority over a violated immunity fault when both are present, so the more specific "does not catch the bug" reason is not lost', () => {
    const result = certifyTestCase(report([kill('SURVIVE'), immunity('KILL')]));
    assert.equal(result.verdict, 'rejected');
    assert.match(result.reason, /survived/);
  });

  it('rejects a deliberately weak test - zero derivable kill faults, even though every immunity fault survives, must not fall through to certified', () => {
    // e.g. an assertion like "body" alone (no field path) or "true" is
    // unparseable by deriveKillFaults, so the report carries only immunity
    // verdicts. Without an explicit rule this falls through to the default
    // `certified` case at the bottom of certifyTestCase - exactly the gap
    // the master plan's own named weak-test check exists to catch.
    const result = certifyTestCase(report([immunity('SURVIVE')]));
    assert.equal(result.verdict, 'rejected');
    assert.match(result.reason, /no kill faults/);
  });

  it('rejects a weak test even with zero verdicts at all (no kill and no immunity faults derived)', () => {
    const result = certifyTestCase(report([]));
    assert.equal(result.verdict, 'rejected');
    assert.match(result.reason, /no kill faults/);
  });
});
