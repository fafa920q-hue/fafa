"""Reference sandbox launcher for a separately administered rootless worker.
No Web API imports this module. Requires an operator-built, digest-pinned executor
image implementing /usr/local/bin/fafa-job and already staged workspace.
No Codex authorization is bundled. Network is denied by default.
"""
import json,os,re,selectors,subprocess,time,uuid
from pathlib import Path

class SandboxError(RuntimeError):pass

def run(workspace:Path,prompt:str,timeout_seconds:int,image:str):
    workspace=workspace.resolve();root=Path(os.environ.get('WORKER_ROOT','/workspaces')).resolve()
    if workspace==root or not workspace.is_relative_to(root) or not workspace.is_dir():raise SandboxError('Workspace must be inside worker root')
    if not re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}',image):raise SandboxError('Executor image must be digest pinned')
    if not 30<=timeout_seconds<=3600:raise SandboxError('Invalid timeout')
    if len(prompt)>16000:raise SandboxError('Prompt too large')
    # Do not inherit registry/proxy credentials into the sandbox. Rootless Docker is mandatory.
    info=subprocess.run(['docker','info','--format','{{json .SecurityOptions}}'],capture_output=True,text=True,timeout=10,check=True)
    if 'rootless' not in info.stdout:raise SandboxError('A dedicated rootless Docker daemon is required')
    name='fafa-job-'+uuid.uuid4().hex
    argv=['docker','run','--rm','--pull=never','--name',name,'--network=none','--cpus=1','--memory=512m','--memory-swap=512m',
          '--pids-limit=128','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=10001:10001',
          '--ulimit','nofile=1024:1024','--tmpfs','/tmp:rw,noexec,nosuid,size=64m',
          '--mount',f'type=bind,source={workspace},target=/workspace','--workdir=/workspace',image,'/usr/local/bin/fafa-job']
    process=None
    try:
        process=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        process.stdin.write(json.dumps({'prompt':prompt}).encode());process.stdin.close()
        output=bytearray();deadline=time.monotonic()+timeout_seconds
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout,selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic()>=deadline:raise SandboxError('Sandbox exceeded timeout')
                for key,_ in selector.select(timeout=min(.5,max(.01,deadline-time.monotonic()))):
                    chunk=os.read(key.fd,65536)
                    if not chunk:selector.unregister(key.fileobj);break
                    output.extend(chunk)
                    if len(output)>1_000_000:raise SandboxError('Sandbox exceeded output limit')
        code=process.wait(timeout=max(.01,deadline-time.monotonic()))
        return {'exit_code':code,'stdout':output.decode('utf-8',errors='replace'),'stderr':''}
    except subprocess.TimeoutExpired:raise SandboxError('Sandbox exceeded timeout')
    finally:
        if process is not None:
            if process.poll() is None:process.kill()
            process.wait(timeout=5)
            if process.stdout:process.stdout.close()
        # Always remove the known container name, including Docker client failure/timeouts.
        subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=15,check=False)
