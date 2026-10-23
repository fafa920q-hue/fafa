"""Pluggable worker boundary. Web API never launches processes or mounts Docker."""
from abc import ABC,abstractmethod
import httpx
from fastapi import HTTPException
from ..config import settings
from ..security import secret_value

LIMITS={'cpu':1,'memory_mb':512,'pids':128,'network':'deny','filesystem':'workspace_only','rootfs':'read_only','user':'unprivileged','capabilities':[]}
class Executor(ABC):
    @abstractmethod
    def submit(self,task,project): ...
    @abstractmethod
    def poll(self,job_id): ...
    @abstractmethod
    def cancel(self,job_id): ...
    @abstractmethod
    def rollback(self,job_id): ...

class RemoteExecutor(Executor):
    def call(self,method,path,body=None):
        if not settings.worker_url.startswith('https://'): raise HTTPException(503,'Trusted TLS Codex worker not configured')
        with httpx.Client(timeout=15,follow_redirects=False) as client:
            r=client.request(method,settings.worker_url.rstrip('/')+path,headers={'Authorization':'Bearer '+secret_value(settings.worker_token_ref)},json=body)
            r.raise_for_status()
            if len(r.content)>1_000_000: raise ValueError('Worker response too large')
            return r.json()
    def submit(self,task,project):
        return self.call('POST','/v1/jobs',{'idempotency_key':f'fafa-{task.id}-{task.attempts}',
            'repository':project.repository,'prompt':task.prompt,'timeout_seconds':task.timeout_seconds,
            'limits':LIMITS,'approval':{'administrator_id':task.approved_by,'task_id':task.id}})
    def poll(self,job_id): return self.call('GET','/v1/jobs/'+job_id)
    def cancel(self,job_id): return self.call('POST','/v1/jobs/'+job_id+'/cancel')
    def rollback(self,job_id): return self.call('POST','/v1/jobs/'+job_id+'/rollback',{'limits':LIMITS})

def get_executor(): return RemoteExecutor() if settings.worker_url else None
