import { MemberDeliveryAdmin } from './MemberDeliveryAdmin';
import { useState } from 'react';
import {
  Card,
  PageTitle,
  useApp,
  useData,
  DataState,
} from '../../../../packages/ui/src/core';

export function MemberRegistrationPolicy() {
  const { request, session, toast } = useApp();
  const policy = useData<any>('/api/admin/member-registration');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageTitle
        title="普通账户注册策略"
        description="注册账户默认 Member，必须实际验证邮箱；停用账户和撤销会话继续使用用户管理。"
      />
      <Card title="允许自由注册">
        <DataState
          error={policy.error}
          loading={!policy.data}
          onRetry={policy.refresh}
        />
        {policy.data && (
          <form
            className="fields"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              const form = new FormData(event.currentTarget);
              setBusy(true);
              try {
                await request('/api/admin/member-registration', 'PATCH', {
                  enabled: form.get('enabled') === 'on',
                  seatLimit: Number(form.get('seatLimit')),
                });
                policy.refresh();
                toast('注册策略已保存');
              } catch {
                /* Shared request handler provides a Chinese error message. */
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              {policy.data.mailConfigured
                ? '邮件服务已配置，实际投递仍由提供商决定'
                : '邮件服务未配置，禁止开启自由注册'}
            </p>
            <p>最近一小时投递失败记录：{policy.data.recentMailFailures}</p>
            <label className="checkbox-label">
              <span>允许自由注册</span>
              <input
                key={String(policy.data.enabled)}
                name="enabled"
                type="checkbox"
                defaultChecked={policy.data.enabled}
                disabled={session.user.role !== 'Owner' || busy}
              />
            </label>
            <label>
              <span>注册人数上限（所有有效用户共用）</span>
              <input
                key={policy.data.seatLimit}
                name="seatLimit"
                type="number"
                min={1}
                max={1000}
                defaultValue={policy.data.seatLimit}
                required
                disabled={session.user.role !== 'Owner' || busy}
              />
            </label>
            <button
              className="primary"
              disabled={session.user.role !== 'Owner' || busy}
            >
              {busy ? '保存中…' : '保存注册策略'}
            </button>
          </form>
        )}
      </Card>
      <MemberDeliveryAdmin />
    </>
  );
}
