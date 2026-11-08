import datetime, hashlib, json, os, shutil, subprocess
from pathlib import Path

ROOT = Path('/opt/fafa-one')
EXPECTED = 'b4dd0cea3ad6c12214258b6cdd6cbca788e7aaa0'
TABLES = ['users','google_identities','node_sources','nodes','subscription_profiles','subscription_tokens','ai_accounts','server_connections']
def checked(args, **options):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, **options)
    if result.returncode:
        raise RuntimeError('BACKUP_STEP_FAILED:' + Path(args[0]).name + ':' + str(result.returncode))
    return result.stdout
def counts(container, database):
    query = 'SELECT json_build_object(' + ','.join("'" + t + "',(SELECT count(*) FROM " + t + ")" for t in TABLES) + ')'
    return json.loads(checked(['docker','exec',container,'psql','-U','fafa','-d',database,'-X','-Atc',query]))
def pipeline(first, second, output=None, input_file=None):
    a = subprocess.Popen(first, stdin=input_file if input_file else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    b = subprocess.Popen(second, stdin=a.stdout, stdout=output if output else subprocess.PIPE, stderr=subprocess.PIPE)
    a.stdout.close()
    data, errors = b.communicate()
    a.wait()
    if a.returncode or b.returncode:
        raise RuntimeError('BACKUP_PIPELINE_FAILED')
    return data

def main():
    os.umask(0o077)
    if os.geteuid() != 0: raise RuntimeError('ROOT_REQUIRED')
    if (ROOT/'.deployed-sha').read_text().strip() != EXPECTED: raise RuntimeError('PRODUCTION_ADVANCED')
    label = checked(['docker','inspect','fafa-auth-acceptance-db','--format','{{index .Config.Labels "fafa.validation"}}']).decode().strip()
    if label != 'ec2-auth-release': raise RuntimeError('ISOLATED_RESTORE_CONTAINER_REQUIRED')
    os.environ['IMAGE_TAG'] = EXPECTED
    compose = ['docker','compose','-p','fafa-one','--env-file',str(ROOT/'.env.production'),'-f',str(ROOT/'infra/docker/compose.production.yaml')]
    ops = compose + ['run','--rm','-T','--no-deps','ops','node','--max-old-space-size=2048','--import','tsx','infra/scripts/backup-envelope.ts']
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    folder = ROOT/'backups'/('before-selfservice-'+stamp)
    folder.mkdir(mode=0o700)
    archive = folder/'configuration.tar.envelope'
    with archive.open('xb') as stream:
        pipeline(['tar','-C',str(ROOT),'-cf','-','--','.env.production','.env.runtime','.deployed-sha','infra/docker/compose.production.yaml','infra/reverse-proxy/Caddyfile'],ops+['encrypt'],output=stream)
    with archive.open('rb') as stream:
        names = pipeline(ops+['decrypt'],['tar','-tf','-'],input_file=stream).decode().splitlines()
    if len(names) != 5: raise RuntimeError('CONFIG_ARCHIVE_INCOMPLETE')
    before = counts('fafa-one-postgres-1','fafa')
    checked(['bash',str(ROOT/'infra/scripts/backup-production.sh')])
    latest = max((ROOT/'backups').glob('fafa-*.dump.envelope'), key=lambda p:p.stat().st_mtime)
    backup = folder/'database.dump.envelope'
    shutil.copyfile(latest, backup)
    backup.chmod(0o600)
    database = 'fafa_restore_' + stamp.lower().replace('t','_').replace('z','')
    checked(['docker','exec','fafa-auth-acceptance-db','createdb','-U','fafa',database])
    with backup.open('rb') as stream:
        pipeline(ops+['decrypt'],['docker','exec','-i','fafa-auth-acceptance-db','pg_restore','-U','fafa','-d',database,'--no-owner','--no-acl','--exit-on-error'],input_file=stream)
    restored = counts('fafa-auth-acceptance-db',database)
    after = counts('fafa-one-postgres-1','fafa')
    if restored != before or restored != after: raise RuntimeError('LIVE_COUNTS_CHANGED_RECHECK_REQUIRED')
    report = {'verifiedAt':stamp,'productionSha':EXPECTED,'encryptedDatabaseBackup':str(backup),'encryptedConfigurationBackup':str(archive),'configurationMembersVerified':len(names),'restoredIntoIsolatedContainer':'fafa-auth-acceptance-db','restoredDatabase':database,'tableCounts':restored,'restoredCountsMatchProduction':True,'databaseBackupSha256':hashlib.sha256(backup.read_bytes()).hexdigest(),'productionDataChanged':False}
    reports = ROOT/'reports'
    reports.mkdir(mode=0o750,exist_ok=True)
    (reports/'pre-release-backup.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'backupVerified':False,'errorType':type(error).__name__,'reason':str(error) if isinstance(error,RuntimeError) else 'REDACTED'}))
        raise SystemExit(1)
