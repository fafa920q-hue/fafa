import { execFileSync, spawnSync } from 'node:child_process';
const base = '7ee1c7b97d6abfd95bf261b99b8242c5aeae203c';
const paths = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const reserved = [
  'packages/ui/src/core.tsx', 'packages/ui/src/style.css',
  'tests/e2e/admin-nodes.spec.ts', '.github/workflows/ci.yml',
  '.github/workflows/deploy.yml',
];
if (paths.some((path) => reserved.includes(path))) throw Error('账户分支不得改写 Muse 的文件或发布工作流');
if (process.argv.includes('--format')) {
  const checked = spawnSync('pnpm', ['exec', 'prettier', '--check', '--ignore-unknown', ...paths], { stdio: 'inherit' });
  if (checked.status !== 0) {
    const formatted = spawnSync('pnpm', ['exec', 'prettier', '--write', '--ignore-unknown', ...paths], { stdio: 'inherit' });
    if (formatted.status !== 0) throw Error('格式化工具失败');
    execFileSync('git', ['diff'], { stdio: 'inherit' });
    process.exitCode = 1;
  }
}
console.log('独立账户分支检查：未修改弹窗、节点 E2E 或生产发布工作流。');
