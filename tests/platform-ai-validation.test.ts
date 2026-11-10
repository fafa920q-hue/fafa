// AI 服务账户凭据校验单元测试（无需数据库）。
// 回归覆盖 2026-11-10 “添加服务账户保存失败，提示输入内容不符合要求”：
// 从 OpenAI 控制台粘贴凭据时常带首尾空格/换行，旧校验无 trim 直接 400。
// 修复后：先 trim 再做格式校验；非法格式（sk-admin-、过短、错误前缀、
// 空模型、每日预算大于每月预算、非 UUID 指定用户、未勾选确认）仍拒绝。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { accountSchema, apiKey } from '../apps/api/src/platform-ai';

const validKey = 'sk-svcacct-abcdefghijklmnopqrstuvwxyz123456';
const createSchema = accountSchema.extend({
  apiKey,
  confirmServiceAccount: z.literal(true),
});
const base = {
  priority: 100,
  allowedUsers: null,
  name: 'Test Account',
  note: '',
  projectId: 'proj_fixture',
  serviceAccountId: 'svc_acct_fixture',
  limits: { daily: 5_000_000, monthly: 10_000_000 },
  models: ['gpt-4.1-mini'],
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
      apiKey.safeParse('sk-admin-abcdefghijklmnopqrstuvwxyz123456').success,
    ).toBe(false);
  });

  it('拒绝过短或空的密钥', () => {
    expect(apiKey.safeParse('sk-abc').success).toBe(false);
    expect(apiKey.safeParse('').success).toBe(false);
  });
});

describe('新增服务账户整体校验', () => {
  it('接受格式正确的完整提交', () => {
    expect(createSchema.safeParse(base).success).toBe(true);
  });

  it('接受粘贴时带首尾空白的项目编号与服务账户编号', () => {
    expect(
      createSchema.safeParse({
        ...base,
        projectId: 'proj_fixture ',
        serviceAccountId: 'svc_acct_fixture\n',
        apiKey: validKey + '\n',
      }).success,
    ).toBe(true);
  });

  it('trim 后存入的是干净值', () => {
    const parsed = createSchema.parse({
      ...base,
      projectId: '  proj_fixture  ',
      serviceAccountId: '\tsvc_acct_fixture\n',
      apiKey: validKey + '\n',
    });
    expect(parsed.projectId).toBe('proj_fixture');
    expect(parsed.serviceAccountId).toBe('svc_acct_fixture');
    expect(parsed.apiKey).toBe(validKey);
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
