-- Dedicated, server-only ActivityKit installation and delivery state.
CREATE TABLE IF NOT EXISTS family_live_activity_installations (
 id uuid PRIMARY KEY,
 household_id uuid NOT NULL REFERENCES family_households(id) ON DELETE CASCADE,
 mobile_session_id uuid NOT NULL,
 installation_id uuid NOT NULL,
 environment text NOT NULL CHECK(environment IN ('sandbox','production')),
 enabled boolean NOT NULL DEFAULT true,
 start_credentials jsonb,
 start_token_hash text UNIQUE,
 activity_credentials jsonb,
 run_id uuid,
 dismissed boolean NOT NULL DEFAULT false,
 last_state_hash text,
 last_sent_at timestamptz,
 started_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid,
 lease_until timestamptz,
 last_error text,
 registered_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(mobile_session_id,installation_id,environment),
 FOREIGN KEY(household_id,mobile_session_id) REFERENCES family_mobile_sessions(household_id,id) ON DELETE CASCADE
);
ALTER TABLE family_live_activity_installations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON family_live_activity_installations FROM PUBLIC;
DO $block$
DECLARE r text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON family_live_activity_installations FROM %I',r);
  END IF;
 END LOOP;
END
$block$;
CREATE INDEX IF NOT EXISTS family_live_activity_due ON family_live_activity_installations(next_attempt_at);
