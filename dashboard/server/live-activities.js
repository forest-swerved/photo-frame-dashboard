import { randomUUID, timingSafeEqual } from 'node:crypto';
import { one, transaction } from './database.js';
import { requireValue, uuidField } from './errors.js';
import { encryptCredentials, decryptCredentials, keyedDigest, digest } from './credentials.js';
import { activeMobileSessionSql } from './mobile.js';
import { readDeviceWidgetSnapshot } from './device-widget.js';
import { sendLiveActivityApns, classifyApnsResult } from './apns.js';

const capability = (row, expires, env) => keyedDigest('live-activity-token-report-v1', `${row.id}:${row.session_hash}:${expires}`, env);
const allowed = p => requireValue(p.authType === 'mobile' && ['admin','member'].includes(p.role), 403, 'parent_required', 'Live Activities are available to signed-in parents.');
const tokenValid = value => typeof value === 'string' && /^[0-9a-f]{64,400}$/i.test(value) && value.length % 2 === 0;
const eligibleSession = async (db, id, now) => one(db, `SELECT s.* FROM family_mobile_sessions s WHERE s.id=$1 AND s.kind='parent' AND ${activeMobileSessionSql('s','$2')}`, [id, now]);

export async function registerLiveActivity(db, principal, body, {env=process.env, now=new Date()}={}) {
 allowed(principal);
 const installationId=uuidField(body.installationId);
 requireValue(['production','sandbox'].includes(body.environment) && typeof body.enabled==='boolean',422,'invalid_activity','Use valid Live Activity settings.');
 return transaction(db,async client=>{
  const session=await eligibleSession(client,principal.mobileSessionId,now);
  requireValue(session && session.household_id===principal.household.id,401,'mobile_session_revoked','Sign in again.');
  const row=await one(client,`INSERT INTO family_live_activity_installations(id,household_id,mobile_session_id,installation_id,environment,enabled)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(mobile_session_id,installation_id,environment)
   DO UPDATE SET enabled=EXCLUDED.enabled,registered_at=$7 RETURNING *`,[randomUUID(),session.household_id,session.id,installationId,body.environment,body.enabled,now]);
  const expires=Math.floor(Math.min(+new Date(session.expires_at),(Math.floor(+now/86400000)+8)*86400000)/1000);
  return {registrationId:row.id,reportToken:`${row.id}.${expires}.${capability({...row,session_hash:session.token_hash},expires,env)}`,expiresAt:new Date(expires*1000).toISOString()};
 });
}

// A locked phone can report ActivityKit token rotations without access to its
// full mobile credential. This capability can only register/disable this row.
export async function reportLiveActivity(request, db, body, {env=process.env,now=new Date()}={}) {
 const match=/^FamilyActivity ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.(\d{10})\.([0-9a-f]{64})$/.exec(request.headers.get('authorization')||'');
 requireValue(match && +match[2]*1000>+now,401,'activity_session_required','Open Family Frame to reconnect.');
 requireValue(['start','update','dismiss','disable','reconcile'].includes(body.kind),422,'invalid_activity','Use a valid activity report.');
 return transaction(db,async client=>{
  const row=await one(client,`SELECT l.*,s.token_hash AS session_hash FROM family_live_activity_installations l
   JOIN family_mobile_sessions s ON s.id=l.mobile_session_id AND s.household_id=l.household_id
   WHERE l.id=$1 AND s.kind='parent' AND ${activeMobileSessionSql('s','$2')} FOR UPDATE OF l`,[match[1],now]);
  requireValue(row && timingSafeEqual(Buffer.from(match[3],'hex'),Buffer.from(capability(row,match[2],env),'hex')),401,'activity_session_revoked','Open Family Frame to reconnect.');
  if(body.kind==='reconcile') {
   requireValue(Array.isArray(body.runIds) && body.runIds.length<=20 && body.runIds.every(id=>typeof id==='string' && id.length<=40),422,'invalid_activity','Use valid activity identifiers.');
   if(row.run_id && !body.runIds.includes(row.run_id) && +now-+new Date(row.started_at)>120000)
    await client.query('UPDATE family_live_activity_installations SET dismissed=true,activity_credentials=NULL WHERE id=$1',[row.id]);
   return {registered:true,registrationId:row.id};
  }
  if(body.kind==='disable') {await client.query('UPDATE family_live_activity_installations SET enabled=false,next_attempt_at=$2 WHERE id=$1',[row.id,now]);return {registered:true,registrationId:row.id};}
  if(body.kind==='start') {
   requireValue(tokenValid(body.token),422,'invalid_activity','Use a valid ActivityKit token.');
   const token=body.token.toLowerCase(), hash=keyedDigest('activity-start',`${row.environment}:${token}`,env);
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`activity-token:${hash}`]);
   // Receiving the same secret token proves this is the same physical install.
   // Remove the old account binding rather than fan out across sign-ins.
   await client.query('DELETE FROM family_live_activity_installations WHERE start_token_hash=$1 AND id<>$2',[hash,row.id]);
   await client.query('UPDATE family_live_activity_installations SET start_credentials=$2::jsonb,start_token_hash=$3 WHERE id=$1',
    [row.id,JSON.stringify(encryptCredentials(row.household_id,{purpose:'activity-start',token},env)),hash]);
  } else {
   const runId=uuidField(body.runId);
   requireValue(row.run_id===runId,409,'activity_changed','This activity is no longer current.');
   if(body.kind==='dismiss') await client.query('UPDATE family_live_activity_installations SET dismissed=true,activity_credentials=NULL WHERE id=$1',[row.id]);
   else {
    requireValue(tokenValid(body.token),422,'invalid_activity','Use a valid ActivityKit token.');
    if(!row.dismissed) await client.query('UPDATE family_live_activity_installations SET activity_credentials=$2::jsonb,next_attempt_at=$3,last_state_hash=NULL WHERE id=$1',
     [row.id,JSON.stringify(encryptCredentials(row.household_id,{purpose:'activity-update',token:body.token.toLowerCase()},env)),now]);
   }
  }
  return {registered:true,registrationId:row.id};
 });
}

export function liveActivityContent(snapshot, showDetails=true) {
 const candidates=snapshot.items.filter(i=>!['Paused','Internet off'].includes(i.status));
 const confirmed=candidates.some(i=>['Time running','Internet on'].includes(i.status));
 const seconds=value=>value?Math.floor(+new Date(value)/1000):null;
 const items=candidates.slice(0,4).map(i=>({id:i.id,person:showDetails?i.person.slice(0,80):'',device:showDetails?i.device.slice(0,80):'Device',status:i.status,
  endsAt:seconds(i.endsAt),preparationEndsAt:seconds(i.preparationEndsAt)}));
 return {confirmed,content:{items,totalCount:candidates.length,checkedAt:seconds(snapshot.checkedAt)}};
}
export function liveActivityPayload(event, content, registrationId, runId, now) {
 const timestamp=Math.floor(+now/1000);
 const aps={timestamp,event,'content-state':content,'stale-date':timestamp+300};
 if(event==='start') Object.assign(aps,{'attributes-type':'DeviceAccessActivityAttributes',attributes:{registrationId,runId},'input-push-token':1,
  alert:{title:'Device access is on',body:'Device time or an Internet-on override is active.'}});
 if(event==='end') aps['dismissal-date']=timestamp-1;
 return {aps};
}

async function claim(db,id,env,now,readSnapshot) {
 return transaction(db,async client=>{
  const row=await one(client,`SELECT l.*,s.user_id FROM family_live_activity_installations l JOIN family_mobile_sessions s ON s.id=l.mobile_session_id
   WHERE l.id=$1 AND (l.lease_until IS NULL OR l.lease_until<=$2) AND l.next_attempt_at<=$2 FOR UPDATE OF l SKIP LOCKED`,[id,now]);
  if(!row)return null;
  await client.query('UPDATE family_live_activity_installations SET next_attempt_at=$2 WHERE id=$1',[id,new Date(+now+60000)]);
  const active=await eligibleSession(client,row.mobile_session_id,now);
  const preferences=active?await one(client,'SELECT show_details,push_enabled,internet_sessions FROM family_account_notification_preferences WHERE household_id=$1 AND user_id=$2',[row.household_id,row.user_id]):null;
  const enabled=row.enabled && active && preferences?.push_enabled!==false && preferences?.internet_sessions!==false;
  const snapshot=enabled?await readSnapshot(client,row.household_id,now):{checkedAt:now.toISOString(),items:[]};
  const {confirmed,content}=liveActivityContent(snapshot,preferences?.show_details!==false);
  const hasItems=content.totalCount>0;
  if(row.dismissed && !hasItems) {
   await client.query('UPDATE family_live_activity_installations SET run_id=NULL,dismissed=false,activity_credentials=NULL,started_at=NULL WHERE id=$1',[id]);return null;
  }
  if(row.dismissed)return null;
  let event,runId=row.run_id,credentials;
  if(!runId) {
   if(!enabled || !confirmed || !row.start_credentials)return null;
   event='start';runId=randomUUID();credentials=row.start_credentials;
  } else {
   if(!row.activity_credentials)return null; // Never replay an uncertain start.
   event=!hasItems || !enabled || +now-+new Date(row.started_at)>7.5*3600000?'end':'update';credentials=row.activity_credentials;
  }
  const stateHash=digest(JSON.stringify({...content,checkedAt:0}));
  if(event==='update' && row.last_state_hash===stateHash && +now-+new Date(row.last_sent_at)<180000)return null;
  let secret;
  try { secret=decryptCredentials(row.household_id,credentials,env); } catch { secret=null; }
  requireValue(secret?.purpose===(event==='start'?'activity-start':'activity-update'),503,'activity_credentials_invalid','Activity delivery is unavailable.');
  const leaseId=randomUUID();
  await client.query(`UPDATE family_live_activity_installations SET run_id=$2,started_at=coalesce(started_at,$3),lease_id=$4,lease_until=$5 WHERE id=$1`,[id,runId,now,leaseId,new Date(+now+45000)]);
  return {id,runId,leaseId,event,stateHash,environment:row.environment,token:secret.token,payload:liveActivityPayload(event,content,row.id,runId,now)};
 });
}
export async function processLiveActivities(db,{env=process.env,now=new Date(),send=sendLiveActivityApns,readSnapshot=readDeviceWidgetSnapshot,registrationId=null}={}) {
 const rows=(await db.query(`SELECT id FROM family_live_activity_installations WHERE (enabled OR run_id IS NOT NULL)
  AND next_attempt_at<=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY next_attempt_at,id LIMIT 30`,[now,registrationId])).rows;
 const counts={accepted:0,failed:0,skipped:0};
 for(let index=0;index<rows.length;index+=3)await Promise.all(rows.slice(index,index+3).map(async row=>{
  let action;
  try {action=await claim(db,row.id,env,now,readSnapshot);}catch{counts.failed++;return;}
  if(!action){counts.skipped++;return;}
  let result;
  try {result=await send({token:action.token,environment:action.environment,notificationId:action.leaseId,expiresAt:new Date(+now+60000),payload:action.payload},env);}catch{result={status:0,accepted:false};}
  const accepted=result.accepted && result.status===200;
  const decision=classifyApnsResult(result);
  // Starts are at-most-once: a lost reply must not produce duplicate cards.
  // Updates/end are safe to retry with a new timestamp and the latest state.
  const finished=accepted && action.event==='end' || decision.disable || (action.event==='start' && !accepted && result.status>0);
  await db.query(`UPDATE family_live_activity_installations SET lease_id=NULL,lease_until=NULL,last_error=$3,
   last_sent_at=CASE WHEN $4 THEN $5 ELSE last_sent_at END,last_state_hash=CASE WHEN $4 THEN $6 ELSE last_state_hash END,
   next_attempt_at=$7,run_id=CASE WHEN $8 THEN NULL ELSE run_id END,started_at=CASE WHEN $8 THEN NULL ELSE started_at END,
   activity_credentials=CASE WHEN $8 THEN NULL ELSE activity_credentials END,
   start_credentials=CASE WHEN $9 THEN NULL ELSE start_credentials END,
   dismissed=CASE WHEN $10 THEN true ELSE dismissed END
   WHERE id=$1 AND lease_id=$2`,[action.id,action.leaseId,accepted?null:decision.reason,accepted,now,action.stateHash,
    new Date(+now+(accepted?60:(decision.retrySeconds||900))*1000),finished,decision.disable && action.event==='start',decision.disable && action.event!=='start']);
  counts[accepted?'accepted':'failed']++;
 }));
 return counts;
}
