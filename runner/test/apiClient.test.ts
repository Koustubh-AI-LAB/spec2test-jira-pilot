/**
 * The two side channels a generated test never sees, tested directly against
 * a stub transport rather than through a spawned Playwright run - the same
 * reasoning scopedEnv and runFalsification's aggregate() are exported for:
 * the guarantee is far easier to prove here than by asserting on a live
 * process's behaviour.
 *
 * Both exist because a chained test makes several requests, and the two
 * consumers want different things from that: falsification samples the single
 * response the assertions are about, while replay needs an entry for every
 * request the chain makes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCapture, withTranscriptCapture, type ApiResponse, type Transport } from '../src/client/apiClient.ts';

/** Answers each call with a canned response keyed by "METHOD pathname". */
function stubTransport(responses: Record<string, ApiResponse>): Transport {
  return async (method, url, _init) => {
    const key = `${method} ${new URL(url).pathname}`;
    return responses[key] ?? { status: 599, body: { unstubbed: key } };
  };
}

const CHAIN: Record<string, ApiResponse> = {
  'POST /api/users': { status: 201, body: { user: { token: 'jwt' } } },
  'POST /api/articles': { status: 201, body: { article: { slug: 'a-slug' } } },
  'PUT /api/articles/a-slug': { status: 403, body: { message: 'not authorized' } },
};

/** `await`s the body before cleaning up - a synchronous finally would delete
 *  the directory the moment fn returned its promise, not when it settled. */
async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'spec2test-client-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('SPEC2TEST_CAPTURE (withCapture)', () => {
  it('records only the subject request, so a chain samples the response its assertions are about', async () => {
    await inTempDir(async (dir) => {
      const capturePath = join(dir, 'capture.json');
      const transport = withCapture(stubTransport(CHAIN), capturePath);

      await transport('POST', 'http://x/api/users', { headers: {} });
      await transport('POST', 'http://x/api/articles', { headers: {} });
      await transport('PUT', 'http://x/api/articles/a-slug', { headers: {}, subject: true });

      const captured = JSON.parse(readFileSync(capturePath, 'utf8')) as ApiResponse;
      assert.equal(captured.status, 403, 'the subject response, not the last-written setup response');
    });
  });

  it('writes nothing at all when no request is the subject', async () => {
    await inTempDir(async (dir) => {
      const capturePath = join(dir, 'capture.json');
      const transport = withCapture(stubTransport(CHAIN), capturePath);
      await transport('POST', 'http://x/api/users', { headers: {} });
      assert.equal(existsSync(capturePath), false);
    });
  });
});

describe('SPEC2TEST_TRANSCRIPT_CAPTURE (withTranscriptCapture)', () => {
  it('accumulates every request in the chain rather than last-write-wins', async () => {
    await inTempDir(async (dir) => {
      const transcriptPath = join(dir, 'transcript.json');
      const transport = withTranscriptCapture(stubTransport(CHAIN), transcriptPath);

      await transport('POST', 'http://x/api/users', { headers: {} });
      await transport('POST', 'http://x/api/articles', { headers: {} });
      await transport('PUT', 'http://x/api/articles/a-slug', { headers: {}, subject: true });

      const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as Record<string, ApiResponse>;
      assert.deepEqual(Object.keys(transcript).sort(), [
        'POST /api/articles',
        'POST /api/users',
        'PUT /api/articles/a-slug',
      ]);
      assert.equal(transcript['PUT /api/articles/a-slug']!.status, 403);
    });
  });

  it('keys by the RESOLVED pathname, which is what makes an interpolated subject path replayable', async () => {
    await inTempDir(async (dir) => {
      const transcriptPath = join(dir, 'transcript.json');
      const transport = withTranscriptCapture(stubTransport(CHAIN), transcriptPath);
      await transport('PUT', 'http://x/api/articles/a-slug', { headers: {}, subject: true });

      const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as Record<string, ApiResponse>;
      // The spec's own path is "/api/articles/{{capture.slug}}"; recording
      // that instead would produce a key replay never looks up.
      assert.ok(transcript['PUT /api/articles/a-slug']);
      assert.equal(Object.keys(transcript).some((k) => k.includes('{{capture')), false);
    });
  });

  it('collapses two requests sharing a method+path to one entry - the documented replay limitation', async () => {
    await inTempDir(async (dir) => {
      const transcriptPath = join(dir, 'transcript.json');
      const transport = withTranscriptCapture(stubTransport(CHAIN), transcriptPath);
      await transport('POST', 'http://x/api/users', { headers: {} });
      await transport('POST', 'http://x/api/users', { headers: {} });

      const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as Record<string, ApiResponse>;
      assert.equal(Object.keys(transcript).length, 1);
    });
  });
});
