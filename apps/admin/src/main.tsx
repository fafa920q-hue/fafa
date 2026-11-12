import { PlatformAiAccounts } from './pages/PlatformAiAccounts';
import { AiRuntimeTasks } from './pages/AiRuntimeTasks';
import { AccessCenter } from './pages/AccessCenter';
import { MemberAccessControls } from './pages/MemberDeliveryAdmin';
import { NodesAdmin } from './pages/NodesAdmin';
import { GrantsAdmin } from './pages/GrantsAdmin';
import { AiModelsAdmin } from './pages/AiModelsAdmin';
import { ApiKeysAdmin } from './pages/ApiKeysAdmin';
import { QuotaAdmin } from './pages/QuotaAdmin';
import { MonitoringAdmin } from './pages/MonitoringAdmin';
import { AuditAdmin } from './pages/AuditAdmin';
import { BackupAdmin } from './pages/BackupAdmin';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Globe2,
  Server,
  Code2,
  ListTodo,
  ShieldCheck,
  Settings,
  RefreshCw,
  Network,
  KeyRound,
  Cpu,
  Gauge,
  Activity,
  ScrollText,
  DatabaseBackup,
} from 'lucide-react';
import {
  Provider,
  Shell,
  PageTitle,
  Card,
  Badge,
  Empty,
  useApp,
  useData,
  FormDialog,
  ConfirmDialog,
  DataState,
  type Row,
} from '../../../packages/ui/src/core';
import { isAdmin } from '../../../packages/shared/src';
import { SubscriptionWorkspace } from '../../../packages/ui/src/subscriptions';
import { MemberRegistrationPolicy } from './pages/MemberRegistrationPolicy';
const nav = [
  { to: '/', label: '儀表板', icon: LayoutDashboard },
  { to: '/nodes', label: '節點管理', icon: Network },
  { to: '/users', label: '使用者管理', icon: Users },
  { to: '/grants', label: '訂閱授權', icon: ShieldCheck },
  { to: '/ai/models', label: 'AI 模型管理', icon: Cpu },
  { to: '/ai/keys', label: 'API Key 管理', icon: KeyRound },
  { to: '/ai/quota', label: '額度與計費管理', icon: Gauge },
  { to: '/monitoring', label: '系統監控', icon: Activity },
  { to: '/audit', label: '操作審計', icon: ScrollText },
  { to: '/settings', label: '系統設定', icon: Settings },
  { to: '/backup', label: '備份和版本管理', icon: DatabaseBackup },
];
function Admin() {
  const { session } = useApp();
  if (!isAdmin(session.user.role))
    return (
      <div className="glass card admin-warning">
        <Empty
          title="需要管理员权限"
          description="当前角色无法访问管理控制台，API 同时强制执行权限检查。"
        />
      </div>
    );
  return (
    <Shell
      nav={
        session.user.role === 'Owner'
          ? [
              ...nav,
              { to: '/ai/service-accounts', label: 'AI 服务管理', icon: Code2 },
            ]
          : nav
      }
      bottom={[nav[0], nav[1], nav[2], nav[8], nav[9]]}
      admin
    >
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/users" element={<UserManagement />} />
        <Route path="/nodes" element={<NodesAdmin />} />
        <Route path="/grants" element={<GrantsAdmin />} />
        <Route path="/ai/models" element={<AiModelsAdmin />} />
        <Route path="/ai/keys" element={<ApiKeysAdmin />} />
        <Route path="/ai/quota" element={<QuotaAdmin />} />
        <Route path="/monitoring" element={<MonitoringAdmin />} />
        <Route path="/backup" element={<BackupAdmin />} />
        <Route path="/sources" element={<SourcesAdmin />} />
        <Route path="/servers" element={<ResourceAdmin kind="servers" />} />
        <Route path="/ai" element={<ResourceAdmin kind="ai" />} />
        <Route path="/ai/service-accounts" element={<PlatformAiAccounts />} />
        <Route
          path="/jobs"
          element={
            <>
              <ResourceAdmin kind="jobs" />
              <AiRuntimeTasks />
            </>
          }
        />
        <Route path="/audit" element={<AuditAdmin />} />
        <Route path="/audit/resources" element={<ResourceAdmin kind="audit" />} />
        <Route path="/settings" element={<SystemSettings />} />
        <Route
          path="/member-registration"
          element={<MemberRegistrationPolicy />}
        />
        <Route path="*" element={<Empty title="页面不存在" />} />
      </Routes>
    </Shell>
  );
}
function Overview() {
  const summary = useData<any>('/api/summary');
  const jobs = useData<Row[]>('/api/admin/jobs');
  const users = useData<Row[]>('/api/admin/users');
  const audit = useData<Row[]>('/api/admin/audit');
  return (
    <>
      <PageTitle
        title="管理概览"
        description="让权限、连接与系统运行始终清晰可见。"
        eyebrow="FAFA ONE / ADMINISTRATION"
      />
      <div className="stats">
        {[
          ['注册用户', users.data?.length ?? '—', '真实数据库计数'],
          ['席位上限', summary.data?.seatLimit ?? '—', '默认 20 人，可调整'],
          [
            '失败任务',
            jobs.data?.filter((j) => j.data.status === 'FAILED').length ?? '—',
            '数据库持久队列',
          ],
          ['在线节点', '未接入', '没有实时监控数据'],
        ].map(([label, value, hint]) => (
          <div className="glass stat" key={label}>
            <div>
              <label>{label}</label>
              <strong>{value}</strong>
              <small>{hint}</small>
            </div>
          </div>
        ))}
      </div>
      <div className="two-col">
        <Card
          title="安全边界"
          description="管理权不等于用户密钥读取权"
          icon={ShieldCheck}
        >
          <div className="list">
            {[
              'Google OIDC + 邮箱验证',
              '角色与对象级服务端鉴权',
              '凭据 AES-256-GCM 信封加密',
              'SSH 固定指纹 + 授权目标',
              '订阅 SSRF 防护 + 禁止重定向',
            ].map((s) => (
              <div key={s} className="list-item">
                <ShieldCheck size={16} />
                <strong>{s}</strong>
                <Badge>已实现逻辑</Badge>
              </div>
            ))}
          </div>
        </Card>
        <Card title="最近审计" icon={ShieldCheck}>
          {audit.data?.slice(0, 6).map((r) => (
            <div className="list-item" key={r.id}>
              <div>
                <strong>{r.action}</strong>
                <small>{new Date(r.created_at).toLocaleString('zh-CN')}</small>
              </div>
            </div>
          ))}
          {!audit.data?.length && <Empty title="暂无审计事件" />}
        </Card>
      </div>
    </>
  );
}
function UserManagement() {
  const { request, toast } = useApp();
  const users = useData<Row[]>('/api/admin/users');
  const [action, setAction] = useState<{ user: Row; type: string }>();
  return (
    <>
      <PageTitle
        title="用户管理"
        description="用户自行注册并验证邮箱；禁用与角色变更会撤销会话。"
      />
      <div className="stack">
        <AccessCenter />
        <Card title="已注册用户" icon={Users}>
          <DataState
            error={users.error}
            loading={!users.data}
            onRetry={users.refresh}
          />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.data?.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.name}
                      <br />
                      <small>{u.email}</small>
                      <small>
                        注册：{new Date(u.created_at).toLocaleString('zh-CN')} ·{' '}
                        {u.email_verified ? '邮箱已验证' : '邮箱未验证'}
                      </small>
                    </td>
                    <td>{u.role}</td>
                    <td>
                      <Badge>{u.disabled ? '已禁用' : '已激活'}</Badge>
                      <small>
                        节点上限：{u.node_limit} · 订阅
                        {u.subscription_enabled ? '启用' : '停用'}
                      </small>
                      <small>
                        流量未计量 ·{' '}
                        {u.trafficLimitBytes == null
                          ? '未设流量政策'
                          : '流量政策 ' +
                            (u.trafficLimitBytes / 1073741824).toLocaleString(
                              'zh-CN',
                            ) +
                            ' GiB（未执行）'}
                      </small>
                    </td>
                    <td>
                      <MemberAccessControls user={u} onSaved={users.refresh} />
                      <div className="actions">
                        <button
                          disabled={u.role === 'Owner'}
                          onClick={() =>
                            setAction({ user: u, type: 'disabled' })
                          }
                        >
                          {u.disabled ? '启用' : '禁用'}
                        </button>
                        <button
                          disabled={u.role === 'Owner'}
                          onClick={() => setAction({ user: u, type: 'revoke' })}
                        >
                          撤销会话
                        </button>
                        <button
                          disabled={u.role === 'Owner'}
                          onClick={() => setAction({ user: u, type: 'quota' })}
                        >
                          节点额度
                        </button>
                        <select
                          aria-label={`修改 ${u.name} 角色`}
                          value={u.role}
                          disabled={u.role === 'Owner'}
                          onChange={(e) =>
                            setAction({ user: u, type: e.target.value })
                          }
                        >
                          <option>Owner</option>
                          <option>Admin</option>
                          <option>Member</option>
                          <option>Viewer</option>
                        </select>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <FormDialog
        open={action?.type === 'quota'}
        onClose={() => setAction(undefined)}
        title="节点额度与订阅权限"
        notice="节点数与订阅启停立即生效；流量限额仅保存政策，当前未接入真实计量或数据面强制限流。流量使用量不可用。"
        fields={[
          {
            name: 'nodeLimit',
            label: '导出节点数上限',
            type: 'number',
            value: String(action?.user.node_limit ?? 500),
            min: 0,
            max: 5000,
            required: true,
          },
          {
            name: 'trafficPolicy',
            label: '流量限额政策（未执行）',
            value:
              action?.user.trafficLimitBytes == null
                ? 'unlimited'
                : 'configured',
            options: [
              { label: '不设限额', value: 'unlimited' },
              { label: '保存指定限额（尚未执行）', value: 'configured' },
            ],
          },
          {
            name: 'trafficLimitGiB',
            label: '流量政策额度（GiB）',
            type: 'number',
            value: String(
              action?.user.trafficLimitBytes == null
                ? 1
                : action.user.trafficLimitBytes / 1073741824,
            ),
            min: 0,
            max: 8388607,
            step: 'any',
            help: '仅当选择指定限额时保存。已用流量未知，限额尚未强制执行。',
          },
          {
            name: 'enabled',
            label: '订阅状态',
            value: String(action?.user.subscription_enabled ?? true),
            options: [
              { label: '启用', value: 'true' },
              { label: '禁用', value: 'false' },
            ],
          },
        ]}
        onSubmit={async (d) => {
          await request('/api/admin/users/' + action!.user.id, 'PATCH', {
            nodeLimit: d.nodeLimit,
            subscriptionEnabled: d.enabled === 'true',
            trafficLimitBytes:
              d.trafficPolicy === 'configured'
                ? Math.round(d.trafficLimitGiB * 1073741824)
                : null,
          });
          users.refresh();
          toast('节点额度与订阅权限已保存');
        }}
      />
      <ConfirmDialog
        open={!!action && action.type !== 'quota'}
        title="确认修改用户权限？"
        description={`${action?.user.name}：${action?.type === 'disabled' ? '更改启用状态' : action?.type === 'revoke' ? '撤销所有会话' : '角色调整为 ' + action?.type}。权限变更立即生效。`}
        onClose={() => setAction(undefined)}
        onConfirm={async () => {
          await request(
            '/api/admin/users/' + action!.user.id,
            'PATCH',
            action!.type === 'disabled'
              ? { disabled: !action!.user.disabled }
              : action!.type === 'revoke'
                ? { revokeSessions: true }
                : { role: action!.type },
          );
          users.refresh();
        }}
      />
    </>
  );
}
function SourcesAdmin() {
  const [version, setVersion] = useState(0);
  return (
    <div className="stack">
      <SubscriptionWorkspace
        admin
        onChanged={() => setVersion((value) => value + 1)}
      />
      <ResourceAdmin key={version} kind="sources" embedded />
    </div>
  );
}
function ResourceAdmin({
  kind,
  embedded = false,
}: {
  kind: 'sources' | 'servers' | 'ai' | 'jobs' | 'audit';
  embedded?: boolean;
}) {
  const { request, toast, session } = useApp();
  const data = useData<Row[]>('/api/admin/' + kind);
  const users = useData<Row[]>('/api/admin/users');
  const grants = useData<Row[]>('/api/admin/grants');
  const [grant, setGrant] = useState<Row>();
  const labels = {
    sources: '节点源与订阅分配',
    servers: '服务器授权',
    ai: 'AI 连接摘要',
    jobs: '后台任务队列',
    audit: '安全审计',
  };
  return (
    <>
      {!embedded && (
        <PageTitle
          title={labels[kind]}
          description={
            kind === 'audit'
              ? '只追加审计，不记录凭据、订阅 URL 或终端输出。'
              : '平台共享资源与用户个人资源分别授权，界面只展示非敏感摘要。'
          }
          action={
            <button onClick={data.refresh}>
              <RefreshCw size={15} />
              刷新
            </button>
          }
        />
      )}
      <Card
        title={embedded ? '节点源授权分配' : labels[kind]}
        description={
          embedded
            ? '平台自有资源可以分配给用户；其他用户个人源只显示摘要，不允许越权编辑。'
            : undefined
        }
        action={
          embedded && (
            <button
              aria-label="刷新授权摘要"
              onClick={() => {
                data.refresh();
                grants.refresh();
                users.refresh();
              }}
            >
              <RefreshCw size={15} />
              刷新
            </button>
          )
        }
      >
        {kind === 'sources' && (
          <DataState
            error={grants.error}
            loading={false}
            onRetry={grants.refresh}
          />
        )}
        <DataState
          error={data.error}
          loading={!data.data}
          onRetry={data.refresh}
        />
        <div className="resource-grid">
          {data.data?.map((r) => (
            <article className="resource-card" key={r.id}>
              <div className="resource-top">
                <h3>
                  {r.data?.name || r.action || r.data?.type || '后台任务'}
                </h3>
                <Badge>
                  {r.data?.demo
                    ? '演示数据'
                    : kind === 'sources' && r.data?.status === 'READY'
                      ? '已解析 · 待实测'
                      : r.data?.status || '记录'}
                </Badge>
              </div>
              <div className="resource-meta">
                <span>记录：{r.id}</span>
                <span>
                  拥有者：
                  {users.data?.find((u) => u.id === r.owner_id)?.name ||
                    r.owner_id ||
                    '系统'}
                </span>
                {kind === 'ai' && (
                  <span>接入：OpenAI API · 管理员不可读取密钥</span>
                )}
                {kind === 'jobs' && (
                  <span>
                    重试次数：{r.data.attempt || 0} · {r.data.error || '无错误'}
                  </span>
                )}
                {kind === 'audit' && (
                  <span>
                    目标：{r.target_id || '—'} · 关联 ID：
                    {r.correlation_id || '—'}
                  </span>
                )}
                <span>{new Date(r.created_at).toLocaleString('zh-CN')}</span>
              </div>
              {['sources', 'servers'].includes(kind) && (
                <>
                  <p>
                    已授权：
                    {r.owner_id !== session.user.id
                      ? '个人授权不可见'
                      : grants.data
                          ?.filter(
                            (g) =>
                              g.resourceId === r.id &&
                              g.kind ===
                                (kind === 'sources' ? 'source' : 'server'),
                          )
                          .map(
                            (g) =>
                              users.data?.find((u) => u.id === g.userId)
                                ?.name || g.userId,
                          )
                          .join('、') || '暂无授权'}
                  </p>
                  {r.owner_id === session.user.id ? (
                    <button onClick={() => setGrant(r)}>分配 / 撤销授权</button>
                  ) : (
                    <p className="muted">个人资源 · 仅拥有者可管理</p>
                  )}
                </>
              )}
              {kind === 'jobs' && r.data.status === 'FAILED' && (
                <button
                  onClick={() =>
                    request(`/api/admin/jobs/${r.id}/retry`, 'POST')
                      .then(() => {
                        data.refresh();
                        toast('已重新入队');
                      })
                      .catch(() => {})
                  }
                >
                  重新入队
                </button>
              )}
            </article>
          ))}
        </div>
        {data.data?.length === 0 && (
          <Empty
            title="暂无记录"
            description="完成资源配置或产生操作后，将显示真实记录。"
          />
        )}
      </Card>
      <FormDialog
        open={!!grant}
        onClose={() => setGrant(undefined)}
        title="分配 / 撤销资源授权"
        notice="仅能分配管理员本人拥有且有权共享的资源；其他用户个人资源不允许擅自转授。"
        fields={[
          {
            name: 'userId',
            label: '用户',
            required: true,
            options:
              users.data?.map((u) => ({
                label: u.name + ' · ' + u.email,
                value: u.id,
              })) || [],
          },
          {
            name: 'operation',
            label: '操作',
            options: [
              { label: '授予使用权', value: 'grant' },
              { label: '撤销使用权', value: 'revoke' },
            ],
          },
        ]}
        onSubmit={async (d) => {
          const k = kind === 'sources' ? 'source' : 'server';
          if (d.operation === 'revoke')
            await request(
              `/api/admin/grants/${k}/${grant!.id}/${d.userId}`,
              'DELETE',
            );
          else
            await request('/api/admin/grants', 'POST', {
              kind: k,
              resourceId: grant!.id,
              userId: d.userId,
            });
          grants.refresh();
          toast('资源授权已更新');
        }}
      />
    </>
  );
}
function SystemSettings() {
  const { request, toast } = useApp();
  const config = useData<any>('/api/admin/settings');
  const [edit, setEdit] = useState(false);
  return (
    <>
      <PageTitle
        title="系统设置与备份"
        description="开发与生产明确分离，尚未部署到生产服务器。"
      />
      <div className="stack">
        <Card title="运行配置" icon={Settings}>
          <div className="detail-grid">
            {config.data?.settings.map((s: any) => (
              <div key={s.key}>
                <small>
                  {s.key === 'seat_limit' ? '用户席位上限' : '维护模式'}
                </small>
                <p>{JSON.stringify(s.value)}</p>
              </div>
            ))}
            {Object.entries(config.data?.capabilities || {}).map(
              ([key, value]) => (
                <div key={key}>
                  <small>{key}</small>
                  <p>
                    {typeof value === 'boolean'
                      ? value
                        ? '已配置 · 待实连验收'
                        : '未配置'
                      : String(value)}
                  </p>
                </div>
              ),
            )}
          </div>
          <button className="section-space" onClick={() => setEdit(true)}>
            调整席位上限
          </button>
        </Card>
        <Card
          title="加密备份 / 恢复"
          description="仅提供离线运维流程，网页不执行任意运维命令"
          icon={ShieldCheck}
        >
          <p>
            使用 infra/scripts/backup.sh 进行 pg_dump + age 公钥加密；通过
            restore.sh
            解密恢复到新数据库。生产启用自动定时任务前需进行恢复演练。不要把数据库凭据或解密私钥粘贴到网页。
          </p>
          <div className="callout section-space">
            当前状态：尚未配置备份计划 / 尚未完成生产恢复演练。详见
            docs/DEPLOYMENT.md。
          </div>
        </Card>
      </div>
      <FormDialog
        open={edit}
        onClose={() => setEdit(false)}
        title="调整席位上限"
        fields={[
          {
            name: 'seatLimit',
            label: '席位数',
            type: 'number',
            value: String(
              config.data?.settings.find((s: any) => s.key === 'seat_limit')
                ?.value || 20,
            ),
            min: 1,
            max: 1000,
            required: true,
          },
        ]}
        onSubmit={async (d) => {
          await request('/api/admin/settings', 'PATCH', d);
          config.refresh();
          toast('席位上限已更新');
        }}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Provider>
      <Admin />
    </Provider>
  </BrowserRouter>,
);
