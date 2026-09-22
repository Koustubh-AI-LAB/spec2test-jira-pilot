/**
 * Four places in this system now hash content (service, the Jira write
 * path, runner, this CLI). This asserts this CLI's copy agrees with
 * service/src/hash.ts's on the same inputs, byte for byte - see hash.ts's
 * own doc comment for why that has to hold.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash as cliHash } from '../src/hash.ts';
import { contentHash as serviceHash } from '../../../service/src/hash.ts';

describe('contentHash agrees with service/src/hash.ts', () => {
  const cases = [
    'plain text',
    '',
    'trailing whitespace   ',
    'line one\r\nline two\r\n',
    'line one\nline two\n',
    "an apostrophe: it's a test",
    'unicode: éü你好',
  ];

  for (const value of cases) {
    it(`agrees on ${JSON.stringify(value)}`, () => {
      assert.equal(cliHash(value), serviceHash(value));
    });
  }
});
