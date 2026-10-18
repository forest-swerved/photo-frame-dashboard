import {randomUUID} from 'node:crypto';
import {one,transaction} from './database.js';
import {digest,randomToken} from './credentials.js';
import {ApiError,requireValue,textField,uuidField} from './errors.js';

const householdDto=r=>({id:r.household_id,title:r.title,timezone:r.timezone});
export const isMobile=p=>p?.authType==='mobile';
export function mobileAdmin(p){requireValue(p?.household&&['user','mobile'].includes(p.authType)&&p.role==='admin',403,'admin_required','Only a parent administrator can manage devices.');}
const sessionDto=p=>({authenticated:true,authType:'mobile',role:p.role,user:p.user,household:p.household,personId:p.personId||null});
export {sessionDto as mobileSessionData};

// Session kind is an issuance snapshot. Current membership/provider authority
// must still agree before either HTTP access or background push fanout.
export const activeMobileSessionSql=(alias='s',now='$2')=>`${alias}.revoked_at IS NULL AND ${alias}.expires_at>${now}::timestamptz
 AND EXISTS(SELECT 1 FROM family_members m JOIN family_internal.auth_sessions a ON a.user_id::text=m.user_id
  WHERE m.household_id=${alias}.household_id AND m.user_id=${alias}.user_id AND m.revoked_at IS NULL
   AND a.id=${alias}.provider_session_id AND (a.not_after IS NULL OR a.not_after>${now}::timestamptz)
   AND ((m.role IN ('admin','member') AND ${alias}.kind='parent' AND ${alias}.person_id IS NULL AND m.person_id IS NULL)
    OR (m.role='child' AND ${alias}.kind='child' AND m.person_id=${alias}.person_id AND EXISTS
     (SELECT 1 FROM family_people p WHERE p.household_id=m.household_id AND p.id=m.person_id))))`;

export async function authenticateMobile(request,db){
 const authorization=request.headers.get('authorization')||'';
 requireValue(/^FamilyMobile [A-Za-z0-9_-]{43}$/.test(authorization),401,'mobile_session_required','Sign in to this app again.');
 const row=await one(db,`SELECT s.*,h.title,h.timezone,p.name AS person_name,m.person_id AS member_person_id,m.name AS member_name,m.email AS member_email,m.role AS member_role,m.revoked_at AS member_revoked_at,
   a.id AS active_provider_session FROM family_mobile_sessions s
   JOIN family_households h ON h.id=s.household_id
   LEFT JOIN family_members m ON m.user_id=s.user_id AND m.household_id=s.household_id
   LEFT JOIN family_people p ON p.id=m.person_id AND p.household_id=s.household_id
   LEFT JOIN family_internal.auth_sessions a ON a.id=s.provider_session_id AND a.user_id::text=s.user_id AND (a.not_after IS NULL OR a.not_after>now())
   WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,[digest(authorization.slice(13))]);
 requireValue(row,401,'mobile_session_required','This phone needs to sign in again.');
 const child=row.member_role==='child';
 requireValue(row.user_id&&row.provider_session_id&&row.active_provider_session&&row.member_role&&!row.member_revoked_at
  &&(child?row.kind==='child'&&row.person_name&&row.person_id===row.member_person_id
   :['admin','member'].includes(row.member_role)&&row.kind==='parent'&&row.person_id==null&&row.member_person_id==null),
  401,'mobile_session_revoked','Your sign-in or household access has ended.');
 await db.query("UPDATE family_mobile_sessions SET last_seen_at=now() WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at<now()-interval '5 minutes')",[row.id]);
 return {authType:'mobile',actor:`mobile:${row.id}`,mobileSessionId:row.id,role:row.member_role,
  personId:child?row.member_person_id:null,household:householdDto(row),user:{id:row.user_id,name:child?row.person_name:row.member_name,email:row.member_email||''}};
}

export async function createMobileSession(db,principal,body){
 requireValue(principal.authType==='user'&&principal.sessionId,403,'account_signin_required','Sign in to your account first.');
 requireValue(principal.household,403,'membership_required','Use your family invitation before connecting this app.');
 const label=body.label?textField(body.label,'Device name',80):'Family iPhone';
 return transaction(db,async client=>{
  const candidate=await one(client,'SELECT person_id FROM family_members WHERE household_id=$1 AND user_id=$2 AND revoked_at IS NULL',[principal.household.id,principal.user.id]);
  if(candidate?.person_id)requireValue(await one(client,'SELECT id FROM family_people WHERE household_id=$1 AND id=$2 FOR KEY SHARE',[principal.household.id,candidate.person_id]),403,'membership_required','Your household access has ended.');
  const member=await one(client,`SELECT m.*,p.name AS person_name FROM family_members m
   LEFT JOIN family_people p ON p.household_id=m.household_id AND p.id=m.person_id
   JOIN family_internal.auth_sessions a ON a.user_id::text=m.user_id AND a.id=$3 AND (a.not_after IS NULL OR a.not_after>now())
   WHERE m.household_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND (m.role<>'child' OR p.id IS NOT NULL) FOR SHARE OF m`,
   [principal.household.id,principal.user.id,principal.sessionId]);
  requireValue(member,403,'membership_required','Your household access has ended.');
  requireValue(member.role!=='child'||member.person_id===candidate?.person_id,409,'membership_changed','Your family profile changed. Sign in again.');
  const token=randomToken(),id=randomUUID(),child=member.role==='child';
  const row=await one(client,`INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,user_id,provider_session_id,person_id,label)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING expires_at`,[id,principal.household.id,digest(token),child?'child':'parent',principal.user.id,principal.sessionId,child?member.person_id:null,label]);
  return {token,expiresAt:row.expires_at,session:sessionDto({...principal,authType:'mobile',mobileSessionId:id,role:member.role,personId:member.person_id,user:{...principal.user,...(child?{name:member.person_name}:{})}})};
 });
}

export async function createMobilePair(){throw new ApiError(410,'child_accounts_required','Children now use their own email accounts and a parent invitation.');}
export async function redeemMobilePair(){throw new ApiError(410,'child_accounts_required','Children now use their own email accounts and a parent invitation.');}

export async function mobileDevices(db,p){
 mobileAdmin(p);
 return {devices:(await db.query('SELECT id,kind,person_id,label,created_at,last_seen_at,expires_at,revoked_at FROM family_mobile_sessions WHERE household_id=$1 ORDER BY created_at DESC',[p.household.id])).rows.map(r=>({id:r.id,kind:r.kind,personId:r.person_id,label:r.label,createdAt:r.created_at,lastSeenAt:r.last_seen_at,expiresAt:r.expires_at,revokedAt:r.revoked_at}))};
}
export async function revokeMobile(db,p,id){
 uuidField(id);
 if(id!==p.mobileSessionId)mobileAdmin(p);
 const r=await db.query('UPDATE family_mobile_sessions SET revoked_at=now() WHERE id=$1 AND household_id=$2 RETURNING id',[id,p.household.id]);
 requireValue(r.rowCount,404,'not_found','That phone does not exist.');return {deleted:true};
}
