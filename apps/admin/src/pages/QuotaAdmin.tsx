import { useState } from 'react';
import { Badge, Card, DataState, Dialog, Empty, PageTitle, useApp, useData } from '../../../../packages/ui/src/core';

interface AiUsage {
  [key: string]: any;
}

interface UserRow {
  id: string;
  email: string;
  name?: string;
  role?: string;
}

interface QuotaEditor {
  user: UserRow;
  values: Record<string, string>;
}

export function QuotaAdmin() {
  const { request } = useApp();
  const platform = useData<AiUsage>('/api/admin/ai-platform');
  const users = useData<UserRow[]>('/api/admin/users');
  const [editing, setEditing] = useState<QuotaEditor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const usage = platform.data?.usage || null;
  const models = platform.data?.models || [];
  const userList = users.data || [];

  async function openEditor(user: UserRow) {
    setError('');
    setBusy(true);
    try {
      const current: any = await request('/api/admin/ai-platform/quota/' + user.id, 'GET');
      const quota = current?.quota || current || {};
      const values: Record<string, string> = {};
      for (const key of Object.keys(quota)) {
        const value = quota[key];
        if (typeof value === 'number') values[key] = String(value);
      }
      setEditing({ user, values });
    } catch (e: any) {
      setError(e?.message || '讀取配額失敗');
    } finally {
      setBusy(false);
    }
  }

  async function saveQuota() {
    if (editing === null) return;
    const body: Record<string, number> = {};
    for (const key of Object.keys(editing.values)) {
      const parsed = Number(editing.values[key]);
      if (Number.isNaN(parsed) || parsed < 0) {
        setError('配額必須為不小於 0 的數字：' + key);
        return;
      }
      body[key] = parsed;
    }
    setBusy(true);
    setError('');
    try {
      await request('/api/admin/ai-platform/quota/' + editing.user.id, 'PATCH', body);
      setEditing(null);
      setNotice('配額已更新。');
    } catch (e: any) {
      setError(e?.message || '更新配額失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageTitle title="額度與計費管理" description="查看平台 AI 用量與使用者配額。配額調整僅 Owner 可執行，變更將寫入操作審計。" />
      <Card title="平台概覽">
        <div className="row" style={{ gap: 24 }}>
          <div><strong>{models.length}</strong><div className="muted">可用模型</div></div>
          <div><strong>{userList.length}</strong><div className="muted">使用者</div></div>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          上游用量以伺服器統計為準；實際計費以管理員設定的模型價格為準。未配置上游模型時，對話與用量統計皆為空，請先到「AI 模型管理」與「API Key 管理」完成配置。
        </p>
      </Card>
      {notice !== '' ? <div className="alert success" style={{ marginTop: 12 }}>{notice}</div> : null}
      {error !== '' ? <div className="alert error" style={{ marginTop: 12 }}>{error}</div> : null}
      <DataState error={platform.error || ''} loading={!platform.data} onRetry={platform.refresh} />
      {usage !== null ? (
        <Card title="平台用量（伺服器統計）">
          <dl className="definition">
            {Object.keys(usage).map((key) => (
              <div key={key}><dt>{key}</dt><dd>{typeof usage[key] === 'object' ? JSON.stringify(usage[key]) : String(usage[key])}</dd></div>
            ))}
          </dl>
        </Card>
      ) : null}
      <DataState error={users.error || ''} loading={!users.data} onRetry={users.refresh} />
      {userList.length > 0 ? (
        <Card title="使用者配額">
          <table className="table">
            <thead>
              <tr><th>使用者</th><th>角色</th><th>操作</th></tr>
            </thead>
            <tbody>
              {userList.map((user) => (
                <tr key={user.id}>
                  <td><strong>{user.email}</strong><div className="muted">{user.name || ''}</div></td>
                  <td>{user.role || '-'}</td>
                  <td><button onClick={() => openEditor(user)} disabled={busy}>調整配額</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {users.data !== undefined && userList.length === 0 ? (
        <Empty title="尚無使用者" description="目前沒有任何使用者帳號。" />
      ) : null}
      <Dialog open={editing !== null} title={editing === null ? '' : '調整配額：' + editing.user.email} onClose={() => setEditing(null)}>
        {editing !== null ? (
          <div>
            <p className="muted">僅顯示目前配額中的數值欄位；未列出的欄位保持不變。</p>
            {Object.keys(editing.values).length === 0 ? <p>此使用者目前無數值型配額欄位。</p> : null}
            {Object.keys(editing.values).map((key) => (
              <div key={key} style={{ marginTop: 12 }}>
                <label>{key}</label>
                <input type="number" value={editing.values[key]} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, [key]: e.target.value } })} />
              </div>
            ))}
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="ghost" onClick={() => setEditing(null)} disabled={busy}>取消</button>
              <button onClick={saveQuota} disabled={busy}>{busy ? '處理中…' : '儲存配額'}</button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
