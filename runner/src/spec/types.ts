export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Single role for the pilot, per day-one item #16's "cheap form". */
export type AuthMode = 'none' | 'user';

export interface Assertion {
  /** Matched against a `// assertion: <name>` comment by the AST checker. */
  name: string;
  /** A TypeScript boolean expression over `status`/`body`, interpolated
   *  verbatim into the generated file - never eval'd here. */
  check: string;
}

export interface TestCaseSpec {
  criterionId: string;
  name: string;
  method: HttpMethod;
  /** Full request path, e.g. "/api/articles" - as a developer would curl it. */
  path: string;
  auth: AuthMode;
  /** String values may contain the literal "{{unique}}" - see generator/render.ts. */
  body?: unknown;
  assertions: Assertion[];
}
