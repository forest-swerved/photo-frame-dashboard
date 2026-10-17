-- Family table DDL is applied as its runtime owner using dashboard/server/migrate.js.
-- This administrative migration only creates the private session view and narrows grants.
-- Managed auth schema cannot grant USAGE to custom roles. A private owner-view
-- exposes only the three fields needed for immediate session-revocation checks.
-- Owner semantics deliberately use postgres; browser/API roles cannot use it.
CREATE SCHEMA IF NOT EXISTS family_internal AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA family_internal FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE VIEW family_internal.auth_sessions AS
  SELECT id, user_id, not_after FROM auth.sessions;
REVOKE ALL ON family_internal.auth_sessions FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA family_internal TO family_frame_server;
GRANT SELECT ON family_internal.auth_sessions TO family_frame_server;
REVOKE SELECT(id,user_id,not_after) ON auth.sessions FROM family_frame_server;

REVOKE CREATE ON SCHEMA public FROM family_frame_server;
