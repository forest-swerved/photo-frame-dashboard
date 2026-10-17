-- Additive mobile sessions, child pairing, chore deadlines and durable notification outbox.
-- Execute as the same restricted server role that owns the family tables; see dashboard/server/README.md.
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

-- Server-only notification inbox and durable APNs outbox. Apply after mobile-schema.sql.
CREATE TABLE IF NOT EXISTS family_notification_preferences (
  mobile_session_id uuid PRIMARY KEY REFERENCES family_mobile_sessions(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES family_households(id),
  push_enabled boolean NOT NULL DEFAULT true,
  chore_completed boolean NOT NULL DEFAULT true,
  chore_reopened boolean NOT NULL DEFAULT true,
  chore_due_soon boolean NOT NULL DEFAULT true,
  chore_overdue boolean NOT NULL DEFAULT true,
  calendar_events boolean NOT NULL DEFAULT true,
  frame_status boolean NOT NULL DEFAULT true,
  quiet_start time,
  quiet_end time,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (household_id,mobile_session_id) REFERENCES family_mobile_sessions(household_id,id) ON DELETE CASCADE,
  CHECK ((quiet_start IS NULL AND quiet_end IS NULL) OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_start<>quiet_end))
);
CREATE TABLE IF NOT EXISTS family_push_installations (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL UNIQUE,
  household_id uuid NOT NULL REFERENCES family_households(id),
  mobile_session_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  credentials jsonb NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  registered_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  FOREIGN KEY (household_id,mobile_session_id) REFERENCES family_mobile_sessions(household_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS family_notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES family_households(id),
  event_key text NOT NULL,
  type text NOT NULL CHECK (type IN ('chore_completed','chore_reopened','chore_due_soon','chore_overdue','calendar_upcoming','calendar_unavailable','calendar_restored','frame_offline','frame_online')),
  person_id uuid,
  chore_id uuid,
  date date,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '24 hours'),
  fanned_at timestamptz,
  UNIQUE(household_id,event_key)
);
CREATE INDEX IF NOT EXISTS family_notification_events_pending ON family_notification_events(occurred_at) WHERE fanned_at IS NULL;
CREATE TABLE IF NOT EXISTS family_notification_inbox (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES family_notification_events(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES family_households(id),
  mobile_session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE(event_id,mobile_session_id),
  FOREIGN KEY (household_id,mobile_session_id) REFERENCES family_mobile_sessions(household_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS family_notification_inbox_session ON family_notification_inbox(mobile_session_id,created_at DESC);
CREATE TABLE IF NOT EXISTS family_notification_deliveries (
  id uuid PRIMARY KEY,
  inbox_id uuid NOT NULL REFERENCES family_notification_inbox(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES family_push_installations(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','accepted','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  accepted_at timestamptz,
  last_error text,
  UNIQUE(inbox_id,installation_id)
);
CREATE INDEX IF NOT EXISTS family_notification_deliveries_pending ON family_notification_deliveries(available_at) WHERE state IN ('pending','leased');
CREATE TABLE IF NOT EXISTS family_notification_scan_state (
  household_id uuid PRIMARY KEY REFERENCES family_households(id),
  scanned_at timestamptz NOT NULL,
  state jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION family_enqueue_completion_notification() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path FROM CURRENT AS $function$
DECLARE chore family_chores%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND NEW.completed IS NOT DISTINCT FROM OLD.completed THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND NOT NEW.completed THEN RETURN NEW; END IF;
  SELECT * INTO chore FROM family_chores WHERE id=NEW.chore_id AND household_id=NEW.household_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  INSERT INTO family_notification_events(household_id,event_key,type,person_id,chore_id,date,payload)
    VALUES(NEW.household_id,'completion:'||NEW.chore_id||':'||NEW.date||':'||NEW.version,
      CASE WHEN NEW.completed THEN 'chore_completed' ELSE 'chore_reopened' END,chore.person_id,NEW.chore_id,NEW.date,
      jsonb_build_object('title',chore.title,'choreVersion',chore.version,'completionVersion',NEW.version,'completed',NEW.completed))
    ON CONFLICT(household_id,event_key) DO NOTHING;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS family_completion_notification ON family_completions;
CREATE TRIGGER family_completion_notification AFTER INSERT OR UPDATE OF completed ON family_completions
  FOR EACH ROW EXECUTE FUNCTION family_enqueue_completion_notification();
REVOKE ALL ON FUNCTION family_enqueue_completion_notification() FROM PUBLIC;

DO $block$
DECLARE table_name text; role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['family_notification_preferences','family_push_installations','family_notification_events',
    'family_notification_inbox','family_notification_deliveries','family_notification_scan_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',table_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,role_name);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION family_enqueue_completion_notification() FROM %I',role_name);
    END IF;
  END LOOP;
END
$block$;
