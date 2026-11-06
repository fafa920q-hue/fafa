import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
let table =
  '| 依赖 | 锁定版本 | 许可证 | 上游 | 修改范围 |\n|---|---|---|---|---|\n';
for (const name of Object.keys({
  ...pkg.dependencies,
  ...pkg.devDependencies,
}).sort()) {
  const p = JSON.parse(
    await readFile(`node_modules/${name}/package.json`, 'utf8'),
  );
  const repo =
    typeof p.repository === 'string'
      ? p.repository
      : p.repository?.url || p.homepage || '见 npm';
  table += `| ${name} | ${p.version} | ${typeof p.license === 'string' ? p.license : JSON.stringify(p.license)} | ${repo.replace(/^git\+|\.git$/g, '')} | 未修改上游代码 |\n`;
}
let notices =
  '# Third-party copyright and license notices\n\nGenerated from installed locked dependencies; no upstream license text removed.\n';
for (const entry of await readdir('node_modules/.pnpm', {
  withFileTypes: true,
})) {
  if (!entry.isDirectory() || entry.name === 'node_modules') continue;
  const base = join('node_modules/.pnpm', entry.name, 'node_modules');
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    continue;
  }
  for (const name of names) {
    const paths = name.startsWith('@')
      ? (await readdir(join(base, name))).map((n) => join(base, name, n))
      : [join(base, name)];
    for (const path of paths) {
      try {
        const metadata = JSON.parse(
          await readFile(join(path, 'package.json'), 'utf8'),
        );
        if (
          !entry.name.startsWith(
            metadata.name.replace('/', '+').replace('@', '@') + '@',
          )
        )
          continue;
        for (const file of await readdir(path)) {
          if (/^(license|licence|notice|copying)(\.|$)/i.test(file)) {
            notices +=
              `\n\n## ${metadata.name}@${metadata.version} / ${file}\n\n` +
              (await readFile(join(path, file), 'utf8'));
          }
        }
      } catch {
        /* 非包目录 */
      }
    }
  }
}
await writeFile('docs/THIRD_PARTY_NOTICES.txt', notices);
await writeFile(
  'docs/OPEN_SOURCE_ATTRIBUTION.md',
  `# 开源引用与许可\n\n核查日期：2026-11-06，以安装包元数据与随包 LICENSE 为依据；直接依赖全部锁定确切版本。保留项目原 Apache-2.0 LICENSE。上游原始声明汇总见 THIRD_PARTY_NOTICES.txt；发布时须随分发物保留。\n\n${table}\n\n未复制 Sub-Store、sing-box、SubHub、metacubexd 或 Codex 源码，不引入 AGPL/GPL 核心代码；订阅适配层为独立实现，仅支持文档已列格式。xterm.js 提供前端终端，SSH 安全由本项目负责。Google 官方库验证 ID Token；OpenAI 官方 SDK 执行 API 请求，不代表取得 ChatGPT 托管登录或 Codex Cloud 控制 API 授权。\n\nminimatch 因 GHSA-g3hv-75wg-m249 统一覆盖至 11.0.4，glob 因 GHSA-3g3m-2fjr-6pw4 覆盖至 14.0.3。修复后执行依赖审计与回归检查。ssh2/cpu-features 可选原生加速构建关闭，使用 JS 回退；esbuild 安装构建脚本明确允许。系统字体，无外部字体追踪。\n`,
);
console.log('已生成直接依赖许可证清单与上游声明');
