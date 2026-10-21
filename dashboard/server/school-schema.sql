-- Versioned documents retain the district's approved source and parent overrides.
CREATE TABLE IF NOT EXISTS family_school_calendars (
  household_id uuid NOT NULL REFERENCES family_households(id),
  version integer NOT NULL CHECK (version>0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,version)
);
ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS school_day_filter text NOT NULL DEFAULT 'any' CHECK (school_day_filter IN ('any','school_day','non_school_day'));
ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS task_section text NOT NULL DEFAULT 'tasks' CHECK (task_section IN ('tasks','before_school','after_school'));
ALTER TABLE family_chore_occurrences ADD COLUMN IF NOT EXISTS school_day_filter text NOT NULL DEFAULT 'any' CHECK (school_day_filter IN ('any','school_day','non_school_day'));
ALTER TABLE family_chore_occurrences ADD COLUMN IF NOT EXISTS task_section text NOT NULL DEFAULT 'tasks' CHECK (task_section IN ('tasks','before_school','after_school'));
ALTER TABLE family_chore_occurrences ADD COLUMN IF NOT EXISTS school_excused boolean NOT NULL DEFAULT false;
ALTER TABLE family_chore_occurrences ADD COLUMN IF NOT EXISTS school_schedule_exempt boolean NOT NULL DEFAULT false;
UPDATE family_chore_occurrences SET school_schedule_exempt=true WHERE date<>original_date AND NOT school_schedule_exempt;
DO $school_routine$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='family_chores'::regclass AND conname='family_school_one_off') THEN
    ALTER TABLE family_chores ADD CONSTRAINT family_school_one_off CHECK (schedule_type<>'one_off' OR school_day_filter='any');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='family_chores'::regclass AND conname='family_school_task_section') THEN
    ALTER TABLE family_chores ADD CONSTRAINT family_school_task_section CHECK (task_section='tasks' OR (schedule_type='weekly' AND school_day_filter='school_day'));
  END IF;
END
$school_routine$;

-- Keep the filter that applied when today's work was generated. Later routine
-- edits must not silently replace the definition of work already in progress.
CREATE OR REPLACE FUNCTION family_keep_school_occurrence_definition() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path FROM CURRENT AS $school_definition$
BEGIN
  IF ROW(NEW.school_day_filter,NEW.task_section) IS DISTINCT FROM ROW(OLD.school_day_filter,OLD.task_section) THEN
    RAISE EXCEPTION 'Daily school chore definitions are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$school_definition$;
DROP TRIGGER IF EXISTS family_school_definition_immutable ON family_chore_occurrences;
CREATE TRIGGER family_school_definition_immutable BEFORE UPDATE ON family_chore_occurrences FOR EACH ROW EXECUTE FUNCTION family_keep_school_occurrence_definition();
DO $school_history$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='family_chore_events'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%type%created%' LOOP
    EXECUTE format('ALTER TABLE family_chore_events DROP CONSTRAINT %I',constraint_name);
  END LOOP;
  ALTER TABLE family_chore_events ADD CONSTRAINT family_chore_event_type CHECK(type IN ('created','completed','submitted','reopened','approved','rejected','skipped','rescheduled','subtasks_changed','exception_removed','school_schedule_changed'));
END
$school_history$;
ALTER TABLE family_school_calendars ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE family_school_calendars FROM PUBLIC;
REVOKE ALL ON FUNCTION family_keep_school_occurrence_definition() FROM PUBLIC;
DO $school_privileges$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE family_school_calendars FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION family_keep_school_occurrence_definition() FROM %I',role_name);
    END IF;
  END LOOP;
END
$school_privileges$;
