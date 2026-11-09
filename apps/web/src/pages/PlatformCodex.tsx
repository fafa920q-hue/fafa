import { useEffect, useRef, useState } from 'react';
import {
  Card,
  DataState,
  Empty,
  PageTitle,
  useApp,
  useData,
  type Row,
} from '../../../../packages/ui/src/core';

export type PlatformService = {
  mode: boolean;
  claude?: boolean;
  models?: string[];
  quota?: {
    daily: number;
    monthly: number;
    concurrency: number;
    charged: number;
    input: number;
    output: number;
  };
};
const dollars = (micros: number) => 'USD ' + (micros / 1_000_000).toFixed(6);
const status: Record<string, string> = {
  QUEUED: '等待执行',
  RUNNING: '执行中',
  COMPLETED: '完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  TIMEOUT: '超时',
};
export function PlatformCodex({
  service,
}: {
  service: ReturnType<typeof useData<PlatformService>>;
}) {
  const { request, toast } = useApp();
  const tasks = useData<Row[]>('/api/ai/tasks');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const models = service.data?.models ?? [];
  const chosen = models.includes(model) ? model : (models[0] ?? '');
  const quota = service.data?.quota;
  const history =
    tasks.data?.filter((task) => task.provider === 'OPENAI_API') ?? [];
  const active = history.some((task) =>
    ['QUEUED', 'RUNNING'].includes(task.status),
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      tasks.refresh();
      service.refresh();
    }, 2500);
    return () => clearInterval(timer);
  }, [active]);
  return (
    <>
      <PageTitle
        title="Codex 工作台"
        description="使用平台提供的 OpenAI 服务，选择模型并提交任务。"
      />
      <Card title="平台 AI 服务">
        {models.length ? (
          <p role="status">服务可用</p>
        ) : (
          <p role="status">当前没有可用模型，请联系管理员或稍后刷新。</p>
        )}
        <button
          onClick={() => {
            service.refresh();
            tasks.refresh();
          }}
        >
          刷新状态
        </button>
        {quota && (
          <p>
            今日剩余 {dollars(quota.daily)} · 本月剩余 {dollars(quota.monthly)}{' '}
            · 并发 {quota.concurrency} 个
          </p>
        )}
        <DataState
          error={service.error}
          loading={!service.data}
          onRetry={service.refresh}
        />
        <form
          className="fields"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!chosen || !prompt.trim() || submitting.current) return;
            submitting.current = true;
            setBusy(true);
            try {
              await request('/api/ai/platform/tasks', 'POST', {
                model: chosen,
                prompt,
                workspace,
              });
              setPrompt('');
              tasks.refresh();
              service.refresh();
              toast('任务已提交');
            } catch (error) {
              toast((error as Error).message);
              service.refresh();
            } finally {
              setBusy(false);
              submitting.current = false;
            }
          }}
        >
          <label>
            模型
            <select
              value={chosen}
              onChange={(e) => setModel(e.target.value)}
              disabled={!models.length}
            >
              {!models.length && <option value="">暂无可用模型</option>}
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            GitHub 项目备注
            <input
              maxLength={300}
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="owner/repository（仅关联说明）"
            />
          </label>
          <label>
            任务描述
            <textarea
              required
              rows={5}
              maxLength={16000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={busy || !chosen || !prompt.trim()}
          >
            开始执行
          </button>
        </form>
        <p className="muted">
          当前任务生成文本建议。个人 ChatGPT 授权暂未开放。
        </p>
      </Card>
      <Card title="任务与用量">
        {quota && (
          <p>
            本月已结算 {dollars(quota.charged)} · 输入 {quota.input} tokens ·
            输出 {quota.output} tokens
          </p>
        )}
        <DataState
          error={tasks.error}
          loading={!tasks.data}
          onRetry={tasks.refresh}
        />
        {tasks.data && !history.length && <Empty title="暂无任务" />}
        {history.map((task) => (
          <details key={task.id}>
            <summary>
              {status[task.status] || task.status} · {task.model || '历史任务'}{' '}
              · {new Date(task.createdAt).toLocaleString()}
            </summary>
            <p>{task.workspace}</p>
            <p>{task.prompt}</p>
            {task.output && (
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {task.output}
              </pre>
            )}
            {task.error && <p role="alert">{task.error}</p>}
            {['QUEUED', 'RUNNING'].includes(task.status) && (
              <button
                onClick={async () => {
                  try {
                    await request(
                      '/api/ai/tasks/' + task.id + '/cancel',
                      'POST',
                    );
                    tasks.refresh();
                    service.refresh();
                  } catch (error) {
                    toast((error as Error).message);
                  }
                }}
              >
                取消任务
              </button>
            )}
          </details>
        ))}
      </Card>
    </>
  );
}
