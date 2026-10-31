-- History is separately opted into by each adult, retained until that adult
-- deletes it or their household membership/account is deleted.
ALTER TABLE family_parent_locations ADD COLUMN IF NOT EXISTS history_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE family_parent_locations ADD COLUMN IF NOT EXISTS refresh_requested_at timestamptz;
CREATE TABLE IF NOT EXISTS family_parent_location_history (
  household_id uuid NOT NULL REFERENCES family_households(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy double precision NOT NULL CHECK (accuracy BETWEEN 0 AND 50000),
  place text NOT NULL CHECK (length(place)<=160),
  PRIMARY KEY (household_id,user_id,recorded_at),
  FOREIGN KEY (household_id,user_id) REFERENCES family_members(household_id,user_id) ON DELETE CASCADE
);
ALTER TABLE family_parent_location_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON family_parent_location_history FROM PUBLIC;
DO $block$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON family_parent_location_history FROM %I',r);
    END IF;
  END LOOP;
END
$block$;
