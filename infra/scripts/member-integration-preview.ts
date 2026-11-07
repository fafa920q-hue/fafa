import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const branch = 'refs/remotes/origin/feat/fafa-one-control-panel';
const run = (args: string[]) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1048576 });
const resolve = (ref: string) => {
  const result = run(['rev-parse', '--verify', ref + '^{commit}']);
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout.trim()))
    throw Error('集成目标不可读取；不修改分支');
  return result.stdout.trim();
};
const head = resolve('HEAD');
const target = resolve(branch);
const base = run(['merge-base', head, target]).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(base)) throw Error('没有共同基线');
const preview = run(['merge-tree', '--write-tree', head, target]);
if (![0, 1].includes(preview.status ?? -1)) throw Error('只读合并预览失败');
const conflicts = [...new Set(preview.stdout.split('\n')
  .filter((line) => /^[0-7]{6} [0-9a-f]{40} [123]\t/.test(line))
  .map((line) => line.slice(line.indexOf('\t') + 1)))];
const report = {
  accountSha: head, observedMuseSha: target, commonBase: base,
  cleanMerge: preview.status === 0, conflicts,
  scope: 'Git object merge preview only; no checkout, ref update, worktree merge or production execution',
  approval: 'NOT_A_RELEASE_APPROVAL',
};
if (process.argv.includes('--artifact')) {
  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync('docs/evidence/member-integration-preview.json', JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
// Conflicts are an integration finding, not a reason to skip or weaken auth tests.
