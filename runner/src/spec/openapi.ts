import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import type { HttpMethod } from './types.ts';

/** The parsed OpenAPI document, kept around (not just the summarised
 *  {paths} view) so body-shape checks can resolve $ref pointers into
 *  components.schemas - route existence alone doesn't prove a spec's body
 *  matches what the endpoint actually expects. */
type RawDoc = Record<string, unknown>;

export interface OpenApiDoc {
  /** The server's own base path (e.g. "/api" from "https://host/api"), so a
   *  spec's full request path can be compared against the schema's paths,
   *  which are documented relative to that server URL. */
  readonly serverBasePath: string;
  readonly paths: Readonly<Record<string, readonly HttpMethod[]>>;
  readonly hash: string;
  readonly raw: RawDoc;
}

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE'];

export function loadOpenApiSchema(filePath: string): OpenApiDoc {
  const rawText = readFileSync(filePath, 'utf8');
  const doc = parse(rawText) as {
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
    hash: createHash('sha256').update(rawText.replace(/\r\n/g, '\n').trim(), 'utf8').digest('hex'),
    raw: doc as RawDoc,
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

/** A spec's full request path (e.g. "/api/articles") relative to the
 *  schema's own server base path (e.g. "/api") - the form the schema's own
 *  `paths` keys use. Shared by isGrounded and the body-shape check so they
 *  agree on what "the same endpoint" means. */
function toSchemaRelativePath(schema: OpenApiDoc, requestPath: string): string {
  return schema.serverBasePath && requestPath.startsWith(schema.serverBasePath)
    ? requestPath.slice(schema.serverBasePath.length) || '/'
    : requestPath;
}

/** The schema's own path template (e.g. "/articles/{slug}") that matches a
 *  request path + method, or undefined if none does. */
function matchingTemplate(schema: OpenApiDoc, method: HttpMethod, requestPath: string): string | undefined {
  const relative = toSchemaRelativePath(schema, requestPath);
  for (const [template, methods] of Object.entries(schema.paths)) {
    if (methods.includes(method) && pathToRegExp(template).test(relative)) return template;
  }
  return undefined;
}

/**
 * True when `method path` (a full request path, e.g. "/api/articles") is
 * documented by the schema. The schema's own paths are relative to its
 * server URL, so the server's base path is stripped first.
 */
export function isGrounded(schema: OpenApiDoc, method: HttpMethod, requestPath: string): boolean {
  return matchingTemplate(schema, method, requestPath) !== undefined;
}

function resolveRef(doc: RawDoc, ref: string): unknown {
  const segments = ref.replace(/^#\//, '').split('/');
  let node: unknown = doc;
  for (const segment of segments) {
    node = (node as Record<string, unknown> | undefined)?.[segment];
  }
  return node;
}

/** Follows a `$ref` chain (requestBody -> components.requestBodies.X, schema
 *  -> components.schemas.Y, ...) until it lands on a real object. */
function resolve(doc: RawDoc, node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === 'string') return resolve(doc, resolveRef(doc, obj.$ref));
  return obj;
}

function requestBodyJsonSchema(schema: OpenApiDoc, method: HttpMethod, requestPath: string): Record<string, unknown> | undefined {
  const template = matchingTemplate(schema, method, requestPath);
  if (!template) return undefined;

  const pathItem = (schema.raw.paths as Record<string, Record<string, unknown>> | undefined)?.[template];
  const operation = pathItem?.[method.toLowerCase()] as Record<string, unknown> | undefined;
  const requestBody = resolve(schema.raw, operation?.requestBody);
  const content = requestBody?.content as Record<string, { schema?: unknown }> | undefined;
  return resolve(schema.raw, content?.['application/json']?.schema);
}

/**
 * Dotted paths (e.g. "user.email") present as `required` in the schema but
 * absent from `body`. Deliberately a *presence* check, not full JSON-schema
 * validation (types, formats, enums) - proving grounding means more than
 * "the route exists" without pulling in a full schema validator for a
 * pilot's three fixtures.
 */
function missingRequiredFields(
  doc: RawDoc,
  jsonSchema: Record<string, unknown> | undefined,
  value: unknown,
  path: string,
): string[] {
  const resolved = resolve(doc, jsonSchema);
  if (!resolved || resolved.type !== 'object' || typeof value !== 'object' || value === null) return [];

  const object = value as Record<string, unknown>;
  const missing: string[] = [];
  for (const key of (resolved.required as string[] | undefined) ?? []) {
    if (!(key in object)) missing.push(`${path}${key}`);
  }
  const properties = (resolved.properties as Record<string, unknown> | undefined) ?? {};
  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in object) {
      missing.push(...missingRequiredFields(doc, propSchema as Record<string, unknown>, object[key], `${path}${key}.`));
    }
  }
  return missing;
}

/**
 * Body-shape grounding: for a documented endpoint with a requestBody schema,
 * which required fields (at any nesting level) does `body` fail to declare.
 * Empty array when the endpoint has no documented requestBody, or `body` is
 * undefined and none is required - those aren't this function's problem to
 * flag, isGrounded already covers route existence.
 */
export function missingRequiredBodyFields(
  schema: OpenApiDoc,
  method: HttpMethod,
  requestPath: string,
  body: unknown,
): string[] {
  const jsonSchema = requestBodyJsonSchema(schema, method, requestPath);
  if (!jsonSchema) return [];
  return missingRequiredFields(schema.raw, jsonSchema, body, '');
}
