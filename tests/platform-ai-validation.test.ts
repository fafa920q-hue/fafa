// AI 服务账户凭据校验单元测试（无需数据库）。
// 回归覆盖 2026-11-10 “添加服务账户保存失败，提示输入内容不符合要求”：
// 从 OpenAI 控制台粘贴凭据时常带首尾空格/换行，旧校验无 trim 直接 400。
// 回归覆盖 2026-11-14：OpenAI Admin API（List 与 Create 服务账户）返回
// 的服务账户编号均以 user- 开头（例如 user-TEST123），文档示例 svc_acct_
// 只是占位写法；旧校验只接受 svc_acct_，真实编号一律被拒，且后端只回
// 一句笼统的“输入内容不符合要求”，不指明是哪个字段。
// 修复后：先 trim 再做格式校验；服务账户编号接受 svc_acct_ 与 user- 两
// 种前缀；非法格式（sk-admin-、过短、错误前缀、空模型、每日预算大于每
// 月预算、非 UUID 指定用户、未勾选确认）仍拒绝；400 响应附字段级 issues。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { accountSchema, apiKey } from '../apps/api/src/platform-ai';

const validKey = 'sk-test-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const createSchema = accountSchema.extend({
  apiKey,
  confirmServiceAccount: z.literal(true),
});
const base = {
  priority: 100,
  allowedUsers: null,
  name: 'Test Account',
  note: '',
  projectId: 'proj_TEST123',
  serviceAccountId: 'user-TEST123',
  limits: { daily: 5_000_000, monthly: 10_000_000 },
  models: ['gpt-5.4-mini'],
  enabled: false,
  concurrency: 2,
  apiKey: validKey,
  confirmServiceAccount: true as const,
};

describe('服务账户 API Key 格式', () => {
  it('接受格式正确的服务账户密钥', () => {
    expect(apiKey.safeParse(validKey).success).toBe(true);
  });

  it('接受粘贴时带首尾空格或换行的密钥', () => {
    expect(apiKey.safeParse(validKey + '\n').success).toBe(true);
    expect(apiKey.safeParse(validKey + ' ').success).toBe(true);
    expect(apiKey.safeParse(' ' + validKey).success).toBe(true);
    // trim 后存入的是干净值
    expect(apiKey.parse(validKey + '\n')).toBe(validKey);
  });

  it('拒绝管理员密钥 sk-admin-', () => {
    expect(
      apiKey.safeParse('sk-admin-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx').success,
    ).toBe(false);
  });

  it('拒绝过短或空的密钥', () => {
    expect(apiKey.safeParse('sk-abc').success).toBe(false);
    expect(apiKey.safeParse('').success).toBe(false);
  });
});

describe('服务账户编号格式', () => {
  it('接受 OpenAI 真实返回的 user- 编号', () => {
    expect(
      createSchema.safeParse({ ...base, serviceAccountId: 'user-TEST123' })
        .success,
    ).toBe(true);
  });

  it('接受 svc_acct_ 编号', () => {
    expect(
      createSchema.safeParse({
        ...base,
        serviceAccountId: 'svc_acct_TEST123',
      }).success,
    ).toBe(true);
  });

  it('接受粘贴时带首尾空白的 user- 编号，trim 后存入干净值', () => {
    const parsed = createSchema.parse({
      ...base,
      serviceAccountId: '  user-TEST123\n',
    });
    expect(parsed.serviceAccountId).toBe('user-TEST123');
  });

  it('拒绝其他前缀与空编号', () => {
    for (const bad of [
      'my-service-account',
      'acct_TEST123',
      'svc_TEST123',
      'USER-TEST123',
      'user-',
      'svc_acct_',
      '',
      'user-TEST 123',
    ]) {
      expect(
        createSchema.safeParse({ ...base, serviceAccountId: bad }).success,
      ).toBe(false);
    }
  });

  it('校验失败时 Zod issues 指明 serviceAccountId 字段', () => {
    const result = createSchema.safeParse({
      ...base,
      serviceAccountId: 'my-service-account',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.join('.') === 'serviceAccountId',
        ),
      ).toBe(true);
    }
  });
});

describe('新增服务账户整体校验', () => {
  it('接受格式正确的完整提交（user- 编号）', () => {
    expect(createSchema.safeParse(base).success).toBe(true);
  });

  it('接受粘贴时带首尾空白的项目编号与服务账户编号', () => {
    expect(
      createSchema.safeParse({
        ...base,
        projectId: 'proj_TEST123 ',
        serviceAccountId: 'svc_acct_TEST123\n',
        apiKey: validKey + '\n',
      }).success,
    ).toBe(true);
  });

  it('trim 后存入的是干净值', () => {
    const parsed = createSchema.parse({
      ...base,
      projectId: '  proj_TEST123  ',
      serviceAccountId: '\tuser-TEST123\n',
      apiKey: validKey + '\n',
    });
    expect(parsed.projectId).toBe('proj_TEST123');
    expect(parsed.serviceAccountId).toBe('user-TEST123');
    expect(parsed.apiKey).toBe(validKey);
  });

  it('接受 API Key 管理页提交的 limits 形状 {daily, monthly}', () => {
    expect(
      createSchema.safeParse({
        ...base,
        limits: { daily: 500_000, monthly: 3_000_000 },
      }).success,
    ).toBe(true);
  });

  it('拒绝 limits 误写成 {dailyMicros, monthlyMicros} 的形状', () => {
    // 2026-11-14 发现的第二个保存失败原因：ApiKeysAdmin 曾以
    // dailyMicros/monthlyMicros 为键提交 limits，Zod 会去掉未知键，
    // 导致 limits 缺 daily/monthly 而 400。前端现已改发 daily/monthly。
    expect(
      createSchema.safeParse({
        ...base,
        limits: { dailyMicros: 500_000, monthlyMicros: 3_000_000 },
      }).success,
    ).toBe(false);
  });

  it('拒绝错误前缀的项目编号与服务账户编号', () => {
    expect(
      createSchema.safeParse({ ...base, projectId: 'my-project' }).success,
    ).toBe(false);
    expect(
      createSchema.safeParse({
        ...base,
        serviceAccountId: 'my-service-account',
      }).success,
    ).toBe(false);
  });

  it('拒绝空模型列表', () => {
    expect(createSchema.safeParse({ ...base, models: [] }).success).toBe(false);
  });

  it('拒绝每日预算大于每月预算', () => {
    expect(
      createSchema.safeParse({
        ...base,
        limits: { daily: 10_000_000, monthly: 5_000_000 },
      }).success,
    ).toBe(false);
  });

  it('拒绝非 UUID 的指定共享用户', () => {
    expect(
      createSchema.safeParse({ ...base, allowedUsers: ['not-a-uuid'] }).success,
    ).toBe(false);
  });

  it('拒绝未勾选服务账户确认', () => {
    expect(
      createSchema.safeParse({ ...base, confirmServiceAccount: false }).success,
    ).toBe(false);
  });
});
