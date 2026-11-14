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
import {
  accountSchema,
  apiKey,
  mapAdminAccount,
} from '../apps/api/src/platform-ai';
import { audience } from '../packages/auth/src/platform-models';

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

// 回归覆盖 2026-11-14 启用失败：GET /api/admin/ai-platform 曾直接回
// 传数据库原始列（daily_micros/monthly_micros），没有 limits 对象，
// 前端 toggleEnabled 于是送出 limits: {}，PATCH 的 Zod 报
// limits.daily/monthly expected number, received undefined，点「启用」
// 永远失败。修复后 GET 对映出 limits {daily, monthly}。
describe('管理列表 GET 对映（limits）', () => {
  const row = {
    id: '00000000-0000-0000-0000-000000000001',
    project_id: 'proj_TEST123',
    service_account_id: 'user-TEST123',
    name: 'FAFA ONE AI',
    note: '',
    models: ['gpt-5.4-mini'],
    enabled: false,
    health: 'READY',
    daily_micros: '500000',
    monthly_micros: 3000000,
    concurrency: 1,
    priority: 100,
    allowed_users: null,
  };

  it('回传 limits {daily, monthly} 且为数字', () => {
    const mapped = mapAdminAccount(row);
    expect(mapped.limits).toEqual({ daily: 500000, monthly: 3000000 });
  });

  it('保留其他栏位不变', () => {
    const mapped = mapAdminAccount(row);
    expect(mapped.id).toBe(row.id);
    expect(mapped.name).toBe('FAFA ONE AI');
    expect(mapped.enabled).toBe(false);
    expect(mapped.health).toBe('READY');
    expect(mapped.daily_micros).toBe('500000');
  });
});

// PATCH /api/admin/ai-platform/accounts/:id 的 schema（与路由一致：
// accountSchema 去掉 projectId/serviceAccountId，allowedUsers 与
// priority 为选填；不收 apiKey）。启用与编辑都走这条路。
const patchSchema = accountSchema
  .omit({ projectId: true, serviceAccountId: true })
  .extend({
    allowedUsers: audience.optional(),
    priority: z.number().int().min(1).max(1000).optional(),
  });
const patchBase = {
  priority: 100,
  allowedUsers: null,
  name: 'FAFA ONE AI',
  note: '平台 GPT 对话及 AI 中转',
  limits: { daily: 500000, monthly: 3000000 },
  models: ['gpt-5.4-mini', 'gpt-6.1-sol'],
  enabled: true,
  concurrency: 1,
};

describe('PATCH 更新账号（启用／编辑）', () => {
  it('接受启用时的提交：limits {daily, monthly}、无 apiKey', () => {
    expect(patchSchema.safeParse(patchBase).success).toBe(true);
  });

  it('接受编辑时的提交：改名称、模型与上限', () => {
    expect(
      patchSchema.safeParse({
        ...patchBase,
        name: 'FAFA ONE AI 2',
        models: ['gpt-5.4-mini'],
        limits: { daily: 1000000, monthly: 5000000 },
        enabled: false,
      }).success,
    ).toBe(true);
  });

  it('拒绝 limits: {}，issues 指明 limits.daily 与 limits.monthly', () => {
    const result = patchSchema.safeParse({ ...patchBase, limits: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('limits.daily');
      expect(paths).toContain('limits.monthly');
    }
  });

  it('拒绝 limits 误写成 {dailyMicros, monthlyMicros}', () => {
    expect(
      patchSchema.safeParse({
        ...patchBase,
        limits: { dailyMicros: 500000, monthlyMicros: 3000000 },
      }).success,
    ).toBe(false);
  });

  it('拒绝每日上限大于每月上限的编辑', () => {
    expect(
      patchSchema.safeParse({
        ...patchBase,
        limits: { daily: 5000000, monthly: 3000000 },
      }).success,
    ).toBe(false);
  });
});
