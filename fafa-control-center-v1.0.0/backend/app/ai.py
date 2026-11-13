import calendar
import math
from datetime import datetime,timezone
from fastapi import APIRouter,Depends,HTTPException,Query,Request
from pydantic import BaseModel,Field
from sqlalchemy import func,select
from .database import transaction,serialize_security
from .config import settings
from .models import User,AIAccount,Model,AIRequest,now
from .security import require_admin,require_module,allowed,secret_value,rate_limit,safe_error
from .admin import record
from .adapters.ai import invoke,ProviderFailure

router=APIRouter(prefix='/api/v1/ai',tags=['AI'])
class AccountIn(BaseModel):
    name:str=Field(min_length=1,max_length=80)
    provider:str=Field(pattern='^(openai|anthropic|google)$')
    secret_ref:str=Field(pattern=r'^[a-z][a-z0-9_]{0,63}$')
    enabled:bool=True
class ModelIn(BaseModel):
    id:str=Field(pattern=r'^[a-zA-Z0-9._-]{1,100}$')
    provider:str=Field(pattern='^(openai|anthropic|google)$')
    capabilities:list[str]=Field(default_factory=lambda:['text'],max_length=20)
    input_cents_per_million:int|None=Field(default=None,ge=0,le=10000000)
    output_cents_per_million:int|None=Field(default=None,ge=0,le=10000000)
    enabled:bool=True
class ChatIn(BaseModel):
    account_id:int
    model_id:str=Field(max_length=100)
    prompt:str=Field(min_length=1,max_length=16000)
    max_tokens:int=Field(default=512,ge=16,le=4096)
    fallback_model_id:str|None=Field(default=None,max_length=100)

def model_view(m): return {k:getattr(m,k) for k in ('id','provider','capabilities','input_cents_per_million','output_cents_per_million','enabled')}
def account_view(a,admin=False):
    result={k:getattr(a,k) for k in ('id','name','provider','enabled')}
    # Even administrators receive only a reference, never a credential value.
    if admin: result['secret_ref']=a.secret_ref
    return result|{'billing_type':'api','provider_remaining_quota':None,'subscription_quota':'not_applicable'}

@router.get('/catalog')
def catalog(user=Depends(require_module('ai'))):
    with transaction() as s:
        return {'models':[model_view(m) for m in s.scalars(select(Model)) if allowed(user,'models',m.id)],
                'accounts':[account_view(a,user['role']=='super_admin') for a in s.scalars(select(AIAccount)) if allowed(user,'accounts',a.id)],
                'notice':'API billing only; ChatGPT/Codex subscription allowances cannot be combined. Unknown provider quota is null.'}
@router.post('/accounts')
def add_account(data:AccountIn,user=Depends(require_admin)):
    with transaction() as s:
        a=AIAccount(**data.model_dump());s.add(a);s.flush();record(s,user['id'],f'account:{a.id}','ai_account_create')
        return account_view(a,True)
@router.put('/accounts/{aid}')
def edit_account(aid:int,data:AccountIn,user=Depends(require_admin)):
    with transaction() as s:
        a=s.get(AIAccount,aid)
        if not a: raise HTTPException(404,'Account not found')
        if a.provider!=data.provider: raise HTTPException(409,'Provider is immutable; create another account')
        for k,v in data.model_dump().items(): setattr(a,k,v)
        record(s,user['id'],f'account:{aid}','ai_account_update')
        return account_view(a,True)
@router.put('/models')
def put_model(data:ModelIn,user=Depends(require_admin)):
    with transaction() as s:
        m=s.get(Model,data.id)
        if m and m.provider!=data.provider: raise HTTPException(409,'Provider is immutable')
        if m:
            for k,v in data.model_dump().items(): setattr(m,k,v)
        else: s.add(Model(**data.model_dump()))
        record(s,user['id'],f'model:{data.id}','ai_model_update')
    return {'status':'saved'}

def month_start():
    d=datetime.now(timezone.utc);return calendar.timegm((d.year,d.month,1,0,0,0))
def totals(s,uid):
    records=list(s.scalars(select(AIRequest).where(AIRequest.user_id==uid,AIRequest.created_at>=month_start())))
    return {'requests':len(records),
            'tokens_reserved_or_used':sum((r.input_tokens+r.output_tokens) if r.input_tokens is not None and r.output_tokens is not None else r.reserved_tokens for r in records),
            'cost_cents_known':sum(r.cost_cents or 0 for r in records),
            'cost_cents_reserved':sum(r.reserved_cents for r in records if r.cost_cents is None),
            'unknown_usage_requests':sum(r.input_tokens is None for r in records),
            'errors':sum(r.status=='failed' for r in records)}
@router.get('/usage')
def usage(user=Depends(require_module('ai'))):
    with transaction() as s:
        u=s.get(User,user['id']);t=totals(s,u.id)
        t.update({'monthly_requests':u.monthly_requests,'monthly_tokens':u.monthly_tokens,'budget_cents':u.budget_cents,'provider_remaining_quota':None})
        t['alerts']=[key for key,used,limit in [('requests',t['requests'],u.monthly_requests),('tokens',t['tokens_reserved_or_used'],u.monthly_tokens),('budget',t['cost_cents_known']+t['cost_cents_reserved'],u.budget_cents)] if limit==0 or used>=limit*.8]
        return t
@router.get('/logs')
def logs(page:int=Query(1,ge=1),user=Depends(require_module('ai'))):
    with transaction() as s:
        q=select(AIRequest).where(AIRequest.user_id==user['id'])
        return {'logs':[{k:getattr(r,k) for k in ('id','account_id','model_id','fallback_used','status','input_tokens','output_tokens','cost_cents','reserved_cents','error','created_at')} for r in s.scalars(q.order_by(AIRequest.id.desc()).offset((page-1)*30).limit(30))]}

def authorize_model(s,user,mid,provider):
    if not allowed(user,'models',mid): raise HTTPException(403,'Model access denied')
    m=s.get(Model,mid)
    if not m or not m.enabled or m.provider!=provider: raise HTTPException(422,'Model not enabled for this provider')
    if m.input_cents_per_million is None or m.output_cents_per_million is None: raise HTTPException(503,'Model pricing not configured; budget enforcement requires reviewed prices')
    return m

@router.post('/requests')
def chat(data:ChatIn,request:Request,user=Depends(require_module('ai'))):
    rate_limit(request,'ai:'+str(user['id']),30,60)
    with transaction() as s:
        serialize_security(s)
        if not allowed(user,'accounts',data.account_id): raise HTTPException(403,'Account access denied')
        a=s.get(AIAccount,data.account_id)
        if not a or not a.enabled: raise HTTPException(422,'Account disabled or missing')
        m=authorize_model(s,user,data.model_id,a.provider)
        fallback=authorize_model(s,user,data.fallback_model_id,a.provider) if data.fallback_model_id else None
        key=secret_value(a.secret_ref)
        u=s.get(User,user['id']);t=totals(s,u.id)
        # Byte upper bound plus API framing reserve. This is an admission reserve, not reported usage.
        input_bound=len(data.prompt.encode('utf-8'))+1024
        reserve_tokens=input_bound+data.max_tokens
        models=[m]+([fallback] if fallback else [])
        reserve_cents=max(math.ceil((input_bound*x.input_cents_per_million+data.max_tokens*x.output_cents_per_million)/1_000_000) for x in models)
        if t['requests']>=u.monthly_requests or t['tokens_reserved_or_used']+reserve_tokens>u.monthly_tokens or t['cost_cents_known']+t['cost_cents_reserved']+reserve_cents>u.budget_cents:
            raise HTTPException(429,'User budget or usage limit exceeded')
        r=AIRequest(user_id=u.id,account_id=a.id,model_id=m.id,status='running',reserved_tokens=reserve_tokens,reserved_cents=reserve_cents)
        s.add(r);s.flush();rid=r.id
    output=None;error=None;used=m;fallback_used=False
    try:
        try: output=invoke(a.provider,key,m.id,data.prompt,data.max_tokens)
        except ProviderFailure as e:
            # Only a 429 rejection is eligible. No automatic retry of ambiguous/charged failures.
            if fallback and e.status==429:
                used=fallback;fallback_used=True;output=invoke(a.provider,key,fallback.id,data.prompt,data.max_tokens)
            else: raise
    except Exception as exc:
        error='provider_http_'+str(exc.status) if isinstance(exc,ProviderFailure) else safe_error(exc)
    finally: key=None
    with transaction() as s:
        r=s.get(AIRequest,rid);r.fallback_used=fallback_used;r.model_id=used.id
        if output:
            r.status='succeeded';r.input_tokens=output['input_tokens'];r.output_tokens=output['output_tokens']
            if r.input_tokens is not None:
                r.cost_cents=math.ceil((r.input_tokens*used.input_cents_per_million+r.output_tokens*used.output_cents_per_million)/1_000_000)
        else: r.status='failed';r.error=error
    if not output: raise HTTPException(502,{'request_id':rid,'error':error,'usage':'unknown','budget_reservation':'retained'})
    return output|{'request_id':rid,'model_id':used.id,'fallback_used':fallback_used,'billing_source':'configured_prices_and_provider_tokens'}
