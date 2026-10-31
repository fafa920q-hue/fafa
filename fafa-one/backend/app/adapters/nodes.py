"""Our agent protocol is documented locally. It is NOT an Xray/sing-box HTTP API.
Xray/V2Ray: agent executes fixed `run -test -config` / `test -c` validation.
sing-box: agent executes fixed `sing-box check -c`. No arbitrary shell is accepted.
"""
import time
import httpx
from fastapi import HTTPException
from ..config import settings
from ..security import secret_value

class TestNodeAdapter:
    """Explicit, opt-in test fixture; values never claim real node connectivity."""
    def call(self,node,action,config=None):
        return {'status':'TEST','source':'TEST','metrics':None,'latency_ms':None,'message':'TEST adapter: no external operation performed'}

class AgentNodeAdapter:
    def call(self,node,action,config=None):
        if not settings.agent_url: raise HTTPException(503,'Node Agent not configured')
        if not settings.agent_url.startswith('https://'): raise HTTPException(503,'Node Agent requires TLS')
        if action not in {'health','apply','rollback'}: raise HTTPException(422,'Unsupported action')
        started=time.monotonic()
        with httpx.Client(timeout=15,follow_redirects=False) as client:
            r=client.post(settings.agent_url.rstrip('/')+'/v1/nodes/'+node.agent_ref+'/'+action,
                          headers={'Authorization':'Bearer '+secret_value(settings.agent_token_ref)},json={'config':config})
            r.raise_for_status();data=r.json()
        if data.get('source')!='FAFA_AGENT' or data.get('status') not in {'ok','degraded'}: raise ValueError('Invalid agent response')
        metrics=data.get('metrics')
        if metrics is not None and not isinstance(metrics,dict): raise ValueError('Invalid metrics')
        return data|{'latency_ms':round((time.monotonic()-started)*1000)}

def adapter(node): return TestNodeAdapter() if node.engine=='TEST' else AgentNodeAdapter()
