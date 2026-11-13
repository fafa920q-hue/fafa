import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailApiKey } from '../packages/auth/src/mail-secret';

const original = {
  file: process.env.MAIL_API_KEY_FILE,
  key: process.env.MAIL_API_KEY,
};
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true });
  for (const [name, value] of Object.entries({
    MAIL_API_KEY_FILE: original.file,
    MAIL_API_KEY: original.key,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'fafa-synthetic-mail-'));
  folders.push(folder);
  process.env.MAIL_API_KEY = 'synthetic-env-must-not-be-fallback';
  process.env.MAIL_API_KEY_FILE = join(folder, 'secret');
  return { folder, path: process.env.MAIL_API_KEY_FILE };
}
it('配置秘密文件时，缺失、目录、符号链接和宽权限文件均失败关闭，不回退旧环境凭据', () => {
  const { folder, path } = fixture();
  expect(mailApiKey()).toBe('');
  process.env.MAIL_API_KEY_FILE = folder;
  expect(mailApiKey()).toBe('');
  process.env.MAIL_API_KEY_FILE = path;
  const target = join(folder, 'target');
  writeFileSync(target, 'synthetic-file-key-not-real', { mode: 0o600 });
  symlinkSync(target, path);
  expect(mailApiKey()).toBe('');
  rmSync(path);
  writeFileSync(path, 'synthetic-file-key-not-real', { mode: 0o644 });
  chmodSync(path, 0o644);
  expect(mailApiKey()).toBe('');
});
it('受限普通文件仅供请求内存使用；轮换、空值、换行和超大内容不泄露或误用旧值', () => {
  const { path } = fixture();
  const before = process.env.MAIL_API_KEY;
  writeFileSync(path, 'synthetic-file-key-first-version', { mode: 0o600 });
  expect(mailApiKey()).toBe('synthetic-file-key-first-version');
  writeFileSync(path, 'synthetic-file-key-new-version');
  expect(mailApiKey()).toBe('synthetic-file-key-new-version');
  for (const bad of ['', 'invalid\nembedded\nnewlines', 'x'.repeat(4097)]) {
    writeFileSync(path, bad);
    expect(mailApiKey()).toBe('');
  }
  expect(process.env.MAIL_API_KEY).toBe(before);
});
