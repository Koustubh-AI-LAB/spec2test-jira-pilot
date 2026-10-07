-- Step 6 hardening: durably caps a criterion's failed test-case-spec drafting
-- attempts, independent of whatever session drove them (the design's
-- "repair loop capped at 2 attempts") - `generate` (codegen) is
-- deterministic templating, so a worker-side retry loop can't repair
-- anything; the retry that matters is the LLM redrafting the spec after a
-- /specs/validate failure, which is driven by the skill/CLI, not this
-- service. What the service owns is the durable cap so that loop can't spin
-- forever even across sessions.
ALTER TABLE criterion
    ADD COLUMN spec_draft_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN criterion.spec_draft_attempts IS
    'Consecutive failed /specs/validate calls for a TestCaseSpec targeting '
    'this criterion. Incremented on validation failure, reset to 0 on a '
    'successful POST /test-cases. POST /specs/validate refuses outright at '
    '2, with event draft_attempts_exhausted, rather than letting a drafting '
    'loop retry forever.';
