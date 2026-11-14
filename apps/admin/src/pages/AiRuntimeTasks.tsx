import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Card,
  ConfirmDialog,
  DataState,
  Empty,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';

type Task = {
  id: string;
  ownerId: string;
  ownerName: string;
  ownerRole: string;
  accountId: string | null;
  provider: string;
  status: string;
  updatedAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
};

export function AiRuntimeTasks() {
  const { request, session, toast } = useApp();
  const tasks = useData<Task[]>('/api/admin/ai-tasks');
  const [pending, setPending] = useState<{
    target: 'task' | 'owner';
    id: string;
  }>();
  return (
    <Card
      title="AI 运行任务"
      description="API 请求共用 Worker。任务用量来自提供商回执。"
    >
      <div className="actions">
        <button type="button" onClick={tasks.refresh}>
          刷新
        </button>
        <Link className="button" to="/audit">
          查看审计记录
        </Link>
      </div>
      <DataState
        error={tasks.error}
        loading={!tasks.data}
        onRetry={tasks.refresh}
      />
      {tasks.data?.length === 0 && <Empty title="暂无 AI 任务" />}
      <div className="list">
        {tasks.data?.map((task) => {
          const active = ['QUEUED', 'RUNNING'].includes(task.status);
          const canStop =
            session.user.role === 'Owner' ||
            task.ownerId === session.user.id ||
            !['Owner', 'Admin'].includes(task.ownerRole);
          return (
            <article className="resource-card" key={task.id}>
              <div className="resource-top">
                <strong>
                  {task.ownerName} ·{' '}
                  {task.provider === 'ANTHROPIC_API'
                    ? 'Claude API'
                    : 'OpenAI API'}
                </strong>
                <Badge>{task.status}</Badge>
              </div>
              <p>
                任务 {task.id} · 账户 {task.accountId ?? '—'}
              </p>
              <p>
                更新 {new Date(task.updatedAt).toLocaleString('zh-CN')} · 输入{' '}
                {task.inputTokens ?? '—'} · 输出 {task.outputTokens ?? '—'}{' '}
                tokens
              </p>
              {task.error && <p>{task.error}</p>}
              {active && canStop && (
                <div className="actions">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => setPending({ target: 'task', id: task.id })}
                  >
                    强制停止任务
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPending({ target: 'owner', id: task.ownerId })
                    }
                  >
                    停止该用户的 API 任务
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <ConfirmDialog
        open={!!pending}
        title="确认停止 API 任务"
        description={
          pending?.target === 'owner'
            ? '取消该用户当前排队和执行中的请求。'
            : '取消选中的 API 请求。'
        }
        onClose={() => setPending(undefined)}
        onConfirm={async () => {
          if (!pending) return;
          const result = await request(
            '/api/admin/ai-tasks/cancel',
            'POST',
            pending,
          );
          toast('已取消 ' + result.cancelled + ' 个任务');
          tasks.refresh();
        }}
      />
    </Card>
  );
}
