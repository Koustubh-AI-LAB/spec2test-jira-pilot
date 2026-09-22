import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * The one place this CLI talks HTTP to the State Service. Every failure mode
 * - unreachable service, a non-JSON response, a {event,message} business
 * error - resolves to the SAME ApiResult shape rather than throwing.
 *
 * That is deliberate: "the service is down" is routine, expected, actionable
 * data for the skill (a distinct event a stage block can react to), not a CLI
 * bug. Only a genuine crash (a real exception this module did not expect)
 * should ever reach the CLI's exit-1 path - see cli.ts's top-level catch.
 *
 * Uses node:http/https directly, with `agent: false`, rather than the
 * global fetch() the rest of this monorepo uses (service/src/jira/client.ts)
 * - a deliberate, narrow divergence. fetch() is backed by undici's pooled,
 * keep-alive dispatcher, which is the right default for a long-running
 * service process but actively wrong here: this CLI is one-shot - a single
 * command, then `process.exit()` - and an open pooled/keep-alive socket
 * still technically live at that moment raced process teardown on Windows
 * (reproduced directly: multi-request commands like `preflight` and
 * `draft-test-case` intermittently reported exit code 3221226505 /
 * 0xC0000409 - a stack-buffer-overrun status - while the JSON payload
 * itself still arrived on stdout intact; single-request commands like
 * `status` never showed it). `agent: false` opens a fresh socket per
 * request and closes it the moment the response completes, so nothing is
 * ever still open by the time a command reaches process.exit().
 */
export interface ApiSuccess<T> {
  ok: true;
  status: number;
  body: T;
}

export interface ApiFailure {
  ok: false;
  status: number;
  event: string;
  message: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export interface HttpClient {
  get<T>(path: string, query?: Record<string, string | undefined>): Promise<ApiResult<T>>;
  post<T>(path: string, body?: unknown): Promise<ApiResult<T>>;
}

export function createHttpClient(baseUrl: string): HttpClient {
  const parsedBase = new URL(baseUrl);
  const doRequest = parsedBase.protocol === 'https:' ? httpsRequest : httpRequest;

  function raw(method: 'GET' | 'POST', path: string, payload?: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = doRequest(
        new URL(path, parsedBase),
        {
          method,
          agent: false,
          headers: {
            ...(payload !== undefined
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {}),
            connection: 'close',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
    let res: { status: number; text: string };
    try {
      res = await raw(method, path, body !== undefined ? JSON.stringify(body) : undefined);
    } catch (err) {
      return {
        ok: false,
        status: 0,
        event: 'service_unreachable',
        message:
          `could not reach the State Service at ${baseUrl} - is it running? ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      };
    }

    let parsed: unknown;
    try {
      parsed = res.text ? JSON.parse(res.text) : undefined;
    } catch {
      return {
        ok: false,
        status: res.status,
        event: 'unparseable_response',
        message: `the State Service returned non-JSON (status ${res.status}): ${res.text.slice(0, 500)}`,
      };
    }

    if (res.status >= 400) {
      const err = parsed as { event?: string; message?: string } | undefined;
      return {
        ok: false,
        status: res.status,
        event: err?.event ?? 'service_error',
        message: err?.message ?? `HTTP ${res.status} with no error body`,
      };
    }

    return { ok: true, status: res.status, body: parsed as T };
  }

  return {
    get: (path, query) => {
      const entries = Object.entries(query ?? {}).filter((e): e is [string, string] => e[1] !== undefined);
      const qs = entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : '';
      return request('GET', `${path}${qs}`);
    },
    post: (path, body) => request('POST', path, body),
  };
}
