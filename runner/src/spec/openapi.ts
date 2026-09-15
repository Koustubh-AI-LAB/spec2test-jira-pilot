import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import type { HttpMethod } from './types.ts';

export interface OpenApiDoc {
  /** The server's own base path (e.g. "/api" from "https://host/api"), so a
   *  spec's full request path can be compared against the schema's paths,
   *  which are documented relative to that server URL. */
  readonly serverBasePath: string;
  readonly paths: Readonly<Record<string, readonly HttpMethod[]>>;
  readonly hash: string;
}

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE'];

export function loadOpenApiSchema(filePath: string): OpenApiDoc {
  const raw = readFileSync(filePath, 'utf8');
  const doc = parse(raw) as {
    servers?: { url: string }[];
    paths?: Record<string, Record<string, unknown>>;
  };

  const serverUrl = doc.servers?.[0]?.url ?? '';
  const serverBasePath = (() => {
    try {
      return new URL(serverUrl).pathname.replace(/\/+$/, '');
    } catch {
      return '';
    }
  })();

  const paths: Record<string, HttpMethod[]> = {};
  for (const [path, operations] of Object.entries(doc.paths ?? {})) {
    const methods = Object.keys(operations)
      .map((m) => m.toUpperCase())
      .filter((m): m is HttpMethod => (METHODS as string[]).includes(m));
    paths[path] = methods;
  }

  return {
    serverBasePath,
    paths,
    hash: createHash('sha256').update(raw.replace(/\r\n/g, '\n').trim(), 'utf8').digest('hex'),
  };
}

/** "/users/{id}" -> /^\/users\/[^/]+$/ */
function pathToRegExp(template: string): RegExp {
  const escaped = template
    .split('/')
    .map((segment) => (segment.startsWith('{') && segment.endsWith('}') ? '[^/]+' : escapeRegExp(segment)))
    .join('/');
  return new RegExp(`^${escaped}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `method path` (a full request path, e.g. "/api/articles") is
 * documented by the schema. The schema's own paths are relative to its
 * server URL, so the server's base path is stripped first.
 */
export function isGrounded(schema: OpenApiDoc, method: HttpMethod, requestPath: string): boolean {
  const relative = schema.serverBasePath && requestPath.startsWith(schema.serverBasePath)
    ? requestPath.slice(schema.serverBasePath.length) || '/'
    : requestPath;

  for (const [template, methods] of Object.entries(schema.paths)) {
    if (!methods.includes(method)) continue;
    if (pathToRegExp(template).test(relative)) return true;
  }
  return false;
}
