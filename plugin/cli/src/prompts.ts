import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from './hash.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROMPTS_DIR = join(HERE, '..', '..', 'prompts');
const LOCK_PATH = join(PROMPTS_DIR, 'prompts.lock.json');

export interface LoadedPrompt {
  id: string;
  file: string;
  hash: string;
  /** The instructions themselves, after the frontmatter block. */
  body: string;
}

/**
 * Fails loud when a prompt file's hash differs from `prompts.lock.json` - an
 * edited prompt must not ship under a stale version id. See
 * PLAN-5.3-5.7-WALKING-SKELETON.md 5.4.
 */
export class PromptHashMismatchError extends Error {
  readonly event: string;
  readonly file: string;
  readonly locked: string;
  readonly actual: string;

  // Written without TypeScript parameter properties on purpose - see
  // service/src/errors.ts's own comment: Node's strip-only type removal does
  // not support them.
  constructor(file: string, locked: string, actual: string) {
    super(
      `${file}: the hash in prompts.lock.json (${locked.slice(0, 12)}) does not match ` +
        `the file on disk (${actual.slice(0, 12)}) - an edited prompt must not ship under ` +
        'a stale version id. Run "npm run prompts:lock -w @spec2test/plugin-cli" to regenerate deliberately.',
    );
    this.event = 'prompt_hash_mismatch';
    this.file = file;
    this.locked = locked;
    this.actual = actual;
  }
}

function parseFrontmatter(raw: string, file: string): { id: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${file}: no frontmatter block ("---\\n...\\n---") found`);
  const idMatch = /^id:\s*(\S+)\s*$/m.exec(match[1]!);
  if (!idMatch) throw new Error(`${file}: frontmatter has no "id" field`);
  return { id: idMatch[1]!, body: match[2]! };
}

function loadLock(): Record<string, string> {
  if (!existsSync(LOCK_PATH)) return {};
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Record<string, string>;
}

/** Loads and verifies one prompt file against the committed lock. */
export function loadPrompt(filename: string): LoadedPrompt {
  const raw = readFileSync(join(PROMPTS_DIR, filename), 'utf8');
  const hash = contentHash(raw);
  const locked = loadLock()[filename];
  if (locked === undefined || locked !== hash) {
    throw new PromptHashMismatchError(filename, locked ?? '(not in lock)', hash);
  }
  const { id, body } = parseFrontmatter(raw, filename);
  return { id, file: filename, hash, body };
}

/** Regenerates prompts.lock.json from every .md file in the prompts
 *  directory. Only ever called deliberately (`npm run prompts:lock`), never
 *  at runtime - loadPrompt() must fail loud until this is re-run by hand. */
export function regenerateLock(): Record<string, string> {
  const files = readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const lock: Record<string, string> = {};
  for (const file of files) {
    lock[file] = contentHash(readFileSync(join(PROMPTS_DIR, file), 'utf8'));
  }
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv.includes('--lock');
if (invokedDirectly) {
  const lock = regenerateLock();
  console.log(JSON.stringify({ ok: true, files: Object.keys(lock) }));
}
