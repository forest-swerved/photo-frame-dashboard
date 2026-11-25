-- Owner SQL (family_frame_server), recorded from dashboard/server/chore-schema.sql
-- and parent-pin-schema.sql. Additive
-- columns on existing private tables: no new tables, grants, policies or functions.
ALTER TABLE family_chores ADD COLUMN IF NOT EXISTS alarm boolean NOT NULL DEFAULT false;
ALTER TABLE family_chore_occurrences ADD COLUMN IF NOT EXISTS alarm boolean NOT NULL DEFAULT false;
ALTER TABLE family_chore_occurrences ADD COLUMN IF NOT EXISTS alarm_snoozed_until timestamptz;
DO $task_alarm$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='family_chores'::regclass AND conname='family_chore_alarm_time') THEN
    ALTER TABLE family_chores ADD CONSTRAINT family_chore_alarm_time CHECK (NOT alarm OR due_time IS NOT NULL);
  END IF;
END
$task_alarm$;
ALTER TABLE family_people ADD COLUMN IF NOT EXISTS frame_pin_hash text;
ALTER TABLE family_people ADD COLUMN IF NOT EXISTS frame_pin_salt text;
ALTER TABLE family_people ADD COLUMN IF NOT EXISTS frame_pin_set_by text;
ALTER TABLE family_people ADD COLUMN IF NOT EXISTS frame_pin_updated_at timestamptz;
