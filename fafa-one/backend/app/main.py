import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from fastapi import FastAPI,Depends,HTTPException,Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from sqlalchemy import select,text,func
from .config import settings
from .database import transaction
from .models import User,Node,Task,Audit
from .security import check_csrf,current_user,require_admin,audit
from . import auth,admin,nodes,ai,codex
from .one import connections, chat

logging.basicConfig(level=logging.INFO,format='%(message)s')
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)
log=logging.getLogger('fafa')

async def coordinator():
    while True:
        try:await asyncio.to_thread(codex.tick)
        except Exception as exc:log.error(json.dumps({'event':'coordinator_error','type':type(exc).__name__}))
        await asyncio.sleep(2)

@asynccontextmanager
async def lifespan(app):
    settings.validate()
    with transaction() as s:
        s.execute(text('SELECT 1'))
        if not s.execute(text("SELECT version_num FROM alembic_version WHERE version_num='0002_personal_ai'")).first():
            raise RuntimeError('Run alembic upgrade head before starting')
    runner=asyncio.create_task(coordinator())
    yield
    runner.cancel()
    try:await runner
    except asyncio.CancelledError:pass

app=FastAPI(title='FAFA ONE',version='2.0.0-alpha.1',lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)

@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    return JSONResponse({'detail':[{'loc':list(e['loc']),'msg':e['msg'],'type':e['type']} for e in exc.errors()]},status_code=422)

@app.middleware('http')
async def security_middleware(request:Request,call_next):
    started=time.monotonic();rid=uuid.uuid4().hex
    try:
        if request.headers.get('content-length','').isdigit() and int(request.headers['content-length'])>1_000_000:
            raise HTTPException(413,'Request too large')
        if request.method not in ('GET','HEAD','OPTIONS'):check_csrf(request)
        response=await call_next(request)
    except HTTPException as exc:response=JSONResponse({'detail':exc.detail},status_code=exc.status_code,headers=exc.headers)
    except Exception as exc:
        log.error(json.dumps({'request_id':rid,'event':'internal_error','type':type(exc).__name__}))
        response=JSONResponse({'detail':'Internal server error','request_id':rid},status_code=500)
    if (request.url.path.startswith('/api/v1/admin/') or getattr(request.state,'admin_access',False)) and request.method not in ('GET','HEAD') and response.status_code>=400:
        audit(getattr(request.state,'user_id',None),request.url.path,'admin_operation','denied' if response.status_code<500 else 'failed')
    if request.url.path=='/api/v1/auth/login' and response.status_code in (401,403,429):audit(None,'authentication','login','denied')
    response.headers.update({'X-Request-ID':rid,'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cache-Control':'no-store','X-Frame-Options':'DENY'})
    log.info(json.dumps({'request_id':rid,'method':request.method,'path':request.url.path,'status':response.status_code,'duration_ms':round((time.monotonic()-started)*1000)}))
    return response

for router in (auth.router,admin.router,nodes.router,ai.router,codex.router,connections.router,chat.router):app.include_router(router)

@app.get('/api/health')
def health():
    with transaction() as s:s.execute(text('SELECT 1'))
    return {'status':'ok','version':'2.0.0-alpha.1','service':'fafa-one-api','production_approved':False}
@app.get('/api/v1/status')
def status(user=Depends(current_user)):
    return {'version':'1.0.0','integrations':{'node_agent':'configured' if settings.agent_url else 'not_configured',
        'ai':'configuration_required','codex_worker':'configured' if settings.worker_url else 'not_configured',
        'google_oauth':'configured' if settings.google_configured else 'not_configured','email':'configured' if settings.smtp_host and settings.smtp_from else 'not_configured'}}
@app.get('/api/v1/admin/operations')
def operations(user=Depends(require_admin)):
    with transaction() as s:
        return {'users':s.scalar(select(func.count()).select_from(User)),
                'tasks':[{ 'status':status,'count':count} for status,count in s.execute(select(Task.status,func.count()).group_by(Task.status))],
                'node_alerts':[{'id':n.id,'name':n.name,'health':n.health,'error':n.last_error,'checked_at':n.checked_at} for n in s.scalars(select(Node).where(Node.last_error.is_not(None)))],
                'database':'connected','metrics_scope':'application database, not host telemetry','backups':'operator_managed; use documented backup scripts'}
@app.get('/api/v1/admin/openapi')
def openapi(user=Depends(require_admin)):return app.openapi()
