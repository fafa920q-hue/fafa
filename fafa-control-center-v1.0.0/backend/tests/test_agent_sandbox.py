import json,sys,subprocess
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
sys.path.insert(0,str(Path(__file__).parents[2]))
from agent import main as agent
from worker import sandbox

def test_agent_allowlist_auth_staging(monkeypatch,tmp_path):
    root=tmp_path/'configs';root.mkdir();token=tmp_path/'token';token.write_text('TEST_TOKEN_'+'x'*32)
    config=tmp_path/'nodes.json';config.write_text(json.dumps({'test':{'engine':'sing-box','config_file':'test.json'}}))
    monkeypatch.setattr(agent,'ROOT',root);monkeypatch.setattr(agent,'TOKEN_FILE',token);monkeypatch.setattr(agent,'ALLOWLIST',config)
    with TestClient(agent.app) as c:
        assert c.post('/v1/nodes/test/health',json={}).status_code==401
        c.headers['Authorization']='Bearer TEST_TOKEN_'+'x'*32
        assert c.post('/v1/nodes/missing/health',json={}).status_code==404
        monkeypatch.setattr(agent,'validate',lambda engine,path:None)
        r=c.post('/v1/nodes/test/apply',json={'config':{'TEST':True}}).json()
        assert r['config_written'] and r['runtime_activation']=='not_performed'
        assert json.loads((root/'test.json').read_text())=={'TEST':True}
        r=c.post('/v1/nodes/test/health',json={}).json()
        assert r['runtime_running'] is False and r['status']=='degraded'
        config.write_text(json.dumps({'bad':{'engine':'xray','config_file':'../escape'}}))
        assert c.post('/v1/nodes/bad/apply',json={'config':{}}).status_code==422

def test_agent_fixed_official_validation_arguments(monkeypatch,tmp_path):
    calls=[]
    monkeypatch.setattr(agent,'BINARIES',{'xray':(sys.executable,['run','-test','-config'])})
    class Result:returncode=0
    monkeypatch.setattr(agent.subprocess,'run',lambda argv,**kwargs:calls.append((argv,kwargs)) or Result())
    agent.validate('xray',tmp_path/'TEST.json')
    assert calls[0][0][1:4]==['run','-test','-config'] and 'shell' not in calls[0][1]

def test_sandbox_rejects_unpinned_or_outside_root(monkeypatch,tmp_path):
    monkeypatch.setenv('WORKER_ROOT',str(tmp_path));workspace=tmp_path/'project';workspace.mkdir()
    with pytest.raises(sandbox.SandboxError):sandbox.run(workspace,'TEST',30,'unpinned:latest')
    with pytest.raises(sandbox.SandboxError):sandbox.run(tmp_path.parent,'TEST',30,'image@sha256:'+'0'*64)

def test_sandbox_limits_and_cleanup(monkeypatch,tmp_path):
    monkeypatch.setenv('WORKER_ROOT',str(tmp_path));workspace=tmp_path/'project';workspace.mkdir();calls=[]
    class Result:
        returncode=0;stdout='["name=rootless"]';stderr=''
    def run(argv,**kwargs):calls.append((argv,kwargs));return Result()
    monkeypatch.setattr(sandbox.subprocess,'run',run)
    original_popen=subprocess.Popen
    def popen(argv,**kwargs):
        calls.append((argv,kwargs))
        return original_popen([sys.executable,'-c','import sys; sys.stdin.read(); print("TEST fixture subprocess")'],**kwargs)
    monkeypatch.setattr(sandbox.subprocess,'Popen',popen)
    result=sandbox.run(workspace,'TEST',30,'test/executor@sha256:'+'0'*64)
    argv=calls[1][0]
    for flag in ['--network=none','--cpus=1','--memory=512m','--pids-limit=128','--read-only','--cap-drop=ALL','--user=10001:10001']:assert flag in argv
    assert calls[-1][0][:3]==['docker','rm','-f'] and result['exit_code']==0


def test_sandbox_bounds_untrusted_output(monkeypatch,tmp_path):
    monkeypatch.setenv('WORKER_ROOT',str(tmp_path));workspace=tmp_path/'project';workspace.mkdir()
    class Result:returncode=0;stdout='["rootless"]';stderr=''
    monkeypatch.setattr(sandbox.subprocess,'run',lambda *args,**kwargs:Result())
    original_popen=subprocess.Popen
    def popen(argv,**kwargs):
        return original_popen([sys.executable,'-c','import sys; sys.stdin.read(); sys.stdout.write("x"*1100000)'],**kwargs)
    monkeypatch.setattr(sandbox.subprocess,'Popen',popen)
    with pytest.raises(sandbox.SandboxError,match='output limit'):
        sandbox.run(workspace,'TEST',30,'test/executor@sha256:'+'0'*64)
