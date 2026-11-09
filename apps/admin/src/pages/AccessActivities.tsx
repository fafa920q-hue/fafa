import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Card,
  DataState,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';
import { Field, Options, Toggle } from './AccessCenter';

type Item = { id: string; name: string };
type Activity = {
  name?: string;
  enabled: boolean;
  timeZone: string;
  windowStart?: string;
  windowEnd?: string;
  startsAt?: string;
  endsAt?: string;
  paused?: boolean;
  allMembers?: boolean;
  userIds?: string[];
  durationHours?: number;
  registrationMethod?: string;
  emailDomains?: string[];
  sourceIds: string[];
  services: {
    node: boolean;
    server: boolean;
    codex: boolean;
    subscription?: boolean;
  };
  nodeLimit: number;
  trafficLimitBytes: number | null;
  aiDailyLimit: number;
  concurrency: number;
};

function ActivityCard({ trial }: { trial: boolean }) {
  const { request, toast } = useApp();
  const path = '/api/admin/access/' + (trial ? 'trial-policy' : 'campaign');
  const settings = useData<Activity>(path);
  const resources = useData<{ sources: Item[] }>('/api/admin/access/resources');
  const users = useData<(Item & { role: string })[]>('/api/admin/access/users');
  const [busy, setBusy] = useState(false);
  const value = settings.data;
  const title = trial ? '注册体验策略' : '全站限时开放';
  const start = trial ? 'windowStart' : 'startsAt';
  const end = trial ? 'windowEnd' : 'endsAt';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const from = String(data.get(start)),
      to = String(data.get(end));
    if (
      ![from, to].every(
        (date) =>
          /(?:Z|[+-]\d{2}:\d{2})$/.test(date) &&
          Number.isFinite(Date.parse(date)),
      )
    ) {
      toast('请输入带 Z 或时区偏移的完整时间，如 2026-12-01T08:00:00+08:00');
      return;
    }
    setBusy(true);
    try {
      await request(path, 'PATCH', {
        name: String(data.get('name')).trim(),
        enabled: data.has('enabled'),
        timeZone: String(data.get('timeZone')).trim(),
        [start]: new Date(from).toISOString(),
        [end]: new Date(to).toISOString(),
        services: {
          node: data.has('node'),
          server: data.has('server'),
          codex: data.has('codex'),
          subscription: data.has('subscription'),
        },
        sourceIds: data.getAll('sourceIds'),
        nodeLimit: Number(data.get('nodeLimit')),
        trafficLimitBytes:
          data.get('traffic') === '' ? null : Number(data.get('traffic')),
        aiDailyLimit: Number(data.get('aiDailyLimit')),
        concurrency: Number(data.get('concurrency')),
        ...(trial
          ? {
              durationHours: Number(data.get('durationHours')),
              registrationMethod: data.get('registrationMethod'),
              emailDomains: String(data.get('emailDomains'))
                .toLowerCase()
                .split(/[，,\s]+/)
                .filter(Boolean),
            }
          : {
              paused: data.has('paused'),
              allMembers: data.has('allMembers'),
              userIds: data.getAll('userIds'),
            }),
      });
      settings.refresh();
      toast(title + '已保存并记录审计');
    } catch {
      // The shared request handler displays API errors.
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title={title}
      description={
        trial
          ? '仅发给活动时段内完成验证的新用户。默认关闭，每个用户只发放一次。'
          : '按服务端时间自动生效。暂停或到期后，用户继续使用其原有权限。'
      }
    >
      <DataState
        error={settings.error || resources.error || users.error}
        loading={!value || !resources.data || !users.data}
        onRetry={() => {
          settings.refresh();
          resources.refresh();
          users.refresh();
        }}
      />
      {value && resources.data && users.data && (
        <form key={JSON.stringify(value)} className="fields" onSubmit={submit}>
          <fieldset disabled={busy}>
            <Field
              name="name"
              label="活动名称"
              value={value.name || title}
              required
            />
            <Toggle name="enabled" label="启用活动" checked={value.enabled} />
            <Field
              name="timeZone"
              label="显示时区（IANA 名称）"
              value={value.timeZone}
              required
            />
            <Field
              name={start}
              label="开始时间（ISO，含时区偏移）"
              value={value[start]}
              required
            />
            <Field
              name={end}
              label="结束时间（ISO，含时区偏移）"
              value={value[end]}
              required
            />
            {trial ? (
              <>
                <Field
                  name="durationHours"
                  label="体验时长（小时）"
                  min={0.25}
                  max={8760}
                  step={0.25}
                  value={value.durationHours}
                  required
                />
                <label>
                  <span>注册方式</span>
                  <select
                    name="registrationMethod"
                    defaultValue={value.registrationMethod}
                  >
                    <option value="all">邮箱或 Google</option>
                    <option value="email">已验证邮箱</option>
                    <option value="google">Google 注册</option>
                  </select>
                </label>
                <Field
                  name="emailDomains"
                  label="限定邮箱域名（逗号分隔，可留空）"
                  value={value.emailDomains?.join(', ')}
                />
              </>
            ) : (
              <>
                <Toggle name="paused" label="暂停开放" checked={value.paused} />
                <Toggle
                  name="allMembers"
                  label="面向所有普通用户"
                  checked={value.allMembers}
                />
                <Options
                  name="userIds"
                  label="或选择指定普通用户"
                  items={users.data.filter((user) => user.role === 'Member')}
                  values={value.userIds}
                  multiple
                />
              </>
            )}
            <Toggle
              name="node"
              label="开放节点"
              checked={value.services.node}
            />
            <Toggle
              name="subscription"
              label="开放个人订阅"
              checked={value.services.subscription !== false}
            />
            <Options
              name="sourceIds"
              label="开放的平台节点源"
              items={resources.data.sources}
              values={value.sourceIds}
              multiple
            />
            <Toggle
              name="server"
              label="开放服务器能力（仍需服务器授权）"
              checked={value.services.server}
            />
            <Toggle
              name="codex"
              label="开放 AI 服务（仍需平台 AI 启用）"
              checked={value.services.codex}
            />
            <Field
              name="nodeLimit"
              label="节点数量上限"
              min={0}
              max={5000}
              value={value.nodeLimit}
              required
            />
            <Field
              name="traffic"
              label="流量上限（字节，可留空）"
              min={0}
              max={Number.MAX_SAFE_INTEGER}
              value={value.trafficLimitBytes}
            />
            <Field
              name="aiDailyLimit"
              label="AI 每 24 小时调用上限"
              min={0}
              max={1000}
              value={value.aiDailyLimit}
              required
            />
            <Field
              name="concurrency"
              label="AI 并发上限"
              min={1}
              max={10}
              value={value.concurrency}
              required
            />
            <button>保存{title}</button>
          </fieldset>
        </form>
      )}
    </Card>
  );
}
export function AccessActivities() {
  return (
    <>
      <ActivityCard trial />
      <ActivityCard trial={false} />
    </>
  );
}
