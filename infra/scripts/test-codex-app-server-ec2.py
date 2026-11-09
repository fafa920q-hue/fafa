"""Verify two isolated Codex profiles using the official CLI and offline App Server."""

import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading


def docker_profile(binary, home, workspace):
    return [
        'docker', 'run', '--rm', '--pull=never',
        '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--read-only', '--user=10001:10001', '--pids-limit=64', '--memory=384m',
        '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777',
        '--env=HOME=/home/codex', '--env=CODEX_HOME=/home/codex',
        '--workdir=/workspace',
        '--mount', f'type=bind,source={binary},target=/usr/local/bin/codex,readonly',
        '--mount', f'type=bind,source={home},target=/home/codex',
        '--mount', f'type=bind,source={workspace},target=/workspace',
    ]


IMAGE = 'mcr.microsoft.com/playwright:v1.64.1-noble'
CLI = '/usr/local/bin/codex'


def check_app_server(profile, name):
    command = profile + ['-i', '--name', name, IMAGE, CLI, 'app-server', '--stdio']
    messages = queue.Queue()
    with subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, bufsize=1,
    ) as process:
        def read_messages():
            for line in process.stdout:
                messages.put(json.loads(line))
            messages.put(None)

        threading.Thread(target=read_messages, daemon=True).start()

        def send(method, params=None, request_id=None):
            request = {'method': method}
            if params is not None:
                request['params'] = params
            if request_id is not None:
                request['id'] = request_id
            process.stdin.write(json.dumps(request) + '\n')
            process.stdin.flush()
            if request_id is None:
                return None
            while (response := messages.get(timeout=15)) is not None:
                if response.get('id') == request_id:
                    if 'result' not in response:
                        raise RuntimeError(f'{method}: RPC rejected')
                    return response['result']
            raise RuntimeError(f'{method}: App Server exited')

        try:
            send('initialize', {'clientInfo': {'name': 'fafa_offline_smoke', 'version': '1.0.0'}}, 1)
            send('initialized')
            account = send('account/read', {'refreshToken': False}, 2)
            if account.get('account') is not None:
                raise RuntimeError('ISOLATION_FAILED: inherited account')
            thread = send('thread/start', {
                'cwd': '/workspace', 'approvalPolicy': 'never', 'sandbox': 'read-only',
            }, 3)
            thread_id = thread.get('thread', {}).get('id')
            if not thread_id:
                raise RuntimeError('THREAD_NOT_CREATED')
            return thread_id
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                subprocess.run(['docker', 'stop', '-t', '2', name], check=False, stdout=subprocess.DEVNULL)


def check_profile(profile, identity, other):
    probe = profile + [
        IMAGE, 'sh', '-ec',
        'test "$(cat /home/codex/.profile-id)" = "$1"; '
        'test -f "/workspace/$1"; test ! -e "/workspace/$2"; '
        'test ! -e "/home/codex/$2"; test ! -e /var/run/docker.sock; '
        'test ! -e /opt/fafa-one/source',
        'isolation-probe', identity, other,
    ]
    subprocess.run(probe, check=True, timeout=20, stdout=subprocess.DEVNULL)
    status = subprocess.run(
        profile + [IMAGE, CLI, 'login', 'status'],
        capture_output=True, text=True, timeout=25,
    )
    if status.returncode != 1 or 'not logged in' not in (status.stdout + status.stderr).lower():
        raise RuntimeError('EXPECTED_ISOLATED_SIGNED_OUT_STATUS')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='fafa-codex-profile-test-') as tmp:
        root = Path(tmp)
        ids = ('test-profile-a', 'test-profile-b')
        threads = set()
        for identity, other in (ids, ids[::-1]):
            home = root / (identity + '-home')
            work = root / (identity + '-work')
            for folder in (home, work):
                folder.mkdir(mode=0o700)
                os.chown(folder, 10001, 10001)
            for marker in (home / '.profile-id', home / identity, work / identity):
                marker.write_text(identity + '\n')
                marker.chmod(0o600)
                os.chown(marker, 10001, 10001)
            profile = docker_profile(binary, home, work)
            check_profile(profile, identity, other)
            threads.add(check_app_server(profile, f'fafa-codex-offline-{os.getpid()}-{identity}'))
            check_profile(profile, identity, other)
            print('PASS', identity, 'isolated workspace and home, official signed-out status across restarts')
        if len(threads) != len(ids):
            raise RuntimeError('EXPECTED_DISTINCT_APP_SERVER_THREADS')
        print('PASS two independent official App Server processes and restricted threads')


if __name__ == '__main__':
    main()
