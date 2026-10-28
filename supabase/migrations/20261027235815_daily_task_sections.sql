BEGIN;
SET LOCAL ROLE family_frame_server;
ALTER TABLE public.family_chores DROP CONSTRAINT IF EXISTS family_school_task_section;
ALTER TABLE public.family_chores ADD CONSTRAINT family_school_task_section
  CHECK (task_section='tasks' OR (schedule_type='weekly' AND school_day_filter IN ('any','school_day')));
RESET ROLE;
COMMIT;
