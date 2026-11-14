import { PlatformAiModels, audienceIds } from './PlatformAiModels';
import { useEffect, useState } from 'react';
import {
  Card,
  ConfirmDialog,
  DataState,
  Empty,
  FormDialog,
  PageTitle,
  useApp,
  useData,
  type Field,
  type Row,
} from '../../../../packages/ui/src/core';

const base = '/api/admin/ai-platform';
const usd = (n: number) => 'USD ' + (n / 1_000_000).toFixed(6);
const numeric = (
  name: string,
  label: string,
  value: number,
  money = true,
): Field => ({
  name,
  label,
  type: 'number',
  value: String(money ? value / 1_000_000 : value),
  min: money ? 0.000001 : 1,
  step: money ? '0.000001' : '1',
  required: true,
});
const keyField: Field = {
  name: 'apiKey',
  label: '新项目服务账户 API Key',
  type: 'password',
  required: true,
  // 格式要求与后端 accountSchema 的 apiKey 校验一致；粘贴时首尾空白
  // 会被自动去掉，管理员密钥（sk-admin- 开头）不可用。
  help: '以 sk- 开头、至少 16 位字符的服务账户密钥（不是 sk-admin- 管理员密钥）。从 OpenAI 控制台粘贴时首尾空格/换行会被自动去掉。',
};
const attest: Field = {
  name: 'confirmServiceAccount',
  label: '我已在 OpenAI 项目中核对这是服务账户签发的密钥',
  type: 'checkbox',
  required: true,
};
const pickModels = (available: string[], selected: string[]): Field[] =>
  available.map((name) => ({
    name: 'model:' + name,
    label: name,
    type: 'checkbox',
    value: String(selected.includes(name)),
  }));
const chosenModels = (d: any, available: string[]) =>
  available.filter((name) => d['model:' + name]);
const toMoney = (n: number) => Math.round(n * 1_000_000);
const budgetFields = (
  v: { daily: number; monthly: number },
  prefix = '',
  label = '',
) => [
  numeric(prefix + 'daily', label + '每日预算 (USD)', v.daily),
  numeric(prefix + 'monthly', label + '每月预算 (USD)', v.monthly),
];
const readBudget = (d: any, prefix = '') => ({
  daily: toMoney(d[prefix + 'daily']),
  monthly: toMoney(d[prefix + 'monthly']),
});
function quotaFields(q: any, available: string[]) {
  return [
    {
      name: 'userEnabled',
      label: '允许使用平台 AI',
      type: 'checkbox',
      value: String(q.enabled),
    },
    ...budgetFields(q.limits),
    numeric('task', '单任务预算 (USD)', q.task),
    numeric('dailyTokens', '每日 tokens 上限', q.dailyTokens, false),
    numeric('requestsPerMinute', '每分钟请求数', q.requestsPerMinute, false),
    numeric('concurrency', '并发任务数', q.concurrency, false),
    ...pickModels(available, q.models),
  ];
}
function readQuota(d: any, available: string[]) {
  return {
    enabled: d.userEnabled,
    limits: readBudget(d),
    task: toMoney(d.task),
    dailyTokens: d.dailyTokens,
    requestsPerMinute: d.requestsPerMinute,
    concurrency: d.concurrency,
    models: chosenModels(d, available),
  };
}
const health: Record<string, string> = {
  READY: '项目模型权限已检查',
  ERROR: '异常',
  THROTTLED: '项目限流',
  REVOKED: '平台凭据已撤销',
  UNCHECKED: '等待检查',
  CHECK_PENDING: '等待 Worker 检查',
  CHECK_RUNNING: '检查中',
};
export function PlatformAiAccounts() {
  const { session, request, toast } = useApp();
  if (session.user.role !== 'Owner')
    return <Empty title="仅 Owner 可管理平台凭据" />;
  return <Accounts request={request} toast={toast} />;
}

function Accounts({
  request,
  toast,
}: Pick<ReturnType<typeof useApp>, 'request' | 'toast'>) {
  const info = useData<any>(base);
  const users = useData<Row[]>('/api/admin/users');
  const [account, setAccount] = useState<Row | 'new'>();
  const [rotate, setRotate] = useState<Row>();
  const [revoke, setRevoke] = useState<Row>();
  const [policyOpen, setPolicyOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const [quota, setQuota] = useState<{ id: string; value: any }>();
  const [busy, setBusy] = useState(false);
  const available: string[] = info.data?.models ?? [];
  const rows: Row[] = info.data?.accounts ?? [];
  const checking = rows.some((a) =>
    ['CHECK_PENDING', 'CHECK_RUNNING'].includes(a.health),
  );
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(info.refresh, 2500);
    return () => clearInterval(timer);
  }, [checking]);
  const policy = info.data?.policy;
  const editing = account && account !== 'new' ? account : undefined;
  const perform = async (run: () => Promise<unknown>, result: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
      toast(result);
      info.refresh();
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageTitle
        title="API 服务账户"
        description="AI 服务管理 · 统一管理 OpenAI 项目服务账户、预算和调度。"
      />
      <DataState
        error={info.error}
        loading={!info.data}
        onRetry={info.refresh}
      />
      {policy && (
        <Card title="平台服务与预算">
          <p>
            {policy.enabled ? '服务已启用' : '服务已停用'} · 本月预算{' '}
            {usd(policy.globalMonthly)}
          </p>
          <p>
            本月用量 {info.data.usage.input} 输入 tokens /{' '}
            {info.data.usage.output} 输出 tokens
          </p>
          <p>
            按标准费率结算 {usd(info.data.usage.charged)} · 预留或待结算{' '}
            {usd(info.data.usage.unsettled)}
          </p>
          <div className="actions">
            <button onClick={() => setPolicyOpen(true)}>
              分配策略和默认额度
            </button>
            <button onClick={info.refresh}>刷新</button>
          </div>
          <div className="fields">
            <label>
              个人额度
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              >
                <option value="">选择普通用户</option>
                {users.data
                  ?.filter((u) => u.role === 'Member')
                  .map((u) => (
                    <option value={u.id} key={u.id}>
                      {u.name} · {u.email}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={!userId || busy}
              onClick={() =>
                perform(async () => {
                  const value = await request(base + '/quota/' + userId);
                  setQuota({ id: userId, value });
                }, '已读取额度')
              }
            >
              管理个人额度
            </button>
          </div>
        </Card>
      )}
      {policy && (
        <Card
          title="项目服务账户"
          action={
            <button className="primary" onClick={() => setAccount('new')}>
              添加服务账户
            </button>
          }
        >
          {!rows.length && <Empty title="暂无平台服务账户" />}
          {rows.map((a) => (
            <details key={a.id}>
              <summary>
                {a.name} · {a.enabled ? '已启用' : '已停用'} ·{' '}
                {health[a.health]}
              </summary>
              <p>
                {a.has_key ? '密钥 •••••••• · ' : ''}
                {a.id} · {a.project_id} · {a.service_account_id} ·{' '}
                {a.models.join('、')}
              </p>
              <p>{a.note}</p>
              <p>
                月用量 {a.usage.input} / {a.usage.output} tokens · 已结算{' '}
                {usd(a.usage.charged)} · 预留或待结算 {usd(a.usage.unsettled)}
              </p>
              {a.last_error && <p role="alert">最近异常 {a.last_error}</p>}
              <div className="actions">
                <button onClick={() => setAccount(a)}>编辑</button>
                <button
                  disabled={
                    busy ||
                    a.health === 'REVOKED' ||
                    ['CHECK_PENDING', 'CHECK_RUNNING'].includes(a.health)
                  }
                  onClick={() =>
                    perform(
                      () =>
                        request(base + '/accounts/' + a.id + '/test', 'POST'),
                      '已请求 Worker 检查',
                    )
                  }
                >
                  测试连接
                </button>
                <button onClick={() => setRotate(a)}>轮换密钥</button>
                <button
                  disabled={a.health === 'REVOKED'}
                  onClick={() => setRevoke(a)}
                >
                  撤销平台凭据
                </button>
              </div>
            </details>
          ))}
        </Card>
      )}
      {policy && <PlatformAiModels accounts={rows} onSaved={info.refresh} />}
      <FormDialog
        open={!!account}
        onClose={() => setAccount(undefined)}
        title={editing ? '编辑服务账户' : '添加项目服务账户'}
        fields={[
          { name: 'name', label: '名称', value: editing?.name, required: true },
          { name: 'note', label: '备注', value: editing?.note },
          ...(!editing
            ? [
                {
                  name: 'projectId',
                  label: 'OpenAI Project ID',
                  required: true,
                },
                {
                  name: 'serviceAccountId',
                  label: 'OpenAI Service Account ID',
                  required: true,
                  // OpenAI Admin API 返回的服务账户编号以 user- 开头
                  // （文档示例 svc_acct_ 只是占位写法），两种前缀都接受。
                  help: '以 svc_acct_ 或 user- 开头的服务账户编号（不是显示名称或邮箱）。粘贴时首尾空格/换行会被自动去掉。',
                },
                keyField,
                attest,
              ]
            : [
                {
                  name: 'enabled',
                  label: '启用已通过检查的账户',
                  type: 'checkbox',
                  value: String(editing.enabled),
                },
              ]),
          ...budgetFields({
            daily: Number(editing?.daily_micros ?? 2_000_000),
            monthly: Number(editing?.monthly_micros ?? 10_000_000),
          }),
          numeric(
            'priority',
            '优先级（数值越小优先）',
            editing?.priority ?? 100,
            false,
          ),
          {
            name: 'audience',
            label: '指定共享用户 UUID（逗号分隔，留空对已授权用户开放）',
            value: editing?.allowed_users?.join(', '),
          },
          numeric(
            'concurrency',
            '账户并发限制',
            editing?.concurrency ?? 2,
            false,
          ),
          ...pickModels(available, editing?.models ?? available.slice(0, 1)),
        ]}
        onSubmit={async (d) => {
          // 凭据字段先 trim 再提交，与后端 accountSchema 的 trim 一致。
          const payload = {
            ...d,
            projectId:
              typeof d.projectId === 'string'
                ? d.projectId.trim()
                : d.projectId,
            serviceAccountId:
              typeof d.serviceAccountId === 'string'
                ? d.serviceAccountId.trim()
                : d.serviceAccountId,
            apiKey: typeof d.apiKey === 'string' ? d.apiKey.trim() : d.apiKey,
            note: d.note ?? '',
            priority: d.priority,
            allowedUsers: audienceIds(d.audience),
            enabled: d.enabled ?? false,
            limits: readBudget(d),
            models: chosenModels(d, available),
          };
          const result = await request<{ enabled?: boolean }>(
            base + '/accounts' + (editing ? '/' + editing.id : ''),
            editing ? 'PATCH' : 'POST',
            payload,
          );
          info.refresh();
          toast(
            editing
              ? d.enabled && !result.enabled
                ? '已保存，账户仍需通过连接检查'
                : '已保存'
              : '已保存，等待连接检查后启用',
          );
        }}
      />
      <FormDialog
        open={!!rotate}
        onClose={() => setRotate(undefined)}
        title="录入替换密钥"
        fields={[keyField, attest]}
        notice="替换后需重新测试并启用。旧密钥请在 OpenAI 项目中撤销。"
        onSubmit={async (d) => {
          await request(
            base + '/accounts/' + rotate!.id + '/credential',
            'POST',
            {
              action: 'rotate',
              ...d,
              apiKey: typeof d.apiKey === 'string' ? d.apiKey.trim() : d.apiKey,
            },
          );
          info.refresh();
        }}
      />
      <ConfirmDialog
        open={!!revoke}
        onClose={() => setRevoke(undefined)}
        title="撤销平台凭据"
        description="平台将停止使用并清除该凭据。请同时在 OpenAI 项目撤销上游密钥。"
        onConfirm={async () => {
          await request(
            base + '/accounts/' + revoke!.id + '/credential',
            'POST',
            { action: 'revoke' },
          );
          info.refresh();
        }}
      />
      {policy && (
        <FormDialog
          open={policyOpen}
          onClose={() => setPolicyOpen(false)}
          title="分配策略和默认额度"
          fields={[
            {
              name: 'enabled',
              label: '启用平台服务',
              type: 'checkbox',
              value: String(policy.enabled),
            },
            {
              name: 'routing',
              label: '分配策略',
              value: policy.routing,
              options: [
                { label: '按空闲程度均衡', value: 'BALANCED' },
                { label: '按连接检查时间', value: 'HEALTH' },
                { label: '指定服务账户', value: 'ACCOUNT' },
                { label: '指定项目', value: 'PROJECT' },
              ],
            },
            {
              name: 'target',
              label: '指定账户编号或 OpenAI Project ID',
              value: policy.target,
            },
            {
              name: 'allowTextAttachments',
              label: '允许对话上传小型文本文件',
              type: 'checkbox',
              value: String(policy.allowTextAttachments),
            },
            numeric('globalDaily', '全局每日预算 (USD)', policy.globalDaily),
            {
              name: 'timeZone',
              label: '额度重置时区（IANA）',
              value: policy.timeZone,
              required: true,
            },
            numeric('global', '全局每月预算 (USD)', policy.globalMonthly),
            ...budgetFields(policy.project, 'project_', '单个项目'),
            numeric(
              'maxOutput',
              '单任务输出 tokens 上限',
              policy.maxOutput,
              false,
            ),
            ...quotaFields(policy.defaultUser, available),
          ]}
          onSubmit={async (d) => {
            await request(base + '/policy', 'PATCH', {
              enabled: d.enabled,
              routing: d.routing,
              target: d.target ?? '',
              globalMonthly: toMoney(d.global),
              globalDaily: toMoney(d.globalDaily),
              timeZone: d.timeZone,
              allowTextAttachments: d.allowTextAttachments,
              project: readBudget(d, 'project_'),
              maxOutput: d.maxOutput,
              defaultUser: readQuota(d, available),
            });
            info.refresh();
          }}
        />
      )}
      {quota && (
        <FormDialog
          open
          onClose={() => setQuota(undefined)}
          title="设置个人 AI 额度"
          fields={quotaFields(quota.value, available)}
          onSubmit={async (d) => {
            await request(
              base + '/quota/' + quota.id,
              'PATCH',
              readQuota(d, available),
            );
            toast('个人额度已更新');
          }}
        />
      )}
    </>
  );
}
