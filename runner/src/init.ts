import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// spec2test/playwright.config.ts -> repo root. __dirname, not
// import.meta.url: Playwright loads this config as CommonJS whenever the
// target repo's own package.json has no "type": "module" (Conduit's
// doesn't), and import.meta.url throws under CJS. Manual .env parse, same
// pattern service/test/jira.test.ts uses - no dotenv dependency needed.
const repoRoot = join(__dirname, '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

export default defineConfig({
  testDir: './generated',
  timeout: 30_000,
  use: {
    baseURL: process.env.CONDUIT_BASE_URL,
  },
});
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node", "@playwright/test"]
  },
  "include": ["**/*.ts"]
}
`;

/**
 * Scaffolds/refreshes spec2test/ in the target app's own repo - the actual
 * artifact home. Re-run when the client wrapper changes,
 * not on every generate.
 */
export function initTargetRepo(targetRepoRoot: string): void {
  const spec2testDir = join(targetRepoRoot, 'spec2test');
  const clientDir = join(spec2testDir, 'client');
  const generatedDir = join(spec2testDir, 'generated');

  mkdirSync(clientDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });

  copyFileSync(join(HERE, 'client', 'apiClient.ts'), join(clientDir, 'apiClient.ts'));
  writeFileSync(join(spec2testDir, 'playwright.config.ts'), PLAYWRIGHT_CONFIG, 'utf8');
  writeFileSync(join(spec2testDir, 'tsconfig.json'), TSCONFIG, 'utf8');
  if (!existsSync(join(generatedDir, '.gitkeep'))) {
    writeFileSync(join(generatedDir, '.gitkeep'), '', 'utf8');
  }
}
