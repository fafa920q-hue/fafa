import { useState } from 'react';
import { Badge, Card, DataState, Dialog, Empty, PageTitle, useApp, useData } from '../../../../packages/ui/src/core';
import { nodeFlagLabel, nodeFlagScope, nodeStateAction } from '../../../../packages/shared/src/admin-nodes';
import type { NodeAdminFlag } from '../../../../packages/shared/src/admin-nodes';

export interface AdminNodeItem {
  id: string;
  name: string;
  group: string;
  kind: string;
  enabled: boolean;
  distributionStopped: boolean;
  hidden: boolean;
  serviceStopped: boolean;
  nodeCount: number;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  updatedAt: string;
}

type Field = 'distribution' | 'visibility' | 'service';

const FIELD_OF: Record<Field, NodeAdminFlag> = {
  distribution: 'distributionStopped',
  visibility: 'hidden',
  service: 'serviceStopped',
};

interface Pending {
  item: AdminNodeItem;
  field: Field;
  value: boolean;
}

function stateBadge(ok: boolean, onLabel: string, offLabel: string) {
  return ok ? <Badge tone="success">{onLabel}</Badge> : <Badge tone="warning">{offLabel}</Badge>;
}

export function NodesAdmin() {
  const { request } = useApp();
  const query = useData<AdminNodeItem[]>('/api/admin/nodes');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const items = query.data || [];
  const stoppedDistribution = items.filter((item) => item.distributionStopped).length;
  const hidden = items.filter((item) => item.hidden).length;
  const stoppedService = items.filter((item) => item.serviceStopped).length;

  async function confirmChange() {
    if (pending === null) return;
    setBusy(true);
    setError('');
    try {
      await request('/api/admin/nodes/' + pending.item.id + '/state', 'PATCH', { field: pending.field, value: pending.value });
      setPending(null);
      query.refresh();
    } catch (e: any) {
      setError(e?.message || '操作失敗');
    } finally {
      setBusy(false);
    }
  }

  function actionButton(item: AdminNodeItem, field: Field, current: boolean) {
    const flag = FIELD_OF[field];
    const label = nodeStateAction(flag, !current);
    const tone = !current && field === 'service' ? 'danger' : 'primary';
    return (
      <button key={field} className={tone === 'danger' ? 'danger' : ''} onClick={() => setPending({ item, field, value: !current })} disabled={busy}>
        {label}
      </button>
    );
  }

  return (
    <div>
      <PageTitle title="節點管理" description="三種狀態嚴格分開：停止分發、隱藏節點、停止節點服務是三個獨立的操作，不會互相影響。" />
      <Card title="狀態統計">
        <div className="row" style={{ gap: 24 }}>
          <div><strong>{items.length}</strong><div className="muted">節點來源</div></div>
          <div><strong>{stoppedDistribution}</strong><div className="muted">已停止分發</div></div>
          <div><strong>{hidden}</strong><div className="muted">已隱藏</div></div>
          <div><strong>{stoppedService}</strong><div className="muted">已停止服務</div></div>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          停止分發：節點不再出現在新訂閱與訂閱更新中；隱藏節點：節點不再出現在使用者節點列表中；停止服務：節點服務被標記為已停止。
          三者皆不刪除節點憑據、不刪除已匯入的客戶端配置、不斷開已有客戶端連接。所有變更皆寫入操作審計。
        </p>
      </Card>
      {error !== '' ? <div className="alert error" style={{ marginTop: 12 }}>{error}</div> : null}
      <DataState error={query.error || ''} loading={query.data === undefined && query.error === null} onRetry={query.refresh} />
      {query.data !== undefined && items.length === 0 ? (
        <Empty title="尚無節點來源" description="尚未匯入任何節點來源，請先到「節點來源」頁匯入。" />
      ) : null}
      {items.length > 0 ? (
        <Card title="節點來源">
          <table className="table">
            <thead>
              <tr>
                <th>節點來源</th>
                <th>群組</th>
                <th>類型</th>
                <th>節點數</th>
                <th>分發</th>
                <th>顯示</th>
                <th>服務</th>
                <th>健康檢查</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.name}</strong><div className="muted">{item.id.slice(0, 8)}</div></td>
                  <td>{item.group || '-'}</td>
                  <td>{item.kind || '-'}</td>
                  <td>{item.nodeCount}</td>
                  <td>{stateBadge(!item.distributionStopped, '分發中', '已停止分發')}</td>
                  <td>{stateBadge(!item.hidden, '顯示中', '已隱藏')}</td>
                  <td>
                    {item.serviceStopped ? <Badge tone="danger">已停止</Badge> : <Badge tone="success">運行中</Badge>}
                  </td>
                  <td>{item.lastCheckAt === null ? '無記錄' : item.lastCheckOk ? '正常' : '異常'}</td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {actionButton(item, 'distribution', item.distributionStopped)}
                      {actionButton(item, 'visibility', item.hidden)}
                      {actionButton(item, 'service', item.serviceStopped)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Dialog open={pending !== null} title={pending === null ? '' : nodeStateAction(FIELD_OF[pending.field], pending.value) + '：' + pending.item.name} onClose={() => setPending(null)}>
        {pending !== null ? (
          <div>
            <p><strong>{nodeFlagLabel(FIELD_OF[pending.field])}</strong></p>
            <p>{nodeFlagScope(FIELD_OF[pending.field])}</p>
            <p className="muted">影響範圍：僅變更此節點來源的狀態旗標。不會刪除節點憑據、不刪除使用者已匯入的客戶端配置、不斷開已有客戶端連接。此操作將寫入操作審計。</p>
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button className="ghost" onClick={() => setPending(null)} disabled={busy}>取消</button>
              <button className={pending.field === 'service' && pending.value ? 'danger' : ''} onClick={confirmChange} disabled={busy}>
                {busy ? '處理中…' : '確認執行'}
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
