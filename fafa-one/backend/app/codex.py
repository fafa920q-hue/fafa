import re
from fastapi import APIRouter,Depends,HTTPException
from pydantic import BaseModel,Field,field_validator
from sqlalchemy import select
from .database import transaction,serialize_security
from .models import Project,Task,now
from .security import require_admin,require_module,safe_error
from .admin import record
from .adapters.executor import get_executor

router=APIRouter(prefix='/api/v1/codex',tags=['Codex'])
class ProjectIn(BaseModel):
    name:str=Field(min_length=1,max_length=100)
    repository:str=Field(min_length=1,max_length=255,pattern=r'^https://[A-Za-z0-9.-]+/[A-Za-z0-9_./-]+$')
    @field_validator('repository')
    @classmethod
    def repo(cls,v):
        if '..' in v or '@' in v: raise ValueError('Invalid repository URL')
        return v
class TaskIn(BaseModel):
    project_id:int
    prompt:str=Field(min_length=1,max_length=16000)
    timeout_seconds:int=Field(default=300,ge=30,le=3600)

def task_view(t):
    return {k:getattr(t,k) for k in ('id','owner_id','project_id','prompt','status','approved_by','timeout_seconds','attempts','logs','changes','diff','tests','error','created_at','started_at','finished_at')}
def project_access(s,pid,user):
    p=s.get(Project,pid)
    if not p: raise HTTPException(404,'Project not found')
    if user['role']!='super_admin' and p.owner_id!=user['id']: raise HTTPException(403,'Project access denied')
    return p
def task_access(s,tid,user):
    t=s.get(Task,tid)
    if not t: raise HTTPException(404,'Task not found')
    if user['role']!='super_admin' and t.owner_id!=user['id']: raise HTTPException(403,'Task access denied')
    return t

@router.get('/projects')
def projects(user=Depends(require_module('codex'))):
    with transaction() as s:
        q=select(Project)
        if user['role']!='super_admin':q=q.where(Project.owner_id==user['id'])
        return {'projects':[{k:getattr(p,k) for k in ('id','owner_id','name','repository','created_at')} for p in s.scalars(q.order_by(Project.id))]}
@router.post('/projects')
def create_project(data:ProjectIn,user=Depends(require_module('codex'))):
    with transaction() as s:
        p=Project(owner_id=user['id'],**data.model_dump());s.add(p);s.flush();record(s,user['id'],f'project:{p.id}','project_create')
        return {'id':p.id}
@router.get('/tasks')
def tasks(user=Depends(require_module('codex'))):
    with transaction() as s:
        q=select(Task)
        if user['role']!='super_admin':q=q.where(Task.owner_id==user['id'])
        return {'tasks':[task_view(t) for t in s.scalars(q.order_by(Task.id.desc()).limit(200))],
                'executor':'configured' if get_executor() else 'not_configured'}
@router.post('/tasks')
def create_task(data:TaskIn,user=Depends(require_module('codex'))):
    with transaction() as s:
        project_access(s,data.project_id,user)
        t=Task(owner_id=user['id'],**data.model_dump());s.add(t);s.flush();record(s,user['id'],f'task:{t.id}','task_create')
        return task_view(t)
@router.post('/tasks/{tid}/approve')
def approve(tid:int,user=Depends(require_admin)):
    with transaction() as s:
        serialize_security(s);t=task_access(s,tid,user)
        if t.status!='pending_approval':raise HTTPException(409,'Task is not awaiting approval')
        t.approved_by=user['id'];t.status='queued' if get_executor() else 'not_configured'
        t.error=None if get_executor() else 'Codex executor and authorization not configured; no code executed'
        record(s,user['id'],f'task:{tid}','task_approve',t.status)
        return task_view(t)
@router.post('/tasks/{tid}/cancel')
def cancel(tid:int,user=Depends(require_module('codex'))):
    with transaction() as s:
        serialize_security(s);t=task_access(s,tid,user)
        if t.status in ('succeeded','failed','cancelled','timed_out','rolled_back'):raise HTTPException(409,'Task already terminal')
        t.status='cancel_requested' if t.status in ('running','dispatching','cancel_requested') else 'cancelled'
        if t.status=='cancelled':t.finished_at=now()
        record(s,user['id'],f'task:{tid}','task_cancel',t.status)
        return task_view(t)
@router.post('/tasks/{tid}/retry')
def retry(tid:int,user=Depends(require_module('codex'))):
    with transaction() as s:
        serialize_security(s);t=task_access(s,tid,user)
        if t.status not in ('failed','timed_out','not_configured','cancelled'):raise HTTPException(409,'Task cannot be retried')
        if t.status=='timed_out' and t.error=='timeout_cancellation_unconfirmed':raise HTTPException(409,'Worker cancellation must be confirmed before retry')
        t.status='pending_approval';t.approved_by=None;t.remote_id=None;t.logs='';t.changes=[];t.diff='';t.tests=None;t.error=None;t.started_at=None;t.finished_at=None
        record(s,user['id'],f'task:{tid}','task_retry')
        return task_view(t)
@router.post('/tasks/{tid}/rollback')
def rollback(tid:int,user=Depends(require_admin)):
    with transaction() as s:
        serialize_security(s);t=task_access(s,tid,user)
        if t.status!='succeeded' or not t.remote_id:raise HTTPException(409,'Only completed real worker tasks can be rolled back')
        executor=get_executor()
        if not executor:raise HTTPException(503,'Worker not configured')
        t.status='rollback_requested';rid=t.remote_id
    try:
        result=executor.rollback(rid)
        if result.get('status')!='rolled_back':raise ValueError('Worker has not confirmed rollback')
    except Exception:
        with transaction() as s:
            t=s.get(Task,tid);t.status='succeeded';t.error='Rollback unconfirmed; inspect worker before retry'
        raise HTTPException(502,'Worker rollback unconfirmed')
    with transaction() as s:
        t=s.get(Task,tid);t.status='rolled_back';record(s,user['id'],f'task:{tid}','task_rollback')
        return task_view(t)

def redact(value):
    text=str(value)[:200000]
    text=re.sub(r'(?i)(authorization|api[_-]?key|password|token|secret)\s*[:=]\s*\S+',r'\1=[REDACTED]',text)
    return re.sub(r'\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b','[REDACTED]',text)

def tick():
    """Single coordinator; DB locks serialize claims across API replicas.
    Remote jobs MUST implement idempotent submission and hard sandbox timeouts.
    """
    executor=get_executor()
    if not executor:return
    with transaction() as s:
        serialize_security(s)
        active=s.scalar(select(Task).where(Task.status.in_(['dispatching','running','cancel_requested'])).order_by(Task.id))
        if not active:
            active=s.scalar(select(Task).where(Task.status=='queued').order_by(Task.id))
            if not active:return
            active.status='dispatching';active.started_at=now();active.attempts+=1
        tid=active.id
        task=active;project=s.get(Project,task.project_id)
    # Repeated submission after a crash uses exactly the same idempotency key.
    try:
        if task.status=='dispatching':
            result=executor.submit(task,project)
            rid=result.get('id','')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',rid):raise ValueError('Invalid job ID')
            with transaction() as s:
                t=s.get(Task,tid);t.remote_id=rid
                if t.status=='dispatching':t.status='running'
            return
        expired=now()-(task.started_at or now())>=task.timeout_seconds
        if task.status=='cancel_requested' or expired:
            result=executor.cancel(task.remote_id) if task.remote_id else {'status':'unconfirmed'}
            confirmed=result.get('status')=='cancelled'
            with transaction() as s:
                t=s.get(Task,tid)
                if expired:
                    t.status='timed_out';t.error=None if confirmed else 'timeout_cancellation_unconfirmed';t.finished_at=now()
                elif confirmed:t.status='cancelled';t.finished_at=now()
                else:t.error='Cancellation not yet confirmed'
            return
        result=executor.poll(task.remote_id)
        status=result.get('status')
        if status not in ('running','succeeded','failed','cancelled'):raise ValueError('Invalid worker state')
        with transaction() as s:
            serialize_security(s);t=s.get(Task,tid)
            if t.status!='running':return
            t.status=status;t.logs=redact(result.get('logs',''));t.diff=redact(result.get('diff',''))
            changes=result.get('changes',[])
            if not isinstance(changes,list) or len(changes)>500:raise ValueError('Invalid change list')
            t.changes=[redact(x)[:255] for x in changes];t.tests=result.get('tests')
            if status!='running':t.finished_at=now()
            if status=='failed':t.error=redact(result.get('error','Worker failed'))[:250]
    except Exception as exc:
        with transaction() as s:
            t=s.get(Task,tid)
            # Failed submit/poll can be ambiguous: retain state to reconcile, never claim execution success.
            t.error=safe_error(exc)
            if now()-(t.started_at or now())>=t.timeout_seconds:
                t.status='timed_out';t.error='timeout_cancellation_unconfirmed';t.finished_at=now()
