---
name: pipeline
description: Drive a Jira ticket through the spec2test pipeline - draft requirement and criteria, wait on Gate 1, draft and verify test cases, wait on Gate 2, certify, sync back to Jira. Resumable across sessions.
disable-model-invocation: true
allowed-tools: Bash(s2t:*), Read, Write
---

# spec2test pipeline

Invoked as `/pipeline <ISSUE-KEY>` (e.g. `/pipeline S2T-1`). Take the issue
key from `$ARGUMENTS`.

## How this works

Every invocation - the first one on a ticket, and every resume after - runs
the same loop:

1. Run `s2t preflight`. If the command isn't found (`s2t: command not
   found` or similar shell error), print: *"the plugin CLI isn't linked -
   run `npm link` in `plugin/cli/`"* and stop. If it runs but reports `ok:
   false`, print the `event`, `message`, and `remedy` fields verbatim and
   stop. Do not proceed past a failing preflight for any reason.
2. Run `s2t status --issue <KEY>` and read its `stage` field.
3. Look up `stage` in the table below and do exactly that action.
4. Unless the table says the stage stops, go back to step 2 and re-read the
   stage fresh. Never reuse a stage value from earlier in this session -
   always re-derive it from a new `status` call. This is what makes a resume
   correct after the session was closed for days: nothing here is inferred
   from chat history, only from what the service reports right now.

Every field named below (`criteria`, `testCases`, `uncoveredCriteria`,
`pendingTestCases`, `unverifiedTestCases`, `rejectionReason`, `jira.*`)
comes from that same `status` response - never re-derive one of these by
re-joining `criteria[]` against `testCases[]` yourself; `status` already did
that (see `uncoveredCriteria`/`pendingTestCases`/`unverifiedTestCases`).

## Stage actions

**`no_requirement`** - Nothing drafted yet.
Run `s2t draft-requirement --issue <KEY> --model <your own model id>`. This
posts the ticket's summary/description to the service verbatim - it takes no
`--body`, so never paraphrase the ticket yourself. Then read
`plugin/prompts/criteria.v1.md`, draft 3-8 acceptance criteria from the
ticket text it just adopted (`status`'s `jira.requirementText`), write them
as a JSON array to `plugin/.scratch/criteria-<KEY>.json` via `Write`, and run
`s2t draft-criteria --requirement-id <id from draft-requirement's output>
--model <your model id> --json-file plugin/.scratch/criteria-<KEY>.json`.
Continue the loop (step 4) - do not stop here.

**`needs_criteria`** - A requirement exists with no criteria yet.
Same criteria-drafting half of the action above (read `criteria.v1.md`,
write the JSON file, run `draft-criteria` against `requirement.id` from
`status`). Continue the loop.

**`needs_criteria_posting`** - Criteria are drafted but not yet on the
ticket.
Run `s2t post-criteria --issue <KEY> --requirement-id <id> --preview`. Show
the human the previewed comment and fields from its output. Ask them to
confirm before posting - a vague or missing answer is not a yes; ask again
rather than proceeding. On an explicit yes, run the same command with
`--confirm` instead of `--preview`. Then stop and report that the criteria
are posted and Gate 1 is now with the PO.

**`awaiting_criteria_approval`** - Posted; waiting on the PO in Jira.
Report that Gate 1 is with the PO and stop. Do nothing else - there is
nothing for the skill to do until the PO acts in Jira.

**`gate1_decision_unapplied`** - The PO has already decided in Jira, but
it hasn't been pulled in yet.
Run `s2t reconcile --issue <KEY> --confirm`. Continue the loop.

**`criteria_rejected`** - The PO rejected the criteria.
Read `status`'s `rejectionReason`. Read `criteria.v1.md`, redraft the
criteria using the rejection reason as context for what to change, write the
new JSON array to `plugin/.scratch/`, and run `s2t redraft --requirement-id
<id> --model <your model id> --reason "<rejectionReason>" --json-file
<path>`. This adopts the ticket's current text automatically (same as
`draft-requirement`, `redraft` takes no `--body`). Continue the loop.

**`stale`** - The ticket text changed after criteria were drafted or
approved.
Same redraft action as `criteria_rejected` above, but the reason is drift,
not a rejection: pass `--reason "requirement text changed; redrafting
against the current text"`. Continue the loop.

**`needs_tests`** - Gate 1 is closed on at least one criterion with no live
test case yet.
Run `s2t grounding` to see the target's routes, then read
`plugin/prompts/testcase.v1.md` and draft one `TestCaseSpec` for
`uncoveredCriteria[0]` (one at a time, never more). Write it to
`plugin/.scratch/`, run `s2t draft-test-case --criterion-id <id> --model
<your model id> --json-file <path>`.

This is the one stage with an explicit exception to "stop on any
`ok:false`" (see Standing rules), because the service caps drafting attempts
at 2 per criterion and expects the skill to use both:

- If the command fails with an event **other than**
  `draft_attempts_exhausted` (e.g. `spec_not_grounded`,
  `spec_body_missing_required_fields`), read the `message` field, redraft
  once more taking it into account, and try `draft-test-case` again.
- If that second attempt also fails, or the server refuses outright with
  `draft_attempts_exhausted`, stop and report the failure message to the
  human. Never attempt a third draft for the same criterion in this
  invocation - the server would refuse it anyway.
- If the command succeeds but its output includes a non-empty `hints`
  array, the test case was still created - mention the hint to the human as
  a caveat (this assertion may never derive a kill fault) rather than
  treating it as a failure. `hints` is a success-path signal only; it never
  appears alongside a failure.

On a clean success with no hints, continue the loop.

**`awaiting_test_approval`** - A drafted test case is waiting on Gate 2.
Take **one** entry from `pendingTestCases[]` - never more than one per
approval action. `status`'s own `testCases[]` never carries the `spec` body
(only id/name/state/contentHash), so run `s2t get-test-case --test-case-id
<id>` first to fetch it - this works the same whether the test case was
drafted earlier in this same invocation or in a session that's since closed.
Show the human its `spec` and `contentHash`. Ask them to approve or reject
it. A vague answer is not a decision; ask again. On approval, run `s2t
approve-test-case --test-case-id <id> --seen-hash <contentHash>`. On
rejection, ask for a reason and run the same command with `--reject --reason
"<reason>"`. There is no way to approve more than one test case in a single
command, by design - never try to batch this. Continue the loop.

**`needs_verification`** - Every test case is approved; none has run yet.
For every entry in `unverifiedTestCases[]`, run `s2t verify --test-case-id
<id>`. Each call only enqueues a background job and returns immediately
(`{jobId, status: 'queued'}`) - it does not wait for falsification to
finish, so it's safe to do this for all of them in one pass. Report how many
jobs were queued, then stop. The next invocation of this skill will see
`verifying` until the background worker finishes them.

**`verifying`** - A falsification job is genuinely queued or running right
now.
Report that verification is in progress and stop. There is nothing to do
but wait for the next invocation.

**`contract_verified`** - Every criterion is covered.
Run `s2t sync --issue <KEY> --requirement-id <id> --preview`. Show the human
the previewed Jira comment. Ask them to confirm. On a yes, run the same
command with `--confirm` instead of `--preview`. Report the final Jira
state and stop.

**`weak` / `failing`** - Verification finished, but not everything is
covered.
Before syncing, explain what's wrong - this is why `verify-result` exists.
For every entry in `status`'s `testCases[]` whose `state` is `'approved'`,
run `s2t verify-result --test-case-id <id>`. For any whose `certify.verdict`
comes back `'rejected'`, report that test case's criterion and the full
`certify.reason` string to the human verbatim - it already names the exact
surviving fault or brittle assertion. For a `'quarantined'` verdict, report
it differently: the environment was unstable during that run, not a real
regression - suggest re-running `verify` for that test case rather than
treating it as a finding.

Do **not** reject the test case or draft a replacement yourself, even after
explaining what's wrong. Gate 2 approval is a historical fact the service
never revokes on its own (a bad falsification verdict never changes a test
case's approved state) - only an explicit human decision
(`approve-test-case --reject`) frees a criterion for a new draft, the same
way every other gate decision in this pipeline works. If the human wants a
redraft after hearing the diagnostic, that is their next instruction to you,
not something this stage triggers automatically.

After reporting the diagnostic, proceed with the same sync `contract_verified`
does: `s2t sync --issue <KEY> --requirement-id <id> --preview` → show → ask
→ `--confirm`. Report the final Jira state and stop.

## Standing rules

- **Never infer `stage` from chat history.** Always re-derive it from a
  fresh `s2t status` call, every single time, even seconds after the last
  one. This is what makes a resume across a closed session, or a duplicate
  invocation, behave correctly instead of drifting from what the service
  actually holds.
- **Never call a Jira write tool.** `allowed-tools` only lists `Bash(s2t:*)`,
  `Read`, and `Write` - every Atlassian MCP tool, including any write one, is
  outside that allowlist. This is enforcement by omission, not a separate
  deny-list; do not describe it as one.
- **Never approve or reject a gate decision on the developer's behalf.**
  Gate 1 (criteria) only ever closes from the PO's real action in Jira,
  picked up by `reconcile` - there is no command that lets this skill close
  it directly, on purpose. Gate 2 (test cases) only closes when a human
  explicitly answers the approve/reject question this skill asks; a
  non-answer, silence, or an unrelated reply is never treated as approval.
- **Every Jira write is preview, then a separate confirm.** Never run a
  `--confirm` command without having shown the corresponding `--preview`
  output to the human first, in the same turn.
- **Stop and report on any `ok: false`** from a command, unless the stage's
  own action above names a specific retry exception (today, only
  `needs_tests`'s 2-attempt cap does). A Jira-side error surfaced through a
  command is also a stop-and-report, never a stage to route around.
- **After any action that doesn't stop, re-run `status` and re-enter this
  table.** Most stages fall through to the next one this way within a single
  invocation; only the stages marked "stop" above end the turn.
