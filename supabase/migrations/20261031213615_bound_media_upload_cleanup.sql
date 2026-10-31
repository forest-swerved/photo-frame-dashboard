-- Final cleanup outlives signed upload links and in-flight provider writes.
CREATE OR REPLACE FUNCTION family_queue_media_cleanup() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path FROM CURRENT AS $media_cleanup$
BEGIN
  INSERT INTO family_media_cleanup(object_key,reserved_bytes,not_before) VALUES(OLD.object_key,CASE WHEN OLD.kind='video' THEN 52428800 ELSE OLD.bytes END,now()+interval '3 hours') ON CONFLICT DO NOTHING;
  RETURN OLD;
END
$media_cleanup$;
