import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProvenance, ModelIdInvalidError } from '../src/provenance.ts';
import { loadPrompt, PromptHashMismatchError, PROMPTS_DIR } from '../src/prompts.ts';
import { contentHash } from '../src/hash.ts';

describe('buildProvenance', () => {
  it('assembles drafted_by_model/prompt_version/grounding_hash from the real committed prompt', () => {
    const p = buildProvenance({
      model: 'claude-opus-5',
      promptFile: 'criteria.v1.md',
      groundingText: 'some ticket text',
    });
    assert.equal(p.drafted_by_model, 'claude-opus-5');
    assert.match(p.prompt_version, /^criteria\.v1@[0-9a-f]{12}$/);
    assert.equal(p.grounding_hash, contentHash('some ticket text'));
  });

  it('rejects a model id that does not look like claude-*', () => {
    assert.throws(
      () => buildProvenance({ model: 'gpt-4', promptFile: 'criteria.v1.md', groundingText: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof ModelIdInvalidError);
        assert.equal(err.event, 'model_id_invalid');
        return true;
      },
    );
  });

  it('includes temperature only when given', () => {
    const withTemp = buildProvenance({
      model: 'claude-opus-5',
      promptFile: 'criteria.v1.md',
      groundingText: 'x',
      temperature: 0.2,
    });
    assert.equal(withTemp.temperature, 0.2);
    const without = buildProvenance({ model: 'claude-opus-5', promptFile: 'criteria.v1.md', groundingText: 'x' });
    assert.equal('temperature' in without, false, 'omitted, not sent as undefined');
  });
});

describe('loadPrompt against the committed lock', () => {
  it('loads both real prompt files clean', () => {
    const criteria = loadPrompt('criteria.v1.md');
    assert.equal(criteria.id, 'criteria.v1');
    assert.ok(criteria.body.length > 0);
    const testcase = loadPrompt('testcase.v1.md');
    assert.equal(testcase.id, 'testcase.v1');
  });
});

// Sabotage a real committed prompt file, confirm loadPrompt fails loud, then
// restore it.
describe('prompt_hash_mismatch - sabotage and restore', () => {
  const path = join(PROMPTS_DIR, 'criteria.v1.md');
  let original: string;

  before(() => {
    original = readFileSync(path, 'utf8');
  });

  after(() => {
    writeFileSync(path, original, 'utf8');
  });

  it('fails loud when the file on disk no longer matches prompts.lock.json', () => {
    writeFileSync(path, `${original}\n<!-- sabotage: not what the committed lock hashes -->\n`, 'utf8');
    assert.throws(() => loadPrompt('criteria.v1.md'), (err: unknown) => {
      assert.ok(err instanceof PromptHashMismatchError);
      assert.equal(err.event, 'prompt_hash_mismatch');
      assert.notEqual(err.locked, err.actual);
      return true;
    });
  });
});
