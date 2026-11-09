import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const runtimeFiles = fileURLToPath(
  new URL('../../../infra/codex-runtime', import.meta.url),
);
const cli = () =>
  process.env.CODEX_RUNNER_SUDO === 'true'
    ? { file: '/usr/bin/sudo', prefix: ['-n', '/usr/bin/docker'] }
    : { file: '/usr/bin/docker', prefix: [] };

export async function docker(args: string[], signal?: AbortSignal) {
  const { file, prefix } = cli();
  const result = await exec(file, [...prefix, ...args], {
    signal,
    timeout: 30000,
    maxBuffer: 100_000,
  });
  return result.stdout.trim();
}
export function runtimeConfiguration() {
  const binary = process.env.CODEX_RUNNER_BINARY || '';
  const image = process.env.CODEX_RUNNER_IMAGE || '';
  const namespace = process.env.CODEX_RUNNER_NAMESPACE || '';
  if (
    !binary.startsWith('/') ||
    /[,\r\n]/.test(binary) ||
    !/^sha256:[0-9a-f]{64}$/.test(image) ||
    !/^[a-z0-9][a-z0-9-]{4,40}$/.test(namespace) ||
    !process.getuid?.() ||
    !process.getgid?.()
  )
    throw Error('CODEX_RUNTIME_CONFIGURATION');
  return { binary, image, namespace };
}
export async function verifyRuntime() {
  const c = runtimeConfiguration();
  await access(c.binary);
  await docker(['image', 'inspect', c.image]);
  const { stdout } = await exec(c.binary, ['--version'], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      CODEX_HOME: '/nonexistent',
    },
    timeout: 5000,
    maxBuffer: 10000,
  });
  if (!/^codex-cli 0\.167\.0\s*$/.test(stdout))
    throw Error('CODEX_RUNTIME_VERSION');
  return c;
}
export const label = (namespace: string) =>
  'com.fafa.codex-runner=' + namespace;
const bind = (src: string, dst: string, readonly: boolean) => [
  '--mount',
  'type=bind,src=' + src + ',dst=' + dst + (readonly ? ',readonly' : ''),
];
const containerId = (id: string) => /^[0-9a-f]{64}$/.test(id);
export async function createContainer(options: {
  workspace: string;
  name: string;
  recipe: 'CODEX' | 'NODE_TEST';
  socket?: string;
  model?: string;
  context?: number;
}) {
  const c = runtimeConfiguration();
  const code = options.recipe === 'CODEX';
  if (code && (!options.socket || !options.model || !options.context))
    throw Error('CODEX_RUNTIME_CONFIGURATION');
  const args = [
    'create',
    '--pull=never',
    '--name',
    options.name,
    '--label',
    label(c.namespace),
    '--read-only',
    '--network',
    'none',
    '--ipc',
    'private',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '96',
    '--memory',
    '768m',
    '--memory-swap',
    '768m',
    '--cpus',
    '0.75',
    '--ulimit',
    'nofile=256:256',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777',
    '--user',
    process.getuid!() + ':' + process.getgid!(),
    '--init',
    '--interactive',
    '--workdir',
    '/workspace',
    '--env',
    'HOME=/tmp',
    '--log-driver',
    'none',
    ...bind(options.workspace, '/workspace', !code),
  ];
  if (code)
    args.push(
      ...bind(runtimeFiles, '/runtime', true),
      ...bind(c.binary, '/bin/fafa-codex', true),
      ...bind(options.socket!, '/model.sock', true),
      '--env',
      'FAFA_MODEL=' + options.model,
      '--env',
      'FAFA_CONTEXT=' + Math.max(4096, options.context!),
    );
  args.push(
    '--entrypoint',
    'node',
    c.image,
    ...(code ? ['/runtime/entry.mjs'] : ['--test']),
  );
  const id = await docker(args);
  if (!containerId(id)) throw Error('CODEX_CONTAINER_ID');
  return id;
}
export async function destroyContainer(id: string) {
  if (containerId(id)) await docker(['rm', '-f', id]).catch(() => {});
}
export async function clearNamespace(namespace: string) {
  const ids = await docker([
    'ps',
    '-aq',
    '--no-trunc',
    '--filter',
    'label=' + label(namespace),
  ]);
  for (const id of ids.split('\n')) if (id) await destroyContainer(id);
}
export function runContainer(
  id: string,
  input: string,
  signal: AbortSignal,
  onOutput: (chunk: string) => void,
) {
  if (!containerId(id)) throw Error('CODEX_CONTAINER_ID');
  const { file, prefix } = cli();
  return new Promise<number>((resolve, reject) => {
    const child = spawn(file, [...prefix, 'start', '-a', '-i', id], {
      signal,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.stdout.setEncoding('utf8');
    let seen = 0;
    child.stdout.on('data', (chunk: string) => {
      seen += Buffer.byteLength(chunk);
      if (seen < 192_000) onOutput(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}
