"""Stage a caller-authorized AWS credential in tmpfs, without displaying its value."""
import argparse
import json
import os
import re
import stat
import sys
from pathlib import Path


def read_secret(args, client):
    if args.store == 'ssm':
        response = client.get_parameter(Name=args.reference, WithDecryption=True)
        if response['Parameter']['Type'] != 'SecureString':
            raise RuntimeError('SECURESTRING_REQUIRED')
        value = response['Parameter']['Value']
    else:
        response = client.get_secret_value(SecretId=args.reference, VersionStage='AWSCURRENT')
        value = response.get('SecretString', '')
    if args.store == 'secretsmanager' or value.startswith('{'):
        value = json.loads(value).get('RESEND_API_KEY', '')
    if not isinstance(value, str) or not re.fullmatch(r'\S{16,4096}', value):
        raise RuntimeError('INVALID_SECRET_FORMAT')
    return value


def stage(args, client):
    # Refuse ordinary disks, symlinks, arbitrary output paths, and non-root runs.
    target = Path('/run/fafa-one/secrets/resend_api_key')
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('ROOT_LINUX_REQUIRED')
    mounts = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left, right = line.split(' - ', 1)
        mount = left.split()[4]
        if str(target).startswith(mount.rstrip('/') + '/'):
            mounts.append((len(mount), right.split()[0]))
    if not mounts or max(mounts)[1] != 'tmpfs':
        raise RuntimeError('TMPFS_REQUIRED')
    for folder in [Path('/run/fafa-one'), target.parent]:
        try:
            folder.mkdir(mode=0o700)
        except FileExistsError:
            pass
        info = folder.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise RuntimeError('UNSAFE_SECRET_DIRECTORY')
    if target.exists() or target.is_symlink():
        raise RuntimeError('EXISTING_SECRET_PRESERVED')
    value = read_secret(args, client)
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o400)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write(value)
            out.flush()
            os.fsync(out.fileno())
        os.chown(target, 1000, 1000)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return {'staged': True, 'store': args.store, 'file': str(target), 'ordinaryEnvWritten': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', choices=['ssm', 'secretsmanager'], required=True)
    parser.add_argument('--reference', required=True)
    parser.add_argument('--region', default='us-east-2')
    args = parser.parse_args()
    try:
        import boto3
        from botocore.config import Config
        client = boto3.client(args.store, region_name=args.region, config=Config(connect_timeout=3, read_timeout=5, retries={'max_attempts': 0}))
        print(json.dumps(stage(args, client)))
    except Exception as error:
        # Do not serialize SDK error bodies, exception messages or secret responses.
        print(json.dumps({'staged': False, 'errorType': type(error).__name__}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
