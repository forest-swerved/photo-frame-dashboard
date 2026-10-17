ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS due_time time;
ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS reminder_minutes smallint NOT NULL DEFAULT 15 CHECK (reminder_minutes BETWEEN 0 AND 1440);

CREATE TABLE IF NOT EXISTS family_mobile_sessions (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  token_hash text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('parent','child')),
  user_id text,
  provider_session_id uuid,
  person_id uuid,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '90 days'),
  revoked_at timestamptz,
  last_seen_at timestamptz,
  UNIQUE(household_id,id),
  FOREIGN KEY(household_id,person_id) REFERENCES family_people(household_id,id) ON DELETE CASCADE,
  CHECK ((kind='parent' AND user_id IS NOT NULL AND provider_session_id IS NOT NULL AND person_id IS NULL)
      OR (kind='child' AND user_id IS NULL AND provider_session_id IS NULL AND person_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS family_mobile_pairs (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  person_id uuid NOT NULL,
  code_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(household_id,person_id) REFERENCES family_people(household_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS family_mobile_sessions_household ON family_mobile_sessions(household_id);
ALTER TABLE family_mobile_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_mobile_pairs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON family_mobile_sessions,family_mobile_pairs FROM PUBLIC;
DO $block$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON family_mobile_sessions,family_mobile_pairs FROM %I',r);
    END IF;
  END LOOP;
END
$block$;
