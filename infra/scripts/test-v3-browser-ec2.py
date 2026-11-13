"""Reuse the established EC2 browser image and disposable mail transport."""
import datetime
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

root = Path('/opt/fafa-one')
source = Path(__file__).resolve().parents[2]
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
name = 'fafa_member_browser_' + secrets.token_hex(6) + '_test'
label = subprocess.check_output(['docker', 'inspect', 'fafa-auth-acceptance-db', '--format', '{{index .Config.Labels "fafa.validation"}}'], text=True).strip()
if label != 'ec2-auth-release':
    raise RuntimeError('ISOLATED_CONTAINER_REQUIRED')
subprocess.run(['docker', 'exec', 'fafa-auth-acceptance-db', 'createdb', '-U', 'fafa', name], check=True)
evidence = root / 'reports' / ('b-v3-browser-' + stamp)
evidence.mkdir(mode=0o700)
env = {
    'PATH': '/opt/fafa-one/tools/node-v24.22.2-linux-x64/bin:/opt/fafa-one/tools/pnpm/bin:/usr/local/bin:/usr/bin:/bin',
    'DATABASE_URL': 'postgres://fafa:fafa_dev_only@localhost:5432/' + name,
    'TEST_DATABASE_URL': 'postgres://fafa:fafa_dev_only@localhost:5432/' + name,
    'NODE_ENV': 'development', 'DEMO_MODE': 'true', 'DEV_MOCK_LOGIN': 'true',
    'MEMBER_SELF_SERVICE': 'true', 'MAIL_PROVIDER': 'resend',
    'MAIL_API_KEY': 'synthetic-browser-resend-fixture', 'MAIL_FROM': 'accounts@example.invalid',
    'FAFA_TEST_MAIL_FILE': '/tmp/member-synthetic-mail.ndjson',
    'FAFA_LOCAL_MAIL_FIXTURE': 'disposable-docker',
    'NODE_OPTIONS': '--import /app/tests/fixtures/member-mail.mjs',
    'ENCRYPTION_KEY': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'FAFA_TEST_REPORT': '/evidence/auth-browser.json',
    'FAFA_TEST_OUTPUT_DIR': '/evidence/test-results',
    'FAFA_TEST_HTML_REPORT': '/evidence/html', 'FAFA_TEST_SCREENSHOT_DIR': '/evidence',
}
args = ['docker', 'run', '--rm', '--name', 'fafa-b-v3-browser-' + stamp.lower(), '--network', 'container:fafa-auth-acceptance-db', '--workdir', '/app', '--tmpfs', '/app/apps/web/node_modules:rw,nosuid,nodev', '--tmpfs', '/app/apps/admin/node_modules:rw,nosuid,nodev']
for src, dest, kind in [
    (str(source), '/app', 'bind'), ('fafa-auth-browser-modules-9464834a', '/app/node_modules', 'volume'),
    (str(evidence), '/evidence', 'bind'),
    (str(root / 'tools/node-v24.22.2-linux-x64'), str(root / 'tools/node-v24.22.2-linux-x64'), 'bind'),
    (str(root / 'tools/pnpm'), str(root / 'tools/pnpm'), 'bind'),
]:
    args += ['--mount', 'type=' + kind + ',source=' + src + ',target=' + dest]
for key, value in env.items():
    args += ['-e', key + '=' + value]
args += ['mcr.microsoft.com/playwright:v1.64.1-noble', 'bash', '-c', 'pnpm db:migrate && pnpm db:seed && pnpm exec playwright test --config playwright.member-delivery.config.ts']
print('Browser evidence: ' + str(evidence), flush=True)
with (evidence / 'runner.log').open('w') as log:
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
(evidence / 'exit.json').write_text(json.dumps({'sha': subprocess.check_output(['git', '-c', 'safe.directory=' + str(source), '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(), 'exitCode': result.returncode, 'database': name, 'productionAccessed': False}) + '\n')
if result.returncode:
    print((evidence / 'runner.log').read_text()[-12000:])
print(json.dumps({'browserExit': result.returncode, 'evidence': str(evidence)}), flush=True)
sys.exit(result.returncode)
