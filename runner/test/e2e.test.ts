/**
 * Live end-to-end test: generate -> validate -> run, against the real
 * self-hosted Conduit fork and the real State Service. Skipped entirely when
 * CONDUIT_BASE_URL is unset (offline machines, CI without the target app);
 * once it's set, every precondition (State Service reachable, Postgres up)
 * fails loud rather than silently skipping - the developer opted into a live
 * run by setting the env var.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenApiSchema } from '../src/spec/openapi.ts';
import { validateSpec } from '../src/spec/validateSpec.ts';
import { generate } from '../src/generator/index.ts';
import { validate } from '../src/validator/index.ts';
import type { TestCaseSpec } from '../src/spec/types.ts';

for (const path of ['../.env', '.env']) {
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
  break;
}

const live = Boolean(process.env.CONDUIT_BASE_URL);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');
const STATE_SERVICE = process.env.STATE_SERVICE_URL ?? 'http://localhost:8787';

const FIXTURE_NAMES = ['register-user', 'login-user', 'create-article', 'login-wrong-password'] as const;

async function registerEnvironment(targetRepoPath: string, baseUrl: string, openapiPath: string): Promise<void> {
  const projectRes = await fetch(`${STATE_SERVICE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'S2T', jira_project_key: 'S2T', target_repo_path: targetRepoPath }),
  });
  if (!projectRes.ok) {
    throw new Error(
      `State Service unreachable or refused /projects (${projectRes.status}) - is "npm start" running in service/?`,
    );
  }
  const project = (await projectRes.json()) as { id: string };

  const envRes = await fetch(`${STATE_SERVICE}/environments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: project.id, base_url: baseUrl, class: 'dedicated', openapi_url: openapiPath }),
  });
  if (!envRes.ok) {
    throw new Error(`State Service refused /environments (${envRes.status})`);
  }

  const resolveRes = await fetch(
    `${STATE_SERVICE}/environments/resolve?project_id=${project.id}&base_url=${encodeURIComponent(baseUrl)}`,
  );
  if (!resolveRes.ok) {
    throw new Error(`environment allowlist did not resolve ${baseUrl} after registering it (${resolveRes.status})`);
  }
}

describe('runner e2e (live)', { skip: !live && 'CONDUIT_BASE_URL not set' }, () => {
  const targetRepoRoot = process.env.CONDUIT_REPO_PATH ?? '';
  const spec2testDir = join(targetRepoRoot, 'spec2test');
  const schema = loadOpenApiSchema(join(FIXTURES, 'openapi', 'conduit.snapshot.yml'));

  before(async () => {
    if (!targetRepoRoot) {
      throw new Error('CONDUIT_BASE_URL is set but CONDUIT_REPO_PATH is not - both are required for the live e2e run');
    }
    if (!existsSync(spec2testDir)) {
      throw new Error(
        `${spec2testDir} does not exist - run "npm run init --workspace=runner -- ${targetRepoRoot}" first`,
      );
    }
    // Preflight: the environment-allowlist machinery, exercised over real
    // HTTP against a really-running State Service - the same path the
    // eventual plugin will use, not an in-process shortcut.
    await registerEnvironment(targetRepoRoot, process.env.CONDUIT_BASE_URL!, join(spec2testDir, 'openapi.yml'));
  });

  for (const name of FIXTURE_NAMES) {
    it(`generates, validates and smoke-runs "${name}"`, async () => {
      const spec = JSON.parse(readFileSync(join(FIXTURES, 'specs', `${name}.json`), 'utf8')) as TestCaseSpec;

      validateSpec(spec, schema);

      const generatedDir = join(spec2testDir, 'generated');
      const { filePath, source } = generate(spec, generatedDir);

      const report = validate({
        filePath,
        source,
        spec,
        targetRepoRoot,
        spec2testDir,
        transcriptPath: join(FIXTURES, 'transcripts', `${name}.json`),
        runSmoke: true,
      });

      if (!report.ok) {
        const failing = report.stages.find((s) => !s.ok)!;
        assert.fail(`${failing.stage} failed:\n${failing.details.join('\n')}`);
      }
      assert.ok(report.ok);
    });
  }
});
