-- Child accounts use verified provider identities. No new browser/Data API grants.
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS person_id uuid;
ALTER TABLE family_members DROP CONSTRAINT IF EXISTS family_members_role_check;
ALTER TABLE family_members ADD CONSTRAINT family_members_role_check CHECK (role IN ('admin','member','child'));
ALTER TABLE family_members DROP CONSTRAINT IF EXISTS family_members_child_person_check;
ALTER TABLE family_members ADD CONSTRAINT family_members_child_person_check CHECK
  ((role='child' AND (person_id IS NOT NULL OR revoked_at IS NOT NULL)) OR (role<>'child' AND person_id IS NULL));
DO $block$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='family_members'::regclass AND conname='family_members_person_fkey') THEN
    ALTER TABLE family_members ADD CONSTRAINT family_members_person_fkey
      FOREIGN KEY(household_id,person_id) REFERENCES family_people(household_id,id);
  END IF;
END
$block$;
CREATE UNIQUE INDEX IF NOT EXISTS family_members_active_child_person ON family_members(household_id,person_id)
  WHERE role='child' AND revoked_at IS NULL;

ALTER TABLE family_invites ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';
ALTER TABLE family_invites ADD COLUMN IF NOT EXISTS person_id uuid;
ALTER TABLE family_invites ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE family_invites ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE family_invites DROP CONSTRAINT IF EXISTS family_invites_role_check;
ALTER TABLE family_invites ADD CONSTRAINT family_invites_role_check CHECK (role IN ('member','child'));
ALTER TABLE family_invites DROP CONSTRAINT IF EXISTS family_invites_child_target_check;
ALTER TABLE family_invites ADD CONSTRAINT family_invites_child_target_check CHECK
  ((role='child' AND person_id IS NOT NULL AND email IS NOT NULL AND email=lower(trim(email))) OR (role='member' AND person_id IS NULL AND email IS NULL));
DO $block$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='family_invites'::regclass AND conname='family_invites_person_fkey') THEN
    ALTER TABLE family_invites ADD CONSTRAINT family_invites_person_fkey
      FOREIGN KEY(household_id,person_id) REFERENCES family_people(household_id,id) ON DELETE CASCADE;
  END IF;
END
$block$;

-- Anonymous paired child credentials are intentionally retired. Keep revoked
-- historical rows valid without permitting creation of new anonymous sessions.
UPDATE family_mobile_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE kind='child' AND (user_id IS NULL OR provider_session_id IS NULL);
UPDATE family_mobile_pairs SET redeemed_at=coalesce(redeemed_at,now());
ALTER TABLE family_mobile_sessions DROP CONSTRAINT IF EXISTS family_mobile_sessions_check;
ALTER TABLE family_mobile_sessions DROP CONSTRAINT IF EXISTS family_mobile_sessions_account_check;
ALTER TABLE family_mobile_sessions ADD CONSTRAINT family_mobile_sessions_account_check CHECK
  ((user_id IS NOT NULL AND provider_session_id IS NOT NULL AND
      ((kind='parent' AND person_id IS NULL) OR (kind='child' AND person_id IS NOT NULL))) OR
   (kind='child' AND revoked_at IS NOT NULL AND person_id IS NOT NULL AND user_id IS NULL AND provider_session_id IS NULL));
