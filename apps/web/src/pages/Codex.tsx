import { useEffect, useMemo, useState } from 'react';
import type { AiProvider } from '../../../../packages/shared/src';
import { backendUrl } from '../../../../packages/ui/src/endpoints';
import { Code2, Plus, ExternalLink, Send, Square } from 'lucide-react';
import {
  Card,
  PageTitle,
  useData,
  useApp,
  FormDialog,
  ConfirmDialog,
  Empty,
  Badge,
  DataState,
  type Row,
} from '../../../../packages/ui/src/core';
export function Codex() {
  const { request, toast, session } = useApp();
  const accounts = useData<Row[]>('/api/ai_accounts');
  const tasks = useData<Row[]>('/api/ai/tasks');
  const service = useData<{
    enabled: boolean;
    claudeApi?: 'AVAILABLE' | 'UNAVAILABLE';
    quota: { dailyLimit: number; concurrency: number };
    chatgptAuthorization?: 'DISABLED' | 'AWAITING_PROVIDER_APPROVAL';
  }>('/api/ai/service');
  const [provider, setProvider] = useState<AiProvider>('OPENAI_API');
  const [add, setAdd] = useState(false);
  const [remove, setRemove] = useState<Row>();
  const [selected, setSelected] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [task, setTask] = useState<Row>();
  const [busy, setBusy] = useState(false);
  const writable = session.user.role !== 'Viewer';
  const isClaude = provider === 'ANTHROPIC_API';
  const engine = isClaude ? 'Claude' : 'Codex';
  const apiName = isClaude ? 'Anthropic' : 'OpenAI';
  const available = !isClaude || service.data?.claudeApi === 'AVAILABLE';
  const providerAccounts = useMemo(
    () =>
      accounts.data?.filter((a) => (a.provider ?? 'OPENAI_API') === provider),
    [accounts.data, provider],
  );
  const providerTasks = tasks.data?.filter(
    (t) => (t.provider ?? 'OPENAI_API') === provider,
  );
  useEffect(() => {
    if (selected === 'platform' && provider === 'OPENAI_API') return;
    if (providerAccounts && !providerAccounts.some((a) => a.id === selected))
      setSelected(
        providerAccounts.find((a) => a.selected)?.id ||
          (provider === 'OPENAI_API' ? providerAccounts[0]?.id : '') ||
          '',
      );
  }, [provider, providerAccounts, selected]);
  useEffect(() => {
    if (!task?.id || !['QUEUED', 'RUNNING'].includes(task.status)) return;
    const events = new EventSource(
      backendUrl(`/api/ai/tasks/${task.id}/events`),
      {
        withCredentials: true,
      },
    );
    events.onmessage = (e) => {
      const d = JSON.parse(e.data);
      setTask((t) => ({ ...t!, ...d }));
      if (!['QUEUED', 'RUNNING'].includes(d.status)) {
        events.close();
        tasks.refresh();
        accounts.refresh();
      }
    };
    events.onerror = () => {
      events.close();
      tasks.refresh();
    };
    return () => events.close();
  }, [task?.id]);
  const account = providerAccounts?.find((a) => a.id === selected);
  return (
    <>
      <PageTitle
        title={engine + ' 工作台'}
        description="在 AI 工作台选择引擎、个人账户和任务。"
        action={
          writable &&
          available && (
            <button className="primary" onClick={() => setAdd(true)}>
              <Plus size={16} />
              添加 API 账户
            </button>
          )
        }
      />
      <div className="stack">
        <div className="actions" role="group" aria-label="AI 引擎">
          {(['OPENAI_API', 'ANTHROPIC_API'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={provider === choice}
              className={provider === choice ? 'primary' : ''}
              onClick={() => {
                if (provider === choice) return;
                setProvider(choice);
                setSelected('');
                setTask(undefined);
              }}
            >
              {choice === 'OPENAI_API' ? 'Codex' : 'Claude'}
            </button>
          ))}
        </div>
        <div className="callout">
          {isClaude
            ? 'Claude API 费用由所选 Anthropic 账户承担。'
            : 'API 模式独立计费，不使用 ChatGPT Plus 订阅额度。'}
          命令输出仅作建议，本工作台不会自动执行 shell、写文件或部署。
        </div>
        {isClaude ? (
          <Card title="Claude 原生 CLI · 暂未开放">
            <p>
              {available
                ? '可添加个人 Anthropic API Key。'
                : 'Claude API 当前未启用。'}
            </p>
          </Card>
        ) : (
          <Card
            title="个人 Codex 授权 · 暂未开放"
            description="通过 OpenAI 官方授权连接自己的 ChatGPT 账户。"
          >
            <p role="status">
              {service.error
                ? '暂时无法读取 ChatGPT 授权状态。'
                : !service.data
                  ? '正在读取 ChatGPT 授权状态。'
                  : service.data.chatgptAuthorization ===
                      'AWAITING_PROVIDER_APPROVAL'
                    ? '等待 OpenAI 托管应用授权。'
                    : '本站的 ChatGPT 网页授权尚未启用。'}
            </p>
            <div className="actions">
              <button type="button" disabled>
                Continue with ChatGPT
              </button>
              <a
                className="button"
                href="https://chatgpt.com/codex"
                target="_blank"
                rel="noopener noreferrer"
              >
                打开官方 Codex Cloud
                <ExternalLink size={13} />
              </a>
            </div>
          </Card>
        )}
        <div className="two-col">
          <Card
            title="账户中心"
            description="按用户加密保存，管理员无法查看密钥明文"
            icon={Code2}
          >
            <DataState
              error={accounts.error}
              loading={!accounts.data}
              onRetry={accounts.refresh}
            />
            <div className="list">
              {providerAccounts?.map((a) => (
                <div className="resource-card" key={a.id}>
                  <div className="resource-top">
                    <h3>{a.name}</h3>
                    <Badge
                      tone={a.status === 'VERIFIED' ? 'success' : 'neutral'}
                    >
                      {a.demo
                        ? '演示 · 未配置'
                        : a.status === 'VERIFIED'
                          ? '已验证'
                          : '待验证'}
                    </Badge>
                  </div>
                  <div className="resource-meta">
                    <span>
                      接入方式：{apiName} API · 凭据
                      {a.credentialConfigured ? '已加密配置' : '未配置'}
                    </span>
                    <span>
                      最近验证：
                      {a.verifiedAt
                        ? new Date(a.verifiedAt).toLocaleString('zh-CN')
                        : '尚未验证'}
                    </span>
                  </div>
                  <div className="actions">
                    <button
                      disabled={!writable}
                      className={a.selected ? 'primary' : ''}
                      onClick={() =>
                        request('/api/ai/select', 'POST', { accountId: a.id })
                          .then(() => {
                            setSelected(a.id);
                            accounts.refresh();
                            toast('已设为此引擎的默认账户');
                          })
                          .catch(() => {})
                      }
                    >
                      {a.selected ? '默认账户' : '设为默认并切换'}
                    </button>
                    {writable && (
                      <button className="danger" onClick={() => setRemove(a)}>
                        删除
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {providerAccounts?.length === 0 && (
              <Empty
                title="尚未连接 API 账户"
                description="添加自己的 API Key 后即可创建真实任务。"
              />
            )}
          </Card>
          <Card
            title="API 助手"
            description={`个人每日额度 ${service.data?.quota?.dailyLimit ?? '加载中'} 次 · 并发 ${service.data?.quota?.concurrency ?? '加载中'} 个；管理员服务另受全站额度限制`}
            icon={Send}
          >
            <form
              className="fields"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const r = await request('/api/ai/tasks', 'POST', {
                    ...(selected === 'platform'
                      ? { service: true }
                      : { accountId: selected }),
                    provider,
                    prompt,
                    workspace,
                  });
                  setTask({
                    id: r.id,
                    status: 'QUEUED',
                    output: '',
                    provider,
                    accountId: selected === 'platform' ? undefined : selected,
                    service: selected === 'platform',
                  });
                  setPrompt('');
                  tasks.refresh();
                } catch {
                  /* 错误由统一提示显示 */
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                执行账户
                <select
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  required
                  aria-label="执行账户"
                >
                  <option value="" disabled>
                    请选择 API 账户
                  </option>
                  {!isClaude && service.data?.enabled && (
                    <option value="platform">管理员 AI 服务</option>
                  )}
                  {providerAccounts?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                工作区 / GitHub 项目备注
                <input
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  maxLength={300}
                  placeholder="owner/repository（仅关联说明，不读取仓库）"
                />
              </label>
              <label>
                任务描述
                <textarea
                  rows={5}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  required
                  maxLength={16000}
                  placeholder="描述你的问题，输出的命令须自行审查后执行…"
                />
              </label>
              <button
                className="primary"
                disabled={
                  busy ||
                  !available ||
                  !writable ||
                  !(selected === 'platform'
                    ? service.data?.enabled
                    : account?.credentialConfigured) ||
                  session.demo
                }
              >
                <Send size={16} />
                {session.demo
                  ? '演示模式 · 不调用 API'
                  : selected === 'platform' || account?.credentialConfigured
                    ? '创建真实 API 任务'
                    : '请先配置 API Key'}
              </button>
            </form>
            {task && (
              <div className="section-space">
                <div className="resource-top">
                  <Badge>{task.status}</Badge>
                  {['QUEUED', 'RUNNING'].includes(task.status) && (
                    <button
                      onClick={() =>
                        request(`/api/ai/tasks/${task.id}/cancel`, 'POST')
                          .then(() => {
                            setTask((t) => ({ ...t!, status: 'CANCELLED' }));
                            tasks.refresh();
                          })
                          .catch(() => {})
                      }
                    >
                      <Square size={13} />
                      取消
                    </button>
                  )}
                </div>
                <p>
                  {engine} ·{' '}
                  {task.service
                    ? '管理员 AI 服务'
                    : (providerAccounts?.find((a) => a.id === task.accountId)
                        ?.name ?? '历史账户')}
                </p>
                {task.usage && (
                  <p>
                    输入 {task.usage.input_tokens ?? '—'} tokens · 输出{' '}
                    {task.usage.output_tokens ?? '—'} tokens
                  </p>
                )}
                {task.error && <p role="alert">{task.error}</p>}
                <div className="task-output" aria-live="polite">
                  {task.output || (!task.error && '等待任务输出…')}
                </div>
              </div>
            )}
          </Card>
        </div>
        <Card
          title="最近任务与恢复"
          description="点击已保存任务查看输出，不共享其他用户的会话"
        >
          <div className="list">
            {providerTasks?.map((t) => (
              <button
                className="list-item"
                key={t.id}
                onClick={() => setTask(t)}
              >
                <div>
                  <strong>{t.prompt?.slice(0, 80)}</strong>
                  <small>{new Date(t.createdAt).toLocaleString('zh-CN')}</small>
                </div>
                <Badge>{t.status}</Badge>
              </button>
            ))}
          </div>
          {!providerTasks?.length && (
            <Empty
              title="暂无任务"
              description="配置凭据并关闭演示模式后，任务将通过后台 Worker 执行。"
            />
          )}
        </Card>
      </div>
      <FormDialog
        open={add}
        onClose={() => setAdd(false)}
        title={'添加 ' + apiName + ' API 账户'}
        notice="仅接受你有权使用的 API Key。后端信封加密保存；不在浏览器缓存密钥。"
        fields={[
          {
            name: 'name',
            label: '账户昵称',
            required: true,
            placeholder: '主用 / 开发 / 测试',
          },
          {
            name: 'apiKey',
            label: apiName + ' API Key',
            type: 'password',
            required: true,
          },
        ]}
        onSubmit={async (d) => {
          await request('/api/ai_accounts', 'POST', { ...d, provider });
          accounts.refresh();
          toast('账户已保存，尚未执行真实验证');
        }}
      />
      <ConfirmDialog
        open={!!remove}
        title="删除 API 账户？"
        description="此账户将不可再用于新的任务。已有任务记录仍保留。"
        onClose={() => setRemove(undefined)}
        onConfirm={async () => {
          await request('/api/ai_accounts/' + remove!.id, 'DELETE');
          if (selected === remove!.id) setSelected('');
          accounts.refresh();
        }}
      />
    </>
  );
}
