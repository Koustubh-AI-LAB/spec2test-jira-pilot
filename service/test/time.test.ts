/**
 * Regression tests for a bug that had already shipped into the reconcile once:
 * comparing Jira's offset timestamps against our UTC ones as strings.
 *
 * "2026-09-10T16:00:00.000+0530" and "2026-09-10T10:30:00.000Z" are the same
 * instant, but the first sorts after the second lexicographically. The
 * approval window - "was the requirement edited between the criteria being
 * posted and the PO approving?" - is built on that comparison, so getting it
 * wrong silently refuses valid approvals in one direction and, worse, would
 * accept invalidated ones in the other.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { instant, isBetween, byInstant } from '../src/jira/time.ts';

const IST = '2026-09-10T16:00:00.000+0530';
const UTC_SAME = '2026-09-10T10:30:00.000Z';

describe('timestamp comparison across offsets', () => {
  it('treats the same instant in different offsets as equal', () => {
    assert.equal(instant(IST), instant(UTC_SAME));
    // The string comparison this replaced got it backwards, which is the bug.
    assert.ok(IST > UTC_SAME, 'precondition: string compare disagrees with reality');
  });

  it('orders a changelog by instant, not by string', () => {
    const entries = [
      { at: '2026-09-10T16:00:00.000+0530' }, // 10:30Z
      { at: '2026-09-10T09:00:00.000Z' }, // earlier
      { at: '2026-09-10T18:00:00.000+0530' }, // 12:30Z, latest
    ];
    const sorted = entries.slice().sort(byInstant);
    assert.deepEqual(
      sorted.map((e) => e.at),
      [
        '2026-09-10T09:00:00.000Z',
        '2026-09-10T16:00:00.000+0530',
        '2026-09-10T18:00:00.000+0530',
      ],
    );
  });

  it('an edit inside the approval window is detected across offsets', () => {
    const posted = '2026-09-10T10:00:00.000Z';
    const approved = '2026-09-10T16:30:00.000+0530'; // 11:00Z
    const edit = '2026-09-10T16:00:00.000+0530'; // 10:30Z - inside
    assert.equal(isBetween(edit, posted, approved), true);
  });

  it('an edit outside the window is not', () => {
    const posted = '2026-09-10T10:00:00.000Z';
    const approved = '2026-09-10T16:30:00.000+0530'; // 11:00Z
    assert.equal(isBetween('2026-09-10T09:00:00.000Z', posted, approved), false, 'before posting');
    assert.equal(isBetween('2026-09-10T12:00:00.000Z', posted, approved), false, 'after approval');
  });

  it('an unparseable or missing timestamp never claims to be inside the window', () => {
    // Fail closed: an unknown timestamp must not silently satisfy the check
    // that guards whether an approval can be trusted.
    assert.equal(isBetween('not-a-date', '2026-09-10T10:00:00.000Z', '2026-09-10T11:00:00.000Z'), false);
    assert.equal(isBetween('2026-09-10T10:30:00.000Z', undefined, '2026-09-10T11:00:00.000Z'), false);
    assert.ok(Number.isNaN(instant(undefined)));
  });
});
