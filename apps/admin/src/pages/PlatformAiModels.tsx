import { useState } from 'react';
import {
  Card,
  DataState,
  Empty,
  FormDialog,
  useApp,
  useData,
  type Field,
  type Row,
} from '../../../../packages/ui/src/core';

const api = '/api/admin/ai-platform/models';
const toggle = (name: string, label: string, value: boolean): Field => ({
  name,
  label,
  type: 'checkbox',
  value: String(value),
});
const amount = (name: string, label: string, value: number): Field => ({
  name,
  label,
  type: 'number',
  required: true,
  min: 0,
  step: '0.000001',
  value: String(value),
});
const micros = (value: number) => Math.round(value * 1_000_000);
const usd = (value?: number) => (value ?? 0) / 1_000_000;
export function audienceIds(value?: string) {
  return value?.trim() ? [...new Set(value.trim().split(/[\s,，]+/))] : null;
}

export function PlatformAiModels({
  accounts,
  onSaved,
}: {
  accounts: Row[];
  onSaved: () => void;
}) {
  const data = useData<Row[]>(api);
  const { request, toast } = useApp();
  const [draft, setDraft] = useState<Row | 'new'>();
  const model = draft === 'new' ? undefined : draft;
  return (
    <Card
      title="模型管理"
      action={<button onClick={() => setDraft('new')}>添加模型</button>}
    >
      <p>
        供应商 OpenAI。给模型分配服务账户后，在对应账户运行连接检查。Codex
        能力配置会在隔离执行服务验收后生效。
      </p>
      <DataState
        error={data.error}
        loading={!data.data}
        onRetry={data.refresh}
      />
      {data.data?.length === 0 && <Empty title="暂无模型" />}
      {data.data?.map((row) => (
        <details key={row.model_id}>
          <summary>
            {row.display_name} · {row.enabled ? '已启用' : '已停用'}
          </summary>
          <p>
            {row.model_id} · {row.ready_accounts} 个已验证并启用的账户 · 累计{' '}
            {row.usage_tokens} tokens
          </p>
          <p>
            {row.supports_chat ? 'GPT 对话' : ''}
            {row.supports_codex ? ' · Codex 能力待验收' : ''}
            {row.default_chat ? ' · GPT 默认' : ''}
            {row.default_codex ? ' · Codex 默认配置' : ''}
          </p>
          <p>
            关联服务账户{' '}
            {accounts
              .filter((account) => account.models.includes(row.model_id))
              .map((a) => a.name)
              .join('、') || '暂无'}
          </p>
          <button onClick={() => setDraft(row)}>编辑模型</button>
        </details>
      ))}
      <FormDialog
        open={!!draft}
        onClose={() => setDraft(undefined)}
        title={model ? '编辑模型' : '添加 OpenAI 模型'}
        fields={[
          ...(!model
            ? [
                {
                  name: 'id',
                  label: '完整 API 模型 ID',
                  required: true,
                  placeholder: 'gpt-6.1-terra',
                },
              ]
            : []),
          {
            name: 'displayName',
            label: '显示名称',
            required: true,
            value: model?.display_name,
          },
          toggle('enabled', '启用模型', model?.enabled ?? false),
          toggle('supportsChat', '允许 GPT 对话', model?.supports_chat ?? true),
          toggle(
            'supportsCodex',
            '登记 Codex 能力',
            model?.supports_codex ?? false,
          ),
          toggle(
            'defaultChat',
            '设为 GPT 默认模型',
            model?.default_chat ?? false,
          ),
          toggle(
            'defaultCodex',
            '设为 Codex 默认模型',
            model?.default_codex ?? false,
          ),
          {
            name: 'audience',
            label: '限定用户 UUID（逗号分隔，留空表示按原有权限）',
            value: model?.allowed_users?.join(', '),
          },
          amount(
            'context',
            '输入 tokens 上限（256–262144）',
            model?.pricing.context ?? 32768,
          ),
          amount(
            'input',
            '标准输入 USD / 百万 tokens',
            usd(model?.pricing.input),
          ),
          amount(
            'cached',
            '缓存读取 USD / 百万 tokens',
            usd(model?.pricing.cached),
          ),
          amount(
            'cacheWrite',
            '缓存写入 USD / 百万 tokens（0 表示使用输入费率）',
            usd(model?.pricing.cacheWrite),
          ),
          amount(
            'output',
            '标准输出 USD / 百万 tokens',
            usd(model?.pricing.output),
          ),
          amount(
            'task',
            '单次费用上限 USD',
            usd(model?.task_micros ?? 1_000_000),
          ),
        ]}
        onSubmit={async (d) => {
          await request(
            api + '/' + encodeURIComponent(model?.model_id ?? d.id),
            'PUT',
            {
              displayName: d.displayName,
              enabled: d.enabled,
              supportsChat: d.supportsChat,
              supportsCodex: d.supportsCodex,
              defaultChat: d.defaultChat,
              defaultCodex: d.defaultCodex,
              allowedUsers: audienceIds(d.audience),
              pricing: {
                context: d.context,
                input: micros(d.input),
                cached: micros(d.cached),
                output: micros(d.output),
                ...(d.cacheWrite > 0
                  ? { cacheWrite: micros(d.cacheWrite) }
                  : {}),
              },
              taskMicros: micros(d.task),
            },
          );
          toast('模型配置已保存');
          data.refresh();
          onSaved();
        }}
      />
    </Card>
  );
}
