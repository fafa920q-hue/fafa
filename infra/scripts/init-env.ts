import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
try {
  await writeFile(
    '.env',
    (await readFile('.env.example', 'utf8')).replace(
      'ENCRYPTION_KEY=\n',
      `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('已生成本地 .env');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EEXIST')
    console.log('保留已有 .env');
  else throw e;
}
