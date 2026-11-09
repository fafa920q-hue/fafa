"""Run an owner-operated Codex CLI device login in a disposable EC2 lab."""

import argparse
from datetime import datetime, timezone
import hmac
import ipaddress
import json
import os
from pathlib import Path
import queue
import select
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import uuid


IMAGE = 'mcr.microsoft.com/playwright:v1.64.1-noble'
CLI = '/usr/local/bin/codex'
LOGIN_HOST = 'auth.openai.com'
RUN_UID = 10001
EVIDENCE = Path('/opt/fafa-one/development/codex-device-lab-results')


class LoginProxy(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Request and exception text can include sensitive connection details.
        pass


class ConnectLoginHost(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(12)
        line = self.rfile.readline(256).split()
        if line not in (
            [b'CONNECT', b'auth.openai.com:443', b'HTTP/1.1'],
            [b'CONNECT', b'auth.openai.com:443', b'HTTP/1.0'],
        ):
            self.connection.sendall(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
            return
        for _ in range(32):
            header = self.rfile.readline(4096)
            if header == b'\r\n':
                break
            if not header.endswith(b'\r\n'):
                return
        else:
            return

        addresses = socket.getaddrinfo(LOGIN_HOST, 443, type=socket.SOCK_STREAM)
        public = next(
            (address for _, _, _, _, address in addresses
             if ipaddress.ip_address(address[0]).is_global),
            None,
        )
        if public is None:
            return
        with socket.create_connection(public[:2], timeout=12) as upstream:
            self.connection.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
            peers = {self.connection: upstream, upstream: self.connection}
            while True:
                ready, _, _ = select.select(list(peers), [], [], 45)
                if not ready:
                    return
                for peer in ready:
                    data = peer.recv(65536)
                    if not data:
                        return
                    peers[peer].sendall(data)


RELAY = r'''
const net = require('node:net');
const fs = require('node:fs');
const relay = net.createServer(client => {
  const upstream = net.createConnection('/egress/auth.sock');
  for (const [a, b] of [[client, upstream], [upstream, client]]) {
    a.on('error', () => b.destroy());
    a.on('close', () => b.destroy());
    a.pipe(b);
  }
});
relay.listen(18080, '127.0.0.1', () => fs.writeFileSync('/tmp/relay-ready', '1'));
'''


CONTAINER_STEPS = r'''
set -eu
umask 077
export RUST_LOG=off
export HTTPS_PROXY=http://127.0.0.1:18080
export HTTP_PROXY=$HTTPS_PROXY
export ALL_PROXY=$HTTPS_PROXY
export NO_PROXY=127.0.0.1,localhost
ln -s /dev/null /tmp/codex-login.log
node -e "$1" >/dev/null 2>&1 &
relay=$!
trap 'kill "$relay" 2>/dev/null || true' EXIT
for attempt in $(seq 1 40); do
  test ! -e /tmp/relay-ready || break
  sleep 0.1
done
test -e /tmp/relay-ready
cli=/usr/local/bin/codex
signed_out() {
  result="$("$cli" login status 2>&1)" && return 1
  printf '%s' "$result" | grep -qi 'not logged in'
}
case "$2" in
  preflight)
    curl --silent --show-error --max-time 15 --output /dev/null https://auth.openai.com/codex/device
    if curl --silent --max-time 5 --output /dev/null https://169.254.169.254/; then
      exit 41
    fi
    signed_out
    printf '%s\n' 'PASS official HTTPS, rejected off-list host, signed-out status'
    ;;
  login)
    signed_out
    printf '%s\n' '只在这个终端查看一次性验证码。请到 CLI 显示的 OpenAI 官网完成授权。'
    "$cli" login --device-auth
    ;;
  identity)
    exec "$cli" app-server --stdio
    ;;
  logged-in)
    result="$("$cli" login status 2>&1)"
    printf '%s' "$result" | grep -qi 'logged in using chatgpt'
    ;;
  logged-out)
    signed_out
    ;;
  logout)
    "$cli" logout >/dev/null 2>&1
    signed_out
    ;;
  *) exit 42 ;;
esac
'''


def container_command(binary, home, workspace, proxy, mode, run_id):
    command = [
        'docker', 'run', '--rm', '--pull=never', '--network=none',
        '--log-driver=none', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--read-only',
        f'--user={RUN_UID}:{RUN_UID}', '--pids-limit=64', '--memory=384m',
        '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777', '--workdir=/workspace',
        '--env=HOME=/home/codex', '--env=CODEX_HOME=/home/codex',
        '--name', run_id,
        '--mount', f'type=bind,source={binary},target={CLI},readonly',
        '--mount', f'type=bind,source={home},target=/home/codex',
        '--mount', f'type=bind,source={workspace},target=/workspace',
        '--mount', f'type=bind,source={proxy},target=/egress/auth.sock,readonly',
    ]
    if mode == 'login':
        command += ['-it']
    elif mode == 'identity':
        command += ['-i']
    return command + [IMAGE, 'sh', '-ec', CONTAINER_STEPS, 'codex-lab', RELAY, mode]


def stop_container(name):
    subprocess.run(
        ['docker', 'stop', '-t', '2', name],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        check=False, timeout=10,
    )


def run_container(command, mode, name):
    try:
        return subprocess.run(command, timeout=960 if mode == 'login' else 40).returncode == 0
    except subprocess.TimeoutExpired:
        stop_container(name)
        return False


def prepare_profile(root, name):
    home = root / (name + '-home')
    workspace = root / (name + '-workspace')
    for folder in (home, workspace):
        folder.mkdir(mode=0o700)
        os.chown(folder, RUN_UID, RUN_UID)
    config = home / 'config.toml'
    config.write_text('cli_auth_credentials_store = "file"\nlog_dir = "/tmp"\n')
    config.chmod(0o600)
    os.chown(config, RUN_UID, RUN_UID)
    return home, workspace


def account_fingerprint(command, name, key):
    responses = queue.Queue()
    with subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, bufsize=1,
    ) as child:
        def read_responses():
            for line in child.stdout:
                try:
                    responses.put(json.loads(line))
                except ValueError:
                    responses.put(None)
                    return
            responses.put(None)

        threading.Thread(target=read_responses, daemon=True).start()

        def exchange(method, params=None, request_id=None):
            request = {'method': method}
            if params is not None:
                request['params'] = params
            if request_id is not None:
                request['id'] = request_id
            child.stdin.write(json.dumps(request) + '\n')
            child.stdin.flush()
            if request_id is None:
                return None
            while (response := responses.get(timeout=15)) is not None:
                if response.get('id') == request_id:
                    return response.get('result')
            return None

        try:
            exchange('initialize', {'clientInfo': {'name': 'fafa_login_lab', 'version': '1.0.0'}}, 1)
            exchange('initialized')
            result = exchange('account/read', {'refreshToken': False}, 2) or {}
            account = result.get('account') or {}
            email = account.get('email')
            if account.get('type') != 'chatgpt' or not isinstance(email, str) or not email:
                return None
            return hmac.digest(key, email.strip().lower().encode(), 'sha256')
        except (BrokenPipeError, queue.Empty):
            return None
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                stop_container(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--preflight', action='store_true')
    parser.add_argument('--profiles', type=int, choices=(1, 2), default=2)
    args = parser.parse_args()
    if not args.preflight and not all(stream.isatty() for stream in (sys.stdin, sys.stdout, sys.stderr)):
        parser.error('Live login requires the account holder’s private interactive terminal.')
    binary = args.binary.resolve(strict=True)
    os.umask(0o077)
    run_id = uuid.uuid4().hex[:12]
    result = {'runId': run_id, 'mode': 'preflight' if args.preflight else 'live',
              'startedAt': datetime.now(timezone.utc).isoformat(), 'checks': {}}
    success = False
    with tempfile.TemporaryDirectory(prefix='fafa-codex-device-', dir='/dev/shm') as tmp:
        root = Path(tmp)
        proxy_path = root / 'auth.sock'
        profiles = {label: prepare_profile(root, label) for label in ('A', 'B')}
        with LoginProxy(str(proxy_path), ConnectLoginHost) as proxy:
            os.chown(proxy_path, RUN_UID, RUN_UID)
            os.chmod(proxy_path, 0o600)
            threading.Thread(target=proxy.serve_forever, daemon=True).start()

            def command(label, mode):
                name = f'fafa-device-{run_id}-{label.lower()}-{mode}'
                home, work = profiles[label]
                return container_command(binary, home, work, proxy_path, mode, name), name

            def run(label, mode):
                cmd, name = command(label, mode)
                return run_container(cmd, mode, name)

            def require(check, actual):
                result['checks'][check] = bool(actual)
                if not actual:
                    raise RuntimeError(check)
                print('PASS', check, flush=True)

            attempted = []
            logged_out = set()
            try:
                require('official_https_and_isolation', run('A', 'preflight'))
                if not args.preflight:
                    print('验收编号', run_id, flush=True)
                    print('账户 A 登录', flush=True)
                    attempted.append('A')
                    require('a_device_login', run('A', 'login'))
                    require('a_chatgpt_status_after_recreate', run('A', 'logged-in'))
                    require('b_stays_signed_out', run('B', 'logged-out'))
                    if args.profiles == 2:
                        print('账户 B 登录。请使用另一个 ChatGPT 账户。', flush=True)
                        attempted.append('B')
                        require('b_device_login', run('B', 'login'))
                        require('b_chatgpt_status_after_recreate', run('B', 'logged-in'))
                        secret = os.urandom(32)
                        a_cmd, a_name = command('A', 'identity')
                        b_cmd, b_name = command('B', 'identity')
                        a = account_fingerprint(a_cmd, a_name, secret)
                        b = account_fingerprint(b_cmd, b_name, secret)
                        require('distinct_chatgpt_accounts', bool(a and b and not hmac.compare_digest(a, b)))
                    require('a_logout', run('A', 'logout'))
                    logged_out.add('A')
                    require('a_signed_out_after_recreate', run('A', 'logged-out'))
                    if args.profiles == 2:
                        require('b_stays_signed_in_after_a_logout', run('B', 'logged-in'))
                        require('b_logout', run('B', 'logout'))
                        logged_out.add('B')
                        require('b_signed_out_after_recreate', run('B', 'logged-out'))
                success = True
            except RuntimeError:
                print('验收中止。请查看终端上方的官方登录提示。', flush=True)
            except KeyboardInterrupt:
                print('验收已由操作者中止。', flush=True)
            finally:
                for label in attempted:
                    if label not in logged_out and run(label, 'logged-in'):
                        result['checks'][label.lower() + '_cleanup_logout'] = run(label, 'logout')
                proxy.shutdown()
    result['finishedAt'] = datetime.now(timezone.utc).isoformat()
    result['passed'] = success
    EVIDENCE.mkdir(mode=0o700, exist_ok=True)
    with (EVIDENCE / (run_id + '.json')).open('x') as report:
        json.dump(result, report, indent=2)
        report.write('\n')
    print('验收记录编号', run_id, flush=True)
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
