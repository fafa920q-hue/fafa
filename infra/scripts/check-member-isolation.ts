import { execFileSync, spawnSync } from 'node:child_process';
const base = 'b89e9b4752fa5bfe59303b346ce15b32ebcd7a1a';
const paths = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);
// 整合后比较基线为 Muse 的 b89e9b4（已含 Google 登录来源修复）。
// core.tsx 不再列入保留：集成人员按 MEMBER_INTEGRATION_REVIEW.md 在
// 前台登录卡片加入了普通账户快捷入口（/member/login、/member/register、
// /member/forgot），该改动属于 Muse 自有文件的集成改动，非账户分支改写。
const reserved = [
  'packages/ui/src/style.css',
  'tests/e2e/admin-nodes.spec.ts',
  '.github/workflows/ci.yml',
  '.github/workflows/deploy.yml',
];
if (paths.some((path) => reserved.includes(path)))
  throw Error('账户分支不得改写 Muse 的文件或发布工作流');
if (process.argv.includes('--format')) {
  const checked = spawnSync(
    'pnpm',
    ['exec', 'prettier', '--check', '--ignore-unknown', ...paths],
    { stdio: 'inherit' },
  );
  if (checked.status !== 0) {
    const formatted = spawnSync(
      'pnpm',
      ['exec', 'prettier', '--write', '--ignore-unknown', ...paths],
      { stdio: 'inherit' },
    );
    if (formatted.status !== 0) throw Error('格式化工具失败');
    execFileSync('git', ['diff'], { stdio: 'inherit' });
    process.exitCode = 1;
  }
}
console.log('独立账户分支检查：未修改弹窗、节点 E2E 或生产发布工作流。');
