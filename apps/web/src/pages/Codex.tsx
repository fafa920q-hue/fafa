import { useEffect, useState } from 'react';
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
  const service = useData<any>('/api/ai/service');
  const [add, setAdd] = useState(false);
  const [remove, setRemove] = useState<Row>();
  const [selected, setSelected] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [task, setTask] = useState<Row>();
  const [busy, setBusy] = useState(false);
  const writable = session.user.role !== 'Viewer';
  useEffect(() => {
    if (!selected && accounts.data?.length)
      setSelected(
        accounts.data.find((a) => a.selected)?.id || accounts.data[0].id,
      );
  }, [accounts.data, selected]);
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
  const account = accounts.data?.find((a) => a.id === selected);
  return (
    <>
      <PageTitle
        title="Codex 工作台"
        description="多账户独立管理，使用你自己的 OpenAI API 凭据。"
        action={
          writable && (
            <button className="primary" onClick={() => setAdd(true)}>
              <Plus size={16} />
              添加 API 账户
            </button>
          )
        }
      />
      <div className="stack">
        <div className="callout">
          API 模式独立计费，不使用 ChatGPT Plus
          订阅额度。命令输出仅作建议，本工作台不会自动执行 shell、写文件或部署。
        </div>
        <Card
          title="个人 Codex 授权 · 暂未开放"
          description="本站尚未完成官方个人授权接入。请勿上传 ChatGPT 登录令牌、Cookie 或 Codex 凭据文件。个人 API 账户与管理员 AI 服务使用各自的 API 额度。"
        >
          <p>当前可使用个人 OpenAI API 账户，或由管理员开放的 AI 服务。</p>
        </Card>
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
              {accounts.data?.map((a) => (
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
                      接入方式：OpenAI API · 凭据
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
                      className={selected === a.id ? 'primary' : ''}
                      onClick={() =>
                        request('/api/ai/select', 'POST', { accountId: a.id })
                          .then(() => {
                            setSelected(a.id);
                            accounts.refresh();
                            toast('已切换当前 API 账户');
                          })
                          .catch(() => {})
                      }
                    >
                      {selected === a.id ? '当前账户' : '切换账户'}
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
            {accounts.data?.length === 0 && (
              <Empty
                title="尚未连接 API 账户"
                description="添加自己的 API Key 后即可创建真实任务。"
              />
            )}
            <div className="section-space callout">
              <strong>Sign in with ChatGPT</strong>
              <p>
                暂未开放 · 尚未取得面板集成所需服务商授权。不会收集
                Cookies、auth.json 或设备码。
              </p>
              <button disabled>暂未开放</button>
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
                    prompt,
                    workspace,
                  });
                  setTask({ id: r.id, status: 'QUEUED', output: '' });
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
                  {service.data?.enabled && (
                    <option value="platform">管理员 AI 服务</option>
                  )}
                  {accounts.data?.map((a) => (
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
                <div className="task-output" aria-live="polite">
                  {task.output || task.error || '等待任务输出…'}
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
            {tasks.data?.map((t) => (
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
          {!tasks.data?.length && (
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
        title="添加 OpenAI API 账户"
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
            label: 'OpenAI API Key',
            type: 'password',
            required: true,
          },
        ]}
        onSubmit={async (d) => {
          await request('/api/ai_accounts', 'POST', d);
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
