CREATE TABLE IF NOT EXISTS family_households (
  id uuid PRIMARY KEY,
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  title text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Denver',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS family_members (
  household_id uuid NOT NULL REFERENCES family_households(id),
  user_id text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'child')),
  person_id uuid,
  joined_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (household_id, user_id)
);
CREATE TABLE IF NOT EXISTS family_people (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  name text NOT NULL,
  color text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id)
);
CREATE TABLE IF NOT EXISTS family_chores (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  title text NOT NULL,
  person_id uuid,
  weekdays smallint[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6]::smallint[],
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  due_time time,
  reminder_minutes smallint NOT NULL DEFAULT 15 CHECK (reminder_minutes BETWEEN 0 AND 1440),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, person_id) REFERENCES family_people(household_id, id),
  CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[])
);
CREATE TABLE IF NOT EXISTS family_completions (
  household_id uuid NOT NULL,
  chore_id uuid NOT NULL,
  date date NOT NULL,
  completed boolean NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  actor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, chore_id, date),
  FOREIGN KEY (household_id, chore_id) REFERENCES family_chores(household_id, id)
);
CREATE TABLE IF NOT EXISTS family_mutations (
  household_id uuid NOT NULL REFERENCES family_households(id),
  actor text NOT NULL,
  mutation_id uuid NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, actor, mutation_id)
);
CREATE TABLE IF NOT EXISTS family_invites (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','child')),
  person_id uuid,
  email text,
  revoked_at timestamptz,
  redeemed_at timestamptz,
  redeemed_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS family_frame_pairs (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  code_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS family_devices (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '365 days'),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS family_calendar_connections (
  household_id uuid PRIMARY KEY REFERENCES family_households(id),
  credentials jsonb NOT NULL,
  calendars jsonb NOT NULL,
  selected_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS family_calendar_cache (
  household_id uuid NOT NULL REFERENCES family_households(id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  timezone text NOT NULL,
  snapshot jsonb NOT NULL,
  successful_at timestamptz NOT NULL,
  connection_version integer NOT NULL,
  PRIMARY KEY (household_id, start_date, end_date, timezone)
);
CREATE TABLE IF NOT EXISTS family_rate_limits (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);

-- Household data is accessed only by the server's owning database role. No
-- browser/Data API policies are created. Do not FORCE RLS on the owner.
ALTER TABLE family_households ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_chores ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_frame_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_calendar_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE family_households, family_members, family_people,
  family_chores, family_completions, family_mutations, family_invites,
  family_frame_pairs, family_devices, family_calendar_connections,
  family_calendar_cache, family_rate_limits FROM PUBLIC;

-- Supabase API roles must have no table privileges even if project defaults
-- grant privileges to new public tables. This does not modify auth schemas.
DO $block$
DECLARE
  role_name text;
  table_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      FOREACH table_name IN ARRAY ARRAY[
        'family_households','family_members','family_people','family_chores',
        'family_completions','family_mutations','family_invites','family_frame_pairs',
        'family_devices','family_calendar_connections','family_calendar_cache','family_rate_limits'
      ] LOOP
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', table_name, role_name);
      END LOOP;
    END IF;
  END LOOP;
END
$block$;
