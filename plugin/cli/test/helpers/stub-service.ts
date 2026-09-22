/**
 * A dependency-free HTTP stub standing in for the State Service. The CLI
 * talks real fetch() to a real base URL, so `app.inject()` (the pattern
 * service/test/*.test.ts uses) doesn't apply here - there is no in-process
 * app to inject into, only a real listening server. Built on node:http
 * rather than pulling in Fastify as a CLI-only test dependency.
 */
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface StubRoute {
  status: number;
  body: unknown;
}

export interface StubService {
  url: string;
  requests: RecordedRequest[];
  /** Programs the response for the next (and every subsequent) request to
   *  method+path (query ignored for matching - inspect `requests` for it). */
  respond(method: string, path: string, route: StubRoute): void;
  close(): Promise<void>;
}

export function startStubService(): Promise<StubService> {
  const routes = new Map<string, StubRoute>();
  const requests: RecordedRequest[] = [];

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }

      const url = new URL(req.url ?? '/', 'http://stub');
      requests.push({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body });

      const key = `${req.method} ${url.pathname}`;
      const route = routes.get(key);
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ event: 'stub_route_not_programmed', message: `no stub programmed for ${key}` }));
        return;
      }
      res.writeHead(route.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(route.body));
    });
  }

  return new Promise((resolve, reject) => {
    const server: Server = createServer(handle);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        respond: (method, path, route) => routes.set(`${method} ${path}`, route),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
