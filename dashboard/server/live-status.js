import { digest } from './credentials.js';
import { requireHousehold } from './auth.js';
import { parentCapabilities } from './capabilities.js';
import { householdDate } from './errors.js';

// Small read-only invalidation tokens. No routine/reward reconciliation, provider
// requests, credential data, or public database subscription is needed to poll.
export async function liveStatus(db, principal, { now = new Date() } = {}) {
  const householdId = requireHousehold(principal), personId = principal.role === 'child' ? principal.personId : null;
  const capabilities = await parentCapabilities(db, principal);
  const date = householdDate(principal.household.timezone, now);
  const { rows: [row] } = await db.query(`SELECT
    (SELECT jsonb_build_array(title,timezone) FROM family_households WHERE id=$1) AS home,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(id,version) ORDER BY id),'[]') FROM family_people WHERE household_id=$1 AND ($2::uuid IS NULL OR id=$2)) AS people,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(id,version) ORDER BY id),'[]') FROM family_chores WHERE household_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR person_id=$2)) AS routines,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(id,version,completion_version,status,updated_at) ORDER BY id),'[]') FROM family_chore_occurrences WHERE household_id=$1 AND date=$3::date AND ($2::uuid IS NULL OR person_id=$2)) AS tasks,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(c.chore_id,c.version,c.completed,c.updated_at) ORDER BY c.chore_id),'[]') FROM family_completions c JOIN family_chores r ON r.id=c.chore_id AND r.household_id=c.household_id WHERE c.household_id=$1 AND c.date=$3::date AND ($2::uuid IS NULL OR r.person_id=$2)) AS completions,
    (SELECT coalesce(max(version),0) FROM family_school_calendars WHERE household_id=$1) AS school,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(e.id,e.version) ORDER BY e.id),'[]') FROM family_chore_exceptions e WHERE e.household_id=$1 AND e.revoked_at IS NULL AND e.from_date<=$3::date AND e.to_date>$3::date AND ($2::uuid IS NULL OR e.person_id IS NULL OR e.person_id=$2) AND ($2::uuid IS NULL OR e.chore_id IS NULL OR EXISTS(SELECT 1 FROM family_chores r WHERE r.household_id=e.household_id AND r.id=e.chore_id AND r.person_id=$2))) AS exceptions,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(d.id,d.version,d.control_state,d.default_access,d.desired_access,d.observed_access,d.access_verified_at,d.access_error,d.management_verified_at,d.last_seen_at,d.online,
      EXISTS(SELECT 1 FROM family_internet_commands c WHERE c.household_id=d.household_id AND c.device_id=d.id AND c.state IN ('pending','leased','attention'))) ORDER BY d.id),'[]') FROM family_managed_devices d WHERE d.household_id=$1 AND d.removed_at IS NULL AND ($2::uuid IS NULL OR $2=ANY(d.person_ids))) AS devices,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(s.id,s.version,s.state,s.desired_state,s.observed_state,s.verified_at,s.started_at,s.ends_at,s.remaining_seconds,s.allocated_seconds,s.all_day,s.last_error,s.ended_at,s.policy_snapshot->'preparation') ORDER BY s.id),'[]') FROM (SELECT * FROM family_internet_sessions WHERE household_id=$1 AND ($2::uuid IS NULL OR person_id=$2) ORDER BY requested_at DESC LIMIT 100) s) AS sessions,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(c.id,c.status,c.expires_at,c.expires_at>$4) ORDER BY c.id),'[]') FROM (SELECT * FROM family_reward_credits WHERE household_id=$1 AND ($2::uuid IS NULL OR person_id=$2) ORDER BY created_at DESC LIMIT 100) c) AS credits,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(person_id,version) ORDER BY person_id),'[]') FROM family_reward_policies WHERE household_id=$1 AND ($2::uuid IS NULL OR person_id=$2)) AS policies,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(r.id,r.version,r.status,r.expires_at,r.expires_at>$4) ORDER BY r.id),'[]') FROM (SELECT * FROM family_access_requests WHERE household_id=$1 AND ($2::uuid IS NULL OR person_id=$2) ORDER BY (status='pending') DESC,requested_at DESC LIMIT 100) r) AS requests,
    (SELECT jsonb_build_array(version,state,last_checked_at,last_error,management_verified_at) FROM family_network_integrations WHERE household_id=$1) AS integration,
    (SELECT jsonb_build_array(version,updated_at,selected_ids) FROM family_calendar_connections WHERE household_id=$1) AS connection,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(start_date,end_date,timezone,connection_version,successful_at) ORDER BY start_date,end_date,timezone),'[]') FROM family_calendar_cache WHERE household_id=$1) AS calendar,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(start_date,end_date,timezone,connection_version,next_attempt_at,last_attempt_at,last_successful_at,attempts,last_error_code,lease_until>$4) ORDER BY start_date,end_date,timezone),'[]') FROM family_calendar_sync_jobs WHERE household_id=$1) AS calendar_jobs`,
  [householdId, personId, date, now]);
  const scope = [householdId, personId, principal.role, capabilities, date];
  const household = digest(JSON.stringify([scope,row.home,row.people,row.routines,row.tasks,row.completions,row.school,row.exceptions]));
  return { serverTime: now.toISOString(), household,
    internet: digest(JSON.stringify([household,row.devices,row.sessions,row.credits,row.policies,row.requests,row.integration])),
    calendar: digest(JSON.stringify([scope,row.home,row.connection,row.calendar,row.calendar_jobs])) };
}
