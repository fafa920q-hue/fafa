import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  validatePassword,
  verifyPassword,
} from '../packages/auth/src/password';

describe('普通账户 Argon2id', () => {
  it('使用独立随机盐、固定安全参数和恒定时间比较', async () => {
    const password = 'fictional member password 仅供测试';
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword('incorrect fictional password', first)).toBe(
      false,
    );
    expect(await verifyPassword(password)).toBe(false);
    expect(await verifyPassword(password, '$unsupported$malformed')).toBe(
      false,
    );
  });
  it('允许空格和中文，拒绝短密码和过长输入', () => {
    expect(() => validatePassword('short')).toThrow();
    expect(() => validatePassword('a'.repeat(129))).toThrow();
    expect(() =>
      validatePassword('这是一个足够长的中文密码用于合成测试'),
    ).not.toThrow();
  });
});
