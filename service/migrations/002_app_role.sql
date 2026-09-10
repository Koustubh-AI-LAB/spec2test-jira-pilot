-- Migration 001 revoked UPDATE/DELETE on audit_event from spec2test_app, but
-- nothing connected as that role, so the control was inert: the service was
-- running as the database owner and could rewrite history freely.
--
-- This gives the role a login and makes it the identity the application uses.
-- Migrations keep running as the owner; only the app is constrained.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spec2test_app') THEN
        CREATE ROLE spec2test_app LOGIN PASSWORD 'spec2test_app';
    ELSE
        ALTER ROLE spec2test_app LOGIN PASSWORD 'spec2test_app';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE spec2test TO spec2test_app;
GRANT USAGE ON SCHEMA public TO spec2test_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO spec2test_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO spec2test_app;

-- Re-applied after the blanket grant above, which would otherwise restore them.
REVOKE UPDATE, DELETE ON audit_event FROM spec2test_app;

-- Anything created by later migrations inherits the same shape.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO spec2test_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO spec2test_app;
