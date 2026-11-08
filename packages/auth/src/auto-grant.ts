import { z } from 'zod';
import { sql } from '../../db/src';
import { hash, token } from '../../shared/src/crypto';
import { AppError } from '../../shared/src';

export const AUTO_GRANT_POLICY_KEYS = ['auto_grant_enabled','auto_grant_window_start','auto_grant_window_end','auto_grant_node_source_id','auto_grant_node_limit','auto_grant_trial_valid_days'] as const;
export const autoGrantPolicySchema = z.object({
 enabled:z.boolean(),windowStart:z.iso.datetime(),windowEnd:z.iso.datetime(),
 nodeSourceId:z.uuid().nullable(),nodeLimit:z.number().int().min(0).max(5000).nullable(),
 trialValidDays:z.number().int().min(1).max(3),
}).refine(d=>new Date(d.windowEnd).getTime()>new Date(d.windowStart).getTime() && new Date(d.windowEnd).getTime()-new Date(d.windowStart).getTime()<=3*86400000,{message:'首次自动授权窗口必须在三天以内'});
export type AutoGrantPolicy = z.infer<typeof autoGrantPolicySchema>;
export async function readAutoGrantPolicy(db:any=sql):Promise<AutoGrantPolicy> {
 const rows=await db.unsafe('SELECT key,value FROM settings WHERE key=ANY($1::text[])',[[...AUTO_GRANT_POLICY_KEYS]]);
 const map=new Map<string,any>(rows.map((r:any)=>[r.key,r.value]));
 return {enabled:map.get('auto_grant_enabled')===true,windowStart:String(map.get('auto_grant_window_start')||'2026-11-07T13:33:00Z'),windowEnd:String(map.get('auto_grant_window_end')||'2026-11-10T13:33:00Z'),nodeSourceId:map.get('auto_grant_node_source_id')||null,nodeLimit:map.get('auto_grant_node_limit')??null,trialValidDays:Math.min(Number(map.get('auto_grant_trial_valid_days')||3),3)};
}
export function capabilityAllowed(user:any,kind:'node'|'server'|'codex') {
 if(user.role==='Owner'||user.role==='Admin') return true;
 const prefix={node:'node_access',server:'server_connect',codex:'codex_tasks'}[kind];
 return user[prefix+'_enabled']===true && (!user[prefix+'_until']||new Date(user[prefix+'_until']).getTime()>Date.now());
}
export async function applyAutoGrant(userId:string,db:any=sql) {
 const policy=await readAutoGrantPolicy(db);
 const [user]=await db.unsafe('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[userId]);
 if(!user||user.role!=='Member'||user.disabled) return {applied:false,reason:'ROLE_NOT_ELIGIBLE'};
 const now=Date.now(),start=new Date(policy.windowStart).getTime(),end=new Date(policy.windowEnd).getTime(),created=new Date(user.created_at).getTime();
 if(!policy.enabled||now<start||now>=end||created<start||created>=end||end-start>3*86400000) return {applied:false,reason:'OUTSIDE_WINDOW'};
 const expires=new Date(created+policy.trialValidDays*86400000).toISOString();
 if(new Date(expires).getTime()<=now) return {applied:false,reason:'TRIAL_EXPIRED'};
 const existing=await db.unsafe('SELECT id FROM auto_grant_records WHERE user_id=$1 LIMIT 1',[userId]);
 if(existing.length) return {applied:false,reason:'ALREADY_PROCESSED'};
 await db.unsafe('UPDATE users SET node_access_enabled=true,node_access_until=$2,server_connect_enabled=true,server_connect_until=$2,codex_tasks_enabled=true,codex_tasks_until=$2,updated_at=now() WHERE id=$1',[userId,expires]);
 if(policy.nodeLimit!==null) await db.unsafe('UPDATE users SET node_limit=$2 WHERE id=$1',[userId,policy.nodeLimit]);
 let nodeStatus='PENDING', reason:string|null='NODE_SOURCE_NOT_CONFIGURED';
 if(policy.nodeSourceId){
  const [source]=await db.unsafe('SELECT s.* FROM node_sources s JOIN users u ON u.id=s.owner_id WHERE s.id=$1 AND s.revoked_at IS NULL AND NOT u.disabled AND u.deleted_at IS NULL',[policy.nodeSourceId]);
  if(source && source.data.enabled && !source.data.demo && (!source.data.expiresAt||new Date(source.data.expiresAt).getTime()>now) && (source.data.kind==='OWNED_NODE'||(source.data.authorized===true&&source.data.redistributionAuthorized===true&&source.data.authorizationReference?.trim()))){
   await db.unsafe('INSERT INTO node_group_grants(owner_id,source_id,user_id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[source.owner_id,source.id,userId,JSON.stringify({scope:'USE',autoGranted:true,expiresAt:expires})]);
   nodeStatus='GRANTED';reason=null;
  }else {nodeStatus='FAILED';reason='SOURCE_UNAVAILABLE_OR_UNAUTHORIZED';}
 }
 const zero='00000000-0000-0000-0000-000000000000';
 for(const kind of ['node','server','codex'] as const) await db.unsafe('INSERT INTO auto_grant_records(user_id,kind,resource_id,status,reason,expires_at,granted_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT DO NOTHING',[userId,kind,kind==='node'?(policy.nodeSourceId||zero):zero,kind==='node'?nodeStatus:'GRANTED',kind==='node'?reason:null,expires]);
 const [subscription]=await db.unsafe('SELECT id FROM subscription_tokens WHERE owner_id=$1 AND revoked_at IS NULL',[userId]);
 if(!subscription) await db.unsafe("INSERT INTO subscription_tokens(owner_id,token_hash,data) VALUES($1,$2,'{\"enabled\":true}')",[userId,hash(token())]);
 await db.unsafe("INSERT INTO audit_events(owner_id,action,target_id) VALUES($1,'auto_grant.applied',$2)",[userId,JSON.stringify({source:'FIRST_THREE_DAYS',startsAt:user.created_at,expiresAt:expires,nodeStatus})]);
 return {applied:true,expiresAt:expires,nodeStatus};
}
export async function backfillAutoGrants(actorId:string) {
 return sql.begin(async tx=>{
  await tx.unsafe('SELECT pg_advisory_xact_lock(77702)');
  const policy=await readAutoGrantPolicy(tx);
  if(!policy.enabled) throw new AppError(400,'POLICY_DISABLED','自动授权未开启');
  const users=await tx.unsafe("SELECT id FROM users WHERE role='Member' AND NOT disabled AND deleted_at IS NULL AND created_at >= $1 AND created_at < $2 ORDER BY created_at",[policy.windowStart,policy.windowEnd]);
  let applied=0;
  for(const user of users) if((await applyAutoGrant(user.id,tx)).applied) applied++;
  await tx.unsafe("INSERT INTO audit_events(owner_id,action) VALUES($1,'auto_grant.backfilled')",[actorId]);
  return {scanned:users.length,applied};
 });
}
