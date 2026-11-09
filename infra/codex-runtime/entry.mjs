import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const bridge = createServer((req, res) => {
  const upstream = request(
    {
      socketPath: '/model.sock',
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (result) => {
      res.writeHead(result.statusCode, result.headers);
      result.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
});
await new Promise((resolve) => bridge.listen(39887, '127.0.0.1', resolve));

const home = '/tmp/codex-home';
await mkdir(home, { mode: 0o700 });
await writeFile(
  home + '/config.toml',
  `model_provider = "fafa"
model = ${JSON.stringify(process.env.FAFA_MODEL)}
model_context_window = ${Number(process.env.FAFA_CONTEXT)}
model_auto_compact_token_limit = ${Number(process.env.FAFA_CONTEXT) - 1024}
web_search = "disabled"
sandbox_mode = "read-only"
approval_policy = "never"
project_doc_max_bytes = 0
[features]
shell_tool = false
unified_exec = false
multi_agent = false
multi_agent_v2 = false
[model_providers.fafa]
name = "FAFA model broker"
base_url = "http://127.0.0.1:39887/v1"
env_key = "FAFA_LOCAL_AUTH"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[mcp_servers.workspace]
command = "node"
args = ["/runtime/files.mjs"]
required = true
startup_timeout_sec = 10
tool_timeout_sec = 30
`,
  { mode: 0o600 },
);
const codex = spawn(
  '/bin/fafa-codex',
  [
    '--ask-for-approval',
    'never',
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-C',
    '/workspace',
    '-',
  ],
  {
    stdio: 'inherit',
    env: {
      PATH: process.env.PATH,
      HOME: '/tmp',
      CODEX_HOME: home,
      FAFA_LOCAL_AUTH: 'local-broker',
      TERM: 'dumb',
    },
  },
);
codex.once('error', () => process.exit(1));
codex.once('exit', (code) => {
  bridge.closeAllConnections();
  bridge.close();
  process.exitCode = code ?? 1;
});
