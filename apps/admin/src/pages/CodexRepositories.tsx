import { useState } from 'react';
import {
  Card,
  DataState,
  Empty,
  FormDialog,
  useApp,
  useData,
  type Row,
} from '../../../../packages/ui/src/core';
import { audienceIds } from './PlatformAiModels';

const api = '/api/admin/codex/repositories';
export function CodexRepositories() {
  const list = useData<Row[]>(api);
  const { request, toast } = useApp();
  const [item, setItem] = useState<Row | 'new'>();
  const row = item === 'new' ? undefined : item;
  return (
    <Card
      title="Codex 仓库授权"
      action={<button onClick={() => setItem('new')}>登记 GitHub 提交</button>}
    >
      <p>
        仅登记公开仓库和固定提交。用户只可选择已获授权的版本，任务变更不会推送到
        GitHub。
      </p>
      <DataState
        error={list.error}
        loading={!list.data}
        onRetry={list.refresh}
      />
      {list.data?.length === 0 && <Empty title="暂无授权仓库" />}
      {list.data?.map((repo) => (
        <details key={repo.id}>
          <summary>
            {repo.github_owner}/{repo.github_repo} ·{' '}
            {repo.commit_sha.slice(0, 12)} ·{' '}
            {repo.enabled ? '已启用' : '已停用'}
          </summary>
          <p>
            {repo.allowed_users
              ? '已指定 ' + repo.allowed_users.length + ' 个用户'
              : '向具备 AI 权限的用户开放'}
          </p>
          <p>
            {repo.test_recipe === 'NODE_TEST'
              ? '允许用户批准 node --test'
              : '仅允许文件读取和修改'}
          </p>
          <button onClick={() => setItem(repo)}>编辑授权</button>
        </details>
      ))}
      <FormDialog
        open={!!item}
        onClose={() => setItem(undefined)}
        title={row ? '编辑仓库授权' : '登记公开 GitHub 仓库'}
        fields={[
          ...(!row
            ? [
                { name: 'githubOwner', label: 'GitHub Owner', required: true },
                { name: 'githubRepo', label: '仓库名称', required: true },
                {
                  name: 'commitSha',
                  label: '固定 Git 提交 SHA（40 位）',
                  required: true,
                },
              ]
            : []),
          {
            name: 'enabled',
            label: '启用仓库授权',
            type: 'checkbox',
            value: String(row?.enabled ?? false),
          },
          {
            name: 'audience',
            label: '指定用户 UUID（逗号分隔，留空对已授权用户开放）',
            value: row?.allowed_users?.join(', '),
          },
          {
            name: 'testRecipe',
            label: '可批准的测试',
            value: row?.test_recipe ?? 'NONE',
            options: [
              { value: 'NONE', label: '不运行命令' },
              { value: 'NODE_TEST', label: 'Node 内置测试 · node --test' },
            ],
          },
        ]}
        onSubmit={async (d) => {
          const payload = {
            enabled: d.enabled,
            allowedUsers: audienceIds(d.audience),
            testRecipe: d.testRecipe,
            ...(!row
              ? {
                  githubOwner: d.githubOwner,
                  githubRepo: d.githubRepo,
                  commitSha: d.commitSha,
                }
              : {}),
          };
          await request(
            row ? api + '/' + row.id : api,
            row ? 'PATCH' : 'POST',
            payload,
          );
          toast('仓库授权已保存');
          list.refresh();
        }}
      />
    </Card>
  );
}
