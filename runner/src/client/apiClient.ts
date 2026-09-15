import { readFileSync } from 'node:fs';

/**
 * The typed client every generated test must use - the seam this whole
 * design hangs off. `transport` is swappable: real fetch by default, a
 * canned-transcript reader for the validator's replay stage now, and Tier-1
 * fault injection at step 4, all without touching a single generated test.
 *
 * This file is vendored (copied, not imported) into the target app's repo at
 * spec2test/client/apiClient.ts, so generated tests run standalone via that
 * repo's own `npx playwright test` with no dependency on this pilot repo.
 * The import whitelist only scans generated test files, never this one - a
 * generated test can't import 'fs' directly, but this wrapper legitimately
 * needs it to read a replay transcript.
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
  body: any;
}

export interface RequestOptions {
  body?: unknown;
  auth: AuthMode;
}

export type Transport = (
  method: HttpMethod,
  url: string,
  init: { body?: unknown; headers: Record<string, string> },
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

let transport: Transport = process.env.SPEC2TEST_TRANSCRIPT
  ? transcriptTransport(process.env.SPEC2TEST_TRANSCRIPT)
  : liveTransport;

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
      const token = process.env.TARGET_AUTH_TOKEN;
      if (!token) {
        throw new Error('TARGET_AUTH_TOKEN is not set - required for an auth: "user" request');
      }
      headers.Authorization = `Bearer ${token}`;
    }

    return transport(method, `${baseUrl}${path}`, { body: opts.body, headers });
  }
}

export const apiClient = new ApiClient();
