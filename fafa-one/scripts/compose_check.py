"""No host/service mutation. Resolve Compose with temporary synthetic test values."""
import json,os,secrets,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='fafa-compose-') as temp:
    envfile=Path(temp)/'test.env'
    envfile.write_text('APP_ENV=production\nAPP_SECRET='+secrets.token_urlsafe(48)+'\nPOSTGRES_PASSWORD='+secrets.token_hex(24)+'\nPUBLIC_ORIGIN=https://codex.fafa888.uk\nCOOKIE_SECURE=true\n')
    env=os.environ|{'FAFA_ENV_FILE':str(envfile)}
    args=['docker','compose','--env-file',str(envfile),'-f',str(root/'docker-compose.yml'),'config']
    subprocess.run(args+['--quiet'],env=env,check=True)
    result=subprocess.run(args+['--format','json'],env=env,check=True,capture_output=True,text=True)
    data=json.loads(result.stdout)
    ports=data['services']['frontend']['ports']
    assert all(p.get('host_ip')=='127.0.0.1' for p in ports)
    assert not data['services']['api'].get('ports') and not data['services']['db'].get('ports')
    assert 'docker.sock' not in result.stdout
    assert data['services']['api']['read_only']
print('PASS: Compose schema, loopback Web binding, private API/DB, no Docker socket, read-only API')
