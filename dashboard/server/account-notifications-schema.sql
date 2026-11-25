-- Account Activity/preferences survive phone sign-out or installation changes.
-- Device inbox/outbox tables remain for APNs installation delivery only.
CREATE TABLE IF NOT EXISTS family_account_notification_preferences (
  household_id uuid NOT NULL,
  user_id text NOT NULL,
  push_enabled boolean NOT NULL DEFAULT true,
  chore_completed boolean NOT NULL DEFAULT true,
  chore_reopened boolean NOT NULL DEFAULT true,
  chore_due_soon boolean NOT NULL DEFAULT true,
  chore_overdue boolean NOT NULL DEFAULT true,
  calendar_events boolean NOT NULL DEFAULT true,
  frame_status boolean NOT NULL DEFAULT true,
  rewards boolean NOT NULL DEFAULT true,
  internet_sessions boolean NOT NULL DEFAULT true,
  quiet_start time,
  quiet_end time,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(household_id,user_id),
  FOREIGN KEY(household_id,user_id) REFERENCES family_members(household_id,user_id) ON DELETE CASCADE,
  CHECK ((quiet_start IS NULL AND quiet_end IS NULL) OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_start<>quiet_end))
);
CREATE TABLE IF NOT EXISTS family_account_notification_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES family_notification_events(id) ON DELETE CASCADE,
  household_id uuid NOT NULL,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL,
  read_at timestamptz,
  FOREIGN KEY(household_id,user_id) REFERENCES family_members(household_id,user_id) ON DELETE CASCADE,
  UNIQUE(event_id,household_id,user_id)
);
CREATE INDEX IF NOT EXISTS family_account_activity_recent ON family_account_notification_inbox(household_id,user_id,created_at DESC,id DESC);

-- Prefer the latest actually-saved preference; use UUID as a deterministic tie
-- breaker. Existing account settings always win when the migration is rerun.
INSERT INTO family_account_notification_preferences(household_id,user_id,push_enabled,chore_completed,chore_reopened,chore_due_soon,chore_overdue,calendar_events,frame_status,quiet_start,quiet_end,updated_at)
SELECT DISTINCT ON(s.household_id,s.user_id) s.household_id,s.user_id,p.push_enabled,p.chore_completed,p.chore_reopened,p.chore_due_soon,p.chore_overdue,p.calendar_events,p.frame_status,p.quiet_start,p.quiet_end,p.updated_at
FROM family_notification_preferences p JOIN family_mobile_sessions s ON s.id=p.mobile_session_id AND s.household_id=p.household_id
JOIN family_members m ON m.household_id=s.household_id AND m.user_id=s.user_id
WHERE s.user_id IS NOT NULL AND ((s.kind='parent' AND m.role IN('admin','member')) OR (s.kind='child' AND m.role='child' AND s.person_id=m.person_id))
ORDER BY s.household_id,s.user_id,p.updated_at DESC,s.id DESC
ON CONFLICT(household_id,user_id) DO NOTHING;

INSERT INTO family_account_notification_inbox(event_id,household_id,user_id,created_at,read_at)
SELECT i.event_id,i.household_id,s.user_id,min(i.created_at),min(i.read_at)
FROM family_notification_inbox i JOIN family_mobile_sessions s ON s.id=i.mobile_session_id AND s.household_id=i.household_id
JOIN family_members m ON m.household_id=s.household_id AND m.user_id=s.user_id
JOIN family_notification_events e ON e.id=i.event_id
WHERE s.user_id IS NOT NULL AND (m.role IN('admin','member') OR (m.role='child' AND m.person_id=e.person_id
  AND e.type IN('chore_completed','chore_reopened','chore_due_soon','chore_overdue') AND EXISTS(
    SELECT 1 FROM family_chore_occurrences o WHERE o.household_id=e.household_id AND o.chore_id=e.chore_id AND o.date=e.date AND o.person_id=m.person_id)))
GROUP BY i.event_id,i.household_id,s.user_id
ON CONFLICT(event_id,household_id,user_id) DO NOTHING;

DO $account_event_types$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='family_notification_events'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%type%chore_completed%' LOOP
    EXECUTE format('ALTER TABLE family_notification_events DROP CONSTRAINT %I',constraint_name);
  END LOOP;
  ALTER TABLE family_notification_events ADD CONSTRAINT family_notification_event_type CHECK(type IN (
    'chore_submitted','chore_completed','chore_reopened','chore_due_soon','chore_overdue','calendar_upcoming','calendar_unavailable','calendar_restored','frame_offline','frame_online',
    'reward_earned','session_started','session_warning','session_expired','session_paused','session_ended','session_adjusted','enforcement_failed','daily_tasks_reminder','daily_tasks_completed','access_requested','access_approved','access_declined','access_granted'));
END
$account_event_types$;
DO $account_notification_privileges$
DECLARE table_name text; role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['family_account_notification_preferences','family_account_notification_inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',table_name);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',table_name,role_name); END IF;
    END LOOP;
  END LOOP;
END
$account_notification_privileges$;
