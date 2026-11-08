import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import {
  boundNodeManagementEvidence,
  splitBrowserChecks,
} from './browser-ci-contract';
const base = 'b4dd0cea3ad6c12214258b6cdd6cbca788e7aaa0';
const paths = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);
// 变基后比较基线为生产 b4dd0cea（已含 WLOC 与 Google 登录来源修复）。
// core.tsx 不再列入保留：集成人员按 MEMBER_INTEGRATION_REVIEW.md 在
// 前台登录卡片加入了普通账户快捷入口（/member/login、/member/register、
// /member/forgot），该改动属于 Muse 自有文件的集成改动，非账户分支改写。
const reserved = ['packages/ui/src/style.css', '.github/workflows/deploy.yml'];
if (paths.some((path) => reserved.includes(path)))
  throw Error('账户分支不得改写 Muse 的文件或发布工作流');
if (paths.includes('.github/workflows/ci.yml')) {
  const baseline = parse(
    execFileSync('git', ['show', base + ':.github/workflows/ci.yml'], {
      encoding: 'utf8',
    }),
  );
  const current = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  if (!isDeepStrictEqual(current, splitBrowserChecks(baseline)))
    throw Error('主CI仅允许已审核的独立浏览器矩阵拆分，不能改变测试或发布门禁');
}
if (paths.includes('tests/e2e/admin-nodes.spec.ts')) {
  const baseline = execFileSync(
    'git',
    ['show', base + ':tests/e2e/admin-nodes.spec.ts'],
    { encoding: 'utf8' },
  );
  if (
    readFileSync('tests/e2e/admin-nodes.spec.ts', 'utf8') !==
    boundNodeManagementEvidence(baseline)
  )
    throw Error('节点E2E仅允许限制非断言截图的成本，不能改变任何测试断言');
}
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
console.log(
  '独立检查：保留全部节点断言与生产发布工作流；仅允许精确审核的CI拆分和证据截图配置。',
);
