---
id: testcase.v1
---

# Draft a TestCaseSpec for one approved criterion

You are given one approved acceptance criterion, its `criterionId`, and the
target application's OpenAPI document (the grounding text). Your job is to
draft exactly one `TestCaseSpec` - a JSON object a deterministic generator
renders into a real Playwright test. You never write the test code itself;
you author the request(s) and the checks, and generation is templated from
that structure.

## The exact shape

```ts
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type AuthMode = 'none' | 'user';

interface Assertion {
  name: string;   // snake_case, becomes a named test.step
  check: string;  // see "Assertion checks" below - only three forms derive a kill fault
}

interface RequestStep {
  name: string;
  method: HttpMethod;
  path: string;
  auth: AuthMode;
  authToken?: string;              // only meaningful when auth is "user"
  body?: unknown;
  capture?: Record<string, string[]>;  // name -> path SEGMENTS, e.g. ["article","slug"]
}

interface TestCaseSpec {
  criterionId: string;
  name: string;             // the test's title
  setup?: RequestStep[];    // ordered; each MUST return < 400 or the test is an INCONCLUSIVE broken control
  method: HttpMethod;       // the SUBJECT request - the only one assertions check, the only one a fault targets
  path: string;
  auth: AuthMode;
  authToken?: string;
  body?: unknown;
  assertions: Assertion[];  // at least one
}
```

`criterionId` must equal the criterion id you were given, exactly.

## Grounding: only real routes

Every request - every `setup[]` entry and the subject request - must name a
`method`+`path` that literally appears in the grounding OpenAPI document you
were given. A request naming a route the schema does not document is refused
before anything is generated (`spec_not_grounded`). Do not guess at a
plausible-sounding endpoint; if the criterion needs a route you cannot find in
the grounding text, say so instead of drafting a spec.

Every field your `body` marks required by the schema at that route must be
present (`spec_body_missing_required_fields`) - check the schema's required
list, do not assume a shape from the criterion text alone.

## `{{unique}}` - uniqueness constraints

The generator is deterministic: the same spec always renders to the same
source file. A fixed literal like `"alice@example.com"` would violate a real
uniqueness constraint (email, username, slug) on every run after the first.
Write `{{unique}}` anywhere inside a string - `path`, `authToken`, or any
nested string in `body` - and it renders as a reference to a value computed
fresh at each test run:

```json
{ "user": { "email": "spec2test_{{unique}}@spec2test.dev", "username": "spec2test_{{unique}}" } }
```

Use it for every field a real uniqueness constraint could apply to. Do not use
it where the value must be a specific, meaningful literal (e.g. a password, a
field you are deliberately asserting an exact value of).

## Multi-step chains: `setup`, `capture`, subject marking

Some criteria need more than one request - "only the article's author may
edit it" needs two different identities and an article that already exists.
Express that with `setup`:

```json
{
  "criterionId": "C-AUTHOR-ONLY-EDIT",
  "name": "only the author may edit an article",
  "setup": [
    { "name": "register the author", "method": "POST", "path": "/api/users", "auth": "none",
      "body": { "user": { "username": "s2t_author_{{unique}}", "email": "s2t_author_{{unique}}@spec2test.dev", "password": "Spec2Test!1" } },
      "capture": { "authorToken": ["user", "token"] } },
    { "name": "register the intruder", "method": "POST", "path": "/api/users", "auth": "none",
      "body": { "user": { "username": "s2t_intruder_{{unique}}", "email": "s2t_intruder_{{unique}}@spec2test.dev", "password": "Spec2Test!1" } },
      "capture": { "intruderToken": ["user", "token"] } },
    { "name": "the author creates an article", "method": "POST", "path": "/api/articles", "auth": "user",
      "authToken": "{{capture.authorToken}}",
      "body": { "article": { "title": "Ownership fixture {{unique}}", "description": "d", "body": "b", "tagList": [] } },
      "capture": { "slug": ["article", "slug"] } }
  ],
  "method": "PUT",
  "path": "/api/articles/{{capture.slug}}",
  "auth": "user",
  "authToken": "{{capture.intruderToken}}",
  "body": { "article": { "title": "Hijacked {{unique}}" } },
  "assertions": [ { "name": "non_author_is_refused", "check": "status === 403" } ]
}
```

Rules that are enforced, not suggestions:

- `capture` values are **path segment arrays**, never dotted strings -
  `["article", "slug"]`, not `"article.slug"`. A real response can contain a
  key that itself has a literal `.` in it, which a dotted string cannot
  express safely.
- Reference a captured value anywhere later with `{{capture.NAME}}` - in a
  later step's `path`, `authToken`, or `body`. A reference to a name no
  *earlier* step captured is refused (`spec_unknown_capture`) - forward
  references do not work, because nothing has run yet to produce the value.
  Do not reference a capture from the SAME step that declares it.
  Capture names must be unique across the whole spec
  (`spec_duplicate_capture`).
- `authToken` is only meaningful when `auth` is `"user"` on that same request
  - setting it with `auth: "none"` is refused
  (`spec_auth_token_without_user`), because it would be silently ignored and
  the request would run unauthenticated.
- **The subject is the one request the top-level `method`/`path`/`auth`
  describe.** It is the only request assertions check, and the only one a
  fault mutates. Every `setup[]` request is a precondition: it is never
  asserted on, and it must return a non-error status (< 400) or the whole
  test scores INCONCLUSIVE as a broken control, never a real result.
- When `auth: "user"` and you do not set `authToken` explicitly, the request
  uses a single shared fallback token from the test environment. Set
  `authToken` explicitly (often from a capture) whenever the criterion needs a
  *specific* identity, as in the example above.

## Assertion checks - only three forms can be verified

`check` is a boolean expression evaluated against the subject request's real
response (`status: number`, `body: any`). Falsification derives a "kill
fault" from an assertion's `check` - a targeted mutation that must make the
assertion fail, proving it is load-bearing rather than decorative. **Only
three forms of `check` can derive a kill fault:**

| Form | Example |
|---|---|
| `status === <n>` | `status === 403` |
| `body.a.b` (bare truthy) | `body.user.token` |
| `body.a.b === <expr>` | `body.article.slug === 'my-article'` |

Any other form of `check` - a boolean combination (`&&`/`\|\|`), a call
(`JSON.stringify(body) === "..."`), a comparison operator other than `===`,
anything referencing more than one of `status`/`body` - is not wrong, but it
derives **zero kill faults**. A criterion whose every assertion is like this
can never be certified: falsification has nothing to prove the assertion
matters, so it quarantines rather than passing or failing. Always include at
least one `status === <n>` assertion, and prefer the two forms above for
every other check you write. If `POST /specs/validate`'s response includes
`hints`, it is naming exactly this - read it and rewrite the named assertion
before drafting the test case.

Assertion `name`s are snake_case; each becomes `test.step("assertion: <name>",
...)` in the generated file, and each name you declare must have exactly one
matching step.

## What you produce

A single JSON object - the `TestCaseSpec` - and nothing else: no prose, no
markdown fencing.
