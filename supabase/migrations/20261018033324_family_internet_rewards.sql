-- Apply as the dedicated server owner after chore-schema.sql. No client grants.
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS manage_chores boolean NOT NULL DEFAULT false;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS manage_internet boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS family_reward_policies (
  household_id uuid NOT NULL REFERENCES family_households(id),
  person_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  enabled boolean NOT NULL DEFAULT true,
  reward_minutes integer NOT NULL DEFAULT 60 CHECK(reward_minutes BETWEEN 1 AND 1439),
  carryover_days integer NOT NULL DEFAULT 7 CHECK(carryover_days BETWEEN 0 AND 365),
  daily_limit_minutes integer NOT NULL DEFAULT 180 CHECK(daily_limit_minutes BETWEEN 1 AND 1440),
  bedtime time,
  warning_minutes integer NOT NULL DEFAULT 5 CHECK(warning_minutes BETWEEN 0 AND 60),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,person_id),
  FOREIGN KEY(household_id,person_id) REFERENCES family_people(household_id,id)
);
CREATE TABLE IF NOT EXISTS family_reward_credits (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  person_id uuid NOT NULL,
  earned_date date NOT NULL,
  minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1439),
  policy_version integer NOT NULL,
  policy_snapshot jsonb NOT NULL,
  occurrence_ids uuid[] NOT NULL CHECK(cardinality(occurrence_ids)>0),
  status text NOT NULL CHECK(status IN ('available','held','reserved','spent','expired','review')),
  expires_at timestamptz NOT NULL,
  reserved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,person_id,earned_date),
  UNIQUE(household_id,id),
  FOREIGN KEY(household_id,person_id) REFERENCES family_people(household_id,id)
);
CREATE INDEX IF NOT EXISTS family_reward_credit_person ON family_reward_credits(household_id,person_id,status);
CREATE TABLE IF NOT EXISTS family_network_integrations (
  household_id uuid PRIMARY KEY REFERENCES family_households(id),
  site_id uuid,
  source_zone_id uuid,
  external_zone_id uuid,
  state text NOT NULL DEFAULT 'pilot_required' CHECK(state IN ('pilot_required','ready','attention')),
  management_host text NOT NULL,
  pilot_checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  management_verified_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  version integer NOT NULL DEFAULT 1 CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS family_managed_devices (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  kind text NOT NULL DEFAULT 'other',
  person_ids uuid[] NOT NULL CHECK(cardinality(person_ids) BETWEEN 1 AND 20),
  mac_addresses text[] NOT NULL CHECK(cardinality(mac_addresses) BETWEEN 1 AND 8),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  control_state text NOT NULL DEFAULT 'unenrolled' CHECK(control_state IN ('unenrolled','ready','attention')),
  management_policy_id uuid,
  deny_policy_id uuid,
  allow_apple_push boolean NOT NULL DEFAULT false,
  apple_push_policy_id uuid,
  management_verified_at timestamptz,
  last_seen_at timestamptz,
  online boolean,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id)
);
CREATE INDEX IF NOT EXISTS family_managed_device_household ON family_managed_devices(household_id);
CREATE TABLE IF NOT EXISTS family_internet_sessions (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  person_id uuid NOT NULL,
  device_id uuid NOT NULL,
  credit_id uuid,
  source text NOT NULL CHECK(source IN ('reward','parent')),
  state text NOT NULL CHECK(state IN ('starting','active','pausing','paused','resuming','adjusting','ending','ended','failed','checking')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  desired_state text NOT NULL CHECK(desired_state IN ('allowed','blocked')),
  observed_state text NOT NULL DEFAULT 'unknown' CHECK(observed_state IN ('unknown','allowed','blocked')),
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  ends_at timestamptz,
  remaining_seconds integer NOT NULL CHECK(remaining_seconds BETWEEN 0 AND 172800),
  allocated_seconds integer NOT NULL CHECK(allocated_seconds BETWEEN 0 AND 172800),
  verified_at timestamptz,
  ended_at timestamptz,
  reason text,
  last_error text,
  all_day boolean NOT NULL DEFAULT false,
  policy_snapshot jsonb NOT NULL,
  policy_id uuid,
  created_by text NOT NULL,
  pending_action text CHECK(pending_action IN ('start','pause','resume','end','adjust')),
  policy_creation_started_at timestamptz,
  policy_fingerprint text CHECK(policy_fingerprint IS NULL OR policy_fingerprint ~ '^[a-f0-9]{64}$'),
  allow_attempted_at timestamptz,
  activation_planned_at timestamptz,
  planned_policy_fingerprint text CHECK(planned_policy_fingerprint IS NULL OR planned_policy_fingerprint ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY(household_id,person_id) REFERENCES family_people(household_id,id),
  FOREIGN KEY(household_id,device_id) REFERENCES family_managed_devices(household_id,id),
  FOREIGN KEY(household_id,credit_id) REFERENCES family_reward_credits(household_id,id),
  UNIQUE(household_id,id),
  CHECK((source='reward')=(credit_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS family_internet_one_person ON family_internet_sessions(household_id,person_id) WHERE state NOT IN ('ended','failed');
CREATE UNIQUE INDEX IF NOT EXISTS family_internet_one_device ON family_internet_sessions(household_id,device_id) WHERE state NOT IN ('ended','failed');
CREATE INDEX IF NOT EXISTS family_internet_session_ends ON family_internet_sessions(ends_at) WHERE state NOT IN ('ended','failed');
CREATE INDEX IF NOT EXISTS family_internet_session_person ON family_internet_sessions(household_id,person_id);
CREATE INDEX IF NOT EXISTS family_internet_session_device ON family_internet_sessions(household_id,device_id);
CREATE INDEX IF NOT EXISTS family_internet_session_credit ON family_internet_sessions(household_id,credit_id);
CREATE TABLE IF NOT EXISTS family_internet_commands (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_version integer NOT NULL,
  action text NOT NULL CHECK(action IN ('allow','block')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','done','superseded','attention')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id,session_version),
  FOREIGN KEY(household_id,session_id) REFERENCES family_internet_sessions(household_id,id),
  CHECK((lease_id IS NULL)=(lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS family_internet_commands_due ON family_internet_commands(available_at) WHERE state IN ('pending','leased');
CREATE INDEX IF NOT EXISTS family_internet_command_session ON family_internet_commands(household_id,session_id);
CREATE TABLE IF NOT EXISTS family_internet_events (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  person_id uuid,
  session_id uuid,
  device_id uuid,
  type text NOT NULL,
  actor text NOT NULL,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE family_managed_devices ADD COLUMN IF NOT EXISTS reviewed_policy_fingerprint text CHECK(reviewed_policy_fingerprint IS NULL OR reviewed_policy_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE family_internet_sessions ADD COLUMN IF NOT EXISTS policy_fingerprint text CHECK(policy_fingerprint IS NULL OR policy_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE family_internet_sessions ADD COLUMN IF NOT EXISTS allow_attempted_at timestamptz;
ALTER TABLE family_internet_sessions ADD COLUMN IF NOT EXISTS activation_planned_at timestamptz;
ALTER TABLE family_internet_sessions ADD COLUMN IF NOT EXISTS planned_policy_fingerprint text CHECK(planned_policy_fingerprint IS NULL OR planned_policy_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE family_reward_credits DROP CONSTRAINT IF EXISTS family_reward_credits_status_check;
ALTER TABLE family_reward_credits ADD CONSTRAINT family_reward_credits_status_check CHECK(status IN ('available','held','reserved','spent','expired','review'));
CREATE INDEX IF NOT EXISTS family_internet_history ON family_internet_events(household_id,created_at DESC);
CREATE TABLE IF NOT EXISTS family_frame_authorizations (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  created_by text NOT NULL,
  scope text NOT NULL CHECK(scope IN ('parent','child')),
  person_id uuid,
  code_hash text UNIQUE,
  token_hash text UNIQUE,
  frame_id uuid REFERENCES family_devices(id),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  CHECK((scope='child')=(person_id IS NOT NULL)),
  FOREIGN KEY(household_id,person_id) REFERENCES family_people(household_id,id)
);
CREATE INDEX IF NOT EXISTS family_frame_authorization_person ON family_frame_authorizations(household_id,person_id);
CREATE INDEX IF NOT EXISTS family_frame_authorization_frame ON family_frame_authorizations(frame_id);
CREATE INDEX IF NOT EXISTS family_frame_authorization_owner ON family_frame_authorizations(household_id,created_by);
DO $internet_privileges$
DECLARE table_name text; role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['family_reward_policies','family_reward_credits','family_network_integrations','family_managed_devices',
    'family_internet_sessions','family_internet_commands','family_internet_events','family_frame_authorizations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',table_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,role_name); END IF;
    END LOOP;
  END LOOP;
END
$internet_privileges$;
