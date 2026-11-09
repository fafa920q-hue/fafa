"""Exercise the official local App Server in an empty, offline EC2 container."""

import argparse
import json
from pathlib import Path
import queue
import subprocess
import threading


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    image = 'mcr.microsoft.com/playwright:v1.64.1-noble'
    name = 'fafa-codex-offline-smoke'
    command = [
        'docker', 'run', '--rm', '-i', '--name', name, '--pull=never',
        '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--read-only', '--user=10001:10001', '--pids-limit=64', '--memory=384m',
        '--tmpfs=/home/codex:rw,nosuid,nodev,mode=700,uid=10001,gid=10001',
        '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777',
        '--tmpfs=/workspace:rw,nosuid,nodev,mode=700,uid=10001,gid=10001',
        '--env=HOME=/home/codex', '--env=CODEX_HOME=/home/codex',
        '--workdir=/workspace',
        '--mount', f'type=bind,source={binary},target=/usr/local/bin/codex,readonly',
        image, '/usr/local/bin/codex', 'app-server', '--stdio',
    ]
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
            if not thread.get('thread', {}).get('id'):
                raise RuntimeError('THREAD_NOT_CREATED')
            print('PASS initialize, independent signed-out account, restricted thread creation')
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                subprocess.run(['docker', 'stop', '-t', '2', name], check=False, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
