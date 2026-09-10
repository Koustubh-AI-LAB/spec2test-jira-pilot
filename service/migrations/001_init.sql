-- Schema for the spec2test State Service.
--
-- Two invariants this file enforces at the database level rather than in
-- application code, because both are cheap here and expensive to retrofit:
--   1. audit_event is append-only  (REVOKE at the bottom)
--   2. at most one open pipeline instance per Jira issue (partial unique index)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE project (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key               text        NOT NULL UNIQUE,
    jira_project_key  text        NOT NULL,
    target_repo_path  text        NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- The environment allowlist. `class` alone determines what a run may do:
-- capabilities are derived in code from the class, never stored per row, so
-- there is no column anyone can edit to grant tier-2 against production.
CREATE TABLE environment (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid        NOT NULL REFERENCES project (id) ON DELETE CASCADE,
    base_url    text        NOT NULL,
    class       text        NOT NULL
                CHECK (class IN ('ephemeral', 'dedicated', 'shared-staging', 'production')),
    openapi_url text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, base_url)
);

CREATE TABLE requirement (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       uuid        NOT NULL REFERENCES project (id) ON DELETE CASCADE,
    jira_issue_key   text        NOT NULL,
    title            text        NOT NULL,
    body             text        NOT NULL,
    -- Drift detection: hash of the Jira text this requirement was drafted from.
    -- Re-hashed on every reconcile; a change marks criteria stale and reopens gate 1.
    source_text_hash text        NOT NULL,
    state            text        NOT NULL DEFAULT 'draft'
                     CHECK (state IN ('draft', 'awaiting_requirement_approval',
                                      'awaiting_test_approval', 'verifying',
                                      'contract_verified', 'weak', 'failing',
                                      'stale', 'closed')),
    -- Drafting provenance. Unbackfillable later, so it is NOT NULL from day one.
    drafted_by_model text        NOT NULL,
    prompt_version   text        NOT NULL,
    grounding_hash   text        NOT NULL,
    temperature      numeric,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Per-ticket idempotency: re-invoking the pipeline on a ticket that already has
-- an open instance must resume it, never draft a second one.
CREATE UNIQUE INDEX one_open_requirement_per_issue
    ON requirement (project_id, jira_issue_key)
    WHERE state <> 'closed';

CREATE TABLE criterion (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requirement_id   uuid        NOT NULL REFERENCES requirement (id) ON DELETE CASCADE,
    ordinal          integer     NOT NULL,
    body             text        NOT NULL,
    content_hash     text        NOT NULL,
    state            text        NOT NULL DEFAULT 'proposed'
                     CHECK (state IN ('proposed', 'approved', 'rejected', 'stale', 'uncovered')),
    -- A state-affecting criterion cannot be honestly certified by tier-1 evidence
    -- alone; the verdict carries that caveat.
    state_affecting  boolean     NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (requirement_id, ordinal)
);

CREATE TABLE test_case (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    criterion_id     uuid        NOT NULL REFERENCES criterion (id) ON DELETE CASCADE,
    name             text        NOT NULL,
    kind             text        NOT NULL CHECK (kind IN ('api', 'ui')),
    spec             jsonb       NOT NULL,
    content_hash     text        NOT NULL,
    -- Generated code lives in the target app's repo; the DB stores only where it
    -- is and what it hashed to when approved. A mismatch on disk reopens gate 2.
    artifact_path    text        NOT NULL DEFAULT '',
    artifact_hash    text        NOT NULL DEFAULT '',
    state            text        NOT NULL DEFAULT 'proposed'
                     CHECK (state IN ('proposed', 'approved', 'rejected', 'stale')),
    drafted_by_model text        NOT NULL,
    prompt_version   text        NOT NULL,
    grounding_hash   text        NOT NULL,
    temperature      numeric,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Both gates write here, in the same shape, whoever made the decision and
-- wherever they made it.
CREATE TABLE approval (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type text        NOT NULL CHECK (subject_type IN ('criterion', 'test_case')),
    subject_id   uuid        NOT NULL,
    subject_hash text        NOT NULL,
    gate         smallint    NOT NULL CHECK (gate IN (1, 2)),
    decision     text        NOT NULL CHECK (decision IN ('approved', 'rejected')),
    actor        text        NOT NULL,
    channel      text        NOT NULL CHECK (channel IN ('jira', 'claude-code', 'cli')),
    reason       text        NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approval_subject_idx ON approval (subject_type, subject_id, created_at DESC);

CREATE TABLE run (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requirement_id uuid        NOT NULL REFERENCES requirement (id) ON DELETE CASCADE,
    environment_id uuid        NOT NULL REFERENCES environment (id),
    kind           text        NOT NULL CHECK (kind IN ('smoke', 'falsification')),
    state          text        NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued', 'running', 'complete', 'incomplete')),
    started_at     timestamptz,
    finished_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE run_result (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        uuid        NOT NULL REFERENCES run (id) ON DELETE CASCADE,
    test_case_id  uuid        NOT NULL REFERENCES test_case (id) ON DELETE CASCADE,
    assertion     text        NOT NULL DEFAULT '',
    outcome       text        NOT NULL CHECK (outcome IN ('pass', 'fail', 'error', 'skipped')),
    detail        text        NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fault_experiment (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id        uuid        NOT NULL REFERENCES run (id) ON DELETE CASCADE,
    criterion_id  uuid        NOT NULL REFERENCES criterion (id) ON DELETE CASCADE,
    test_case_id  uuid        NOT NULL REFERENCES test_case (id) ON DELETE CASCADE,
    set_kind      text        NOT NULL CHECK (set_kind IN ('kill', 'immunity')),
    tier          smallint    NOT NULL DEFAULT 1,
    spec          jsonb       NOT NULL,
    plausible     boolean     NOT NULL DEFAULT true,
    -- INCONCLUSIVE is not a failure of the system; it means the test failed
    -- somewhere other than its named assertion, which never counts as a kill.
    verdict       text        NOT NULL
                  CHECK (verdict IN ('kill', 'survive', 'inconclusive', 'quarantined')),
    detail        text        NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Falsification runs in the background: a table and a polling loop, no broker.
CREATE TABLE job (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind           text        NOT NULL CHECK (kind IN ('falsification', 'smoke')),
    requirement_id uuid        NOT NULL REFERENCES requirement (id) ON DELETE CASCADE,
    payload        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    state          text        NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued', 'running', 'done', 'failed')),
    attempts       integer     NOT NULL DEFAULT 0,
    last_error     text        NOT NULL DEFAULT '',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_queue_idx ON job (state, created_at);

CREATE TABLE audit_event (
    id         bigserial PRIMARY KEY,
    event      text        NOT NULL,
    subject    text        NOT NULL DEFAULT '',
    actor      text        NOT NULL DEFAULT '',
    detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_event_created_idx ON audit_event (created_at DESC);

-- Append-only, enforced rather than documented. The app role may INSERT and
-- SELECT; nothing may rewrite history. Migrations run as the owner, so this
-- only binds the application.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spec2test_app') THEN
        CREATE ROLE spec2test_app;
    END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO spec2test_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO spec2test_app;
REVOKE UPDATE, DELETE ON audit_event FROM spec2test_app;
