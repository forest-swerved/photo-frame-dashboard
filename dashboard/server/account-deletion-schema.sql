-- Owner SQL, applied after every household schema. The only Data API entry
-- point is the narrowly granted RPC used by the authenticated deletion Edge
-- function. No Supabase API role receives access to these tables.
CREATE TABLE IF NOT EXISTS family_account_deletion_jobs (
  user_id uuid PRIMARY KEY,
  stage text NOT NULL CHECK(stage IN ('data_deleted','auth_deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE family_account_deletion_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE family_account_deletion_jobs FROM PUBLIC;

CREATE OR REPLACE FUNCTION family_delete_account_data(p_user_id uuid,p_action text DEFAULT 'prepare',p_verified_email text DEFAULT NULL,p_verified_session_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $delete_account$
DECLARE
  account_id text := p_user_id::text;
  member_record record;
  existing_stage text;
  delete_households uuid[] := ARRAY[]::uuid[];
  actor_ids text[];
  grant_ids text[];
  account_emails text[];
  delete_household_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_action IS NULL OR p_action NOT IN ('prepare','complete') THEN
    RETURN jsonb_build_object('ok',false,'code','invalid_deletion','message','The deletion request is invalid.');
  END IF;
  PERFORM set_config('lock_timeout','2s',true);
  -- Same account lock as invitation redemption. No provider work occurs while
  -- this transaction is open; cleanup and its recovery marker commit together.
  PERFORM pg_advisory_xact_lock(hashtextextended('membership:'||account_id,0));
  SELECT stage INTO existing_stage FROM family_account_deletion_jobs WHERE user_id=p_user_id FOR UPDATE;
  IF p_action='complete' THEN
    IF existing_stage IS NULL THEN
      RETURN jsonb_build_object('ok',false,'code','deletion_not_started','message','Account cleanup must finish first.');
    END IF;
    UPDATE family_account_deletion_jobs SET stage='auth_deleted',updated_at=now() WHERE user_id=p_user_id;
    RETURN jsonb_build_object('ok',true,'stage','auth_deleted');
  END IF;
  -- getUser authenticates the signed JWT, but a signed token can outlive
  -- sign-out. Require the exact live provider session before any cleanup or
  -- recovery acknowledgement. This is the existing read-only owner view.
  IF p_verified_session_id IS NULL OR NOT EXISTS(SELECT 1 FROM family_internal.auth_sessions s
    WHERE s.id=p_verified_session_id AND s.user_id=p_user_id AND (s.not_after IS NULL OR s.not_after>now())) THEN
    RETURN jsonb_build_object('ok',false,'code','reauthentication_required','message','Sign in again before deleting your account.');
  END IF;
  IF existing_stage IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'stage',existing_stage); END IF;

  -- Validate every household before changing any account data. The Internet
  -- lock matches session/reward mutations; the household row lock also stops
  -- concurrent FK inserts while a sole-owner household is being removed.
  FOR member_record IN SELECT * FROM family_members WHERE user_id=account_id ORDER BY household_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('internet:'||member_record.household_id::text,0));
    PERFORM user_id FROM family_members WHERE household_id=member_record.household_id ORDER BY user_id FOR UPDATE;
    PERFORM id FROM family_households WHERE id=member_record.household_id FOR UPDATE;
    IF member_record.role='admin' AND member_record.revoked_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM family_members m WHERE m.household_id=member_record.household_id AND m.user_id<>account_id AND m.role='admin' AND m.revoked_at IS NULL) THEN
      IF EXISTS(SELECT 1 FROM family_members m WHERE m.household_id=member_record.household_id AND m.user_id<>account_id AND m.revoked_at IS NULL) THEN
        RETURN jsonb_build_object('ok',false,'code','ownership_transfer_required','message','Transfer household ownership to an existing adult before deleting your account.');
      END IF;
      IF EXISTS(SELECT 1 FROM family_managed_devices d WHERE d.household_id=member_record.household_id
        AND (d.control_state='attention' OR d.management_policy_id IS NOT NULL OR d.deny_policy_id IS NOT NULL OR d.apple_push_policy_id IS NOT NULL OR d.removed_at IS NULL AND d.control_state='ready')) THEN
        RETURN jsonb_build_object('ok',false,'code','managed_devices_enrolled','message','Unenroll managed Internet devices and verify their firewall policies are removed before deleting this household.');
      END IF;
      IF EXISTS(SELECT 1 FROM family_internet_sessions s WHERE s.household_id=member_record.household_id AND s.state NOT IN ('ended','failed')) THEN
        RETURN jsonb_build_object('ok',false,'code','internet_sessions_active','message','End all Internet sessions and wait for confirmed blocking before deleting this household.');
      END IF;
      delete_households := array_append(delete_households,member_record.household_id);
    END IF;
  END LOOP;

  SELECT coalesce(array_agg(DISTINCT lower(trim(email))),ARRAY[]::text[]) INTO account_emails FROM family_members WHERE user_id=account_id;
  IF p_verified_email IS NOT NULL AND length(p_verified_email) BETWEEN 3 AND 254 THEN account_emails := array_append(account_emails,lower(trim(p_verified_email))); END IF;
  SELECT ARRAY['user:'||account_id]||coalesce(array_agg('mobile:'||id::text),ARRAY[]::text[]) INTO actor_ids FROM family_mobile_sessions WHERE user_id=account_id;
  SELECT coalesce(array_agg(id::text),ARRAY[]::text[]) INTO grant_ids FROM family_frame_authorizations WHERE created_by=account_id;
  INSERT INTO family_account_deletion_jobs(user_id,stage) VALUES(p_user_id,'data_deleted');

  -- Retain family-owned work/calendar/profile records, while removing account
  -- identifiers from their shared audit history. Names entered as chore titles
  -- or family profile names are shared household content, not login identity.
  UPDATE family_completions SET actor='deleted:account' WHERE actor=ANY(actor_ids) OR split_part(actor,':approval:',2)=ANY(grant_ids);
  UPDATE family_chore_occurrences SET
    completed_by=CASE WHEN completed_by=ANY(actor_ids) OR split_part(completed_by,':approval:',2)=ANY(grant_ids) THEN 'deleted:account' ELSE completed_by END,
    approved_by=CASE WHEN approved_by=ANY(actor_ids) OR split_part(approved_by,':approval:',2)=ANY(grant_ids) THEN 'deleted:account' ELSE approved_by END
    WHERE completed_by=ANY(actor_ids) OR approved_by=ANY(actor_ids) OR split_part(completed_by,':approval:',2)=ANY(grant_ids) OR split_part(approved_by,':approval:',2)=ANY(grant_ids);
  UPDATE family_chore_events SET actor='deleted:account',actor_name='Deleted account'
    WHERE actor=ANY(actor_ids) OR split_part(actor,':approval:',2)=ANY(grant_ids);
  UPDATE family_chore_exceptions SET created_by='deleted:account' WHERE created_by=ANY(actor_ids) OR created_by=account_id OR split_part(created_by,':approval:',2)=ANY(grant_ids);
  UPDATE family_school_calendars SET created_by='deleted:account' WHERE created_by=ANY(actor_ids) OR created_by=account_id OR split_part(created_by,':approval:',2)=ANY(grant_ids);
  UPDATE family_internet_events SET actor='deleted:account' WHERE actor=ANY(actor_ids) OR split_part(actor,':approval:',2)=ANY(grant_ids);
  UPDATE family_internet_sessions SET created_by='deleted:account' WHERE created_by=ANY(actor_ids) OR split_part(created_by,':approval:',2)=ANY(grant_ids);
  DELETE FROM family_mutations WHERE actor=ANY(actor_ids) OR split_part(actor,':approval:',2)=ANY(grant_ids);
  DELETE FROM family_invites WHERE created_by=account_id OR redeemed_by=account_id OR lower(trim(email))=ANY(account_emails);
  DELETE FROM family_frame_authorizations WHERE created_by=account_id;
  -- Session deletion cascades through APNs installations, encrypted device
  -- tokens, inbox deliveries, and legacy installation preferences.
  DELETE FROM family_mobile_sessions WHERE user_id=account_id;
  DELETE FROM family_account_notification_inbox WHERE user_id=account_id;
  DELETE FROM family_account_notification_preferences WHERE user_id=account_id;
  DELETE FROM family_members WHERE user_id=account_id;

  FOREACH delete_household_id IN ARRAY delete_households LOOP
    -- Explicit dependency order; nothing touches managed Auth schemas here.
    DELETE FROM family_notification_inbox n WHERE n.household_id=delete_household_id;
    DELETE FROM family_push_installations n WHERE n.household_id=delete_household_id;
    DELETE FROM family_notification_preferences n WHERE n.household_id=delete_household_id;
    DELETE FROM family_account_notification_inbox n WHERE n.household_id=delete_household_id;
    DELETE FROM family_account_notification_preferences n WHERE n.household_id=delete_household_id;
    DELETE FROM family_mobile_sessions n WHERE n.household_id=delete_household_id;
    DELETE FROM family_mobile_pairs n WHERE n.household_id=delete_household_id;
    DELETE FROM family_frame_authorizations n WHERE n.household_id=delete_household_id;
    DELETE FROM family_internet_commands n WHERE n.household_id=delete_household_id;
    DELETE FROM family_internet_events n WHERE n.household_id=delete_household_id;
    DELETE FROM family_internet_sessions n WHERE n.household_id=delete_household_id;
    DELETE FROM family_reward_credits n WHERE n.household_id=delete_household_id;
    DELETE FROM family_reward_policies n WHERE n.household_id=delete_household_id;
    DELETE FROM family_managed_devices n WHERE n.household_id=delete_household_id;
    DELETE FROM family_network_integrations n WHERE n.household_id=delete_household_id;
    DELETE FROM family_chore_events n WHERE n.household_id=delete_household_id;
    DELETE FROM family_chore_occurrences n WHERE n.household_id=delete_household_id;
    DELETE FROM family_chore_exceptions n WHERE n.household_id=delete_household_id;
    DELETE FROM family_completions n WHERE n.household_id=delete_household_id;
    DELETE FROM family_chores n WHERE n.household_id=delete_household_id;
    DELETE FROM family_invites n WHERE n.household_id=delete_household_id;
    DELETE FROM family_members n WHERE n.household_id=delete_household_id;
    DELETE FROM family_people n WHERE n.household_id=delete_household_id;
    DELETE FROM family_devices n WHERE n.household_id=delete_household_id;
    DELETE FROM family_frame_pairs n WHERE n.household_id=delete_household_id;
    DELETE FROM family_calendar_cache n WHERE n.household_id=delete_household_id;
    DELETE FROM family_calendar_sync_jobs n WHERE n.household_id=delete_household_id;
    DELETE FROM family_calendar_connections n WHERE n.household_id=delete_household_id;
    DELETE FROM family_school_calendars n WHERE n.household_id=delete_household_id;
    DELETE FROM family_notification_events n WHERE n.household_id=delete_household_id;
    DELETE FROM family_notification_scan_state n WHERE n.household_id=delete_household_id;
    DELETE FROM family_mutations n WHERE n.household_id=delete_household_id;
    DELETE FROM family_households WHERE id=delete_household_id;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'stage','data_deleted','householdsDeleted',cardinality(delete_households));
END
$delete_account$;
-- pg_temp must be explicitly last, never its implicit first position. Capture
-- the owning schema at migration time so callers cannot shadow definer tables.
DO $deletion_privileges$
DECLARE role_name text; own_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.family_delete_account_data(uuid,text,text,uuid) SET search_path TO pg_catalog,%I,pg_temp',own_schema,own_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.family_delete_account_data(uuid,text,text,uuid) FROM PUBLIC',own_schema);
  FOR role_name IN SELECT DISTINCT r.rolname FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles r ON r.oid=a.grantee
    WHERE p.oid=format('%I.family_delete_account_data(uuid,text,text,uuid)',own_schema)::regprocedure AND a.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.family_delete_account_data(uuid,text,text,uuid) FROM %I',own_schema,role_name);
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE %I.family_account_deletion_jobs FROM %I',own_schema,role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION %I.family_delete_account_data(uuid,text,text,uuid) FROM %I',own_schema,role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.family_delete_account_data(uuid,text,text,uuid) TO service_role',own_schema);
  END IF;
END
$deletion_privileges$;
