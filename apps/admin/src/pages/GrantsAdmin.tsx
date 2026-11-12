import { useState } from 'react';
import {
  Badge,
  Card,
  DataState,
  Dialog,
  Empty,
  PageTitle,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';
import { grantRevocationScope } from '../../../../packages/shared/src/admin-nodes';

interface GrantRow {
  id: string;
  kind: string;
  userId?: string;
  user_id?: string;
  user_email?: string;
  resourceId?: string;
  resource_id?: string;
  name?: string;
  resource_name?: string;
  group?: string;
  created_at?: string;
  data?: any;
}

interface UserRow {
  id: string;
  email: string;
  name?: string;
  role?: string;
}

interface ResourceRow {
  id: string;
  data?: any;
  name?: string;
}

function pick(row: any, keys: string[]): string {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

export function GrantsAdmin() {
  const { request } = useApp();
  const grants = useData<GrantRow[]>('/api/admin/grants');
  const users = useData<UserRow[]>('/api/admin/users');
  const sources = useData<ResourceRow[]>('/api/admin/sources');
  const servers = useData<ResourceRow[]>('/api/admin/servers');
  const [revoking, setRevoking] = useState<GrantRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<'source' | 'server'>('source');
  const [userId, setUserId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const items = grants.data || [];
  const userList = users.data || [];
  const resourceList =
    kind === 'source' ? sources.data || [] : servers.data || [];

  function userLabel(row: GrantRow): string {
    const id =
      pick(row, ['userId', 'user_id']) ||
      pick(row.data || {}, ['userId', 'user_id']);
    const email = pick(row, ['user_email', 'email']);
    if (email !== '') return email;
    const found = userList.find((u) => u.id === id);
    if (found) return found.email;
    return id === '' ? '未知使用者' : id.slice(0, 8);
  }

  function resourceLabel(row: GrantRow): string {
    const id = pick(row, ['resourceId', 'resource_id', 'id']);
    const name =
      pick(row, ['resource_name', 'name']) || pick(row.data || {}, ['name']);
    if (name !== '') return name;
    const all = [...(sources.data || []), ...(servers.data || [])];
    const found = all.find((r) => r.id === id);
    if (found) return found.data?.name || found.name || id.slice(0, 8);
    return id.slice(0, 8);
  }

  async function confirmRevoke() {
    if (revoking === null) return;
    setBusy(true);
    setError('');
    try {
      const id = pick(revoking, ['resourceId', 'resource_id', 'id']);
      const uid =
        pick(revoking, ['userId', 'user_id']) ||
        pick(revoking.data || {}, ['userId', 'user_id']);
      await request(
        '/api/admin/grants/' + revoking.kind + '/' + id + '/' + uid,
        'DELETE',
      );
      setRevoking(null);
      setNotice('授權已撤銷。');
      grants.refresh();
    } catch (e: any) {
      setError(e?.message || '撤銷失敗');
    } finally {
      setBusy(false);
    }
  }

  async function createGrant() {
    if (userId === '' || resourceId === '') {
      setError('請選擇使用者與授權資源。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request('/api/admin/grants', 'POST', { kind, resourceId, userId });
      setCreating(false);
      setUserId('');
      setResourceId('');
      setNotice('授權已建立。');
      grants.refresh();
    } catch (e: any) {
      setError(e?.message || '建立授權失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageTitle
        title="訂閱授權管理"
        description="授權決定哪些使用者可以取得哪些節點或伺服器的訂閱。撤銷授權只阻止未來取得或更新訂閱，不會斷開已有客戶端連接。"
      />
      <Card title="授權">
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <strong>{items.length}</strong>
            <span className="muted"> 筆授權</span>
          </div>
          <button
            onClick={() => {
              setCreating(true);
              setError('');
            }}
          >
            新增授權
          </button>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          {grantRevocationScope()}
        </p>
      </Card>
      {notice !== '' ? (
        <div className="alert success" style={{ marginTop: 12 }}>
          {notice}
        </div>
      ) : null}
      {error !== '' ? (
        <div className="alert error" style={{ marginTop: 12 }}>
          {error}
        </div>
      ) : null}
      <DataState
        error={grants.error || ''}
        loading={!grants.data}
        onRetry={grants.refresh}
      />
      {grants.data !== undefined && items.length === 0 ? (
        <Empty
          title="尚無授權"
          description="目前沒有任何訂閱授權，請新增授權以開放使用者訂閱。"
        />
      ) : null}
      {items.length > 0 ? (
        <Card title="授權列表">
          <table className="table">
            <thead>
              <tr>
                <th>使用者</th>
                <th>資源類型</th>
                <th>授權資源</th>
                <th>群組</th>
                <th>建立時間</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id + ':' + pick(row, ['userId', 'user_id'])}>
                  <td>{userLabel(row)}</td>
                  <td>
                    {row.kind === 'source' ? (
                      <Badge tone="success">節點來源</Badge>
                    ) : (
                      <Badge>伺服器</Badge>
                    )}
                  </td>
                  <td>{resourceLabel(row)}</td>
                  <td>
                    {pick(row, ['group']) ||
                      pick(row.data || {}, ['group']) ||
                      '-'}
                  </td>
                  <td>{row.created_at ? row.created_at.slice(0, 10) : '-'}</td>
                  <td>
                    <button
                      className="danger"
                      onClick={() => setRevoking(row)}
                      disabled={busy}
                    >
                      撤銷授權
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Dialog
        open={revoking !== null}
        title={revoking === null ? '' : '撤銷授權：' + userLabel(revoking)}
        onClose={() => setRevoking(null)}
      >
        {revoking !== null ? (
          <div>
            <p>{grantRevocationScope()}</p>
            <p className="muted">
              影響範圍：此使用者將無法再依此授權取得或更新該資源的訂閱配置。此操作不會刪除節點憑據、不停止節點服務、不刪除已匯入的客戶端配置。操作將寫入操作審計。
            </p>
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="ghost"
                onClick={() => setRevoking(null)}
                disabled={busy}
              >
                取消
              </button>
              <button
                className="danger"
                onClick={confirmRevoke}
                disabled={busy}
              >
                {busy ? '處理中…' : '確認撤銷'}
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={creating}
        title="新增授權"
        onClose={() => setCreating(false)}
      >
        <div>
          <label>資源類型</label>
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as 'source' | 'server');
              setResourceId('');
            }}
          >
            <option value="source">節點來源</option>
            <option value="server">伺服器</option>
          </select>
          <label style={{ marginTop: 12 }}>使用者</label>
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">請選擇</option>
            {userList.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
          <label style={{ marginTop: 12 }}>授權資源</label>
          <select
            value={resourceId}
            onChange={(e) => setResourceId(e.target.value)}
          >
            <option value="">請選擇</option>
            {resourceList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.data?.name || r.name || r.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <div
            className="row"
            style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}
          >
            <button
              className="ghost"
              onClick={() => setCreating(false)}
              disabled={busy}
            >
              取消
            </button>
            <button onClick={createGrant} disabled={busy}>
              {busy ? '處理中…' : '建立授權'}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
