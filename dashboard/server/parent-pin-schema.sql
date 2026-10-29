-- Durable parent PINs belong to the existing private membership record. No new
-- browser grants, policies, privileged functions, or auth-schema access.
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS frame_pin_hash text;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS frame_pin_salt text;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS frame_pin_updated_at timestamptz;
ALTER TABLE family_members ADD COLUMN IF NOT EXISTS frame_pin_lookup text;
CREATE UNIQUE INDEX IF NOT EXISTS family_members_parent_pin_unique ON family_members(household_id,frame_pin_lookup) WHERE frame_pin_lookup IS NOT NULL AND revoked_at IS NULL;
ALTER TABLE family_devices ADD COLUMN IF NOT EXISTS parent_pin_failures integer NOT NULL DEFAULT 0;
ALTER TABLE family_devices ADD COLUMN IF NOT EXISTS parent_pin_locked_until timestamptz;
