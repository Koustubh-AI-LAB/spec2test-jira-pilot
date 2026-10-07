# spec2test-jira-pilot

[![CI](https://github.com/Koustubh-AI-LAB/spec2test-jira-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Koustubh-AI-LAB/spec2test-jira-pilot/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Koustubh-AI-LAB/spec2test-jira-pilot/badge)](https://scorecard.dev/viewer/?uri=github.com/Koustubh-AI-LAB/spec2test-jira-pilot)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A requirement leaves Jira, becomes a test that is proven to actually catch the
bug it claims to, and the result lands back on the ticket. The developer stays
in their IDE; the product owner stays in Jira.

**Status: pilot (v0.1.0).** The walking skeleton runs end to end: a Claude Code
skill drafts acceptance criteria from a Jira ticket, the product owner approves
them in Jira, test cases are drafted, generated as Playwright API tests,
validated, and proven by fault injection against a self-hosted
[Conduit](https://github.com/gothinkster/node-express-realworld-example-app)
target, and the verdict is written back to the ticket. Expect breaking changes
before 1.0.

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
| `service/` | State Service: schema, gates, audit ledger, Jira I/O, verification worker |
| `runner/` | Codegen, a five-stage validator, and tier-1 fault injection (Kill Set / Immunity Set) |
| `plugin/` | Claude Code plugin: the `/pipeline` skill, the `s2t` CLI it drives, and versioned drafting prompts |

## Prerequisites

- **Node.js 22.9 or newer** (every script relies on `--experimental-strip-types`)
- **Docker**, for the Postgres 16 container
- **A Jira Cloud site** with a *classic* API token (see the notes in
  [`.env.example`](.env.example) for why a scoped token is not enough) and four
  custom fields on the project's issues:

  | Field | Type | Values |
  |---|---|---|
  | Verification Status | Select list | Not Started, Criteria Drafted, Criteria Approved, Criteria Rejected, Tests Drafted, Tests Approved, Contract-Verified, Weak, Failing |
  | Criteria Certified | Number | |
  | Criteria Total | Number | |
  | Last Verified | Date time | |

  Put each field's id (`customfield_NNNNN`) in `.env`. The service checks
  them against the site at startup and refuses to run with a missing one.
- **A target app.** The pilot targets a local clone of
  [gothinkster/node-express-realworld-example-app](https://github.com/gothinkster/node-express-realworld-example-app),
  run with that project's own instructions.
- **[Claude Code](https://claude.com/claude-code)**, to run the pipeline skill.

## Quick start

```bash
git clone https://github.com/Koustubh-AI-LAB/spec2test-jira-pilot.git
cd spec2test-jira-pilot
npm ci
cp .env.example .env          # fill in Jira, target app and CLI values
npm run db:up                 # Postgres 16 on localhost:5435
npm run migrate -w service    # runs as the owner role
npm start -w service          # State Service on http://127.0.0.1:8787
```

Both `migrate` and `start` read `.env` from the repo root.

### Connect a target app

```bash
# Scaffold spec2test/ (API client wrapper, Playwright config) into the target
npm run init -w runner -- /path/to/conduit

# Register the project and the target environment with the State Service
curl -s -X POST http://127.0.0.1:8787/projects -H 'content-type: application/json' \
  -d '{"key":"S2T-PILOT","jira_project_key":"S2T","target_repo_path":"/path/to/conduit"}'
curl -s -X POST http://127.0.0.1:8787/environments -H 'content-type: application/json' \
  -d '{"project_id":"<id from the previous response>","base_url":"http://localhost:3000/api","class":"ephemeral","openapi_url":"/abs/path/to/spec2test-jira-pilot/runner/fixtures/openapi/conduit.snapshot.yml"}'
```

An unregistered base URL is refused, never warned about. The environment class
decides what fault injection is allowed: `production` is smoke-only by
construction.

### Run the pipeline

```bash
cd plugin/cli && npm link && cd ../..   # puts `s2t` on your PATH
s2t preflight                           # eleven checks; fails loud on the first problem
claude --plugin-dir plugin              # then, inside Claude Code:
#   /pipeline S2T-1
```

The skill is resumable: every invocation re-reads the ticket and the service's
state, so you can close the session after Gate 1 and pick it up days later.
`scripts/s2t-env.sh` (Bash) and `scripts/s2t-env.ps1` (PowerShell) set up a
shell to call `s2t` directly without linking.

## Development

```bash
npm run lint           # ESLint
npm run format:check   # Prettier (npm run format to fix)
npm run typecheck      # tsc --noEmit in every workspace
npm test               # every workspace; needs the Postgres container
```

Live Jira tests are skipped when `JIRA_API_TOKEN` is unset, and live target
tests when `CONDUIT_BASE_URL` is unset. A token that is *set* but dead fails
loud rather than skipping. Tests use a dedicated `spec2test_test` database, so
they never touch the data of a running session.

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

Two things learned the hard way, both load-bearing:

- **`/rest/api/3/mypermissions` describes the user, not the token.** It reported
  `ADMINISTER=true` for a scoped token that could not create a custom field.
  Preflight probes a real endpoint instead.
- **Jira timestamps carry a site offset** (`+0530`) while ours are UTC `Z`.
  Compared as strings they order wrongly, which silently broke the approval
  window. All comparisons go through `service/src/jira/time.ts`; see
  `service/test/time.test.ts`.

`/rest/api/3/search` is retired on Jira Cloud - only `/search/jql` works, and
it rejects unbounded JQL, so reconcile queries are always project-scoped.

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
  actually approved;
- an approval or rejection with no record of what was actually presented is
  refused outright, never guessed at from the row's current text;
- a rejection is bound to the PO's own comment as its reason, never a comment
  from before the decision or from someone else, and sends the requirement
  back to `draft` without deleting the criteria it rejected;
- a crash between a comment landing on the ticket and our own record of it
  is recovered from by finding the comment again, not by posting a duplicate;
- concurrent writers to the same requirement are serialized, so a reconcile
  and a Gate 2 rejection racing each other cannot lose an update.

They run against a real Postgres and, for the parts that need it, a real Jira
site or a scripted stand-in that proves multi-step sequences fast and
deterministically. See `service/test/lifecycle.test.ts` for why the sequence
tests exist separately from the one-transition-at-a-time ones: every bug found
in the second bug-hunting pass lived in a sequence no single-transition test
could have caught.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). This project
follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
not in a public issue.

## License

[Apache License 2.0](LICENSE). Third-party material is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
