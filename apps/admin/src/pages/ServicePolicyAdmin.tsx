import type { ServicePolicy } from '../../../../packages/auth/src/service-policy';
import { PolicyMultiSelect, PolicyTimeField } from './RegistrationControls';
import { useState } from 'react';
import { DataState, useApp, useData } from '../../../../packages/ui/src/core';

export function ServicePolicyAdmin({
  policy,
  onSaved,
}: {
  policy: ReturnType<typeof useData<ServicePolicy>>;
  onSaved: () => void;
}) {
  const { request, session, toast } = useApp();
  const accounts = useData<any[]>('/api/ai_accounts');
  const users = useData<{ id: string; name: string; role: string }[]>(
    '/api/admin/access/users',
  );
  const [busy, setBusy] = useState(false);
  return (
    <>
      <DataState
        error={policy.error || accounts.error || users.error}
        loading={!policy.data || !accounts.data || !users.data}
        onRetry={() => {
          policy.refresh();
          accounts.refresh();
          users.refresh();
        }}
      />
      {policy.data && accounts.data && users.data && (
        <form
          key={JSON.stringify(policy.data)}
          className="fields reg-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const data = new FormData(event.currentTarget);
            setBusy(true);
            try {
              await request('/api/admin/service-policy', 'PATCH', {
                schedule: {
                  enabled: data.get('enabled') === 'on',
                  startsAt: data.get('startsAt'),
                  endsAt: data.get('endsAt'),
                },
                ai: {
                  enabled: data.get('aiEnabled') === 'on',
                  accountId: data.get('accountId') || null,
                  dailyLimit: Number(data.get('dailyLimit')),
                  concurrency: Number(data.get('concurrency')),
                  maxOutputTokens: Number(data.get('maxOutputTokens')),
                  allMembers: data.has('aiAllMembers'),
                  userIds: data.getAll('aiUserIds'),
                  until: data.get('aiUntil') || null,
                },
              });
              policy.refresh();
              onSaved();
              toast('服务策略已保存，到期自动关闭');
            } catch {
              /* Shared handler displays errors. */
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset
            className="reg-form-grid"
            disabled={busy || session.user.role !== 'Owner'}
          >
            <label>
              <span>开放管理员 AI 服务</span>
              <input
                name="aiEnabled"
                type="checkbox"
                defaultChecked={policy.data.ai.enabled}
              />
            </label>
            <label>
              <span>服务使用的本人 API 账户</span>
              <select
                name="accountId"
                defaultValue={policy.data.ai.accountId || ''}
              >
                <option value="">未配置 · 暂未开放</option>
                {accounts.data
                  ?.filter((a) => (a.provider ?? 'OPENAI_API') === 'OPENAI_API')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>服务每人每日次数上限（滚动24小时；0为停用）</span>
              <input
                name="dailyLimit"
                type="number"
                min={0}
                max={1000}
                defaultValue={policy.data.ai.dailyLimit}
                required
              />
            </label>
            <label>
              <span>服务每人并发上限</span>
              <input
                name="concurrency"
                type="number"
                min={1}
                max={10}
                defaultValue={policy.data.ai.concurrency}
                required
              />
            </label>
            <label>
              <span>每任务输出 token 上限</span>
              <input
                name="maxOutputTokens"
                type="number"
                min={1}
                max={16000}
                defaultValue={policy.data.ai.maxOutputTokens}
                required
              />
            </label>
            <label>
              <span>AI 服务面向所有已授权普通用户</span>
              <input
                name="aiAllMembers"
                type="checkbox"
                defaultChecked={policy.data.ai.allMembers !== false}
              />
            </label>
            <PolicyMultiSelect
              name="aiUserIds"
              label="指定使用者"
              items={users.data.filter((user) => user.role === 'Member')}
              values={policy.data.ai.userIds}
            />
            <PolicyTimeField
              name="aiUntil"
              label="AI 服务到期"
              value={policy.data.ai.until}
            />
            <details className="reg-compat">
              <summary>兼容设置 · 原全站服务时段</summary>
              <p>
                原限时服务按 UTC
                运行，保留现有配置。活动发放请使用「全站限时开放」。
              </p>
              <div className="reg-form-grid">
                <label>
                  <span>启用全站限时服务</span>
                  <input
                    name="enabled"
                    type="checkbox"
                    defaultChecked={policy.data.schedule.enabled}
                  />
                </label>
                <PolicyTimeField
                  name="startsAt"
                  label="服务开始时间"
                  value={policy.data.schedule.startsAt}
                  required
                />
                <PolicyTimeField
                  name="endsAt"
                  label="服务结束时间"
                  value={policy.data.schedule.endsAt}
                  required
                />
              </div>
            </details>
            <div className="reg-save">
              <button className="primary">
                {busy ? '保存中…' : '保存服务策略'}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </>
  );
}

export function MemberAiQuota({ userId }: { userId: string }) {
  const { request, toast } = useApp();
  const quota = useData<any>('/api/admin/users/' + userId + '/ai-quota');
  const [busy, setBusy] = useState(false);
  if (!quota.data)
    return (
      <DataState
        error={quota.error}
        loading={!quota.data}
        onRetry={quota.refresh}
      />
    );
  return (
    <form
      key={JSON.stringify(quota.data)}
      className="fields"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const data = new FormData(event.currentTarget);
        setBusy(true);
        try {
          await request('/api/admin/users/' + userId + '/ai-quota', 'PATCH', {
            dailyLimit: Number(data.get('dailyLimit')),
            concurrency: Number(data.get('concurrency')),
          });
          quota.refresh();
          toast('用户 AI 额度已保存');
        } catch {
          /* Shared handler displays errors. */
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        <span>AI 每日次数（0停用）</span>
        <input
          name="dailyLimit"
          type="number"
          min={0}
          max={1000}
          defaultValue={quota.data.dailyLimit}
          required
        />
      </label>
      <label>
        <span>AI 并发数</span>
        <input
          name="concurrency"
          type="number"
          min={1}
          max={10}
          defaultValue={quota.data.concurrency}
          required
        />
      </label>
      <button disabled={busy}>保存用户 AI 额度</button>
    </form>
  );
}
