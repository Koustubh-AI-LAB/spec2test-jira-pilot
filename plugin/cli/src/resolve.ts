import type { HttpClient, ApiResult, ApiFailure } from './http.ts';
import type { Config } from './config.ts';

export interface ProjectRow {
  id: string;
  key: string;
  jira_project_key: string;
  target_repo_path: string;
}

export interface EnvironmentRow {
  id: string;
  project_id: string;
  base_url: string;
  class: string;
  openapi_url: string;
  capabilities: { tier1Injection: boolean; tier2StateSeeding: boolean; tier3ConfigFlip: boolean; smokeOnly: boolean };
}

/** GET /projects/:key - a read, never the POST upsert. */
export function resolveProject(http: HttpClient, cfg: Config): Promise<ApiResult<ProjectRow>> {
  return http.get<ProjectRow>(`/projects/${encodeURIComponent(cfg.projectKey)}`);
}

/** GET /environments/resolve - the allowlist check itself. 403
 *  `environment_not_allowed` for a base_url nothing registered. */
export function resolveEnvironment(
  http: HttpClient,
  projectId: string,
  baseUrl: string,
): Promise<ApiResult<EnvironmentRow>> {
  return http.get<EnvironmentRow>('/environments/resolve', { project_id: projectId, base_url: baseUrl });
}

export type ResolvedContext =
  | { ok: true; project: ProjectRow; environment: EnvironmentRow }
  | { ok: false; failure: ApiFailure };

/** For commands that need both - draft-test-case, grounding, verify. Commands
 *  that only touch Jira (status, reconcile, post-criteria, sync,
 *  approve-test-case) resolve just the project via resolveProject. */
export async function resolveContext(http: HttpClient, cfg: Config): Promise<ResolvedContext> {
  const project = await resolveProject(http, cfg);
  if (!project.ok) return { ok: false, failure: project };
  const environment = await resolveEnvironment(http, project.body.id, cfg.conduitBaseUrl);
  if (!environment.ok) return { ok: false, failure: environment };
  return { ok: true, project: project.body, environment: environment.body };
}
