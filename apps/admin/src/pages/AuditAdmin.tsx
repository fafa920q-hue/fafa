import { useState } from 'react';
import {
  Badge,
  Card,
  DataState,
  Empty,
  PageTitle,
  useData,
} from '../../../../packages/ui/src/core';

interface AuditRow {
  id: string;
  owner_id?: string;
  action: string;
  target_id?: string | null;
  correlation_id?: string | null;
  created_at: string;
}

export function AuditAdmin() {
  const query = useData<any>('/api/admin/audit');
  const [filter, setFilter] = useState('');
  const raw = query.data;
  const rows: AuditRow[] = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : [];
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === ''
      ? rows
      : rows.filter((row) => {
          const text = [row.action, row.owner_id || '', row.target_id || '']
            .join(' ')
            .toLowerCase();
          return text.includes(needle);
        });

  return (
    <div>
      <PageTitle
        title="操作審計"
        description="所有管理員與使用者的關鍵操作皆記錄於此，包含授權變更、節點狀態變更、設定變更與備份登記，僅管理員可檢視。"
      />
      <Card title="篩選審計記錄">
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <strong>{shown.length}</strong>
            <span className="muted"> 筆審計記錄</span>
          </div>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="依操作、使用者或目標搜尋"
            style={{ minWidth: 260 }}
          />
        </div>
      </Card>
      <DataState
        error={query.error || ''}
        loading={!query.data}
        onRetry={query.refresh}
      />
      {query.data !== undefined && rows.length === 0 ? (
        <Empty title="尚無審計記錄" description="目前沒有任何審計事件。" />
      ) : null}
      {shown.length === 0 && rows.length > 0 ? (
        <Empty title="無符合條件的記錄" description="請調整搜尋條件。" />
      ) : null}
      {shown.length > 0 ? (
        <Card title="審計記錄">
          <table className="table">
            <thead>
              <tr>
                <th>時間</th>
                <th>操作</th>
                <th>執行者</th>
                <th>目標</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.created_at
                      ? row.created_at.slice(0, 19).replace('T', ' ')
                      : '-'}
                  </td>
                  <td>
                    <Badge>{row.action}</Badge>
                  </td>
                  <td>{row.owner_id ? row.owner_id.slice(0, 8) : '-'}</td>
                  <td>{row.target_id ? row.target_id.slice(0, 24) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
