-- Original media remain private; only the server owner can authorize access.
CREATE TABLE IF NOT EXISTS family_media (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES family_households(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('photo','video')),
  object_key text NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 52428800),
  width integer NOT NULL CHECK(width BETWEEN 1 AND 8192),
  height integer NOT NULL CHECK(height BETWEEN 1 AND 8192),
  duration double precision CHECK(duration>0 AND duration<=300),
  ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((kind='photo' AND duration IS NULL) OR (kind='video' AND duration IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS family_media_household ON family_media(household_id,created_at,id);
-- No household FK: cleanup must survive deletion of its owning household.
CREATE TABLE IF NOT EXISTS family_media_cleanup (
  object_key text PRIMARY KEY,
  not_before timestamptz NOT NULL DEFAULT now()+interval '3 hours',
  reserved_bytes integer NOT NULL CHECK(reserved_bytes BETWEEN 1 AND 52428800),
  attempts integer NOT NULL DEFAULT 0
);
CREATE OR REPLACE FUNCTION family_queue_media_cleanup() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path FROM CURRENT AS $media_cleanup$
BEGIN
  INSERT INTO family_media_cleanup(object_key,reserved_bytes,not_before) VALUES(OLD.object_key,CASE WHEN OLD.kind='video' THEN 52428800 ELSE OLD.bytes END,now()+interval '3 hours') ON CONFLICT DO NOTHING;
  RETURN OLD;
END
$media_cleanup$;
DROP TRIGGER IF EXISTS family_media_removed ON family_media;
CREATE TRIGGER family_media_removed AFTER DELETE ON family_media FOR EACH ROW EXECUTE FUNCTION family_queue_media_cleanup();
ALTER TABLE family_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_media_cleanup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE family_media,family_media_cleanup FROM PUBLIC;
REVOKE ALL ON FUNCTION family_queue_media_cleanup() FROM PUBLIC;
DO $media_privileges$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE family_media,family_media_cleanup FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION family_queue_media_cleanup() FROM %I',role_name);
    END IF;
  END LOOP;
END
$media_privileges$;
