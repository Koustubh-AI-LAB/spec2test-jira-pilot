import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideVerificationState } from '../src/verification.ts';
import type { CriterionCoverage } from '../src/verification.ts';

const covered = (id = 'c1'): CriterionCoverage => ({ id, stateAffecting: false, covered: true });
const uncovered = (id = 'c1'): CriterionCoverage => ({ id, stateAffecting: false, covered: false });

const base = {
  nonRejectedCriteriaCount: 1,
  gate1Closed: true,
  hasRunningJob: false,
  coverage: [covered()],
  anyVerificationAttempted: true,
  wasEverCertified: false,
};

describe('decideVerificationState', () => {
  it('is unchanged when every criterion was rejected (nothing to roll up)', () => {
    assert.equal(decideVerificationState({ ...base, nonRejectedCriteriaCount: 0 }), 'unchanged');
  });

  it('is unchanged while gate 1 is still open - reconcile.ts owns those states', () => {
    assert.equal(decideVerificationState({ ...base, gate1Closed: false }), 'unchanged');
  });

  it('is verifying while a falsification job is still queued/running', () => {
    assert.equal(decideVerificationState({ ...base, hasRunningJob: true }), 'verifying');
  });

  it('is awaiting_test_approval once gate 1 closes but nothing has been verified yet', () => {
    assert.equal(decideVerificationState({ ...base, anyVerificationAttempted: false }), 'awaiting_test_approval');
  });

  it('is contract_verified when every non-rejected criterion is covered', () => {
    assert.equal(decideVerificationState({ ...base, coverage: [covered('c1'), covered('c2')] }), 'contract_verified');
  });

  it('is weak when coverage is partial and full certification was never reached before', () => {
    assert.equal(
      decideVerificationState({ ...base, coverage: [covered('c1'), uncovered('c2')], wasEverCertified: false }),
      'weak',
    );
  });

  it('is failing, not weak, when coverage regressed after being fully certified before', () => {
    assert.equal(
      decideVerificationState({ ...base, coverage: [covered('c1'), uncovered('c2')], wasEverCertified: true }),
      'failing',
    );
  });

  it('running job takes priority over gate1Closed=false being reachable at all - defensive ordering', () => {
    // gate1Closed is required to be true for hasRunningJob to be meaningfully
    // set by computeVerification, but the pure function itself should still
    // resolve unambiguously if ever called with both true.
    assert.equal(decideVerificationState({ ...base, gate1Closed: true, hasRunningJob: true }), 'verifying');
  });
});
