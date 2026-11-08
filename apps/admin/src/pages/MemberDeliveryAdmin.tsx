import { useRef, useState } from 'react';
import { MemberAiQuota, ServicePolicyAdmin } from './ServicePolicyAdmin';
import {
  Card,
  DataState,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';

export function MemberAccessControls({
  user,
  onSaved,
}: {
  user: any;
  onSaved: () => void;
}) {
  const { request, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  if (user.role !== 'Member')
    return <small>管理角色与只读访客继续使用原角色权限</small>;
  return (
    <div className="actions">
      <details>
        <summary>AI 额度管理</summary>
        <MemberAiQuota userId={user.id} />
      </details>
      {(['node', 'server', 'codex'] as const).map((kind, i) => (
        <button
          key={kind}
          disabled={busy || user.role === 'Owner'}
          onClick={async () => {
            if (pending.current) return;
            pending.current = true;
            setBusy(true);
            try {
              await request('/api/admin/users/' + user.id, 'PATCH', {
                [[
                  'nodeAccessEnabled',
                  'serverConnectEnabled',
                  'codexTasksEnabled',
                ][i]]: !user.capabilities?.[kind],
              });
              onSaved();
              toast('权限已更新并记录审计');
            } catch {
              /* Shared request handler reports the failure. */
            } finally {
              pending.current = false;
              setBusy(false);
            }
          }}
        >
          {user.capabilities?.[kind] ? '撤销' : '开放'}
          {['节点', '服务器', 'Codex'][i]}
        </button>
      ))}
    </div>
  );
}
export function MemberDeliveryAdmin() {
  const { request, session, toast } = useApp();
  const policy = useData<any>('/api/admin/auto-grant-policy');
  const mail = useData<any[]>('/api/admin/member-mail');
  const records = useData<any[]>('/api/admin/auto-grant-records');
  const [busy, setBusy] = useState(false),
    pending = useRef(false);
  const reasons: Record<string, string> = {
    PROVIDER_REJECTED: '邮件服务拒绝',
    MAIL_NETWORK_ERROR: '网络或超时',
  };
  return (
    <>
      <ServicePolicyAdmin />
      {policy.data && !policy.data.retired && (
        <Card
          title="首次三天自动授权"
          description="复用自动授权策略；活动窗口最多三天，每人试用最多三天，过期按请求实时阻止。服务器权限仅允许连接自己的服务器，不授予他人的服务器或账户。"
        >
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
                if (pending.current) return;
                pending.current = true;
                setBusy(true);
                const data = new FormData(event.currentTarget);
                try {
                  await request('/api/admin/auto-grant-policy', 'PATCH', {
                    enabled: data.get('enabled') === 'on',
                    windowStart: String(data.get('windowStart')),
                    windowEnd: String(data.get('windowEnd')),
                    nodeSourceId: String(data.get('source') || '') || null,
                    nodeLimit:
                      data.get('limit') === ''
                        ? null
                        : Number(data.get('limit')),
                    trialValidDays: Number(data.get('days')),
                  });
                  policy.refresh();
                  toast('自动授权策略已保存');
                } catch {
                  /* Shared handler reports the error. */
                } finally {
                  pending.current = false;
                  setBusy(false);
                }
              }}
            >
              <p>
                {new Date(policy.data.windowEnd).getTime() <= Date.now()
                  ? '活动窗口已结束，新账户由管理员单独授权'
                  : '仅活动窗口内新建并激活的Member符合资格'}
              </p>
              <label>
                <span>启用自动授权</span>
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={policy.data.enabled}
                  disabled={session.user.role !== 'Owner' || busy}
                />
              </label>
              <label>
                <span>开始时间（UTC ISO）</span>
                <input
                  name="windowStart"
                  defaultValue={policy.data.windowStart}
                  required
                  disabled={session.user.role !== 'Owner' || busy}
                />
              </label>
              <label>
                <span>结束时间（UTC ISO，最多三天）</span>
                <input
                  name="windowEnd"
                  defaultValue={policy.data.windowEnd}
                  required
                  disabled={session.user.role !== 'Owner' || busy}
                />
              </label>
              <label>
                <span>节点源ID（留空显示待分配）</span>
                <input
                  name="source"
                  defaultValue={policy.data.nodeSourceId || ''}
                  disabled={session.user.role !== 'Owner' || busy}
                />
              </label>
              <label>
                <span>节点数量上限（留空沿用默认）</span>
                <input
                  name="limit"
                  type="number"
                  min={0}
                  max={5000}
                  defaultValue={policy.data.nodeLimit ?? ''}
                  disabled={session.user.role !== 'Owner' || busy}
                />
              </label>
              <label>
                <span>每人试用天数（1至3）</span>
                <input
                  name="days"
                  type="number"
                  min={1}
                  max={3}
                  defaultValue={policy.data.trialValidDays}
                  required
                  disabled={session.user.role !== 'Owner' || busy}
                />
              </label>
              <button disabled={session.user.role !== 'Owner' || busy}>
                保存自动授权
              </button>
            </form>
          )}
        </Card>
      )}
      <Card
        title="邮件发送状态"
        description="提供商已接受不等于已送达。待发送可能因进程中断而结果未知；不展示收件地址、验证码、重置链接或密钥。"
      >
        <DataState
          error={mail.error}
          loading={!mail.data}
          onRetry={mail.refresh}
        />
        <div className="list">
          {mail.data?.map((row) => (
            <div className="list-item" key={row.id}>
              <div>
                <strong>
                  {
                    (
                      {
                        VERIFY: '激活邮件',
                        RESET: '找回密码',
                        CODE: '注册验证码',
                        VERIFIED: '验证成功通知',
                        RESET_SUCCESS: '重置成功通知',
                        PASSWORD_CHANGED: '密码安全通知',
                      } as Record<string, string>
                    )[row.purpose]
                  }
                </strong>
                <small>
                  {new Date(row.created_at).toLocaleString('zh-CN')}
                </small>
                <small>
                  {
                    (
                      {
                        PENDING: '待发送 / 结果未知',
                        ACCEPTED: '提供商已接受，收件未确认',
                        FAILED: '发送失败',
                      } as Record<string, string>
                    )[row.status]
                  }{' '}
                  {reasons[row.failure_code] || ''}
                </small>
              </div>
            </div>
          ))}
        </div>
        {mail.data?.length === 0 && <p>暂无邮件记录</p>}
      </Card>
      {policy.data && !policy.data.retired && (
        <Card
          title="自动授权记录"
          description="记录授权来源、资格状态和到期时间；缺少已授权节点源时保持待分配。"
        >
          <DataState
            error={records.error}
            loading={!records.data}
            onRetry={records.refresh}
          />
          {records.data?.map((row) => (
            <div
              className="list-item"
              key={row.user_id + row.kind + row.resource_id}
            >
              <div>
                <strong>
                  {row.kind} ·{' '}
                  {row.expires_at &&
                  new Date(row.expires_at).getTime() <= Date.now()
                    ? '已到期'
                    : row.status}
                </strong>
                <small>
                  来源：首次三天活动 · {row.reason || '已按策略处理'}
                </small>
                <small>
                  开始：
                  {new Date(row.granted_at || row.created_at).toLocaleString(
                    'zh-CN',
                  )}{' '}
                  · 到期：
                  {row.expires_at
                    ? new Date(row.expires_at).toLocaleString('zh-CN')
                    : '无'}
                </small>
              </div>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
