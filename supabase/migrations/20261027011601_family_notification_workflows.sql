-- Additive, server-owned family notification and device-request workflow.
ALTER TABLE family_account_notification_preferences ADD COLUMN IF NOT EXISTS task_reminders boolean NOT NULL DEFAULT true;
ALTER TABLE family_account_notification_preferences ADD COLUMN IF NOT EXISTS daily_completed boolean NOT NULL DEFAULT true;
ALTER TABLE family_account_notification_preferences ADD COLUMN IF NOT EXISTS access_requests boolean NOT NULL DEFAULT true;
ALTER TABLE family_account_notification_preferences ADD COLUMN IF NOT EXISTS show_details boolean NOT NULL DEFAULT true;

ALTER TABLE family_notification_events DROP CONSTRAINT IF EXISTS family_notification_event_type;
ALTER TABLE family_notification_events ADD CONSTRAINT family_notification_event_type CHECK(type IN (
  'chore_submitted','chore_completed','chore_reopened','chore_due_soon','chore_overdue','calendar_upcoming','calendar_unavailable','calendar_restored','frame_offline','frame_online',
  'reward_earned','session_started','session_warning','session_expired','session_paused','session_ended','session_adjusted','enforcement_failed',
  'daily_tasks_reminder','daily_tasks_completed','access_requested','access_approved','access_declined','access_granted'));

CREATE TABLE IF NOT EXISTS family_access_requests (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id),
  person_id uuid NOT NULL,
  device_id uuid NOT NULL,
  minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1439),
  reason text CHECK(length(reason)<=500),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','expired')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at>requested_at),
  decided_at timestamptz,
  decided_by text,
  session_id uuid,
  FOREIGN KEY(household_id,session_id) REFERENCES family_internet_sessions(household_id,id) ON DELETE SET NULL (session_id),
  FOREIGN KEY(household_id,person_id) REFERENCES family_people(household_id,id),
  FOREIGN KEY(household_id,device_id) REFERENCES family_managed_devices(household_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS family_access_request_pending ON family_access_requests(household_id,person_id,device_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS family_access_request_recent ON family_access_requests(household_id,requested_at DESC);
ALTER TABLE family_access_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE family_access_requests FROM PUBLIC;
DO $privileges$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE family_access_requests FROM %I',role_name);
    END IF;
  END LOOP;
END
$privileges$;
