import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Card,
  DataState,
  PageTitle,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';

export type CodexConfig = {
  enabled: boolean;
  ready: boolean;
  repositories: {
    id: string;
    github_owner: string;
    github_repo: string;
    commit_sha: string;
    test_recipe: 'NONE' | 'NODE_TEST';
  }[];
  models: { id: string; label: string; default: boolean }[];
};
export function NativeCodex({
  config,
}: {
  config: ReturnType<typeof useData<CodexConfig>>;
}) {
  const { request, toast } = useApp();
  const [repoId, setRepo] = useState('');
  const [modelId, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [approval, setApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; id: string } | undefined>(undefined);
  const locked = useRef(false);
  const ready = config.data?.ready;
  const repo =
    config.data?.repositories.find((r) => r.id === repoId) ??
    config.data?.repositories[0];
  const model =
    config.data?.models.find((m) => m.id === modelId) ?? config.data?.models[0];
  useEffect(() => {
    const timer = setInterval(config.refresh, 15_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <PageTitle
        title="Codex 工作台"
        description="在独立容器中读取和编辑固定提交，查看变更补丁和批准的测试日志。"
      />
      <Card title="提交编程任务" action={<Link to="/ai/tasks">我的任务</Link>}>
        <DataState
          error={config.error}
          loading={!config.data}
          onRetry={config.refresh}
        />
        {config.data && !ready && <p role="status">执行服务暂不可用。</p>}
        {ready && (!repo || !model) && (
          <p role="status">当前没有同时授权的仓库和模型，请联系管理员。</p>
        )}
        {ready && repo && model && (
          <form
            className="fields"
            onSubmit={async (event) => {
              event.preventDefault();
              if (locked.current || !prompt.trim()) return;
              locked.current = true;
              setBusy(true);
              const data = {
                repositoryId: repo.id,
                model: model.id,
                prompt,
                approveTests: approval && repo.test_recipe === 'NODE_TEST',
              };
              const key = JSON.stringify(data);
              if (pending.current?.key !== key)
                pending.current = { key, id: crypto.randomUUID() };
              try {
                await request('/api/ai/codex/tasks', 'POST', {
                  ...data,
                  requestId: pending.current.id,
                });
                toast('Codex 任务已排队，请在我的任务查看进度');
                setPrompt('');
                setApproval(false);
                pending.current = undefined;
              } catch (error) {
                toast((error as Error).message);
                config.refresh();
              } finally {
                setBusy(false);
                locked.current = false;
              }
            }}
          >
            <label>
              GitHub 仓库
              <select
                aria-label="GitHub 仓库"
                value={repo.id}
                onChange={(e) => {
                  setRepo(e.target.value);
                  setApproval(false);
                }}
              >
                {config.data?.repositories.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.github_owner}/{r.github_repo} ·{' '}
                    {r.commit_sha.slice(0, 12)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              模型
              <select
                aria-label="模型"
                value={model.id}
                onChange={(e) => setModel(e.target.value)}
              >
                {config.data?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              任务描述
              <textarea
                required
                maxLength={10000}
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            {repo.test_recipe === 'NODE_TEST' && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={approval}
                  onChange={(e) => setApproval(e.target.checked)}
                />
                我批准本任务在单独的无网络容器中运行 node --test
              </label>
            )}
            <button className="primary" disabled={busy || !prompt.trim()}>
              开始执行
            </button>
          </form>
        )}
        <p className="muted">
          仓库变更以补丁返回。执行容器只开放本任务的文件工具。
        </p>
      </Card>
    </>
  );
}
