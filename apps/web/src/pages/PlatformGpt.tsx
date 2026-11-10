// GPT-only 平台服务与额度页：Codex 工作台与任务页已随 Codex 功能取消。
import {
  Card,
  DataState,
  Empty,
  PageTitle,
  useData,
  type Row,
} from '../../../../packages/ui/src/core';

export type PlatformService = {
  mode: boolean;
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
export const dollars = (micros: number) =>
  'USD ' + (micros / 1_000_000).toFixed(6);
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
