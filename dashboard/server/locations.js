import { one, transaction } from './database.js';
import { requireValue, textField, versionField } from './errors.js';
import { requireHousehold } from './auth.js';
import { activeMobileSessionSql } from './mobile.js';
import { randomUUID } from 'node:crypto';
import { sendApns } from './apns.js';
import { digest, randomToken, decryptCredentials } from './credentials.js';

const active = activeMobileSessionSql('s', 'now()');
const erase = 'latitude=NULL,longitude=NULL,accuracy=NULL,place=NULL,recorded_at=NULL,received_at=NULL';
const stop = `enabled=false,history_enabled=false,report_token_hash=NULL,${erase}`;
export async function locations(db, principal) {
  const household = requireHousehold(principal);
  const rows = (await db.query(`SELECT l.* FROM family_parent_locations l JOIN family_mobile_sessions s ON s.id=l.mobile_session_id
    WHERE l.household_id=$1 AND l.enabled AND l.user_id=s.user_id AND s.kind='parent' AND ${active} ORDER BY l.label,l.user_id`, [household])).rows;
  const own = principal.authType === 'mobile' && ['admin','member'].includes(principal.role)
    ? await one(db, 'SELECT * FROM family_parent_locations WHERE household_id=$1 AND user_id=$2', [household, principal.user.id]) : null;
  const parents = rows.map((r,i) => {
    const fresh = r.recorded_at && Date.now() - new Date(r.recorded_at).getTime() < 86400000;
    return { id:r.user_id, marker:String.fromCharCode(65+i%26), label:r.label, latitude:fresh?r.latitude:null, longitude:fresh?r.longitude:null,
      accuracy:fresh?r.accuracy:null, place:fresh?r.place:null, recordedAt:fresh?r.recorded_at:null };
  });
  return { parents, sharing:own ? { enabled:rows.some(r=>r.user_id===own.user_id), version:own.version, label:own.label, thisPhone:own.mobile_session_id===principal.mobileSessionId, historyEnabled:own.history_enabled }
    : { enabled:false, version:0, label:'', thisPhone:false, historyEnabled:false } };
}
export async function changeLocationSharing(db, principal, body) {
  const household = requireHousehold(principal);
  requireValue(principal.authType==='mobile' && ['admin','member'].includes(principal.role),403,'parent_phone_required','Only a parent can share their own phone location.');
  requireValue(typeof body.enabled==='boolean',422,'invalid_field','Choose whether to share this phone location.');
  const version=versionField(body.expectedVersion), label=textField(body.label,'Map name',40);
  return transaction(db,async client=>{
    const session=await one(client,`SELECT s.id FROM family_mobile_sessions s WHERE s.id=$1 AND s.household_id=$2 AND s.user_id=$3 AND s.kind='parent' AND ${active} FOR SHARE OF s`,[principal.mobileSessionId,household,principal.user.id]);
    requireValue(session,401,'mobile_session_revoked','Sign in again before sharing your location.');
    await client.query(`INSERT INTO family_parent_locations(household_id,user_id,mobile_session_id,label) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[household,principal.user.id,session.id,label]);
    const token=body.enabled?randomToken():null;
    const saved=await one(client,`UPDATE family_parent_locations SET history_enabled=CASE WHEN $4 AND mobile_session_id=$3 THEN history_enabled ELSE false END,enabled=$4,label=$5,mobile_session_id=$3,report_token_hash=$6,version=version+1,${erase}
      WHERE household_id=$1 AND user_id=$2 AND version=$7 RETURNING version,history_enabled`,[household,principal.user.id,session.id,body.enabled,label,token?digest(token):null,version]);
    requireValue(saved,409,'location_changed','Location sharing changed on another phone. Refresh and try again.');
    return { sharing:{enabled:body.enabled,label,version:saved.version,thisPhone:true,historyEnabled:saved.history_enabled}, reportToken:token };
  });
}
export function locationReport(body, now=Date.now()) {
  for (const [key,min,max] of [['latitude',-90,90],['longitude',-180,180],['accuracy',0,50000]])
    requireValue(typeof body[key]==='number' && Number.isFinite(body[key]) && body[key]>=min && body[key]<=max,422,'invalid_location','The phone location is invalid.');
  const recorded=Date.parse(body.recordedAt);
  requireValue(Number.isFinite(recorded) && recorded<=now+60000 && recorded>=now-900000,422,'invalid_location_time','Wait for a recent phone location.');
  return {latitude:body.latitude,longitude:body.longitude,accuracy:body.accuracy,place:body.place?textField(body.place,'Place name',160):'',recordedAt:new Date(recorded).toISOString()};
}
// This credential can only update or stop its own opted-in location. It can
// never read household data or grant sharing, even when the phone is locked.
export async function reportLocation(db, request, body) {
  const auth=request.headers.get('authorization')||'';
  requireValue(/^FamilyLocation [A-Za-z0-9_-]{43}$/.test(auth),401,'location_token_required','Location sharing needs to be enabled again.');
  const point=request.method==='DELETE'?null:locationReport(body);
  return transaction(db,async client=>{
    const row=await one(client,`SELECT l.* FROM family_parent_locations l JOIN family_mobile_sessions s ON s.id=l.mobile_session_id
      WHERE l.report_token_hash=$1 AND l.enabled AND l.user_id=s.user_id AND s.kind='parent' AND ${active} FOR UPDATE OF l`,[digest(auth.slice(15))]);
    requireValue(row,401,'location_revoked','Location sharing has ended.');
    if(!point){await client.query(`UPDATE family_parent_locations SET ${stop},version=version+1 WHERE household_id=$1 AND user_id=$2`,[row.household_id,row.user_id]);return {stopped:true};}
    if(row.recorded_at && new Date(point.recordedAt)<=new Date(row.recorded_at))return {accepted:false};
    const requested=row.refresh_requested_at && new Date(row.refresh_requested_at)>new Date(row.received_at||0) && new Date(point.recordedAt)>=new Date(new Date(row.refresh_requested_at).getTime()-5000);
    if(!requested && row.received_at && Date.now()-new Date(row.received_at).getTime()<15000)return {accepted:false};
    await client.query(`UPDATE family_parent_locations SET latitude=$3,longitude=$4,accuracy=$5,place=$6,recorded_at=$7,received_at=now()
      WHERE household_id=$1 AND user_id=$2`,[row.household_id,row.user_id,point.latitude,point.longitude,point.accuracy,point.place,point.recordedAt]);
    if(row.history_enabled)await client.query(`INSERT INTO family_parent_location_history(household_id,user_id,latitude,longitude,accuracy,place,recorded_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[row.household_id,row.user_id,point.latitude,point.longitude,point.accuracy,point.place,point.recordedAt]);
    return {accepted:true};
  });
}
export function mapURL(parents, key) {
  const points=parents.map((p,i)=>({...p,marker:p.marker||String.fromCharCode(65+i%26)})).filter(p=>Number.isFinite(p.latitude)&&Number.isFinite(p.longitude));
  if(!points.length)return null;
  requireValue(typeof key==='string'&&key.length>20,503,'map_unconfigured','The family map is not configured.');
  const url=new URL('https://maps.googleapis.com/maps/api/staticmap');
  url.searchParams.set('size','640x400');url.searchParams.set('scale','2');url.searchParams.set('maptype','roadmap');
  points.forEach((p,i)=>url.searchParams.append('markers',`color:${i%2?'0x8c62c8':'0x00748c'}|label:${p.marker}|${p.latitude},${p.longitude}`));
  if(points.length===1)url.searchParams.set('zoom','13');
  url.searchParams.set('key',key);return url.href;
}
export async function locationMap(db,principal,options={}) {
  const {parents}=await locations(db,principal);
  return {url:mapURL(parents,(options.env||process.env).FAMILY_GOOGLE_MAPS_KEY)};
}
export async function cleanupLocations(db) {
  return db.query(`UPDATE family_parent_locations l SET ${erase} WHERE l.recorded_at<now()-interval '24 hours'
    OR (l.enabled AND NOT EXISTS(SELECT 1 FROM family_mobile_sessions s WHERE s.id=l.mobile_session_id AND s.kind='parent' AND ${active}))`);
}

function ownParent(principal) {
  const household=requireHousehold(principal);
  requireValue(principal.authType==='mobile'&&['admin','member'].includes(principal.role),403,'parent_phone_required','Manage your own location history from your phone.');
  return household;
}
export async function locationHistory(db,principal) {
  const household=ownParent(principal);
  const row=await one(db,`SELECT count(*)::int AS count,min(recorded_at) AS oldest FROM family_parent_location_history WHERE household_id=$1 AND user_id=$2`,[household,principal.user.id]);
  return {count:row.count,oldest:row.oldest,retention:'until_deleted'};
}
export async function changeLocationHistory(db,principal,body) {
  const household=ownParent(principal);
  requireValue(typeof body.enabled==='boolean',422,'invalid_field','Choose whether to save your location history.');
  const version=versionField(body.expectedVersion);
  return transaction(db,async client=>{
    const saved=await one(client,`UPDATE family_parent_locations l SET history_enabled=$4,version=version+1 FROM family_mobile_sessions s
      WHERE l.household_id=$1 AND l.user_id=$2 AND l.mobile_session_id=$3 AND l.version=$5 AND l.enabled
      AND s.id=l.mobile_session_id AND s.user_id=l.user_id AND s.kind='parent' AND ${active} RETURNING l.*`,[household,principal.user.id,principal.mobileSessionId,body.enabled,version]);
    requireValue(saved,409,'location_changed','Refresh location sharing on this phone before changing history.');
    return {sharing:{enabled:true,version:saved.version,label:saved.label,thisPhone:true,historyEnabled:saved.history_enabled}};
  });
}
export async function deleteLocationHistory(db,principal) {
  const household=ownParent(principal);
  // Serialize with reports so an in-flight point cannot reappear after deletion.
  // Pausing history here makes “delete all” stay empty until explicitly enabled.
  return transaction(db,async client=>{
    await client.query('UPDATE family_parent_locations SET history_enabled=false,version=version+1 WHERE household_id=$1 AND user_id=$2',[household,principal.user.id]);
    await client.query('DELETE FROM family_parent_location_history WHERE household_id=$1 AND user_id=$2',[household,principal.user.id]);
    return {deleted:true};
  });
}
export async function refreshParentLocation(db,principal,body,{env=process.env,send=sendApns}={}) {
  const household=requireHousehold(principal);
  requireValue(principal.authType==='frame'||['admin','member'].includes(principal.role),403,'parent_or_frame_required','Refresh locations from a parent account or paired frame.');
  const id=textField(body.parentId,'Parent',128);
  const target=await transaction(db,async client=>{
    const row=await one(client,`SELECT l.* FROM family_parent_locations l JOIN family_mobile_sessions s ON s.id=l.mobile_session_id
      WHERE l.household_id=$1 AND l.user_id=$2 AND l.enabled AND l.user_id=s.user_id AND s.kind='parent' AND ${active} FOR UPDATE OF l`,[household,id]);
    requireValue(row,404,'location_unavailable','This parent is not currently sharing a location.');
    requireValue(!row.refresh_requested_at||Date.now()-new Date(row.refresh_requested_at).getTime()>=60000,429,'refresh_rate_limited','Wait a minute before requesting another location.');
    const installation=await one(client,`SELECT credentials,environment FROM family_push_installations WHERE household_id=$1 AND mobile_session_id=$2 AND disabled_at IS NULL ORDER BY registered_at DESC LIMIT 1`,[household,row.mobile_session_id]);
    requireValue(installation,409,'phone_unavailable','Open Family Frame on this parent’s phone to register for location refresh.');
    await client.query('UPDATE family_parent_locations SET refresh_requested_at=now() WHERE household_id=$1 AND user_id=$2',[household,id]);
    return installation;
  });
  let credentials;try{credentials=decryptCredentials(household,target.credentials,env);}catch{}
  requireValue(credentials?.purpose==='apns-device',503,'phone_unavailable','Reopen Family Frame on this parent’s phone and try again.');
  let result;try{result=await send({token:credentials.token,environment:target.environment,notificationId:randomUUID(),expiresAt:new Date(Date.now()+60000),pushType:'background',payload:{aps:{'content-available':1},action:'refresh-parent-location'}},env);}catch{}
  requireValue(result?.accepted===true&&result.status===200,502,'phone_refresh_unavailable','The location request could not be delivered to Apple. Try again shortly.');
  return {requested:true};
}
