import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n');
let failures = 0;
for (const file of files) {
  if (!existsSync(file) || /\.(png|jpg|zip)$/.test(file)) continue;
  if (/(^|\/)\.env(\.|$)/.test(file) && file !== '.env.example') {
    console.error('禁止提交环境秘密文件：' + file);
    failures++;
  }
  const text = readFileSync(file, 'utf8');
  const secrets = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /AIza[0-9A-Za-z_-]{35}/,
    /gh[pousr]_[A-Za-z0-9]{30,}/,
    /sk-proj-[A-Za-z0-9_-]{50,}/,
  ];
  if (secrets.some((pattern) => pattern.test(text))) {
    console.error('疑似秘密：' + file);
    failures++;
  }
  if (file.startsWith('apps/admin/dist') || file.startsWith('apps/web/dist'))
    continue;
}
if (failures) process.exit(1);
console.log(
  `基础秘密扫描通过：${files.length} 个候选文件。此规则扫描不代替人工审计或专业秘密扫描。`,
);
