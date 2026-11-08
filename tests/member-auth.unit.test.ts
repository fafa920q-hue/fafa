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

describe('授权到期与中文邮件模板',()=>{
 it('到期不因boolean仍为true而继续生效，Owner不改变绑定',async()=>{
  const {capabilityAllowed,autoGrantPolicySchema}=await import('../packages/auth/src/auto-grant');
  expect(capabilityAllowed({role:'Member',server_connect_enabled:true,server_connect_until:new Date(Date.now()-1000)},'server')).toBe(false);
  expect(capabilityAllowed({role:'Member',server_connect_enabled:true,server_connect_until:null},'server')).toBe(true);
  expect(capabilityAllowed({role:'Owner'},'server')).toBe(true);
  expect(autoGrantPolicySchema.safeParse({enabled:true,windowStart:'2026-11-01T00:00:00Z',windowEnd:'2026-11-10T00:00:00Z',nodeSourceId:null,nodeLimit:null,trialValidDays:3}).success).toBe(false);
 });
 it('模板不插入外部资源，敏感内容HTML转义，保留中文正文',async()=>{
  const {renderAccountMail}=await import('../packages/auth/src/member-mail');
  const mail=renderAccountMail({to:'synthetic@example.invalid',purpose:'CODE',raw:'<script>fictional</script>'});
  expect(mail.html).not.toContain('<script>');expect(mail.html).toContain('&lt;script&gt;');expect(mail.text).toContain('10分钟');expect(mail.html).not.toMatch(/<img|<iframe|<script/);
 });
});
