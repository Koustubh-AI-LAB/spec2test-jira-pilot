import type { FalsificationReport } from './runner/types.ts';

/**
 * Tier-1-only certification verdict for one test case's falsification
 * report. Pure and unpersisted on purpose - see the note in
 * service/src/api/server.ts's schema comments: `test_case.state` and
 * `criterion.state` have no slot for a certification verdict, only
 * `requirement.state` does. This function is what `computeVerification`
 * calls, per test case, to derive that rollup; nothing here writes to the
 * database itself.
 *
 * Rules, straight from the master plan's item 9 and its failure-mode table:
 * a kill fault that survived means the test didn't catch the bug it claims
 * to; an immunity fault that got killed means the test is brittle (fails on
 * an unrelated change); either rejects certification, never both silently
 * cancelling out. A quarantined fault means the *environment* was unstable,
 * not the test - certifying or rejecting on that basis would be scoring
 * noise, so it holds instead.
 *
 * Provisional, same as the design doc treats Assertion Sensitivity: this is
 * the simplest rule that satisfies the master plan's stated cases (a
 * deliberately weak test rejected, a deliberately brittle test caught by
 * Immunity), not a fully general policy. Expect it to move once real
 * tickets produce reports these rules don't cleanly cover.
 */

export type CertifyVerdict = 'certified' | 'rejected' | 'quarantined';

export interface CertifyResult {
  verdict: CertifyVerdict;
  reason: string;
}

export function certifyTestCase(report: FalsificationReport): CertifyResult {
  if (report.criterionQuarantined) {
    return { verdict: 'quarantined', reason: report.criterionQuarantined };
  }

  const quarantinedFault = report.verdicts.find((v) => v.verdict === 'QUARANTINED');
  if (quarantinedFault) {
    return {
      verdict: 'quarantined',
      reason: `fault ${quarantinedFault.fault.id} quarantined: ${quarantinedFault.detail}`,
    };
  }

  // A test whose assertions derive zero kill faults at all (e.g. "asserts
  // only that the response is non-empty", the master plan's own named
  // example of a deliberately weak test) has nothing proving it catches any
  // bug - it can sail through with every immunity fault surviving and no
  // kill fault to fail, which would otherwise fall through to `certified`
  // by default further down. Caught here explicitly, before that default is
  // reached, rather than relying on assertionSensitivity being 0 (that
  // number is provisional and internal-only, never gates certification).
  const killVerdicts = report.verdicts.filter((v) => v.fault.kind === 'kill');
  if (killVerdicts.length === 0) {
    return {
      verdict: 'rejected',
      reason:
        'no kill faults could be derived from this test’s assertions - nothing proves it actually ' +
        'catches the bug it claims to catch (a deliberately weak assertion, e.g. checking only that a ' +
        'response is non-empty, produces exactly this)',
    };
  }

  const survivedKill = report.verdicts.find((v) => v.fault.kind === 'kill' && v.verdict === 'SURVIVE');
  if (survivedKill) {
    return {
      verdict: 'rejected',
      reason:
        `kill fault "${survivedKill.fault.description}" (targeting assertion ` +
        `"${survivedKill.fault.targetAssertion ?? '(unknown)'}") survived - the test does not actually ` +
        `catch the bug it claims to: ${survivedKill.detail}`,
    };
  }

  const violatedImmunity = report.verdicts.find((v) => v.fault.kind === 'immunity' && v.verdict === 'KILL');
  if (violatedImmunity) {
    return {
      verdict: 'rejected',
      reason:
        `immunity fault "${violatedImmunity.fault.description}" broke the test - it is too brittle, ` +
        `failing on an unrelated change: ${violatedImmunity.detail}`,
    };
  }

  const inconclusive = report.verdicts.find((v) => v.verdict === 'INCONCLUSIVE');
  if (inconclusive) {
    return {
      verdict: 'rejected',
      reason:
        `fault "${inconclusive.fault.description}" was inconclusive - the test failed for the wrong ` +
        `reason, or the mutation never applied: ${inconclusive.detail}`,
    };
  }

  return { verdict: 'certified', reason: `${report.verdicts.length} faults checked, all as expected` };
}
