import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedArgs } from '../cli.ts';
import { emit, emitFailure, emitApiFailure } from '../output.ts';
import { ConfigError, loadConfig } from '../config.ts';
import { createHttpClient } from '../http.ts';
import { resolveProject, resolveEnvironment } from '../resolve.ts';
import { loadPrompt, PromptHashMismatchError } from '../prompts.ts';
import { contentHash } from '../hash.ts';

/**
 * The version this build of the CLI was written against. Pinned, not read
 * from the service - the whole point of the handshake (server.ts's own
 * API_VERSION doc comment) is that a cached older plugin refuses to run
 * against a newer/incompatible schema rather than guessing it's fine.
 */
const EXPECTED_API_VERSION = 4;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const CANONICAL_CLIENT = join(REPO_ROOT, 'runner', 'src', 'client', 'apiClient.ts');

/**
 * Ten checks, in order, stopping at the first failure. Fails loud - never
 * warns. See PLAN-5.3-5.7-WALKING-SKELETON.md 5.6 for why each one is here;
 * check 10 (vendored client freshness) is the one not in the master plan's
 * own list and the most valuable: a stale vendored client silently ignores
 * `subject: true`, so every fault stops firing and every kill fault scores
 * INCONCLUSIVE while the suite stays green - a silent-green failure of
 * exactly the kind this project exists to catch.
 */
export async function runPreflight(_args: ParsedArgs): Promise<never> {
  const command = 'preflight';

  // 1. config vars present
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      emitFailure(command, err.event, err.message, 'set the missing variable(s) in .env, then retry');
    }
    throw err;
  }

  const http = createHttpClient(cfg.serviceUrl);

  // 2. service reachable
  const version = await http.get<{ service: string; apiVersion: number }>('/version');
  if (!version.ok) {
    emitFailure(
      command,
      version.event,
      version.message,
      'start it: node --experimental-strip-types --env-file=../.env src/api/server.ts (from service/)',
    );
  }

  // 3. API version match
  if (version.body.apiVersion !== EXPECTED_API_VERSION) {
    emitFailure(
      command,
      'api_version_mismatch',
      `this CLI expects API_VERSION ${EXPECTED_API_VERSION}, the service reports ${version.body.apiVersion}`,
      'update the plugin, or the service, so both agree',
    );
  }

  // 4. Jira field-map validation
  const jiraPreflight = await http.get<{ ok: true; accountId: string; base: string }>('/jira/preflight');
  if (!jiraPreflight.ok) {
    emitApiFailure(command, jiraPreflight);
  }

  // 5. project registered
  const project = await resolveProject(http, cfg);
  if (!project.ok) {
    emitFailure(
      command,
      'project_not_registered',
      `project "${cfg.projectKey}" is not registered with the State Service (${project.event}: ${project.message})`,
      'register it: POST /projects {key, jira_project_key, target_repo_path}',
    );
  }

  // 6. target base URL in the environment allowlist
  const environment = await resolveEnvironment(http, project.body.id, cfg.conduitBaseUrl);
  if (!environment.ok) {
    emitApiFailure(command, environment);
  }

  // 7. grounding readable
  const grounding = await http.get<{ contentHash: string; source: string }>(
    `/environments/${environment.body.id}/grounding`,
  );
  if (!grounding.ok) {
    emitApiFailure(command, grounding);
  }

  // 8. every prompt's hash matches the lock
  try {
    loadPrompt('criteria.v1.md');
    loadPrompt('testcase.v1.md');
  } catch (err) {
    if (err instanceof PromptHashMismatchError) {
      emitFailure(command, err.event, err.message);
    }
    throw err;
  }

  // 9. target repo checked out and scaffolded
  const spec2testDir = join(cfg.conduitRepoPath, 'spec2test');
  if (!existsSync(cfg.conduitRepoPath)) {
    emitFailure(
      command,
      'target_repo_missing',
      `CONDUIT_REPO_PATH (${cfg.conduitRepoPath}) does not exist`,
      'check the path in .env, or clone the target repo there',
    );
  }
  if (!existsSync(spec2testDir)) {
    emitFailure(
      command,
      'target_repo_missing',
      `${spec2testDir} does not exist`,
      "run the runner's init: node --experimental-strip-types runner/src/cli.ts init <target-repo-path>",
    );
  }

  // 10. vendored client freshness - the check not in the master plan's own
  // list; see this file's doc comment for why it matters.
  const vendoredClientPath = join(spec2testDir, 'client', 'apiClient.ts');
  if (!existsSync(vendoredClientPath)) {
    emitFailure(
      command,
      'vendored_client_stale',
      `${vendoredClientPath} does not exist`,
      "run the runner's init to scaffold it",
    );
  }
  const canonicalHash = contentHash(readFileSync(CANONICAL_CLIENT, 'utf8'));
  const vendoredHash = contentHash(readFileSync(vendoredClientPath, 'utf8'));
  if (canonicalHash !== vendoredHash) {
    emitFailure(
      command,
      'vendored_client_stale',
      `${vendoredClientPath} does not match runner/src/client/apiClient.ts - a stale vendored client ` +
        'silently ignores `subject: true`, so every fault stops firing and every kill fault scores ' +
        'INCONCLUSIVE while the suite stays green',
      "re-run the runner's init to re-vendor it",
    );
  }

  emit({
    ok: true,
    command,
    apiVersion: version.body.apiVersion,
    jira: { accountId: jiraPreflight.body.accountId, base: jiraPreflight.body.base },
    project: { id: project.body.id, key: project.body.key },
    environment: { id: environment.body.id, class: environment.body.class, capabilities: environment.body.capabilities },
    grounding: { contentHash: grounding.body.contentHash, source: grounding.body.source },
    prompts: 'ok',
    targetRepo: spec2testDir,
    vendoredClient: 'ok',
  });
}
