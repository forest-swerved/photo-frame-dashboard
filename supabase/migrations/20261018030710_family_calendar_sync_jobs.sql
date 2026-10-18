-- The server owns this durable queue. Clients never receive provider credentials,
-- job identifiers, credential fingerprints, or direct database privileges.
CREATE TABLE IF NOT EXISTS family_calendar_sync_jobs (
  household_id uuid NOT NULL REFERENCES family_households(id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  timezone text NOT NULL,
  connection_version integer NOT NULL,
  credential_generation text NOT NULL CHECK (credential_generation ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz DEFAULT now(),
  last_attempt_at timestamptz,
  last_successful_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000000),
  last_error_code text,
  lease_id uuid,
  lease_until timestamptz,
  PRIMARY KEY (household_id,start_date,end_date,timezone),
  CHECK (end_date > start_date AND end_date-start_date <= 60),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS family_calendar_sync_due ON family_calendar_sync_jobs(next_attempt_at);
ALTER TABLE family_calendar_sync_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON family_calendar_sync_jobs FROM PUBLIC;
DO $calendar_sync_privileges$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON family_calendar_sync_jobs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON family_calendar_sync_jobs FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON family_calendar_sync_jobs FROM service_role;
  END IF;
END
$calendar_sync_privileges$;
