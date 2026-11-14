import 'dotenv/config';
import { spawn } from 'node:child_process';
const children = [
  ['tsx', 'watch', 'apps/api/src/index.ts'],
  ['tsx', 'apps/worker/src/index.ts'],
  ['vite', '--config', 'apps/web/vite.config.ts', '--host', '0.0.0.0'],
  ['vite', '--config', 'apps/admin/vite.config.ts', '--host', '0.0.0.0'],
].map((args) =>
  spawn('pnpm', ['exec', ...args], { stdio: 'inherit', env: process.env }),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((c) => c.kill('SIGTERM'));
  setTimeout(() => process.exit(code), 300);
}
children.forEach((c) =>
  c.on('exit', (code) => {
    if (!stopping) stop(code || 0);
  }),
);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
