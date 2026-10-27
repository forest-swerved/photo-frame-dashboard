-- Additive routine definitions. The current day's work is copied into immutable
-- occurrence definitions; editing a routine changes subsequently generated days.
ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT true;
ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS instructions text NOT NULL DEFAULT '' CHECK (length(instructions)<=3000);
ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS subtasks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(subtasks)='array' AND jsonb_array_length(subtasks)<=20);
ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS schedule_type text NOT NULL DEFAULT 'weekly' CHECK (schedule_type IN ('weekly','one_off'));
ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS scheduled_date date;
ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT false;
DO $routine_schedule$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='family_chores'::regclass AND conname='family_chore_schedule_date') THEN
    ALTER TABLE family_chores ADD CONSTRAINT family_chore_schedule_date CHECK ((schedule_type='weekly' AND scheduled_date IS NULL) OR (schedule_type='one_off' AND scheduled_date IS NOT NULL));
  END IF;
END
$routine_schedule$;

CREATE TABLE IF NOT EXISTS family_chore_exceptions (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  person_id uuid,
  chore_id uuid,
  from_date date NOT NULL,
  to_date date NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  UNIQUE(household_id,id),
  FOREIGN KEY (household_id,chore_id) REFERENCES family_chores(household_id,id),
  CHECK (to_date>from_date AND to_date-from_date<=366)
);
CREATE TABLE IF NOT EXISTS family_chore_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES family_households(id),
  chore_id uuid NOT NULL,
  original_date date NOT NULL,
  date date NOT NULL,
  routine_version integer NOT NULL CHECK (routine_version>0),
  definition_source text NOT NULL DEFAULT 'routine' CHECK (definition_source IN ('routine','legacy_completion','parent_correction')),
  title text NOT NULL,
  person_id uuid,
  person_name text,
  required boolean NOT NULL,
  instructions text NOT NULL DEFAULT '',
  subtask_definitions jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_subtask_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(completed_subtask_ids)='array'),
  requires_approval boolean NOT NULL,
  original_due_time time,
  due_time time,
  reminder_minutes smallint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','completed','skipped')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  completion_version integer NOT NULL DEFAULT 0 CHECK (completion_version>=0),
  completed_at timestamptz,
  completed_by text,
  approved_at timestamptz,
  approved_by text,
  skip_reason text,
  exception_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(household_id,id),
  UNIQUE(household_id,chore_id,original_date),
  FOREIGN KEY(household_id,chore_id) REFERENCES family_chores(household_id,id),
  FOREIGN KEY(household_id,exception_id) REFERENCES family_chore_exceptions(household_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS family_chore_occurrence_active_date ON family_chore_occurrences(household_id,chore_id,date) WHERE status<>'skipped';
CREATE INDEX IF NOT EXISTS family_chore_occurrence_person_day ON family_chore_occurrences(household_id,person_id,date);
CREATE INDEX IF NOT EXISTS family_chore_occurrence_exception ON family_chore_occurrences(household_id,exception_id);
CREATE INDEX IF NOT EXISTS family_chore_exception_chore ON family_chore_exceptions(household_id,chore_id);
CREATE TABLE IF NOT EXISTS family_chore_events (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  occurrence_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('created','completed','submitted','reopened','approved','rejected','skipped','rescheduled','subtasks_changed','exception_removed')),
  actor text NOT NULL,
  actor_name text NOT NULL,
  reason text,
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(household_id,occurrence_id) REFERENCES family_chore_occurrences(household_id,id)
);
CREATE INDEX IF NOT EXISTS family_chore_events_history ON family_chore_events(household_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS family_chore_events_occurrence ON family_chore_events(household_id,occurrence_id);

-- Preserve known legacy completion facts before switching writers. Their source
-- is explicit because the former schema did not retain historical definitions.
INSERT INTO family_chore_occurrences(household_id,chore_id,original_date,date,routine_version,definition_source,title,person_id,person_name,required,instructions,
  subtask_definitions,requires_approval,original_due_time,due_time,reminder_minutes,status,completion_version,completed_at,completed_by,approved_at,approved_by,created_at,updated_at)
SELECT c.household_id,c.id,x.date,x.date,c.version,'legacy_completion',c.title,c.person_id,p.name,c.required,c.instructions,
  c.subtasks,c.requires_approval,c.due_time,c.due_time,c.reminder_minutes,CASE WHEN x.completed THEN 'completed' ELSE 'pending' END,
  x.version,CASE WHEN x.completed THEN x.updated_at END,x.actor,CASE WHEN x.completed THEN x.updated_at END,CASE WHEN x.completed THEN x.actor END,x.updated_at,x.updated_at
FROM family_completions x JOIN family_chores c ON c.household_id=x.household_id AND c.id=x.chore_id
LEFT JOIN family_people p ON p.household_id=c.household_id AND p.id=c.person_id
ON CONFLICT(household_id,chore_id,original_date) DO NOTHING;

CREATE OR REPLACE FUNCTION family_keep_chore_occurrence_definition() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path FROM CURRENT AS $definition$
BEGIN
  IF ROW(NEW.household_id,NEW.chore_id,NEW.original_date,NEW.routine_version,NEW.definition_source,NEW.title,NEW.person_id,NEW.person_name,
    NEW.required,NEW.instructions,NEW.subtask_definitions,NEW.requires_approval,NEW.original_due_time,NEW.reminder_minutes)
    IS DISTINCT FROM ROW(OLD.household_id,OLD.chore_id,OLD.original_date,OLD.routine_version,OLD.definition_source,OLD.title,OLD.person_id,OLD.person_name,
    OLD.required,OLD.instructions,OLD.subtask_definitions,OLD.requires_approval,OLD.original_due_time,OLD.reminder_minutes) THEN
    RAISE EXCEPTION 'Daily chore definitions are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$definition$;
DROP TRIGGER IF EXISTS family_chore_definition_immutable ON family_chore_occurrences;
CREATE TRIGGER family_chore_definition_immutable BEFORE UPDATE ON family_chore_occurrences FOR EACH ROW EXECUTE FUNCTION family_keep_chore_occurrence_definition();

-- New occurrence transitions drive notifications. Materialization/backfill does
-- not emit events, and the old compatibility writer must not double-enqueue.
DO $notification_schema$
DECLARE constraint_name text;
BEGIN
  IF to_regclass('family_notification_events') IS NOT NULL THEN
    FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='family_notification_events'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%type%chore_completed%' LOOP
      EXECUTE format('ALTER TABLE family_notification_events DROP CONSTRAINT %I',constraint_name);
    END LOOP;
    ALTER TABLE family_notification_events ADD CONSTRAINT family_notification_event_type CHECK(type IN ('chore_submitted','chore_completed','chore_reopened','chore_due_soon','chore_overdue','calendar_upcoming','calendar_unavailable','calendar_restored','frame_offline','frame_online','reward_earned','session_started','session_warning','session_expired','session_paused','session_ended','session_adjusted','enforcement_failed','daily_tasks_reminder','daily_tasks_completed','access_requested','access_approved','access_declined','access_granted'));
  END IF;
END
$notification_schema$;
CREATE OR REPLACE FUNCTION family_enqueue_chore_occurrence_notification() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path FROM CURRENT AS $notify_occurrence$
DECLARE event_type text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR to_regclass('family_notification_events') IS NULL THEN RETURN NEW; END IF;
  event_type := CASE WHEN NEW.status='submitted' THEN 'chore_submitted' WHEN NEW.status='completed' THEN 'chore_completed'
    WHEN NEW.status='pending' AND OLD.status IN ('completed','submitted') THEN 'chore_reopened' ELSE NULL END;
  IF event_type IS NULL THEN RETURN NEW; END IF;
  INSERT INTO family_notification_events(household_id,event_key,type,person_id,chore_id,date,payload)
    VALUES(NEW.household_id,'occurrence:'||NEW.id||':'||NEW.version,event_type,NEW.person_id,NEW.chore_id,NEW.date,
      jsonb_build_object('title',NEW.title,'choreVersion',NEW.routine_version,'completionVersion',NEW.completion_version,'completed',NEW.status IN ('submitted','completed'),
        'occurrenceId',NEW.id,'occurrenceVersion',NEW.version,'occurrenceStatus',NEW.status))
    ON CONFLICT(household_id,event_key) DO NOTHING;
  RETURN NEW;
END
$notify_occurrence$;
DROP TRIGGER IF EXISTS family_chore_occurrence_notification ON family_chore_occurrences;
CREATE TRIGGER family_chore_occurrence_notification AFTER UPDATE OF status ON family_chore_occurrences FOR EACH ROW EXECUTE FUNCTION family_enqueue_chore_occurrence_notification();

DO $legacy_trigger$
BEGIN
  IF to_regclass('family_notification_events') IS NOT NULL THEN
    EXECUTE $function_ddl$
      CREATE OR REPLACE FUNCTION family_enqueue_completion_notification() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path FROM CURRENT AS $legacy_function$
      DECLARE chore family_chores%ROWTYPE;
      BEGIN
        IF EXISTS(SELECT 1 FROM family_chore_occurrences o WHERE o.household_id=NEW.household_id AND o.chore_id=NEW.chore_id AND o.date=NEW.date) THEN RETURN NEW; END IF;
        IF TG_OP='UPDATE' AND NEW.completed IS NOT DISTINCT FROM OLD.completed THEN RETURN NEW; END IF;
        IF TG_OP='INSERT' AND NOT NEW.completed THEN RETURN NEW; END IF;
        SELECT * INTO chore FROM family_chores WHERE id=NEW.chore_id AND household_id=NEW.household_id AND deleted_at IS NULL;
        IF NOT FOUND THEN RETURN NEW; END IF;
        INSERT INTO family_notification_events(household_id,event_key,type,person_id,chore_id,date,payload)
          VALUES(NEW.household_id,'completion:'||NEW.chore_id||':'||NEW.date||':'||NEW.version,CASE WHEN NEW.completed THEN 'chore_completed' ELSE 'chore_reopened' END,
            chore.person_id,NEW.chore_id,NEW.date,jsonb_build_object('title',chore.title,'choreVersion',chore.version,'completionVersion',NEW.version,'completed',NEW.completed))
          ON CONFLICT(household_id,event_key) DO NOTHING;
        RETURN NEW;
      END
      $legacy_function$;
    $function_ddl$;
  END IF;
END
$legacy_trigger$;

DO $chore_privileges$
DECLARE object_name text; role_name text;
BEGIN
  FOREACH object_name IN ARRAY ARRAY['family_chore_exceptions','family_chore_occurrences','family_chore_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',object_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',object_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',object_name,role_name); END IF;
    END LOOP;
  END LOOP;
  FOREACH object_name IN ARRAY ARRAY['family_keep_chore_occurrence_definition','family_enqueue_chore_occurrence_notification','family_enqueue_completion_notification'] LOOP
    IF to_regprocedure(object_name||'()') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %I() FROM PUBLIC',object_name);
      FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON FUNCTION %I() FROM %I',object_name,role_name); END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$chore_privileges$;
