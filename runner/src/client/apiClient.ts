import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The typed client every generated test must use - the seam this whole
 * design hangs off. `transport` is swappable: real fetch by default, a
 * canned-transcript reader for the validator's replay stage, and Tier-1
 * fault injection for step 4's falsification, all without touching a single
 * generated test.
 *
 * This file is vendored (copied, not imported) into the target app's repo at
 * spec2test/client/apiClient.ts, so generated tests run standalone via that
 * repo's own `npx playwright test` with no dependency on this pilot repo.
 * The import whitelist only scans generated test files, never this one - a
 * generated test can't import 'fs' directly, but this wrapper legitimately
 * needs it to read a replay transcript or a fault spec.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Single role for the pilot, per day-one item #16's "cheap form". */
export type AuthMode = 'none' | 'user';

export interface ApiResponse {
  status: number;
  /** Deliberately `any`, not `unknown` - the whole point of black-box testing
   *  is the response shape isn't statically known, and forcing a cast at
   *  every assertion would just be noise generated tests (and specs) would
   *  have to carry for no real safety gain. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  body: any;
}

export interface RequestOptions {
  body?: unknown;
  auth: AuthMode;
  /** Overrides TARGET_AUTH_TOKEN for this one request - how a chained test
   *  acts as a second user (e.g. "only the author may edit this article"),
   *  which one static token cannot express. */
  authToken?: string;
  /** True for the request the assertions are about. A chained test makes
   *  several requests; only this one is sampled for immunity-fault derivation
   *  and only this one ever has a fault injected into it. */
  subject?: boolean;
}

export type Transport = (
  method: HttpMethod,
  url: string,
  init: { body?: unknown; headers: Record<string, string>; subject?: boolean },
) => Promise<ApiResponse>;

const liveTransport: Transport = async (method, url, init) => {
  const res = await fetch(url, {
    method,
    headers: init.headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

/**
 * Replay support: SPEC2TEST_TRANSCRIPT points at a JSON file mapping
 * "METHOD path" -> a canned {status, body}. Matched by method+path only,
 * never by request body - request bodies can carry {{unique}}-derived
 * runtime values a static transcript can't predict, and replay's job is only
 * to prove the generated assertions evaluate correctly against a known-good
 * response shape, not to re-validate the request itself.
 */
function transcriptTransport(transcriptPath: string): Transport {
  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as Record<string, ApiResponse>;
  return async (method, url, _init) => {
    const path = new URL(url).pathname;
    const key = `${method} ${path}`;
    const recorded = transcript[key];
    if (!recorded) {
      throw new Error(`replay: no transcript entry for "${key}" in ${transcriptPath}`);
    }
    return recorded;
  };
}

/**
 * A fault mutation, applied to a REAL response (never a canned one - Kill/
 * Immunity Set falsification needs to prove something about the live
 * contract). `path` is an array of raw property-name segments, not a dotted
 * string: a real response can carry a key like "email or password"
 * (login-wrong-password's own error shape), and a dotted-string path breaks
 * the instant a real key contains a literal ".".
 */
export type ResponseMutation =
  | { op: 'set_status'; value: number }
  | { op: 'delete_field'; path: string[] }
  | { op: 'set_field'; path: string[]; value: unknown };

interface FaultFile {
  method: HttpMethod;
  path: string;
  mutation: ResponseMutation;
}

function locate(body: unknown, path: string[]): { parent: Record<string, unknown>; key: string } | undefined {
  if (path.length === 0) return undefined;
  let node: unknown = body;
  for (let i = 0; i < path.length - 1; i++) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[path[i]!];
  }
  if (node === null || typeof node !== 'object') return undefined;
  return { parent: node as Record<string, unknown>, key: path[path.length - 1]! };
}

/**
 * Applies one mutation to a real response, reporting whether it actually
 * changed anything - a hard-won lesson: a mutation whose target
 * path isn't present in this particular response had no effect, and a
 * resulting pass must never be read as "the assertion survived a real
 * fault." `response` is never mutated in place; a fresh copy is returned.
 */
export function applyMutation(
  response: ApiResponse,
  mutation: ResponseMutation,
): { response: ApiResponse; applied: boolean } {
  if (mutation.op === 'set_status') {
    const applied = response.status !== mutation.value;
    return { response: { status: mutation.value, body: response.body }, applied };
  }

  const bodyCopy = response.body === undefined ? undefined : structuredClone(response.body);
  const located = locate(bodyCopy, mutation.path);
  if (!located) return { response, applied: false };

  if (mutation.op === 'delete_field') {
    if (!(located.key in located.parent)) return { response, applied: false };
    delete located.parent[located.key];
    return { response: { status: response.status, body: bodyCopy }, applied: true };
  }

  const applied = located.parent[located.key] !== mutation.value;
  located.parent[located.key] = mutation.value;
  return { response: { status: response.status, body: bodyCopy }, applied };
}

function writeFaultResult(applied: boolean): void {
  const resultPath = process.env.SPEC2TEST_FAULT_RESULT;
  if (resultPath) writeFileSync(resultPath, JSON.stringify({ applied }), 'utf8');
}

/**
 * SPEC2TEST_FAULT points at a JSON file {method, path, mutation}. The real
 * request is always made - falsification needs a genuine response to mutate,
 * not a fabricated one - and the mutation is applied only to the SUBJECT
 * request. Whether it actually changed anything is written to
 * SPEC2TEST_FAULT_RESULT, a side channel the generated test never reads;
 * runFalsification reads it to tell "the assertion survived a real fault"
 * apart from "the fault never fired."
 *
 * Targeting is by the subject flag, not by method+path: a chained test can
 * legitimately repeat a route in setup (registering two users before testing
 * that one of them cannot edit the other's article is exactly that shape),
 * and matching on method+path would fire the fault on the first registration
 * instead of the request under test. The fault file still carries method and
 * path, but only so a report says what was targeted.
 */
function faultTransport(faultPath: string): Transport {
  const fault = JSON.parse(readFileSync(faultPath, 'utf8')) as FaultFile;
  return async (method, url, init) => {
    const real = await liveTransport(method, url, init);
    if (!init.subject) return real;
    const { response, applied } = applyMutation(real, fault.mutation);
    writeFaultResult(applied);
    return response;
  };
}

/**
 * SPEC2TEST_CAPTURE points at a path to write this call's real {status,
 * body} to - how runFalsification samples a real response (from the first
 * healthy control's own run, through the actual generated test) for
 * immunity-fault derivation, instead of a hand-rolled parallel HTTP call
 * that could subtly diverge from the test's real auth/{{unique}} logic.
 * Wraps whichever base transport is already selected, so it composes rather
 * than being a fourth exclusive mode.
 */
export function withCapture(base: Transport, capturePath: string): Transport {
  return async (method, url, init) => {
    const result = await base(method, url, init);
    // Subject only: a chained test's setup responses are not what immunity
    // faults are derived from, and letting the last write win would sample
    // whichever request happened to run last.
    if (init.subject) writeFileSync(capturePath, JSON.stringify(result), 'utf8');
    return result;
  };
}

/**
 * SPEC2TEST_TRANSCRIPT_CAPTURE points at a path to build a complete replay
 * transcript at: EVERY request in the run is recorded, keyed exactly the way
 * transcriptTransport looks entries up - "METHOD <resolved pathname>". A
 * chained test makes several requests and replay needs an entry for each,
 * which is why this is separate from SPEC2TEST_CAPTURE: that one stays
 * subject-only because it feeds immunity-fault derivation, which samples the
 * single response the assertions are about.
 *
 * Keying by the *resolved* pathname is what makes a chain replayable at all:
 * the subject's path is only known after a setup step supplies the captured
 * value, so recording the spec's raw `/api/articles/{{capture.slug}}` would
 * produce a key nothing ever looks up.
 *
 * Two setup steps sharing a method+path - registering two users, say -
 * collapse to one entry, so on replay both receive the same canned response.
 * That is acceptable rather than a gap: replay exists to prove the assertion
 * expressions evaluate correctly against a known-good response shape, and the
 * assertions only ever read the subject's response.
 */
export function withTranscriptCapture(base: Transport, transcriptPath: string): Transport {
  const recorded: Record<string, ApiResponse> = {};
  return async (method, url, init) => {
    const result = await base(method, url, init);
    recorded[`${method} ${new URL(url).pathname}`] = result;
    writeFileSync(transcriptPath, JSON.stringify(recorded, null, 2), 'utf8');
    return result;
  };
}

function resolveTransport(): Transport {
  const base = process.env.SPEC2TEST_FAULT
    ? faultTransport(process.env.SPEC2TEST_FAULT)
    : process.env.SPEC2TEST_TRANSCRIPT
      ? transcriptTransport(process.env.SPEC2TEST_TRANSCRIPT)
      : liveTransport;
  const captured = process.env.SPEC2TEST_CAPTURE ? withCapture(base, process.env.SPEC2TEST_CAPTURE) : base;
  return process.env.SPEC2TEST_TRANSCRIPT_CAPTURE
    ? withTranscriptCapture(captured, process.env.SPEC2TEST_TRANSCRIPT_CAPTURE)
    : captured;
}

let transport: Transport = resolveTransport();

/** Test-only escape hatch: lets the validator's replay stage (or step-4
 *  fault injection) swap the transport without touching any generated test. */
export function setTransport(next: Transport): void {
  transport = next;
}

class ApiClient {
  request(method: HttpMethod, path: string, opts: RequestOptions): Promise<ApiResponse> {
    const baseUrl = (process.env.CONDUIT_BASE_URL ?? '').replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('CONDUIT_BASE_URL is not set');
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth === 'user') {
      const token = opts.authToken || process.env.TARGET_AUTH_TOKEN;
      if (!token) {
        throw new Error('TARGET_AUTH_TOKEN is not set - required for an auth: "user" request');
      }
      headers.Authorization = `Bearer ${token}`;
    }

    return transport(method, `${baseUrl}${path}`, { body: opts.body, headers, subject: opts.subject });
  }
}

export const apiClient = new ApiClient();
