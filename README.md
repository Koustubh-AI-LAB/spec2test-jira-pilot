# spec2test-jira-pilot

A requirement leaves Jira, becomes a test that is proven to actually catch the
bug it claims to, and the result lands back on the ticket. The developer stays
in their IDE; the product owner stays in Jira.

**Status: build step 1 of 8.** The State Service exists and its gate logic is
proven. There is no Jira integration, no drafting, no codegen and no fault
injection yet.

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
| `service/` | State Service: schema, gates, audit ledger, Jira I/O (step 2), worker (step 4) |
| `plugin/` | Claude Code plugin — the orchestrator skill (step 5) |
| `runner/` | Codegen, validation, fault injection (steps 3-4) |

## Running it

```bash
npm install
docker compose up -d postgres

cd service
cp ../.env.example ../.env        # then fill in as needed
npm run migrate                   # runs as the owner role
npm test                          # 19 tests, needs the container above
npm start                         # http://127.0.0.1:8787
```

Postgres is on **5435** deliberately — 5434 is TestForge's and 5433 was found
occupied on this machine.

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
- the application role genuinely cannot rewrite audit history.

They run against a real Postgres rather than a mock: every one of those claims is
a SQL-level guarantee, and a mocked client would prove none of them.

The full plan, including the readiness gates this has to clear before it points
at a company system, is in
`(private design notes, not published)`.
