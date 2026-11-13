"""Run local V3 checks only against a new database in the labelled acceptance container.

Never read production credentials. Keep the isolated database and logs as evidence.
"""
import base64
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
IMAGE = 'fafa-one-runtime:59154d80c87e7a0531ce08a3711b95158fdf0519'
CONTAINER = 'fafa-auth-acceptance-db'

def main():
    os.umask(0o077)
    info = json.loads(subprocess.check_output(['docker', 'inspect', CONTAINER]))[0]
    if info['Config']['Labels'].get('fafa.validation') != 'ec2-auth-release':
        raise RuntimeError('ISOLATED_CONTAINER_REQUIRED')
    env = dict(v.split('=', 1) for v in info['Config']['Env'] if '=' in v)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d_%H%M%S')
    database = 'fafa_member_b_v3_' + stamp + '_test'
    user = env['POSTGRES_USER']
    subprocess.run(['docker', 'exec', CONTAINER, 'createdb', '-U', user, database], check=True)
    target = f'postgres://{quote(user, safe="")}:{quote(env["POSTGRES_PASSWORD"], safe="")}@127.0.0.1:15432/{database}'
    folder = ROOT / 'docs/evidence' / ('b-v3-' + stamp)
    folder.mkdir(mode=0o700)
    os.chown(folder, ROOT.stat().st_uid, ROOT.stat().st_gid)
    folder.chmod(0o750)
    envfile = Path('/tmp') / ('fafa-b-v3-' + stamp + '.env')
    envfile.write_text('\n'.join([
        'DATABASE_URL=' + target, 'TEST_DATABASE_URL=' + target,
        'ENCRYPTION_KEY=' + base64.b64encode(os.urandom(32)).decode(),
        'NODE_ENV=development', 'DEMO_MODE=true', 'DEV_MOCK_LOGIN=true',
        'MEMBER_SELF_SERVICE=false', 'WEB_ORIGIN=http://localhost:5173',
        'ADMIN_ORIGIN=http://localhost:5174', 'API_PUBLIC_URL=http://localhost:5173',
    ]) + '\n')
    envfile.chmod(0o600)
    commands = [
        ('types', ['./node_modules/.bin/tsc', '--noEmit']),
        ('migrate-isolated', ['node', '--import', 'tsx', 'packages/db/src/migrate.ts']),
        ('policies-workspace', ['./node_modules/.bin/vitest', 'run', 'tests/service-policy.integration.test.ts', 'tests/v3-workspace.integration.test.ts', 'tests/self-service.integration.test.ts']),
        ('unit', ['./node_modules/.bin/vitest', 'run', 'tests/unit.test.ts', 'tests/domain.test.ts', 'tests/nodes.test.ts', 'tests/backup.test.ts', 'tests/wloc.test.ts', 'tests/wloc-device.test.ts', 'tests/member-auth.unit.test.ts', 'tests/mail-secret.test.ts']),
        ('member', ['./node_modules/.bin/vitest', 'run', 'tests/member-auth.integration.test.ts', 'tests/member-auth.upgrade.test.ts', 'tests/member-mail-acceptance.test.ts']),
        ('api', ['./node_modules/.bin/vitest', 'run', 'tests/integration.test.ts', 'tests/wloc.integration.test.ts']),
        ('owner', ['./node_modules/.bin/vitest', 'run', 'tests/owner.integration.test.ts']),
        ('lint', ['./node_modules/.bin/eslint', '.']),
        ('deployment', ['python3', '-m', 'unittest', 'discover', '-s', 'infra/deploy', '-p', 'test_*.py']),
        ('security', ['node', '--import', 'tsx', 'infra/scripts/security.ts']),
        ('web-build', ['./node_modules/.bin/vite', 'build', '--config', 'apps/web/vite.config.ts']),
        ('admin-build', ['./node_modules/.bin/vite', 'build', '--config', 'apps/admin/vite.config.ts']),
    ]
    results = []
    tested_sha = subprocess.check_output(['git', '-c', 'safe.directory=' + str(ROOT), '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    for name, command in commands:
        print('RUN ' + name, flush=True)
        with (folder / (name + '.log')).open('w') as log:
            testenv = dict(os.environ)
            testenv.update(dict(line.split('=', 1) for line in envfile.read_text().splitlines()))
            testenv['PATH'] = '/opt/fafa-one/tools/node-v24.22.2-linux-x64/bin:/opt/fafa-one/tools/pnpm/bin:' + testenv.get('PATH', '')
            if name in ['member', 'owner']:
                member_database = database.removesuffix('_test') + '_' + name + '_test'
                subprocess.run(['docker', 'exec', CONTAINER, 'createdb', '-U', user, member_database], check=True)
                testenv['DATABASE_URL'] = target.replace('/' + database, '/' + member_database)
                testenv['TEST_DATABASE_URL'] = testenv['DATABASE_URL']
                subprocess.run(['node', '--import', 'tsx', 'packages/db/src/migrate.ts'], cwd=ROOT, env=testenv, stdout=log, stderr=subprocess.STDOUT, check=True, user=ROOT.stat().st_uid, group=ROOT.stat().st_gid, umask=0o022)
            result = subprocess.run(command, cwd=ROOT, env=testenv, stdout=log, stderr=subprocess.STDOUT, user=ROOT.stat().st_uid, group=ROOT.stat().st_gid, umask=0o022)
        results.append({'check': name, 'exitCode': result.returncode})
        os.chown(folder / (name + '.log'), ROOT.stat().st_uid, ROOT.stat().st_gid)
        (folder / (name + '.log')).chmod(0o640)
        (folder / 'results.json').write_text(json.dumps({'sha': tested_sha, 'database': database, 'productionDatabaseAccessed': False, 'checks': results}, indent=2) + '\n')
        os.chown(folder / 'results.json', ROOT.stat().st_uid, ROOT.stat().st_gid)
        (folder / 'results.json').chmod(0o640)
        print(name + ': ' + str(result.returncode), flush=True)
        if result.returncode:
            print((folder / (name + '.log')).read_text()[-9000:])
            return 1
    print('PASS evidence=' + str(folder), flush=True)
    return 0

if __name__ == '__main__':
    sys.exit(main())
