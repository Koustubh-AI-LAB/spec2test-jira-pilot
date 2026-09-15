import type { ResponseMutation } from '../client/apiClient.ts';

export type { ResponseMutation };

export type FaultKind = 'kill' | 'immunity';

export interface FaultSpec {
  id: string;
  kind: FaultKind;
  /** The assertion name this fault targets - only meaningful for 'kill'
   *  faults, since attribution is by construction: a kill fault is parsed
   *  directly out of the assertion it's meant to falsify. */
  targetAssertion?: string;
  description: string;
  mutation: ResponseMutation;
  /** Presence-check plausibility (schema-documented status/field), not full
   *  type validation - see spec/openapi.ts's isFieldInResponseSchema and
   *  documentedStatuses. */
  plausible: boolean;
}

export type Verdict = 'KILL' | 'SURVIVE' | 'INCONCLUSIVE' | 'QUARANTINED';

export interface FaultVerdict {
  fault: FaultSpec;
  verdict: Verdict;
  /** Human-readable reason, e.g. which step failed, or that the mutation
   *  never applied. */
  detail: string;
}

export interface FalsificationReport {
  criterionId: string;
  verdicts: FaultVerdict[];
  /** kills / (kills + survivals) on the Kill Set, forced to 0 if any
   *  Immunity fault was violated. INCONCLUSIVE/QUARANTINED faults are
   *  excluded from both terms - provisional, internal-only, never surfaced
   *  to Jira/PO (per the scoped plan). */
  assertionSensitivity: number;
  runsExecuted: number;
  /** Set when the whole criterion was quarantined before any per-fault
   *  verdict could be attached to carry that signal - a spec whose
   *  assertions derive zero Kill faults (nothing parseable) would otherwise
   *  report an empty `verdicts` array that looks identical to "nothing
   *  needed checking," silently losing the fact that the environment was
   *  unstable. */
  criterionQuarantined?: string;
}
