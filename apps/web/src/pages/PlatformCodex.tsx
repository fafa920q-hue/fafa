import { useEffect } from 'react';
import {
  Card,
  DataState,
  Empty,
  PageTitle,
  useApp,
  useData,
  type Row,
} from '../../../../packages/ui/src/core';
import { Link } from 'react-router-dom';

export type PlatformService = {
  mode: boolean;
  claude?: boolean;
  codexRuntime?: boolean;
  allowTextAttachments?: boolean;
  models?: string[];
  catalog?: { id: string; label: string; default: boolean }[];
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
  QUEUED: '排队',
  PREPARING: '准备',
  RUNNING: '运行',
  APPROVAL_REQUIRED: '等待批准',
  COMPLETED: '成功',
  FAILED: '失败',
  CANCELLED: '取消',
  TIMEOUT: '超时',
};
export function PlatformCodex() {
  return (
    <>
      <PageTitle
        title="Codex 工作台"
        description="面向隔离代码执行的工作台。"
      />
      <Card title="原生任务执行">
        <p role="status">隔离执行服务尚未配置。原生任务提交暂未开放。</p>
        <p>模型、仓库和授权服务器会在执行服务通过验收后提供选择。</p>
        <Link to="/ai/tasks">查看我的任务</Link>
        {' · '}
        <Link to="/ai/chat">打开 GPT 对话</Link>
      </Card>
    </>
  );
}
export function MyAiTasks() {
  const { request, toast } = useApp();
  const tasks = useData<Row[]>('/api/ai/tasks');
  const active = tasks.data?.some((t) =>
    ['QUEUED', 'PREPARING', 'RUNNING', 'PAUSED', 'TESTING'].includes(t.status),
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(tasks.refresh, 2000);
    return () => clearInterval(timer);
  }, [active]);
  const control = async (task: Row, action: 'PAUSE' | 'RESUME' | 'CANCEL') => {
    try {
      if (task.kind === 'CODEX')
        await request('/api/ai/codex/tasks/' + task.id + '/control', 'POST', {
          action,
        });
      else await request('/api/ai/tasks/' + task.id + '/cancel', 'POST');
      tasks.refresh();
    } catch (error) {
      toast((error as Error).message);
    }
  };
  return (
    <>
      <PageTitle
        title="我的任务"
        description="查看当前账户的任务状态和输出。"
        action={<button onClick={tasks.refresh}>刷新</button>}
      />
      <Card title="任务记录">
        <DataState
          error={tasks.error}
          loading={!tasks.data}
          onRetry={tasks.refresh}
        />
        {tasks.data?.length === 0 && <Empty title="暂无任务" />}
        {tasks.data?.map((task) => (
          <details key={task.id}>
            <summary>
              {status[task.status] || task.status} · {task.model || '历史任务'}{' '}
              · {new Date(task.createdAt).toLocaleString()}
            </summary>
            {task.workspace && <p>{task.workspace}</p>}
            <p>{task.prompt}</p>
            {task.output && (
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {task.output}
              </pre>
            )}
            {task.error && <p role="alert">{task.error}</p>}
            {task.repository && (
              <p>
                {task.repository} · {task.commit}
              </p>
            )}
            {task.patch && (
              <details>
                <summary>查看变更补丁</summary>
                <pre
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {task.patch}
                </pre>
              </details>
            )}
            {task.kind === 'CODEX' && task.status === 'RUNNING' && (
              <button
                disabled={!!task.requestedAction}
                onClick={() => control(task, 'PAUSE')}
              >
                暂停
              </button>
            )}
            {task.kind === 'CODEX' && task.status === 'PAUSED' && (
              <button
                disabled={!!task.requestedAction}
                onClick={() => control(task, 'RESUME')}
              >
                恢复
              </button>
            )}
            {['QUEUED', 'PREPARING', 'RUNNING', 'PAUSED', 'TESTING'].includes(
              task.status,
            ) && (
              <button
                disabled={task.requestedAction === 'CANCEL'}
                onClick={() => control(task, 'CANCEL')}
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
export function MyAiQuota() {
  const service = useData<PlatformService>('/api/ai/platform');
  const quota = service.data?.quota;
  return (
    <>
      <PageTitle
        title="我的额度"
        description="查看当前账户的预算、实际用量和预留记录。"
      />
      <DataState
        error={service.error}
        loading={!service.data}
        onRetry={service.refresh}
      />
      {quota ? (
        <Card
          title="个人额度"
          action={<button onClick={service.refresh}>刷新</button>}
        >
          <p>
            今日剩余 {dollars(quota.daily)} · 本月剩余 {dollars(quota.monthly)}{' '}
            · 并发 {quota.concurrency} 个
          </p>
          <p>
            本月按用量计算 {dollars(quota.charged)} · 输入 {quota.input} tokens
            · 输出 {quota.output} tokens
          </p>
          <UsageHistory />
        </Card>
      ) : (
        service.data && (
          <Card title="个人额度">
            <Empty title="平台额度尚未开放" />
          </Card>
        )
      )}
    </>
  );
}
function UsageHistory() {
  const usage = useData<Row[]>('/api/ai/platform/usage');
  return (
    <>
      <h3>最近用量</h3>
      <DataState
        error={usage.error}
        loading={!usage.data}
        onRetry={usage.refresh}
      />
      {usage.data?.length === 0 && <Empty title="暂无消耗记录" />}
      {usage.data?.map((r) => (
        <p key={r.id}>
          {new Date(r.created_at).toLocaleString()} · {r.model} ·
          {r.charged_micros == null
            ? ' 预留 ' + dollars(Number(r.reserved_micros))
            : ' 用量 ' +
              (r.input_tokens ?? 0) +
              ' 输入 / ' +
              (r.output_tokens ?? 0) +
              ' 输出 · ' +
              dollars(Number(r.charged_micros))}
        </p>
      ))}
    </>
  );
}
