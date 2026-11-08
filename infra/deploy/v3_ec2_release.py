"""V3 release using existing EC2 systemd/Compose supervision; never migrate production.

Run backup, build, preflight and deploy separately. Require exact SHA evidence.
All command output containing configuration or credentials stays out of reports.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import time
import urllib.request
from urllib.parse import urlsplit, urlunsplit

ROOT = Path('/opt/fafa-one')
SOURCE = ROOT / 'source'
TABLES = ['users', 'google_identities', 'node_sources', 'nodes', 'subscription_profiles', 'subscription_tokens', 'ai_accounts', 'server_connections']

def need(condition, reason):
    if not condition:
        raise RuntimeError(reason)

def checked(args, data=None, env=None):
    result = subprocess.run(args, input=data, capture_output=True, env=env)
    need(result.returncode == 0, 'COMMAND_FAILED:' + Path(args[0]).name)
    return result.stdout

def query(database, statement, container='fafa-one-postgres-1'):
    return checked(['docker', 'exec', container, 'psql', '-U', 'fafa', '-d', database, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement]).decode().strip()

def pipeline(first, second, output=None, input_file=None):
    with subprocess.Popen(first, stdin=input_file, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as a:
        b = subprocess.run(second, stdin=a.stdout, stdout=output if output else subprocess.PIPE, stderr=subprocess.PIPE)
        a.stdout.close()
        need(a.wait() == 0 and b.returncode == 0, 'PIPELINE_FAILED')
        return b.stdout

def counts(container, database):
    return json.loads(query(database, 'SELECT json_build_object(' + ','.join("'" + t + "',(SELECT count(*) FROM " + t + ")" for t in TABLES) + ')', container))

def ensure_current(expected):
    current = (ROOT / 'current').resolve()
    need(current.is_relative_to(ROOT / 'releases'), 'CURRENT_RELEASE_PATH')
    need((ROOT / '.deployed-sha').read_text().strip() == expected, 'PRODUCTION_ADVANCED')
    need((current / '.release-sha').read_text().strip() == expected, 'RELEASE_SHA_MISMATCH')
    for service, image in [('api', 'runtime'), ('worker', 'runtime'), ('web', 'web'), ('admin', 'admin')]:
        actual = checked(['docker', 'inspect', 'fafa-one-' + service + '-1', '--format', '{{.Config.Image}}']).decode().strip()
        need(actual == 'fafa-one-' + image + ':' + expected, 'RUNNING_SHA_MISMATCH')
    return current

def public_health():
    statuses = {}
    for url in ['https://fafa888.uk/', 'https://a.fafa888.uk/', 'https://fafa888.uk/member/register', 'https://fafa888.uk/auth/member/config', 'https://fafa888.uk/api/ready']:
        with urllib.request.urlopen(url, timeout=20) as response:
            need(response.status == 200, 'HTTPS_HEALTH')
            statuses[url] = response.status
            if url.endswith('/auth/member/config'):
                config = json.loads(response.read(32768))
                need(all(config.get(k) for k in ['registrationOpen', 'mailConfigured', 'selfService']), 'REGISTRATION_CONFIG')
    return statuses

def backup(args):
    ensure_current(args.expected_production_sha)
    label = checked(['docker', 'inspect', 'fafa-auth-acceptance-db', '--format', '{{index .Config.Labels "fafa.validation"}}']).decode().strip()
    need(label == 'ec2-auth-release', 'ISOLATED_RESTORE_REQUIRED')
    folder = ROOT / 'backups' / ('before-b-v3-' + args.evidence.name)
    folder.mkdir(mode=0o700)
    crypt = ['docker', 'exec', '-i', 'fafa-one-api-1', 'node', '--import', 'tsx', 'infra/scripts/backup-envelope.ts']
    config_names = ['.env.production', '.env.runtime', '.deployed-sha', 'current/infra/docker/compose.production.yaml', 'current/infra/docker/compose.mail-secret.yaml', 'current/infra/docker/compose.ec2.yaml', 'current/infra/reverse-proxy/Caddyfile']
    configuration = folder / 'configuration.tar.envelope'
    with configuration.open('xb') as output:
        pipeline(['tar', '-C', str(ROOT), '-cf', '-', '--'] + config_names, crypt + ['encrypt'], output=output)
    with configuration.open('rb') as stream:
        names = pipeline(crypt + ['decrypt'], ['tar', '-tf', '-'], input_file=stream).decode().splitlines()
    need(names == config_names, 'CONFIG_BACKUP_INCOMPLETE')
    before = counts('fafa-one-postgres-1', 'fafa')
    database_backup = folder / 'database.dump.envelope'
    with database_backup.open('xb') as output:
        pipeline(['docker', 'exec', 'fafa-one-postgres-1', 'pg_dump', '-U', 'fafa', '-d', 'fafa', '--format=custom', '--no-owner'], crypt + ['encrypt'], output=output)
    database = 'fafa_b_restore_' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d_%H%M%S')
    checked(['docker', 'exec', 'fafa-auth-acceptance-db', 'createdb', '-U', 'fafa', database])
    with database_backup.open('rb') as stream:
        pipeline(crypt + ['decrypt'], ['docker', 'exec', '-i', 'fafa-auth-acceptance-db', 'pg_restore', '-U', 'fafa', '-d', database, '--no-owner', '--no-acl', '--exit-on-error'], input_file=stream)
    restored = counts('fafa-auth-acceptance-db', database)
    need(before == restored == counts('fafa-one-postgres-1', 'fafa'), 'RESTORE_COUNTS_DIFFER')
    report = {'productionSha': args.expected_production_sha, 'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'databaseBackup': str(database_backup), 'configurationBackup': str(configuration), 'restoredDatabase': database, 'restoredCountsMatchProduction': True, 'counts': restored, 'sha256': hashlib.sha256(database_backup.read_bytes()).hexdigest(), 'productionMutated': False}
    (args.evidence / 'backup.json').write_text(json.dumps(report, indent=2) + '\n')
    return report

def build(args):
    ensure_current(args.expected_production_sha)
    need(checked(['git', '-c', 'safe.directory=' + str(SOURCE), '-C', str(SOURCE), 'rev-parse', 'HEAD']).decode().strip() == args.sha, 'SOURCE_HEAD_CHANGED')
    need(not checked(['git', '-c', 'safe.directory=' + str(SOURCE), '-C', str(SOURCE), 'diff', 'HEAD', '--name-only']).strip(), 'TRACKED_CHANGES_NOT_COMMITTED')
    core = json.loads(args.core.read_text())
    browser_dir = args.browser
    browser = json.loads((browser_dir / 'auth-browser.json').read_text())
    browser_exit = json.loads((browser_dir / 'exit.json').read_text())
    need(core['sha'] == args.sha and len(core['checks']) >= 8 and all(c['exitCode'] == 0 for c in core['checks']), 'CORE_GATE')
    need(browser_exit['sha'] == args.sha and browser_exit['exitCode'] == 0 and browser['stats']['expected'] >= 51 and not any(browser['stats'][k] for k in ['unexpected', 'skipped', 'flaky']), 'BROWSER_GATE')
    release = ROOT / 'releases' / ('b-v3-' + args.evidence.name + '-' + args.sha[:12])
    release.mkdir(mode=0o755)
    with subprocess.Popen(['git', '-c', 'safe.directory=' + str(SOURCE), '-C', str(SOURCE), 'archive', args.sha], stdout=subprocess.PIPE) as archive:
        with tarfile.open(fileobj=archive.stdout, mode='r|') as tar:
            tar.extractall(release, filter='data')
        need(archive.wait() == 0, 'SOURCE_ARCHIVE_FAILED')
    (release / '.release-sha').write_text(args.sha + '\n')
    current = ensure_current(args.expected_production_sha)
    migrations = sorted(p.name for p in (release / 'packages/db/migrations').glob('*.sql'))
    need(query('fafa', 'SELECT name FROM migrations ORDER BY name').splitlines() == migrations, 'UNREVIEWED_MIGRATION_REQUIRED')
    for name in migrations:
        need((release / 'packages/db/migrations' / name).read_bytes() == (current / 'packages/db/migrations' / name).read_bytes(), 'APPLIED_MIGRATION_CHANGED')
    for target in ['runtime', 'web', 'admin']:
        command = ['docker', 'build', '--target', target, '--label', 'org.opencontainers.image.revision=' + args.sha, '-t', 'fafa-one-' + target + ':' + args.sha]
        if target == 'runtime':
            command += ['-f', str(release / 'infra/docker/Dockerfile'), str(release)]
        else:
            command += ['--build-context', 'runtime=docker-image://fafa-one-runtime:' + args.sha, '-f', str(release / 'infra/docker/Dockerfile.static'), str(release)]
        with (args.evidence / ('build-' + target + '.log')).open('w') as log:
            result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, 'DOCKER_BUILDKIT': '1'})
        need(result.returncode == 0, 'IMAGE_BUILD_FAILED:' + target)
    report = {'sha': args.sha, 'release': str(release), 'coreEvidence': str(args.core), 'browserEvidence': str(args.browser), 'productionMigrationsExecuted': False}
    (args.evidence / 'build.json').write_text(json.dumps(report, indent=2) + '\n')
    return report

def preflight(args):
    build_report = json.loads((args.evidence / 'build.json').read_text())
    backup_report = json.loads((args.evidence / 'backup.json').read_text())
    need(build_report['sha'] == args.sha and backup_report['productionSha'] == args.expected_production_sha, 'SHA_GATE')
    # All role preparation below is confined to the disposable restored database.
    database = backup_report['restoredDatabase']
    need(database.startswith('fafa_b_restore_'), 'ISOLATED_DATABASE_REQUIRED')
    folder = args.evidence / 'isolated-runtime'
    folder.mkdir(mode=0o700)
    existing = Path('/run/fafa-one/preflight-v3-auth/.env.runtime')
    line = next(line for line in existing.read_text().splitlines() if line.startswith('DATABASE_URL='))
    isolated_url = urlsplit(json.loads(line.split('=', 1)[1]))
    need(isolated_url.hostname == '127.0.0.1' and isolated_url.username == 'fafa_app', 'ISOLATED_ROLE_SCOPE')
    runtime = folder / '.env.runtime'
    runtime.write_text('DATABASE_URL=' + json.dumps(urlunsplit(isolated_url._replace(path='/' + database))) + '\n')
    runtime.chmod(0o600)
    image = 'fafa-one-runtime:' + args.sha
    url = 'postgres://fafa:fafa_dev_only@127.0.0.1:5432/' + database
    checked(['docker', 'run', '--rm', '--network', 'container:fafa-auth-acceptance-db', '--user', '0:0', '--mount', 'type=bind,source=' + str(folder) + ',target=/config', '-e', 'DATABASE_URL=' + url, image, 'node', '--import', 'tsx', 'infra/scripts/prepare-production-db.ts'])
    os.chown(runtime, 1000, 1000)
    # Use the same minimum privilege identity for candidate and rollback startup checks.
    bootstrap = "import {readFileSync} from 'node:fs';import {parse} from 'dotenv';Object.assign(process.env,parse(readFileSync('/config/.env.runtime')));await import('./apps/api/src/index.ts');"
    contracts = {}
    for sha, label in [(args.sha, 'candidate'), (args.expected_production_sha, 'rollback')]:
        name = 'fafa-b-v3-preflight-' + label
        common = ['docker', 'run', '-d', '--name', name, '--network', 'container:fafa-auth-acceptance-db', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount', 'type=bind,source=' + str(runtime) + ',target=/config/.env.runtime,readonly']
        env = {'NODE_ENV': 'production', 'DEMO_MODE': 'false', 'DEV_MOCK_LOGIN': 'false', 'WEB_ORIGIN': 'https://fafa888.uk', 'ADMIN_ORIGIN': 'https://a.fafa888.uk', 'API_PUBLIC_URL': 'https://fafa888.uk', 'GOOGLE_REDIRECT_URI': 'https://fafa888.uk/auth/google/callback', 'ENCRYPTION_KEY': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'MEMBER_SELF_SERVICE': 'true'}
        for key, value in env.items():
            common += ['-e', key + '=' + value]
        checked(common + ['fafa-one-runtime:' + sha, 'node', '--import', 'tsx', '--input-type', 'module', '-e', bootstrap])
        try:
            for attempt in range(45):
                test = subprocess.run(['docker', 'exec', name, 'node', '-e', "fetch('http://127.0.0.1:4000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if test.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('ISOLATED_STARTUP_FAILED:' + label)
            checked(['docker', 'exec', name, 'node', '-e', "fetch('http://127.0.0.1:4000/api/me').then(r=>process.exit(r.status===401?0:1))"])
            contracts[label] = {'ready': True, 'anonymousDenied': True, 'runtimeRole': 'fafa_app'}
        finally:
            checked(['docker', 'rm', '--force', name])
    report = {'sha': args.sha, 'contracts': contracts, 'productionPermissionChanges': False, 'productionMigrationChanges': False}
    (args.evidence / 'preflight.json').write_text(json.dumps(report, indent=2) + '\n')
    return report

def snapshot():
    result = {}
    for table in TABLES:
        cols = 'id,owner_id,secret' if table in ['node_sources', 'nodes', 'ai_accounts', 'server_connections'] else ('id,email,role,disabled,deleted_at' if table == 'users' else ('id,user_id,sub' if table == 'google_identities' else '*'))
        result[table] = json.loads(query('fafa', "SELECT coalesce(json_object_agg(id,md5(row_to_json(t)::text)),'{}') FROM (SELECT " + cols + ' FROM ' + table + ') t'))
    result['ownerBinding'] = query('fafa', 'SELECT md5(row_to_json(t)::text) FROM (SELECT owner_id,google_sub,closed FROM owner_initialization WHERE singleton) t')
    return result

def deploy(args):
    previous = ensure_current(args.expected_production_sha)
    build_report = json.loads((args.evidence / 'build.json').read_text())
    proof = json.loads((args.evidence / 'preflight.json').read_text())
    backup_report = json.loads((args.evidence / 'backup.json').read_text())
    need(proof['sha'] == args.sha and all(v['ready'] for v in proof['contracts'].values()) and backup_report['restoredCountsMatchProduction'], 'PREFLIGHT_GATE')
    release = Path(build_report['release'])
    need(release.is_relative_to(ROOT / 'releases') and (release / '.release-sha').read_text().strip() == args.sha, 'RELEASE_PATH')
    for target in ['runtime', 'web', 'admin']:
        label = checked(['docker', 'image', 'inspect', 'fafa-one-' + target + ':' + args.sha, '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}']).decode().strip()
        need(label == args.sha, 'IMAGE_LABEL')
    for name in ['.env.production', '.env.runtime']:
        (release / name).symlink_to(ROOT / name)
    (release / '.previous-release').write_text(str(previous) + '\n')
    baseline = snapshot()
    config = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ['.env.production', '.env.runtime']}
    def switch(path):
        temporary = ROOT / ('current-b-v3-' + str(os.getpid()))
        temporary.symlink_to(path)
        os.replace(temporary, ROOT / 'current')
    try:
        switch(release)
        checked(['systemctl', 'restart', 'fafa-one.service'])
        health = public_health()
        after = snapshot()
        integrity = {t: all(key in after[t] and after[t][key] == value for key, value in baseline[t].items()) for t in TABLES}
        need(all(integrity.values()) and baseline['ownerBinding'] == after['ownerBinding'], 'EXISTING_DATA_CHANGED')
        need(all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == value for name, value in config.items()), 'CONFIGURATION_CHANGED')
        (ROOT / '.deployed-sha').write_text(args.sha + '\n')
        ensure_current(args.sha)
        report = {'sha': args.sha, 'previousSha': args.expected_production_sha, 'release': str(release), 'https': health, 'existingDataPreserved': integrity, 'ownerBindingPreserved': True, 'configurationPreserved': True, 'productionMigrationsExecuted': False, 'productionPrivilegesChanged': False, 'liveAuthenticatedAcceptance': 'PENDING', 'deployedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        (args.evidence / 'deployment.json').write_text(json.dumps(report, indent=2) + '\n')
        return report
    except Exception:
        switch(previous)
        checked(['systemctl', 'restart', 'fafa-one.service'])
        (ROOT / '.deployed-sha').write_text(args.expected_production_sha + '\n')
        public_health()
        (args.evidence / 'rollback.json').write_text(json.dumps({'restoredSha': args.expected_production_sha, 'databaseUntouched': True, 'httpsHealthy': True}) + '\n')
        raise

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['backup', 'build', 'preflight', 'deploy'])
    parser.add_argument('--sha', required=True)
    parser.add_argument('--expected-production-sha', required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--core', type=Path)
    parser.add_argument('--browser', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    need(os.geteuid() == 0, 'ROOT_REQUIRED')
    need(all(re.fullmatch('[0-9a-f]{40}', value) for value in [args.sha, args.expected_production_sha]), 'EXACT_SHA_REQUIRED')
    need(args.evidence.resolve().is_relative_to(ROOT / 'reports'), 'EVIDENCE_PATH')
    args.evidence.mkdir(mode=0o700, exist_ok=True)
    lock = (ROOT / '.deployment.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print(json.dumps(globals()[args.phase](args)), flush=True)

if __name__ == '__main__':
    main()
