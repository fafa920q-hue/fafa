import hmac,json,os,shutil,subprocess,tempfile,time
from pathlib import Path
from fastapi import FastAPI,Depends,Header,HTTPException
from pydantic import BaseModel
app=FastAPI(title='FAFA private Node Agent',docs_url=None,openapi_url=None)
ROOT=Path(os.getenv('AGENT_CONFIG_ROOT','/data/configs'))
ALLOWLIST=Path(os.getenv('AGENT_ALLOWLIST','/etc/fafa/nodes.json'))
TOKEN_FILE=Path(os.getenv('AGENT_TOKEN_FILE','/run/secrets/node_agent_token'))
BINARIES={'xray':('/usr/local/bin/xray',['run','-test','-config']),
          'v2ray':('/usr/local/bin/v2ray',['test','-c']),
          'sing-box':('/usr/local/bin/sing-box',['check','-c'])}
class Payload(BaseModel):config:dict|None=None

def authorized(authorization:str=Header(default='')):
    token=TOKEN_FILE.read_text().strip() if TOKEN_FILE.is_file() else ''
    if len(token)<32 or not hmac.compare_digest(authorization,'Bearer '+token):
        raise HTTPException(401,'Agent authentication required')
def entry(ref):
    try:entries=json.loads(ALLOWLIST.read_text());value=entries[ref]
    except (OSError,ValueError,KeyError):raise HTTPException(404,'Node reference not allowlisted')
    if value.get('engine') not in BINARIES:raise HTTPException(422,'Engine not supported')
    # Paths come from the operator allowlist, never HTTP input.
    target=(ROOT/value['config_file']).resolve()
    if not target.is_relative_to(ROOT.resolve()):raise HTTPException(422,'Invalid allowlist path')
    return value,target

def validate(engine,path):
    binary,args=BINARIES[engine]
    if not Path(binary).is_file():raise HTTPException(503,'Official engine binary not installed')
    try:
        # Fixed argv, no shell, no startup/reload/root operation. Config output can contain credentials.
        result=subprocess.run([binary,*args,str(path)],capture_output=True,timeout=10,check=False,env={'PATH':'/usr/bin:/bin'})
    except subprocess.TimeoutExpired:raise HTTPException(504,'Engine configuration validation timed out')
    if result.returncode:raise HTTPException(422,'Engine rejected configuration; inspect private Agent diagnostics')

def telemetry():
    # These counters describe the Agent namespace, NOT an inferred node-service metric.
    metrics={'scope':'agent_process_and_filesystem','cpu_seconds':time.process_time(),'disk':dict(zip(('total','used','free'),shutil.disk_usage(ROOT))), 'network_bytes':None,'memory_rss_bytes':None}
    try:
        metrics['memory_rss_bytes']=int(Path('/proc/self/statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')
        lines=Path('/proc/net/dev').read_text().splitlines()[2:]
        metrics['network_bytes']={x.split(':')[0].strip():{'rx':int(x.split(':')[1].split()[0]),'tx':int(x.split(':')[1].split()[8])} for x in lines if ':' in x}
        metrics['network_scope']='agent_network_namespace_cumulative_counters'
    except (OSError,ValueError,IndexError):pass
    return metrics

@app.post('/v1/nodes/{ref}/{action}',dependencies=[Depends(authorized)])
def operate(ref:str,action:str,payload:Payload):
    if action not in ('health','apply','rollback'):raise HTTPException(422,'Unsupported operation')
    node,target=entry(ref);ROOT.mkdir(parents=True,exist_ok=True)
    if action=='health':
        running=False
        # An operator may bind a read-only, real PID file from the node's process namespace.
        try:
            pid=int(Path(node['pid_file']).read_text().strip())
            running=Path(f'/proc/{pid}/exe').resolve().name==node['engine']
        except (KeyError,OSError,ValueError):pass
        if target.is_file():validate(node['engine'],target)
        return {'source':'FAFA_AGENT','status':'ok' if running else 'degraded','runtime_running':running,'metrics':telemetry(),
                'message':'Process verified from allowlisted PID' if running else 'Runtime process not verified; no online claim'}
    if payload.config is None:raise HTTPException(422,'Configuration required')
    target.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(prefix='.fafa-',suffix='.json',dir=target.parent)
    try:
        with os.fdopen(fd,'w') as f:json.dump(payload.config,f);f.flush();os.fsync(f.fileno())
        validate(node['engine'],Path(name));os.chmod(name,0o600);os.replace(name,target)
    finally:
        if Path(name).exists():Path(name).unlink()
    return {'source':'FAFA_AGENT','status':'degraded','config_written':True,'runtime_activation':'not_performed','metrics':None,
            'message':'Validated configuration staged. Runtime reload requires operator service integration.'}
