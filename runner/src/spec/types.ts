export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Single role for the pilot, per day-one item #16's "cheap form". A request
 *  can still act as a *different* user than TARGET_AUTH_TOKEN by setting
 *  `authToken` to a value captured from a setup step - which is what a
 *  criterion like "only the author may edit" needs, and what a single static
 *  token cannot express. */
export type AuthMode = 'none' | 'user';

export interface Assertion {
  /** Matched against a `test.step("assertion: <name>", ...)` title by the AST
   *  checker, and reported at runtime by Playwright's own JSON reporter. */
  name: string;
  /** A TypeScript boolean expression over `status`/`body`, interpolated
   *  verbatim into the generated file - never eval'd here. */
  check: string;
}

/**
 * One request in a chain. String fields (`path`, `authToken`, and any string
 * inside `body`) may interpolate:
 *   - `{{unique}}`        - a per-execution suffix, see generator/render.ts
 *   - `{{capture.NAME}}`  - a value captured by an earlier setup step
 */
export interface RequestStep {
  /** Used in the generated failure message, so a setup break says which step. */
  name: string;
  method: HttpMethod;
  path: string;
  auth: AuthMode;
  /** Overrides TARGET_AUTH_TOKEN for this request when `auth` is 'user'. */
  authToken?: string;
  body?: unknown;
  /**
   * Values to pull out of this step's response for later steps to reference.
   * Maps a capture name to path segments into the response body.
   *
   * A segment array rather than a dotted string, for the same reason
   * ResponseMutation.path is one: a real response can carry a key containing
   * a literal "." (login-wrong-password's own error shape has "email or
   * password"), which a dotted string cannot address.
   */
  capture?: Record<string, string[]>;
}

export interface TestCaseSpec {
  criterionId: string;
  name: string;
  /**
   * Requests run in order to establish state before the subject request.
   * Their responses are never asserted on and no fault is ever injected into
   * them - they are scaffolding, not the thing under test. A setup step that
   * returns >= 400 fails the test outside any named assertion, which scores
   * INCONCLUSIVE rather than KILL, exactly as a broken control should.
   */
  setup?: RequestStep[];
  /** The subject request: the one assertions are about, and the only one a
   *  fault is ever injected into. */
  method: HttpMethod;
  path: string;
  auth: AuthMode;
  authToken?: string;
  body?: unknown;
  assertions: Assertion[];
}
