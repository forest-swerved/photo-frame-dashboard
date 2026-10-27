-- Separate parent device controls from the earned-time pool. Existing access guards remain in place.
ALTER TABLE family_managed_devices ADD COLUMN IF NOT EXISTS default_access text NOT NULL DEFAULT 'blocked' CHECK(default_access IN ('blocked','allowed'));
ALTER TABLE family_managed_devices ADD COLUMN IF NOT EXISTS desired_access text NOT NULL DEFAULT 'blocked' CHECK(desired_access IN ('blocked','allowed'));
ALTER TABLE family_managed_devices ADD COLUMN IF NOT EXISTS observed_access text NOT NULL DEFAULT 'unknown' CHECK(observed_access IN ('unknown','blocked','allowed'));
ALTER TABLE family_managed_devices ADD COLUMN IF NOT EXISTS access_verified_at timestamptz;
ALTER TABLE family_managed_devices ADD COLUMN IF NOT EXISTS access_error text;
ALTER TABLE family_internet_commands ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE family_internet_commands ADD COLUMN IF NOT EXISTS device_id uuid;
ALTER TABLE family_internet_commands ADD COLUMN IF NOT EXISTS before_fingerprint text;
ALTER TABLE family_internet_commands ADD COLUMN IF NOT EXISTS after_fingerprint text;
DO $device_command$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='family_internet_commands'::regclass AND conname='family_internet_command_target') THEN
    ALTER TABLE family_internet_commands ADD CONSTRAINT family_internet_command_target CHECK((session_id IS NULL)<>(device_id IS NULL));
    ALTER TABLE family_internet_commands ADD CONSTRAINT family_internet_command_device FOREIGN KEY(household_id,device_id) REFERENCES family_managed_devices(household_id,id);
  END IF;
END
$device_command$;
