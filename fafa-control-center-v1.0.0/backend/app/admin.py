from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from .database import transaction, serialize_security
from .models import User, Role, Audit, Setting, AIAccount, Model, now
from .security import require_admin, user_view, revoke_sessions

router=APIRouter(prefix='/api/v1/admin',tags=['Administration'],dependencies=[Depends(require_admin)])
MODULES={'nodes','ai','codex'}
class Grants(BaseModel):
    modules:list[str]=Field(default_factory=list,max_length=3)
    accounts:list[int]=Field(default_factory=list,max_length=100)
    models:list[str]=Field(default_factory=list,max_length=100)
    nodes:list[int]=Field(default_factory=list,max_length=100)
    @field_validator('modules')
    @classmethod
    def valid_modules(cls,v):
        if not set(v)<=MODULES: raise ValueError('Unknown module')
        return v
class UserUpdate(BaseModel):
    role:str|None=Field(default=None,max_length=64)
    active:bool|None=None
    grants:Grants|None=None
    monthly_requests:int|None=Field(default=None,ge=0,le=1000000)
    monthly_tokens:int|None=Field(default=None,ge=0,le=1000000000)
    budget_cents:int|None=Field(default=None,ge=0,le=100000000)
class RoleIn(BaseModel):
    name:str=Field(pattern=r'^[a-z][a-z0-9_]{0,63}$')
    modules:list[str]=Field(default_factory=list,max_length=3)
    @field_validator('modules')
    @classmethod
    def valid(cls,v):
        if not set(v)<=MODULES: raise ValueError('Unknown module')
        return v
class SecurityIn(BaseModel): open_registration:bool

def record(s,actor,target,action,result='success'):
    s.add(Audit(actor_id=actor,target=target,action=action,result=result))

@router.get('/users')
def list_users(q:str=Query('',max_length=100),status:str=Query('all',pattern='^(all|active|disabled)$'),page:int=Query(1,ge=1),page_size:int=Query(20,ge=1,le=100)):
    with transaction() as s:
        query=select(User)
        if q:
            safe=q.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')
            query=query.where(User.email.ilike('%'+safe+'%',escape='\\') | User.display_name.ilike('%'+safe+'%',escape='\\'))
        if status!='all': query=query.where(User.active.is_(status=='active'))
        total=s.scalar(select(func.count()).select_from(query.subquery()))
        rows=s.scalars(query.order_by(User.id).offset((page-1)*page_size).limit(page_size))
        return {'users':[user_view(u) for u in rows],'total':total,'page':page,'page_size':page_size}

@router.patch('/users/{uid}')
def update_user(uid:int,data:UserUpdate,admin=Depends(require_admin)):
    with transaction() as s:
        serialize_security(s)
        u=s.get(User,uid)
        if not u: raise HTTPException(404,'User not found')
        new_role=data.role if data.role is not None else u.role
        new_active=data.active if data.active is not None else u.active
        if not s.get(Role,new_role): raise HTTPException(422,'Unknown role')
        if u.role=='super_admin' and u.active and (new_role!='super_admin' or not new_active):
            count=s.scalar(select(func.count()).select_from(User).where(User.role=='super_admin',User.active.is_(True)))
            if count<=1: raise HTTPException(409,'Cannot disable or demote the last active super administrator')
        u.role,u.active=new_role,new_active
        if data.grants is not None: u.grants=data.grants.model_dump()
        for key in ('monthly_requests','monthly_tokens','budget_cents'):
            if getattr(data,key) is not None: setattr(u,key,getattr(data,key))
        # Role/grant and status changes all revoke existing sessions, including self changes.
        revoke_sessions(s,uid)
        record(s,admin['id'],f'user:{uid}','user_update')
        return {'user':user_view(u)}

@router.post('/users/{uid}/disable')
def disable(uid:int,admin=Depends(require_admin)):
    return update_user(uid,UserUpdate(active=False),admin)
@router.post('/users/{uid}/restore')
def restore(uid:int,admin=Depends(require_admin)):
    return update_user(uid,UserUpdate(active=True),admin)

@router.get('/roles')
def roles():
    with transaction() as s: return {'roles':[{'name':r.name,'modules':r.modules} for r in s.scalars(select(Role).order_by(Role.name))]}
@router.put('/roles')
def put_role(data:RoleIn,admin=Depends(require_admin)):
    if data.name in ('super_admin','user'): raise HTTPException(409,'Built-in roles are immutable')
    with transaction() as s:
        serialize_security(s)
        r=s.get(Role,data.name)
        if r: r.modules=data.modules
        else: s.add(Role(name=data.name,modules=data.modules))
        for uid in s.scalars(select(User.id).where(User.role==data.name)): revoke_sessions(s,uid)
        record(s,admin['id'],f'role:{data.name}','role_update')
    return {'status':'saved'}

@router.get('/audit')
def audit_logs(page:int=Query(1,ge=1),page_size:int=Query(30,ge=1,le=100)):
    with transaction() as s:
        total=s.scalar(select(func.count()).select_from(Audit))
        rows=s.scalars(select(Audit).order_by(Audit.id.desc()).offset((page-1)*page_size).limit(page_size))
        return {'logs':[{k:getattr(r,k) for k in ('id','actor_id','target','action','result','created_at')} for r in rows],'total':total,'page':page}

@router.get('/security')
def security():
    with transaction() as s:
        flag=s.get(Setting,'open_registration')
        return {'open_registration':flag.value if flag else True,'require_verified_email':__import__('app.config',fromlist=['settings']).settings.require_verified,
                'session_ttl_seconds':43200,'csrf':'required','password_hash':'Argon2id','last_admin_protection':True}
@router.put('/security')
def put_security(data:SecurityIn,admin=Depends(require_admin)):
    with transaction() as s:
        serialize_security(s)
        flag=s.get(Setting,'open_registration')
        if flag: flag.value=data.open_registration
        else: s.add(Setting(key='open_registration',value=data.open_registration))
        record(s,admin['id'],'system','security_update')
    return {'status':'saved'}
