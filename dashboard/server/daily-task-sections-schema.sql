-- Daily routines keep their school-day placement while days off use Tasks.
-- Saved occurrences and their immutable definitions are unchanged.
ALTER TABLE family_chores DROP CONSTRAINT IF EXISTS family_school_task_section;
ALTER TABLE family_chores ADD CONSTRAINT family_school_task_section
  CHECK (task_section='tasks' OR (schedule_type='weekly' AND school_day_filter IN ('any','school_day')));
