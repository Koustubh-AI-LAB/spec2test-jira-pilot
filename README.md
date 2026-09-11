# spec2test-jira-pilot

A requirement leaves Jira, becomes a test that is proven to actually catch the
bug it claims to, and the result lands back on the ticket. The developer stays
in their IDE; the product owner stays in Jira.

**Status: build step 2 of 8, hardened.** The State Service exists and its gate
logic is proven; Jira read-back and write-back are live, with the PO's
approval or rejection in Jira closing or reopening Gate 1, no webhook, and a
real redraft path for a requirement that drifted or was rejected. There is no
drafting, no codegen and no fault injection yet.

## Why a service and not just a Claude Code skill

The two approvals are made by different people, potentially days apart: the PO
approves the requirement's acceptance criteria in Jira, the developer approves
the drafted test cases in their editor. A chat session cannot hold state across
that gap, so the durable state lives in Postgres and every surface — the Claude
Code plugin, Jira, later CI — is a client of it.

Jira is never asked to call back into this service. The pipeline reads Jira's
current state on every invocation instead, which is what lets the service run
locally and be switched off between sessions without breaking the handoff.

## Layout

| Path | What it is |
|---|---|
| `service/` | State Service: schema, gates, audit ledger, Jira I/O, worker (step 4) |
| `plugin/` | Claude Code plugin — the orchestrator skill (step 5) |
| `runner/` | Codegen, validation, fault injection (steps 3-4) |

## Running it

```bash
npm install
docker compose up -d postgres

cd service
cp ../.env.example ../.env        # then fill in as needed
npm run migrate                   # runs as the owner role
npm test                          # 58 tests, needs the container above
                                  # (12 of them are live Jira tests, skipped if
                                  #  JIRA_API_TOKEN is unset - but a token that
                                  #  is SET and dead fails loud, it doesn't skip)
npm start                         # http://127.0.0.1:8787
```

Postgres is on **5435** deliberately — 5434 is TestForge's and 5433 was found
occupied on this machine.

## Jira: pull, never push

Jira is never asked to call back. Each run reads the ticket's current state and
reconciles Postgres against it, which is why the service can live on a laptop
that is switched off between sessions.

The PO closes Gate 1 by setting **Verification Status** to *Criteria Approved*,
or reopens it by setting it to *Criteria Rejected*. Either way the reconcile
answers a question a webhook would have answered for free: not just "what did
they decide?" but **"what were they looking at when they decided it?"** It
binds the decision to the criteria hashes recorded when the comment was
posted, and refuses to honour it outright if the requirement was edited in the
window between posting and the decision - the one case where guessing would
defeat the point of hashing at all.

A rejection captures the PO's own comment as the reason - a select field has
no free-text slot, so the reason has to come from wherever they actually wrote
it. Since there is no reliable way to know whether they type the comment
before or after flipping the field, the nearest comment by the same person
within a 30-minute window on either side is taken as the reason; anything
further off is assumed unrelated. Criteria are marked `rejected`, never
deleted, and the requirement returns to `draft` - nothing here redrafts on its
own, since drafting needs an LLM this service never calls; the reason is
there for the next session to redraft with as context.

**The "Criteria Rejected" option needs adding to the live field's choices** -
it does not exist on the `S2T` project's `Verification Status` select yet
(only `Not Started` / `Criteria Drafted` / `Criteria Approved` / `Tests
Drafted` / `Tests Approved` / `Certified` / `Stale` were provisioned).
Blocked on a working API token as of this writing; see the open item below.

Two things learned the hard way, both load-bearing:

- **`/rest/api/3/mypermissions` describes the user, not the token.** It reported
  `ADMINISTER=true` for a scoped token that could not create a custom field.
  Preflight probes a real endpoint instead.
- **Jira timestamps carry a site offset** (`+0530`) while ours are UTC `Z`.
  Compared as strings they order wrongly, which silently broke the approval
  window. All comparisons go through `src/jira/time.ts`; see `test/time.test.ts`.

`/rest/api/3/search` is retired on this site - only `/search/jql` works, and it
rejects unbounded JQL, so reconcile queries are always project-scoped.

## Two roles, on purpose

`MIGRATION_DATABASE_URL` is the owner and runs migrations. `DATABASE_URL` is
`spec2test_app`, which has no `UPDATE`/`DELETE` on `audit_event`. The
append-only ledger is a privilege boundary, not a convention — there are tests
that fail if that stops being true.

## What the tests prove

Not "the code runs" — specifically:

- a decision is bound to the content hash the decider was shown, so a criterion
  reworded after the PO saw it cannot inherit their approval;
- re-applying an identical decision is a no-op, so nothing accumulates duplicate
  approvals or audit lines;
- one open pipeline instance per Jira issue, enforced by a partial unique index,
  so a second invocation resumes instead of drafting again;
- production environments can never be granted state-mutating capability, because
  capability is derived from environment class rather than stored per row;
- the application role genuinely cannot rewrite audit history;
- a PO's approval in Jira is picked up by *reading* the ticket, and is bound to
  the criteria hashes that were actually posted to it;
- flattening a Jira description is stable, so a document nobody edited cannot
  hash differently and spuriously reopen a gate;
- editing the requirement after approval marks the criteria stale rather than
  letting the approval stand - **and a redraft genuinely recovers from that**,
  not just once: approve, drift, redraft, re-approve ends with everything
  actually approved, not with a reconcile that claims success while nothing
  moved (the bug that shipped once and is now a regression test, not a memory);
- an approval or rejection with no record of what was actually presented is
  refused outright, never guessed at from the row's current text;
- a rejection is bound to the PO's own comment as its reason, never a comment
  from before the decision or from someone else, and sends the requirement
  back to `draft` without deleting the criteria it rejected;
- a crash between a comment landing on the ticket and our own record of it
  is recovered from by finding the comment again, not by posting a duplicate.

They run against a real Postgres and, for the parts that need it, a real Jira
site or a scripted stand-in that proves multi-step sequences fast and
deterministically. See `service/test/lifecycle.test.ts` for why the sequence
tests exist separately from the one-transition-at-a-time ones: every bug found
in the second bug-hunting pass lived in a sequence no single-transition test
could have caught.

The full plan, including the readiness gates this has to clear before it points
at a company system, is in
`(private design notes, not published)`.
