import {randomInt,randomUUID} from 'node:crypto';
import {one,transaction} from './database.js';
import {digest,keyedDigest,randomToken} from './credentials.js';
import {requireValue,textField,uuidField} from './errors.js';

const householdDto=r=>({id:r.household_id,title:r.title,timezone:r.timezone});
export const isMobile=p=>p?.authType==='mobile';
export function mobileAdmin(p){requireValue(p?.household&&['user','mobile'].includes(p.authType)&&p.role==='admin',403,'admin_required','Only a parent administrator can manage devices.');}
const sessionDto=p=>({authenticated:true,authType:'mobile',role:p.role,user:p.user,household:p.household,personId:p.personId||null});
export {sessionDto as mobileSessionData};

export async function authenticateMobile(request,db){
 const authorization=request.headers.get('authorization')||'';
 requireValue(/^FamilyMobile [A-Za-z0-9_-]{43}$/.test(authorization),401,'mobile_session_required','Sign in or pair this phone again.');
 const row=await one(db,`SELECT s.*,h.title,h.timezone,p.name AS person_name,m.name AS member_name,m.email AS member_email,m.role AS member_role,m.revoked_at AS member_revoked_at,
   a.id AS active_provider_session FROM family_mobile_sessions s
   JOIN family_households h ON h.id=s.household_id
   LEFT JOIN family_people p ON p.id=s.person_id AND p.household_id=s.household_id
   LEFT JOIN family_members m ON m.user_id=s.user_id AND m.household_id=s.household_id
   LEFT JOIN family_internal.auth_sessions a ON a.id=s.provider_session_id AND a.user_id::text=s.user_id AND (a.not_after IS NULL OR a.not_after>now())
   WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,[digest(authorization.slice(13))]);
 requireValue(row,401,'mobile_session_required','This phone needs to sign in or pair again.');
 if(row.kind==='parent')requireValue(row.active_provider_session&&row.member_role&&!row.member_revoked_at,401,'mobile_session_revoked','Your sign-in or household access has ended.');
 else requireValue(row.kind==='child'&&row.person_name,401,'mobile_session_revoked','Ask a parent to pair this phone again.');
 await db.query("UPDATE family_mobile_sessions SET last_seen_at=now() WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at<now()-interval '5 minutes')",[row.id]);
 return {authType:'mobile',actor:`mobile:${row.id}`,mobileSessionId:row.id,role:row.kind==='child'?'child':row.member_role,
  personId:row.person_id,household:householdDto(row),user:{id:row.kind==='child'?row.person_id:row.user_id,name:row.kind==='child'?row.person_name:row.member_name,email:row.member_email||''}};
}

export async function createMobileSession(db,principal,body){
 requireValue(principal.authType==='user'&&principal.household&&principal.sessionId,403,'parent_signin_required','Sign in to your parent account first.');
 const token=randomToken(),id=randomUUID();
 const label=body.label?textField(body.label,'Device name',80):'Family iPhone';
 const row=await one(db,`INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,user_id,provider_session_id,label)
  VALUES($1,$2,$3,'parent',$4,$5,$6) RETURNING expires_at`,[id,principal.household.id,digest(token),principal.user.id,principal.sessionId,label]);
 return {token,expiresAt:row.expires_at,session:sessionDto({...principal,authType:'mobile',mobileSessionId:id})};
}

export async function createMobilePair(db,principal,body,env){
 mobileAdmin(principal);const personId=uuidField(body.personId,'Person ID');
 return transaction(db,async c=>{
  requireValue(await one(c,'SELECT id FROM family_people WHERE household_id=$1 AND id=$2 FOR UPDATE',[principal.household.id,personId]),404,'not_found','That child profile does not exist.');
  await c.query('UPDATE family_mobile_pairs SET redeemed_at=now() WHERE household_id=$1 AND person_id=$2 AND redeemed_at IS NULL',[principal.household.id,personId]);
  for(let i=0;i<3;i++){
   const code=String(randomInt(1000000)).padStart(6,'0');
   const row=await one(c,`INSERT INTO family_mobile_pairs(id,household_id,person_id,code_hash,label,expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes') ON CONFLICT(code_hash) DO NOTHING RETURNING expires_at`,[randomUUID(),principal.household.id,personId,keyedDigest('mobile-pair',code,env),body.label?textField(body.label,'Device name',80):'Child iPhone']);
   if(row)return {code,expiresAt:row.expires_at};
  }
  throw Error('Pair generation unavailable');
 });
}

export async function redeemMobilePair(db,body,env){
 requireValue(typeof body.code==='string'&&/^\d{6}$/.test(body.code),403,'invalid_pair','That code has expired or was already used.');
 return transaction(db,async c=>{
  const candidate=await one(c,'SELECT person_id,household_id FROM family_mobile_pairs WHERE code_hash=$1',[keyedDigest('mobile-pair',body.code,env)]);
  requireValue(candidate,403,'invalid_pair','That code has expired or was already used.');
  const person=await one(c,'SELECT name FROM family_people WHERE id=$1 AND household_id=$2 FOR UPDATE',[candidate.person_id,candidate.household_id]);
  requireValue(person,403,'invalid_pair','Ask a parent for a new code.');
  const pair=await one(c,'SELECT * FROM family_mobile_pairs WHERE code_hash=$1 FOR UPDATE',[keyedDigest('mobile-pair',body.code,env)]);
  requireValue(pair&&!pair.redeemed_at&&new Date(pair.expires_at)>new Date(),403,'invalid_pair','That code has expired or was already used.');
  const id=randomUUID(),token=randomToken();
  const row=await one(c,`INSERT INTO family_mobile_sessions(id,household_id,token_hash,kind,person_id,label) VALUES($1,$2,$3,'child',$4,$5) RETURNING expires_at`,[id,pair.household_id,digest(token),pair.person_id,pair.label]);
  await c.query('UPDATE family_mobile_pairs SET redeemed_at=now() WHERE id=$1',[pair.id]);
  const h=await one(c,'SELECT id AS household_id,title,timezone FROM family_households WHERE id=$1',[pair.household_id]);
  return {token,expiresAt:row.expires_at,session:sessionDto({role:'child',personId:pair.person_id,household:householdDto(h),user:{id:pair.person_id,name:person.name}})};
 });
}

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
