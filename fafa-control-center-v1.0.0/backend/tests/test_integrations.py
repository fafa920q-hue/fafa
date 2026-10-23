import secrets
import pytest
from app import ai,nodes,codex
from app.config import settings
from app.database import transaction
from app.models import User,AIAccount,Model,AIRequest,Node,Task,now
from app.adapters.ai import ProviderFailure
from app.adapters.executor import LIMITS
from conftest import create_user
P='/api/v1'
@pytest.fixture
def accounts(admin,tmp_path,monkeypatch):
    monkeypatch.setattr(settings,'secrets_dir',str(tmp_path))
    for ref in ['primary','other']:(tmp_path/ref).write_text('TEST_ONLY_'+secrets.token_hex(16))
    ids=[admin.post(P+'/ai/accounts',json={'name':ref,'provider':'openai','secret_ref':ref}).json()['id'] for ref in ['primary','other']]
    for model in ['test-model','test-fallback']:
        assert admin.put(P+'/ai/models',json={'id':model,'provider':'openai','capabilities':['text'],'input_cents_per_million':100,'output_cents_per_million':200}).status_code==200
    return ids

def test_ai_account_model_usage_isolation(admin,accounts,monkeypatch):
    a,b=accounts;root_id=admin.get(P+'/auth/me').json()['id'];create_user(grants={'modules':['ai'],'accounts':[a],'models':['test-model']})
    admin.post(P+'/auth/login',json={'email':'other@example.com','password':'test-user-password-123'})
    calls=[];monkeypatch.setattr(ai,'invoke',lambda *args:calls.append(args) or {'output':'TEST','input_tokens':10,'output_tokens':20})
    assert [x['id'] for x in admin.get(P+'/ai/catalog').json()['accounts']]==[a]
    assert admin.post(P+'/ai/requests',json={'account_id':b,'model_id':'test-model','prompt':'TEST'}).status_code==403
    assert admin.post(P+'/ai/requests',json={'account_id':a,'model_id':'test-fallback','prompt':'TEST'}).status_code==403
    assert admin.post(P+'/ai/requests',json={'account_id':a,'model_id':'test-model','prompt':'TEST'}).status_code==200
    assert len(calls)==1 and admin.get(P+'/ai/usage').json()['requests']==1
    with transaction() as s:s.add(AIRequest(user_id=root_id,account_id=b,model_id='test-model',status='failed'))
    assert len(admin.get(P+'/ai/logs').json()['logs'])==1

def test_ai_secret_redaction(admin,accounts,tmp_path):
    text=admin.get(P+'/ai/catalog').text
    assert (tmp_path/'primary').read_text() not in text
    assert admin.post(P+'/ai/accounts',json={'name':'bad','provider':'openai','secret_ref':'../escape'}).status_code==422

def test_ai_budget_before_provider(admin,accounts,monkeypatch):
    uid=admin.get(P+'/auth/me').json()['id']
    with transaction() as s:s.get(User,uid).budget_cents=0
    monkeypatch.setattr(ai,'invoke',lambda *args:pytest.fail('Unexpected provider call'))
    assert admin.post(P+'/ai/requests',json={'account_id':accounts[0],'model_id':'test-model','prompt':'TEST'}).status_code==429

def test_ai_unknown_and_failure_safe(admin,accounts,monkeypatch):
    body={'account_id':accounts[0],'model_id':'test-model','prompt':'TEST'}
    monkeypatch.setattr(ai,'invoke',lambda *args:{'output':'TEST','input_tokens':None,'output_tokens':None})
    assert admin.post(P+'/ai/requests',json=body).status_code==200
    u=admin.get(P+'/ai/usage').json();assert u['unknown_usage_requests']==1 and u['cost_cents_reserved']>0 and u['provider_remaining_quota'] is None
    def fail(*args):raise RuntimeError('TEST_SENSITIVE_ERROR')
    monkeypatch.setattr(ai,'invoke',fail)
    r=admin.post(P+'/ai/requests',json=body);assert r.status_code==502 and 'TEST_SENSITIVE_ERROR' not in r.text
    assert 'TEST_SENSITIVE_ERROR' not in admin.get(P+'/ai/logs').text

def test_ai_fallback_same_account_only429(admin,accounts,monkeypatch):
    calls=[]
    def invoke(*args):
        calls.append(args)
        if args[2]=='test-model':raise ProviderFailure(429)
        return {'output':'TEST fallback','input_tokens':1,'output_tokens':2}
    monkeypatch.setattr(ai,'invoke',invoke)
    r=admin.post(P+'/ai/requests',json={'account_id':accounts[0],'model_id':'test-model','fallback_model_id':'test-fallback','prompt':'TEST'})
    assert r.status_code==200 and r.json()['fallback_used'] and calls[0][1]==calls[1][1]

def test_ai_disabled_unpriced_missing_secret(admin,accounts):
    body={'account_id':accounts[0],'model_id':'test-model','prompt':'TEST'}
    with transaction() as s:s.get(AIAccount,accounts[0]).enabled=False
    assert admin.post(P+'/ai/requests',json=body).status_code==422
    with transaction() as s:s.get(AIAccount,accounts[0]).enabled=True;s.get(Model,'test-model').input_cents_per_million=None
    assert admin.post(P+'/ai/requests',json=body).status_code==503

@pytest.fixture
def node(admin):
    r=admin.post(P+'/nodes',json={'name':'TEST node','engine':'TEST','agent_ref':'test-node','region':'TEST'})
    assert r.status_code==200,r.text
    return r.json()['id']
def test_node_test_honest_batch(admin,node):
    r=admin.post(f'{P}/nodes/{node}/health').json()
    assert r['status']=='TEST' and r['node']['latency_ms'] is None and r['node']['metrics'] is None
    assert admin.post(P+'/nodes/batch',json={'ids':[node],'action':'disable'}).status_code==200
    assert admin.post(f'{P}/nodes/{node}/health').status_code==409

def test_node_not_configured_retries_alert(admin,node):
    with transaction() as s:s.get(Node,node).engine='xray'
    r=admin.post(f'{P}/nodes/{node}/health').json()
    assert r['status']=='not_configured' and r['attempts']==1 and r['node']['health']=='unknown'
    assert admin.get(P+'/admin/operations').json()['node_alerts'][0]['id']==node

def test_node_config_versions_rollback(admin,node,monkeypatch):
    calls=[]
    class Fixture:
        def call(self,n,action,config=None):calls.append((action,config));return {'status':'ok','source':'TEST_FIXTURE'}
    monkeypatch.setattr(nodes,'adapter',lambda n:Fixture())
    assert admin.post(f'{P}/nodes/{node}/config',json={'config':{'TEST':1}}).json()['node']['version']==1
    assert admin.post(f'{P}/nodes/{node}/config',json={'config':{'TEST':2}}).json()['node']['version']==2
    assert admin.post(f'{P}/nodes/{node}/rollback',json={'version':1}).json()['node']['version']==3
    assert calls[-1]==('rollback',{'TEST':1})
    assert admin.put(f'{P}/nodes/{node}',json={'name':'change','engine':'xray','agent_ref':'other'}).status_code==409

def test_node_scope(admin,node):
    create_user(grants={'modules':['nodes'],'nodes':[]})
    admin.post(P+'/auth/login',json={'email':'other@example.com','password':'test-user-password-123'})
    assert admin.get(P+'/nodes').json()['nodes']==[]
    assert admin.post(f'{P}/nodes/{node}/health').status_code==403

@pytest.fixture
def task(admin):
    pid=admin.post(P+'/codex/projects',json={'name':'TEST project','repository':'https://example.com/test/repo.git'}).json()['id']
    r=admin.post(P+'/codex/tasks',json={'project_id':pid,'prompt':'TEST task','timeout_seconds':30});assert r.status_code==200,r.text
    return r.json()['id']
class FixtureExecutor:
    def submit(self,task,project):return {'id':'TEST_JOB'}
    def poll(self,job):return {'status':'succeeded','logs':'TEST fixture','changes':['TEST.txt'],'diff':'TEST diff','tests':{'source':'TEST','passed':1}}
    def cancel(self,job):return {'status':'cancelled'}
    def rollback(self,job):return {'status':'rolled_back'}

def test_codex_unconfigured_never_executes(admin,task):
    r=admin.post(f'{P}/codex/tasks/{task}/approve').json()
    assert r['status']=='not_configured' and r['attempts']==0 and r['tests'] is None
    assert admin.post(f'{P}/codex/tasks/{task}/retry').json()['status']=='pending_approval'

def test_codex_queue_logs_changes_rollback_fixture(admin,task,monkeypatch):
    monkeypatch.setattr(codex,'get_executor',lambda:FixtureExecutor())
    assert admin.post(f'{P}/codex/tasks/{task}/approve').json()['status']=='queued'
    codex.tick();codex.tick()
    r=admin.get(P+'/codex/tasks').json()['tasks'][0]
    assert r['status']=='succeeded' and r['changes']==['TEST.txt'] and r['tests']['source']=='TEST'
    assert admin.post(f'{P}/codex/tasks/{task}/rollback').json()['status']=='rolled_back'

def test_codex_timeout_and_retry_approval(admin,task,monkeypatch):
    monkeypatch.setattr(codex,'get_executor',lambda:FixtureExecutor())
    admin.post(f'{P}/codex/tasks/{task}/approve');codex.tick()
    with transaction() as s:s.get(Task,task).started_at=now()-31
    codex.tick()
    assert admin.get(P+'/codex/tasks').json()['tasks'][0]['status']=='timed_out'
    r=admin.post(f'{P}/codex/tasks/{task}/retry').json();assert r['status']=='pending_approval' and r['approved_by'] is None

def test_codex_cancel_and_ownership(admin,task):
    create_user(grants={'modules':['codex']})
    admin.post(P+'/auth/login',json={'email':'other@example.com','password':'test-user-password-123'})
    assert admin.get(P+'/codex/projects').json()['projects']==[] and admin.get(P+'/codex/tasks').json()['tasks']==[]
    assert admin.post(f'{P}/codex/tasks/{task}/cancel').status_code==403

def test_executor_limits():assert LIMITS['network']=='deny' and LIMITS['memory_mb']==512 and LIMITS['rootfs']=='read_only' and LIMITS['capabilities']==[]


def test_node_transient_retry_has_real_attempts(admin,node,monkeypatch):
    calls=[]
    class TransientFixture:
        def call(self,n,action,config=None):
            calls.append(action)
            if len(calls)<3:raise ConnectionError('TEST transient error')
            return {'status':'TEST','metrics':None,'latency_ms':None}
    monkeypatch.setattr(nodes,'adapter',lambda n:TransientFixture())
    r=admin.post(f'{P}/nodes/{node}/health').json()
    assert r['status']=='TEST' and r['attempts']==3 and len(calls)==3

def test_codex_unconfirmed_timeout_prevents_duplicate_retry(admin,task,monkeypatch):
    class Unconfirmed(FixtureExecutor):
        def cancel(self,job):return {'status':'cancel_requested'}
    monkeypatch.setattr(codex,'get_executor',lambda:Unconfirmed())
    admin.post(f'{P}/codex/tasks/{task}/approve');codex.tick()
    with transaction() as s:s.get(Task,task).started_at=now()-31
    codex.tick()
    r=admin.get(P+'/codex/tasks').json()['tasks'][0]
    assert r['status']=='timed_out' and r['error']=='timeout_cancellation_unconfirmed'
    assert admin.post(f'{P}/codex/tasks/{task}/retry').status_code==409

def test_codex_cancel_before_dispatch(admin,task):
    assert admin.post(f'{P}/codex/tasks/{task}/cancel').json()['status']=='cancelled'
    assert admin.get(P+'/codex/tasks').json()['tasks'][0]['attempts']==0
