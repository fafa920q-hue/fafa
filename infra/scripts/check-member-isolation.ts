import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import {
  boundNodeManagementEvidence,
  splitBrowserChecks,
} from './browser-ci-contract';
const base = '7deadc88a31003ffa10ca9b1240a4288bb5b6f48';
const paths = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);
// 比較基線為生產基線 7deadc88（實際部署的生產提交）。
// 舊基線 b4dd0cea 早於生產基線，會把生產自身的設計落地誤判為成員分支改動。
// core.tsx 不再列入保留：集成人员按 MEMBER_INTEGRATION_REVIEW.md 在
// 前台登录卡片加入了普通账户快捷入口（/member/login、/member/register、
// /member/forgot），该改动属于 Muse 自有文件的集成改动，非账户分支改写。
// style.css 不再列入保留：它是共用的设计系统文件，阶段 D/E 的设计工作合法修改它；
// deploy.yml 仍受保护，发布工作流不得改写。
const reserved = ['.github/workflows/deploy.yml'];
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
  // 2026-11-13 用户授权：成员节点管理以中介层 403 为准，PATCH /api/nodes 与
  // DELETE /api/node_sources 的两处断言由 404 改为 403；除此两处外不允许改动断言。
  // Baseline lines 261 and 264 (1-based) hold the authorised 404s;
  // locate them by api call, then verify the lines before allowing 403.
  const adminNodeLines = boundNodeManagementEvidence(baseline).split('\n');
  const patchCall = adminNodeLines.findIndex((line) =>
    line.includes("'/api/nodes/' + importedNodes[0].id, 'PATCH'"),
  );
  const deleteCall = adminNodeLines.findIndex((line) =>
    line.includes("'/api/node_sources/' + sourceId, 'DELETE'"),
  );
  const patchAssert = patchCall + 4;
  const deleteAssert = deleteCall + 1;
  const baselineChanged =
    patchCall < 0 ||
    deleteCall < 0 ||
    adminNodeLines[patchAssert]?.trim() !== ').toBe(404);' ||
    adminNodeLines[deleteAssert]?.trim() !== ').toBe(404);';
  if (baselineChanged) throw Error('节点证据基线发生变化，需重新审核');
  const patchLine = adminNodeLines[patchAssert];
  adminNodeLines[patchAssert] = patchLine.replace('404', '403');
  const deleteLine = adminNodeLines[deleteAssert];
  adminNodeLines[deleteAssert] = deleteLine.replace('404', '403');
  const allowedAdminNodes = adminNodeLines.join('\n');
  if (
    readFileSync('tests/e2e/admin-nodes.spec.ts', 'utf8') !== allowedAdminNodes
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
