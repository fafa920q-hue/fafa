import { DataState, Empty, PageTitle, useData } from '../../../../packages/ui/src/core';
import { PlatformAiModels } from './PlatformAiModels';

export function AiModelsAdmin() {
  const info = useData<any>('/api/admin/ai-platform');
  const rows = info.data?.accounts ?? [];
  const policy = info.data?.policy;
  return (
    <div>
      <PageTitle title="AI 模型管理" description="查看上游模型清單與健康狀態，並調整可用模型與每月額度上限。變更將寫入操作審計。未配置上游帳號時，此頁顯示未配置狀態。" />
      <DataState error={info.error || ''} loading={!info.data} onRetry={info.refresh} />
      {info.data && !policy ? (
        <Empty title="尚未配置 AI 政策" description="目前沒有可用的 AI 模型政策，請先到「API Key 管理」完成上游帳號配置。" />
      ) : null}
      {policy ? <PlatformAiModels accounts={rows} onSaved={info.refresh} /> : null}
    </div>
  );
}
