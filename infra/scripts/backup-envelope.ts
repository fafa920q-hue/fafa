import { seal, unseal } from '../../packages/shared/src/crypto';
const mode = process.argv[2];
if (!['encrypt','decrypt'].includes(mode)) throw Error('用法: backup-envelope encrypt|decrypt');
const chunks: Buffer[] = [];
let size=0;
for await (const chunk of process.stdin) {
  const buffer=Buffer.from(chunk); size+=buffer.length;
  if (size > (mode==='encrypt' ? 256 : 400)*1024*1024) throw Error('备份超过此工具上限；请使用现有流式 age 备份流程');
  chunks.push(buffer);
}
const input=Buffer.concat(chunks);
if (mode==='encrypt') process.stdout.write(JSON.stringify(seal(input.toString('base64'))));
else {
  // Authenticate every encrypted field before writing ANY plaintext.
  const output=Buffer.from(unseal(JSON.parse(input.toString('utf8'))), 'base64');
  process.stdout.write(output);
}
