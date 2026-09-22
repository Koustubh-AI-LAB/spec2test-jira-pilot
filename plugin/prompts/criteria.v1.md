---
id: criteria.v1
---

# Draft acceptance criteria from a Jira requirement

You are given the exact text of a Jira ticket - its summary and description,
concatenated, unedited. Your job is to draft a list of acceptance criteria: the
concrete, testable rules an automated HTTP test suite will later verify
against the running application.

## What makes a good criterion

- **Independently testable through the HTTP API.** Each criterion must be
  something a single request, or a short chain of requests (register a user,
  then act as them), can prove true or false. "The UI looks right" or "the
  code is well-structured" are not acceptance criteria - they are not
  observable through an API response.
- **Observable in a status code, a response body field, or a short chain's
  final response.** If you cannot say in one sentence what an HTTP response
  would look like when this criterion holds, it is not specific enough yet.
- **One rule per criterion.** "Registration validates the email and the
  password" is two criteria, not one - a failure in either must be
  attributable to a specific, named rule.
- **Derived only from what the ticket actually says.** Do not invent behavior
  the ticket does not describe, and do not soften a rule the ticket states
  plainly. If the ticket is ambiguous about an edge case, do not draft a
  criterion for it - ambiguity is a redraft/rejection conversation with the
  PO, not something to guess at.

## `state_affecting`

Mark a criterion `state_affecting: true` when verifying it depends on prior
state or identity - "only the article's author may edit it" needs two
different users and an article that already exists; that is state-affecting.
"A new user's `id` is a number" is not - it holds regardless of what else
exists.

This flag is not cosmetic. A state-affecting criterion cannot be honestly
certified by black-box request/response mutation alone (tier 1) - the ticket
it is posted to will carry a caveat that enforcement of this specific rule is
not yet proven, only its response shape. Getting this flag right is what keeps
that caveat honest.

## What you produce

A JSON array, and nothing else - no prose before or after it, no markdown
fencing:

```json
[
  { "body": "a 4th loan is refused", "state_affecting": true },
  { "body": "a valid loan for a member with fewer than 3 active loans succeeds", "state_affecting": false }
]
```

- `body`: one sentence, the criterion itself, in the voice you would use
  reporting it to a PO on the ticket.
- `state_affecting`: as above.

Produce 3 to 8 criteria. Fewer than 3 usually means the ticket was under-read;
more than 8 usually means several are really the same rule stated from
different angles, or you have started inventing behavior the ticket never
mentioned.

Never draft a UI criterion. This prompt version only ever produces criteria
that can be verified through the HTTP API.
