/**
 * The flattener's job is not "produce nice text" - it is "produce the SAME
 * text for the same requirement, every time". Gate 1's approval is bound to a
 * hash of this output, so an unstable flattening marks untouched criteria
 * stale and reopens the gate for nothing. A pipeline that cries wolf gets
 * switched off, which is why these tests are about stability, not prettiness.
 *
 * Pure functions, no Postgres and no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adfToText, requirementText, textToAdf } from '../src/jira/adf.ts';
import { contentHash } from '../src/hash.ts';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const bullets = (...items: string[]) => ({
  type: 'bulletList',
  content: items.map((t) => ({ type: 'listItem', content: [para(t)] })),
});

describe('adf flattening is stable', () => {
  it('ignores formatting marks, because restyling is not a requirement change', () => {
    const plain = doc({
      type: 'paragraph',
      content: [{ type: 'text', text: 'A member may hold at most 3 books.' }],
    });
    const styled = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'A member may hold at most ' },
        { type: 'text', text: '3', marks: [{ type: 'strong' }] },
        { type: 'text', text: ' books.', marks: [{ type: 'em' }, { type: 'textColor' }] },
      ],
    });
    assert.equal(adfToText(styled), adfToText(plain));
    assert.equal(contentHash(adfToText(styled)), contentHash(adfToText(plain)));
  });

  it('is idempotent - flattening the same document twice cannot differ', () => {
    const d = doc(para('Favouriting is idempotent.'), bullets('no double count', 'no negative'));
    assert.equal(adfToText(d), adfToText(structuredClone(d)));
  });

  it('a real wording change does change the hash', () => {
    const three = contentHash(adfToText(doc(para('at most 3 books'))));
    const five = contentHash(adfToText(doc(para('at most 5 books'))));
    assert.notEqual(three, five);
  });

  it('renders a nested list once, not twice', () => {
    const nested = doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            para('outer'),
            { type: 'bulletList', content: [{ type: 'listItem', content: [para('inner')] }] },
          ],
        },
      ],
    });
    const text = adfToText(nested);
    assert.equal(text.match(/inner/g)?.length, 1, 'nested item rendered more than once');
    assert.match(text, /- outer\n {2}- inner/);
  });

  it('drops decorative nodes whose attrs churn', () => {
    // media ids and rule nodes carry no requirement meaning; if they reached
    // the hash, re-uploading the same screenshot would read as drift.
    const withMedia = doc(
      para('requirement'),
      { type: 'rule' },
      { type: 'mediaSingle', attrs: { width: 400 }, content: [{ type: 'media', attrs: { id: 'x1' } }] },
    );
    const withOther = doc(
      para('requirement'),
      { type: 'rule' },
      { type: 'mediaSingle', attrs: { width: 900 }, content: [{ type: 'media', attrs: { id: 'z9' } }] },
    );
    assert.equal(adfToText(withMedia), 'requirement');
    assert.equal(adfToText(withMedia), adfToText(withOther));
  });

  it('keeps an unknown node type as text rather than dropping the sentence', () => {
    // Atlassian ships new node types; silently losing one would quietly shrink
    // the requirement and read as an edit nobody made.
    const future = doc({
      type: 'someFutureBlock',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'still a requirement' }] }],
    });
    assert.equal(adfToText(future), 'still a requirement');
  });

  it('survives a round trip through our own comment builder', () => {
    const original = 'A member may hold at most 3 books.\n\nA 4th request returns 400.';
    assert.equal(adfToText(textToAdf(original)), original);
  });

  it('treats a plain string description the same as an empty-safe input', () => {
    assert.equal(adfToText('plain text body'), 'plain text body');
    assert.equal(adfToText(null), '');
    assert.equal(adfToText(undefined), '');
  });
});

describe('requirement text', () => {
  it('includes the summary, so a retitled requirement counts as changed', () => {
    const before = requirementText('hold at most 3 books', doc(para('unchanged body')));
    const after = requirementText('hold at most 5 books', doc(para('unchanged body')));
    assert.notEqual(contentHash(before), contentHash(after));
  });

  it('is unchanged by trailing whitespace in the summary', () => {
    const a = requirementText('hold at most 3 books', doc(para('body')));
    const b = requirementText('  hold at most 3 books  ', doc(para('body')));
    assert.equal(contentHash(a), contentHash(b));
  });
});
