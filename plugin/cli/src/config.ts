/**
 * Env resolution for the plugin CLI, fails loud. `preflight` (commands/preflight.ts)
 * checks these explicitly as its first step and names exactly what is
 * missing; every other command calls loadConfig() too, so a config gap is
 * refused the same way everywhere rather than only where a developer
 * remembered to check - "fails loud, never warns" as a systemic property,
 * not a per-command habit.
 *
 * SPEC2TEST_JIRA_PROJECT_KEY, present in early drafts of this plan, is
 * deliberately absent: nothing in this CLI ever needs it. The project's
 * `jira_project_key` is stored on the project row at registration time; every
 * command that touches Jira works from `--issue`, the specific ticket key,
 * not the project-wide one.
 */
export interface Config {
  serviceUrl: string;
  projectKey: string;
  actor: string;
  conduitBaseUrl: string;
  conduitRepoPath: string;
}

const REQUIRED = ['SPEC2TEST_PROJECT_KEY', 'SPEC2TEST_ACTOR', 'CONDUIT_BASE_URL', 'CONDUIT_REPO_PATH'] as const;

export class ConfigError extends Error {
  readonly event: string;
  readonly missing: string[];

  // No parameter properties - strip-only mode doesn't support them; see
  // prompts.ts's comment.
  constructor(missing: string[]) {
    super(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set - ` + 'see .env.example at the repo root',
    );
    this.event = 'config_missing';
    this.missing = missing;
  }
}

export function loadConfig(): Config {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) throw new ConfigError(missing);

  return {
    serviceUrl: process.env.SPEC2TEST_SERVICE_URL ?? 'http://127.0.0.1:8787',
    projectKey: process.env.SPEC2TEST_PROJECT_KEY!,
    actor: process.env.SPEC2TEST_ACTOR!,
    conduitBaseUrl: process.env.CONDUIT_BASE_URL!,
    conduitRepoPath: process.env.CONDUIT_REPO_PATH!,
  };
}
