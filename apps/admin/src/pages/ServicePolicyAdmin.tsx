import { useState } from 'react';
import {
  Card,
  DataState,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';

export function ServicePolicyAdmin() {
  const { request, session, toast } = useApp();
  const policy = useData<any>('/api/admin/service-policy');
  const accounts = useData<any[]>('/api/ai_accounts');
  const users = useData<{ id: string; name: string; role: string }[]>(
    '/api/admin/access/users',
  );
  const [busy, setBusy] = useState(false);
  return (
    <Card
      title="全站开放时间与管理员 AI 服务"
      description="时间统一使用 UTC。开启限时服务后，普通用户在开始前及结束后不能使用节点订阅、服务器和 AI；管理员可继续管理。原有业务权限与资源分配仍须满足。"
    >
      <DataState
        error={policy.error}
        loading={!policy.data}
        onRetry={policy.refresh}
      />
      {policy.data && (
        <form
          key={JSON.stringify(policy.data)}
          className="fields"
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
              toast('服务策略已保存，到期自动关闭');
            } catch {
              /* Shared handler displays errors. */
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy || session.user.role !== 'Owner'}>
            <label>
              <span>启用全站限时服务</span>
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={policy.data.schedule.enabled}
              />
            </label>
            <label>
              <span>服务开始时间（UTC ISO）</span>
              <input
                name="startsAt"
                defaultValue={policy.data.schedule.startsAt}
                required
              />
            </label>
            <label>
              <span>服务结束时间（UTC ISO）</span>
              <input
                name="endsAt"
                defaultValue={policy.data.schedule.endsAt}
                required
              />
            </label>
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
                {accounts.data?.map((a) => (
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
            <label>
              <span>或选择指定用户</span>
              <select
                name="aiUserIds"
                multiple
                defaultValue={policy.data.ai.userIds || []}
              >
                {users.data
                  ?.filter((user) => user.role === 'Member')
                  .map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>AI 服务到期（UTC ISO，可留空）</span>
              <input name="aiUntil" defaultValue={policy.data.ai.until || ''} />
            </label>
            <button>保存服务策略</button>
          </fieldset>
        </form>
      )}
    </Card>
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
