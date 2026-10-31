"""Build-free runtime smoke of this project on the local Docker socket only."""
import base64,json,os,secrets,subprocess,tempfile,time,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[1]
selectors={'DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'}
env={k:v for k,v in os.environ.items() if k not in selectors}|{'DOCKER_HOST':'unix:///var/run/docker.sock'}
project='fafa-local-'+secrets.token_hex(4)
with tempfile.TemporaryDirectory(prefix='fafa-stack-') as temp:
    temp=Path(temp);(temp/'secrets').mkdir()
    envfile=temp/'stack.env';envfile.write_text('APP_ENV=development\nAI_KEY_ENCRYPTION_KEY='+base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()+'\nAPP_SECRET='+secrets.token_urlsafe(48)+'\nPOSTGRES_PASSWORD='+secrets.token_hex(24)+'\nPUBLIC_ORIGIN=http://127.0.0.1:5173\nCOOKIE_SECURE=false\nREQUIRE_VERIFIED_EMAIL=false\nSECRETS_HOST_DIR='+str(temp/'secrets')+'\n')
    override=temp/'override.yml';override.write_text('services:\n  frontend:\n    ports: !override\n      - "127.0.0.1::8080"\n')
    env['FAFA_ENV_FILE']=str(envfile)
    cmd=['docker','compose','-p',project,'--env-file',str(envfile),'-f',str(root/'docker-compose.yml'),'-f',str(override)]
    try:
        guard=subprocess.run(['docker','run','--rm','--network','none','--env-file',str(envfile),'-e','APP_ENV=production','-e','COOKIE_SECURE=true','-e','PUBLIC_ORIGIN=https://fafa888.uk','fafa-one-api:2.0.0-alpha.1','python','-c','from app.config import settings; settings.validate()'],env=env,capture_output=True,text=True)
        assert guard.returncode!=0 and 'not production approved' in guard.stderr
        # Sequence migration in a removable container to avoid duplicate writable
        # VFS copies exhausting a small isolated development filesystem.
        subprocess.run(cmd+['up','-d','--no-build','--wait','--wait-timeout','45','db'],env=env,check=True)
        subprocess.run(cmd+['run','--rm','--no-deps','migrate'],env=env,check=True)
        subprocess.run(cmd+['up','-d','--no-build','--no-deps','--wait','--wait-timeout','75','api','frontend'],env=env,check=True)
        port=subprocess.check_output(cmd+['port','frontend','8080'],env=env,text=True).strip()
        with urllib.request.urlopen('http://'+port+'/api/health',timeout=5) as r:
            data=json.load(r);assert data['status']=='ok' and data['version']=='2.0.0-alpha.1'
        with urllib.request.urlopen('http://'+port+'/',timeout=5) as r:
            assert b'<div id="root">' in r.read()
            assert r.headers.get('Content-Security-Policy') and r.headers.get('X-Frame-Options')=='DENY'
        subprocess.run(cmd+['exec','-T','api','python','-c','import os; assert os.geteuid()==10001'],env=env,check=True)
        print('PASS: isolated full Compose runtime, PostgreSQL migration, healthchecks, non-root API, Nginx UI and security headers')
    except BaseException:
        # Filter logs: access logging is disabled and app logs omit query/body.
        subprocess.run(cmd+['logs','--tail','40','api','migrate','frontend'],env=env,check=False)
        raise
    finally:
        # Only this unique temporary project and its temporary data volumes are removed.
        subprocess.run(cmd+['down','-v','--remove-orphans'],env=env,check=False)
