/**
 * Proves the subprocess boundary itself: service/'s worker will shell out to
 * this CLI rather than import runner/'s TypeScript (see src/errors.ts), so
 * these tests spawn the real `node` process running `src/cli.ts`, the same
 * way the worker eventually will - not an in-process function call, which
 * would prove the wrapped function works but say nothing about arg parsing,
 * JSON framing, or the exit-code contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(HERE, '..', 'src', 'cli.ts');
const FIXTURES = join(HERE, '..', 'fixtures');
const OPENAPI = join(FIXTURES, 'openapi', 'conduit.snapshot.yml');

for (const path of ['../.env', '.env']) {
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
  break;
}
const live = Boolean(process.env.CONDUIT_BASE_URL);
const targetRepoRoot = process.env.CONDUIT_REPO_PATH ?? '';

function runCli(args: string[]): { status: number | null; stdout: unknown; stderr: unknown } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    encoding: 'utf8',
  });
  let stdout: unknown;
  let stderr: unknown;
  try {
    stdout = JSON.parse(result.stdout);
  } catch {
    stdout = result.stdout;
  }
  try {
    stderr = JSON.parse(result.stderr);
  } catch {
    stderr = result.stderr;
  }
  return { status: result.status, stdout, stderr };
}

function writeSpecFile(dir: string, spec: unknown): string {
  const path = join(dir, 'spec.json');
  writeFileSync(path, JSON.stringify(spec), 'utf8');
  return path;
}

const registerSpec = {
  criterionId: 'C-REGISTER-USER',
  name: 'register a new user',
  method: 'POST',
  path: '/api/users',
  auth: 'none',
  body: {
    user: {
      username: 'spec2test_{{unique}}',
      email: 'spec2test_{{unique}}@spec2test.dev',
      password: 'Spec2Test!1',
    },
  },
  assertions: [
    { name: 'status_201', check: 'status === 201' },
    { name: 'has_token', check: 'body.user.token' },
  ],
};

describe('runner CLI', () => {
  it('rejects an unknown command as a usage error, exit 1', () => {
    const { status, stderr } = runCli(['not-a-real-command']);
    assert.equal(status, 1);
    assert.equal((stderr as { event: string }).event, 'usage_error');
  });

  it('validate-spec: reports ok:true for a grounded spec, exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec2test-cli-'));
    try {
      const specPath = writeSpecFile(dir, registerSpec);
      const { status, stdout } = runCli(['validate-spec', specPath, OPENAPI]);
      assert.equal(status, 0);
      assert.deepEqual(stdout, { ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validate-spec: reports ok:false with the grounding error for an undocumented route - exit 0, a rejection is data, not a crash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec2test-cli-'));
    try {
      const ungroundedSpec = { ...registerSpec, path: '/api/not-a-real-route' };
      const specPath = writeSpecFile(dir, ungroundedSpec);
      const { status, stdout } = runCli(['validate-spec', specPath, OPENAPI]);
      assert.equal(status, 0);
      const result = stdout as { ok: boolean; event: string; message: string };
      assert.equal(result.ok, false);
      assert.equal(result.event, 'spec_not_grounded');
      assert.match(result.message, /not documented in the OpenAPI schema/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validate-spec: ok:true plus hints for a grounded spec whose check cannot derive a kill fault', () => {
    // Grounding alone would pass this spec and it would generate a
    // green-looking test - but falsification could never certify it, since
    // no kill fault can be derived from this check. See
    // unparseableAssertionHints's doc comment (deriveKillFaults.ts) and
    // PLAN-5.3-5.7-WALKING-SKELETON.md 0.3.
    const dir = mkdtempSync(join(tmpdir(), 'spec2test-cli-'));
    try {
      const spec = {
        ...registerSpec,
        assertions: [
          { name: 'status_201', check: 'status === 201' },
          { name: 'exact_snapshot', check: 'JSON.stringify(body) === "{}"' },
        ],
      };
      const specPath = writeSpecFile(dir, spec);
      const { status, stdout } = runCli(['validate-spec', specPath, OPENAPI]);
      assert.equal(status, 0);
      const result = stdout as { ok: boolean; hints?: string[] };
      assert.equal(result.ok, true);
      assert.equal(result.hints?.length, 1);
      assert.match(result.hints![0]!, /"exact_snapshot"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generate: writes the file and reports its content hash, exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec2test-cli-'));
    try {
      const specPath = writeSpecFile(dir, registerSpec);
      const outDir = join(dir, 'generated');
      const { status, stdout } = runCli(['generate', specPath, outDir]);
      assert.equal(status, 0);
      const result = stdout as { ok: boolean; filePath: string; fileName: string; contentHash: string };
      assert.equal(result.ok, true);
      assert.equal(result.fileName, 'register-a-new-user.spec.ts');
      assert.match(readFileSync(result.filePath, 'utf8'), /export const criterionId = "C-REGISTER-USER";/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generate: refuses to clobber a hand-edited file (ok:false, exit 0), --force overrides it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec2test-cli-'));
    try {
      const specPath = writeSpecFile(dir, registerSpec);
      const outDir = join(dir, 'generated');
      const first = runCli(['generate', specPath, outDir]);
      const filePath = (first.stdout as { filePath: string }).filePath;
      writeFileSync(filePath, readFileSync(filePath, 'utf8') + '\n// hand-edited\n', 'utf8');

      const second = runCli(['generate', specPath, outDir]);
      assert.equal(second.status, 0);
      const result = second.stdout as { ok: boolean; event: string };
      assert.equal(result.ok, false);
      assert.equal(result.event, 'generated_file_would_be_overwritten');

      const forced = runCli(['generate', specPath, outDir, '--force']);
      assert.equal((forced.stdout as { ok: boolean }).ok, true);
      assert.doesNotMatch(readFileSync(filePath, 'utf8'), /hand-edited/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generate: missing required args is a usage error, exit 1', () => {
    const { status, stderr } = runCli(['generate', 'only-one-arg']);
    assert.equal(status, 1);
    assert.equal((stderr as { event: string }).event, 'usage_error');
  });

  describe('validate (live, against real Conduit)', { skip: !live && 'CONDUIT_BASE_URL not set' }, () => {
    it('synthesizes a transcript from a live capture and passes replay + smoke - regression test for the capture/transcript shape mismatch found while wiring the worker', () => {
      const dir = mkdtempSync(join(tmpdir(), 'spec2test-cli-live-'));
      try {
        const spec = {
          criterionId: 'C-CLI-VALIDATE-LIVE',
          name: `cli validate live ${Date.now()}`,
          method: 'POST',
          path: '/api/users',
          auth: 'none',
          body: {
            user: {
              username: 'spec2test_clival_{{unique}}',
              email: 'spec2test_clival_{{unique}}@spec2test.dev',
              password: 'Spec2Test!1',
            },
          },
          assertions: [
            { name: 'status_201', check: 'status === 201' },
            { name: 'has_token', check: 'body.user.token' },
          ],
        };
        const specPath = writeSpecFile(dir, spec);
        const spec2testDir = join(targetRepoRoot, 'spec2test');
        const outDir = join(spec2testDir, 'generated');
        const generated = runCli(['generate', specPath, outDir]);
        const filePath = (generated.stdout as { filePath: string }).filePath;

        const { status, stdout } = runCli(['validate', specPath, filePath, targetRepoRoot, spec2testDir]);
        assert.equal(status, 0);
        const report = stdout as { ok: boolean; stages: { stage: string; ok: boolean; details: string[] }[] };
        assert.equal(report.ok, true, JSON.stringify(report));
        const replayStage = report.stages.find((s) => s.stage === 'replay');
        assert.equal(replayStage?.ok, true, JSON.stringify(replayStage));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
