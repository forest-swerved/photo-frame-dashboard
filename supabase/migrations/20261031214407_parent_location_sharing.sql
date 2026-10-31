-- Latest opt-in adult position only; access stays behind the household API.
CREATE TABLE IF NOT EXISTS family_parent_locations (
  household_id uuid NOT NULL REFERENCES family_households(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  mobile_session_id uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0 CHECK (version>=0),
  report_token_hash text UNIQUE,
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  accuracy double precision CHECK (accuracy BETWEEN 0 AND 50000),
  place text CHECK (length(place)<=160),
  recorded_at timestamptz,
  received_at timestamptz,
  PRIMARY KEY (household_id,user_id),
  FOREIGN KEY (household_id,user_id) REFERENCES family_members(household_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (household_id,mobile_session_id) REFERENCES family_mobile_sessions(household_id,id) ON DELETE CASCADE,
  CHECK (enabled OR (report_token_hash IS NULL AND latitude IS NULL AND longitude IS NULL AND place IS NULL))
);
ALTER TABLE family_parent_locations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON family_parent_locations FROM PUBLIC;
DO $block$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON family_parent_locations FROM %I',r);
    END IF;
  END LOOP;
END
$block$;
