import re
from fastapi import APIRouter,Depends,HTTPException,Query
from pydantic import BaseModel,Field
from sqlalchemy import select
from .database import transaction,serialize_security
from .models import Node,NodeVersion,NodeOperation,now
from .security import require_admin,require_module,allowed,safe_error
from .admin import record
from .adapters.nodes import adapter

router=APIRouter(prefix='/api/v1/nodes',tags=['Nodes'])
class NodeIn(BaseModel):
    name:str=Field(min_length=1,max_length=80)
    engine:str=Field(pattern='^(xray|v2ray|sing-box|TEST)$')
    group:str=Field(default='default',max_length=80)
    region:str=Field(default='',max_length=80)
    metadata:dict[str,str]=Field(default_factory=dict,max_length=20)
    agent_ref:str=Field(pattern=r'^[a-zA-Z0-9_-]{1,64}$')
    enabled:bool=True
class ConfigIn(BaseModel): config:dict
class RollbackIn(BaseModel): version:int=Field(ge=1)
class BatchIn(BaseModel):
    ids:list[int]=Field(min_length=1,max_length=50)
    action:str=Field(pattern='^(health|disable|enable)$')

def view(n):
    return {k:getattr(n,k) for k in ('id','name','engine','group','region','agent_ref','enabled','health','metrics','latency_ms','last_error','checked_at','version')}|{'metadata':n.metadata_json,'source':'TEST' if n.engine=='TEST' else 'FAFA_AGENT'}
def accessible(s,nid,user):
    n=s.get(Node,nid)
    if not n: raise HTTPException(404,'Node not found')
    if not allowed(user,'nodes',nid): raise HTTPException(403,'Node access denied')
    return n

@router.get('')
def list_nodes(user=Depends(require_module('nodes')),q:str=Query('',max_length=80)):
    with transaction() as s:
        rows=[view(n) for n in s.scalars(select(Node).order_by(Node.id)) if allowed(user,'nodes',n.id) and q.lower() in (n.name+' '+n.region+' '+n.group).lower()]
        return {'nodes':rows,'total':len(rows)}
@router.post('')
def create(data:NodeIn,user=Depends(require_admin)):
    with transaction() as s:
        n=Node(**data.model_dump(exclude={'metadata'}),metadata_json=data.metadata);s.add(n);s.flush()
        record(s,user['id'],f'node:{n.id}','node_create')
        return view(n)
@router.put('/{nid}')
def edit(nid:int,data:NodeIn,user=Depends(require_admin)):
    with transaction() as s:
        serialize_security(s);n=accessible(s,nid,user)
        if n.version and (n.engine!=data.engine or n.agent_ref!=data.agent_ref): raise HTTPException(409,'Engine and agent reference are immutable after configuration')
        for k,v in data.model_dump(exclude={'metadata'}).items(): setattr(n,k,v)
        n.metadata_json=data.metadata
        record(s,user['id'],f'node:{nid}','node_edit')
        return view(n)

@router.get('/{nid}/history')
def history(nid:int,user=Depends(require_module('nodes'))):
    with transaction() as s:
        accessible(s,nid,user)
        return {'operations':[{k:getattr(o,k) for k in ('id','action','status','attempts','message','created_at')} for o in s.scalars(select(NodeOperation).where(NodeOperation.node_id==nid).order_by(NodeOperation.id.desc()).limit(100))],
                'versions':[{'version':v.version,'created_at':v.created_at} for v in s.scalars(select(NodeVersion).where(NodeVersion.node_id==nid).order_by(NodeVersion.version.desc()))]}

def operate(nid,action,user,config=None):
    with transaction() as s:
        serialize_security(s);n=accessible(s,nid,user)
        if not n.enabled: raise HTTPException(409,'Node disabled')
        # Persist intent before remote I/O. Mutating requests are never automatically retried.
        op=NodeOperation(node_id=nid,actor_id=user['id'],action=action,status='running');s.add(op);s.flush();oid=op.id
    result=None;error=None;attempts=0;not_configured=False
    for _ in range(3 if action=='health' else 1):
        attempts+=1
        try: result=adapter(n).call(n,action,config);break
        except Exception as exc:
            if isinstance(exc,HTTPException) and exc.status_code==503:
                error=str(exc.detail);not_configured=True;break
            error=safe_error(exc)
    with transaction() as s:
        serialize_security(s);n=s.get(Node,nid);op=s.get(NodeOperation,oid)
        op.attempts=attempts
        if result:
            op.status=result['status'];op.message=result.get('message','Completed')[:250]
            n.last_error=None
            if action=='health':
                n.health=result['status'];n.metrics=result.get('metrics');n.latency_ms=result.get('latency_ms');n.checked_at=now()
            elif result['status']=='ok' or result.get('config_written'):
                n.version+=1;s.add(NodeVersion(node_id=nid,version=n.version,config=config))
        else:
            op.status='not_configured' if not_configured else 'failed';op.message=error;n.health='unknown';n.last_error=error;n.metrics=None;n.latency_ms=None;n.checked_at=now()
        record(s,user['id'],f'node:{nid}','node_'+action,op.status)
        return {'operation_id':oid,'status':op.status,'attempts':attempts,'node':view(n),'message':op.message}

@router.post('/{nid}/health')
def health(nid:int,user=Depends(require_module('nodes'))): return operate(nid,'health',user)
@router.post('/{nid}/config')
def configure(nid:int,data:ConfigIn,user=Depends(require_admin)): return operate(nid,'apply',user,data.config)
@router.post('/{nid}/rollback')
def rollback(nid:int,data:RollbackIn,user=Depends(require_admin)):
    with transaction() as s:
        accessible(s,nid,user)
        v=s.scalar(select(NodeVersion).where(NodeVersion.node_id==nid,NodeVersion.version==data.version))
        if not v: raise HTTPException(404,'Configuration version not found')
        config=v.config
    return operate(nid,'rollback',user,config)
@router.post('/{nid}/retry')
def retry(nid:int,user=Depends(require_module('nodes'))): return operate(nid,'health',user)
@router.post('/batch')
def batch(data:BatchIn,user=Depends(require_admin)):
    results=[]
    for nid in dict.fromkeys(data.ids):
        if data.action=='health': results.append(operate(nid,'health',user))
        else:
            with transaction() as s:
                n=accessible(s,nid,user);n.enabled=data.action=='enable';record(s,user['id'],f'node:{nid}','node_'+data.action)
            results.append({'id':nid,'enabled':data.action=='enable'})
    return {'results':results}
