import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
it('生产备份信封往返及认证失败不输出任何明文', () => {
  const input = randomBytes(4096);
  const invoke = (mode: string, data: Buffer) =>
    spawnSync(
      'node',
      ['--import', 'tsx', 'infra/scripts/backup-envelope.ts', mode],
      { input: data, env: process.env },
    );
  const encrypted = invoke('encrypt', input);
  expect(encrypted.status).toBe(0);
  expect(encrypted.stdout.includes(input)).toBe(false);
  const restored = invoke('decrypt', encrypted.stdout);
  expect(restored.status).toBe(0);
  expect(restored.stdout.equals(input)).toBe(true);
  const damaged = JSON.parse(encrypted.stdout.toString());
  damaged.value.tag = Buffer.alloc(16).toString('base64');
  const denied = invoke('decrypt', Buffer.from(JSON.stringify(damaged)));
  expect(denied.status).not.toBe(0);
  expect(denied.stdout.length).toBe(0);
});
