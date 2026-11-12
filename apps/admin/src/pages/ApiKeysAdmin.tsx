import { useState } from 'react';
import { Badge, Card, DataState, Dialog, Empty, PageTitle, useApp, useData } from '../../../../packages/ui/src/core';

interface AiAccount {
  id: string;
  projectId: string;
  serviceAccountId: string;
  name: string;
  note?: string;
  models?: string[];
  limits?: any;
  enabled?: boolean;
  concurrency?: number;
  priority?: number;
  allowedUsers?: string[] | null;
  health?: string;
}

interface AiPlatform {
  models: string[];
  policy: any;
  accounts: AiAccount[];
}

interface Rotating {
  account: AiAccount;
  apiKey: string;
  confirm: boolean;
  result: string;
}

export function ApiKeysAdmin() {
  const { request } = useApp();
  const query = useData<AiPlatform>('/api/admin/ai-platform');
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<Rotating | null>(null);
  const [form, setForm] = useState({ projectId: '', serviceAccountId: '', name: '', note: '', apiKey: '', models: '', dailyMicros: '', monthlyMicros: '', confirm: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const accounts = query.data?.accounts || [];

  async function toggleEnabled(account: AiAccount, enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      await request('/api/admin/ai-platform/accounts/' + account.id, 'PATCH', {
        name: account.name,
        note: account.note || '',
        models: account.models || [],
        limits: account.limits || {},
        enabled,
        concurrency: account.concurrency || 1,
        priority: account.priority ?? 100,
        allowedUsers: account.allowedUsers ?? null,
      });
      setNotice(enabled ? '帳號已啟用。' : '帳號已停用：此帳號的上游金鑰不再可用。');
      query.refresh();
    } catch (e: any) {
      setError(e?.message || '更新失敗');
    } finally {
      setBusy(false);
    }
  }

  async function createAccount() {
    if (form.projectId === '' || form.serviceAccountId === '' || form.name === '' || form.apiKey === '') {
      setError('請填寫專案編號、服務帳號編號、名稱與 API Key。');
      return;
    }
    if (form.confirm === false) {
      setError('請勾選確認此為本平台專用的服務帳號金鑰。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request('/api/admin/ai-platform/accounts', 'POST', {
        projectId: form.projectId,
        serviceAccountId: form.serviceAccountId,
        name: form.name,
        note: form.note,
        apiKey: form.apiKey,
        models: form.models.split(',').map((m) => m.trim()).filter((m) => m !== ''),
        limits: { dailyMicros: Number(form.dailyMicros) || 0, monthlyMicros: Number(form.monthlyMicros) || 0 },
        enabled: true,
        concurrency: 1,
        priority: 100,
        allowedUsers: null,
        confirmServiceAccount: true,
      });
      setCreating(false);
      setForm({ projectId: '', serviceAccountId: '', name: '', note: '', apiKey: '', models: '', dailyMicros: '', monthlyMicros: '', confirm: false });
      setNotice('服務帳號已建立，金鑰已加密儲存。');
      query.refresh();
    } catch (e: any) {
      setError(e?.message || '建立帳號失敗');
    } finally {
      setBusy(false);
    }
  }

  async function rotateCredential() {
    if (rotating === null) return;
    if (rotating.apiKey === '') {
      setError('請輸入新的 API Key。');
      return;
    }
    if (rotating.confirm === false) {
      setError('請勾選確認此為本平台專用的服務帳號金鑰。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result: any = await request('/api/admin/ai-platform/accounts/' + rotating.account.id + '/credential', 'POST', { action: 'rotate', apiKey: rotating.apiKey, confirmServiceAccount: true });
      const shown = result?.credential || result?.apiKey || result?.key || '';
      setRotating({ ...rotating, result: shown });
      setNotice('憑證已輪換。舊金鑰即刻失效。');
      query.refresh();
    } catch (e: any) {
      setError(e?.message || '輪換失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageTitle title="API Key 管理" description="管理平台 AI 的上游服務帳號金鑰。金鑰一律加密儲存，頁面永不顯示完整金鑰；輪換後舊金鑰即刻失效。" />
      <Card title="服務帳號">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div><strong>{accounts.length}</strong><span className="muted"> 個服務帳號</span></div>
          <button onClick={() => { setCreating(true); setError(''); }}>新增服務帳號</button>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>僅 Owner 可以新增、輪換或停用服務帳號。輪換後請即時更新上游端設定；停用帳號不會刪除其歷史用量記錄。</p>
      </Card>
      {notice !== '' ? <div className="alert success" style={{ marginTop: 12 }}>{notice}</div> : null}
      {error !== '' ? <div className="alert error" style={{ marginTop: 12 }}>{error}</div> : null}
      <DataState error={query.error || ''} loading={!query.data} onRetry={query.refresh} />
      {query.data !== undefined && accounts.length === 0 ? (
        <Empty title="尚無服務帳號" description="尚未建立任何上游服務帳號，請新增服務帳號以啟用 AI 模型。" />
      ) : null}
      {accounts.length > 0 ? (
        <Card title="服務帳號列表">
          <table className="table">
            <thead>
              <tr><th>名稱</th><th>專案編號</th><th>服務帳號編號</th><th>模型</th><th>狀態</th><th>操作</th></tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td><strong>{account.name}</strong><div className="muted">{account.note || ''}</div></td>
                  <td>{account.projectId}</td>
                  <td>{account.serviceAccountId}</td>
                  <td>{(account.models || []).join(', ') || '-'}</td>
                  <td>
                    {account.enabled === false ? <Badge tone="danger">已停用</Badge> : <Badge tone="success">啟用中</Badge>}
                    {account.health ? <span className="muted"> {account.health}</span> : null}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => setRotating({ account, apiKey: '', confirm: false, result: '' })} disabled={busy}>輪換憑證</button>
                      {account.enabled === false ? (
                        <button onClick={() => toggleEnabled(account, true)} disabled={busy}>啟用</button>
                      ) : (
                        <button className="danger" onClick={() => toggleEnabled(account, false)} disabled={busy}>停用</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Dialog open={creating} title="新增服務帳號" onClose={() => setCreating(false)}>
        <div>
          <label>專案編號（proj_…）</label>
          <input value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} placeholder="proj_xxx" />
          <label style={{ marginTop: 12 }}>服務帳號編號（svc_acct_…）</label>
          <input value={form.serviceAccountId} onChange={(e) => setForm({ ...form, serviceAccountId: e.target.value })} placeholder="svc_acct_xxx" />
          <label style={{ marginTop: 12 }}>名稱</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label style={{ marginTop: 12 }}>備註</label>
          <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <label style={{ marginTop: 12 }}>API Key（sk-…，建立後僅顯示一次概念；本頁不回顯）</label>
          <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          <label style={{ marginTop: 12 }}>模型（以逗號分隔）</label>
          <input value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} placeholder="codex-mini-latest" />
          <div className="row" style={{ gap: 12, marginTop: 12 }}>
            <div><label>每日上限（微單位）</label><input type="number" value={form.dailyMicros} onChange={(e) => setForm({ ...form, dailyMicros: e.target.value })} /></div>
            <div><label>每月上限（微單位）</label><input type="number" value={form.monthlyMicros} onChange={(e) => setForm({ ...form, monthlyMicros: e.target.value })} /></div>
          </div>
          <label style={{ marginTop: 12 }}><input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} /> 此為本平台專用的服務帳號金鑰，我確認其用途</label>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="ghost" onClick={() => setCreating(false)} disabled={busy}>取消</button>
            <button onClick={createAccount} disabled={busy}>{busy ? '處理中…' : '建立帳號'}</button>
          </div>
        </div>
      </Dialog>
      <Dialog open={rotating !== null} title={rotating === null ? '' : '輪換憑證：' + rotating.account.name} onClose={() => setRotating(null)}>
        {rotating !== null ? (
          <div>
            {rotating.result === '' ? (
              <div>
                <p>輪換後舊金鑰即刻失效，請同步更新上游端設定。新金鑰僅於此次回應顯示，請妥善保存。</p>
                <label>新的 API Key</label>
                <input type="password" value={rotating.apiKey} onChange={(e) => setRotating({ ...rotating, apiKey: e.target.value })} />
                <label style={{ marginTop: 12 }}><input type="checkbox" checked={rotating.confirm} onChange={(e) => setRotating({ ...rotating, confirm: e.target.checked })} /> 此為本平台專用的服務帳號金鑰，我確認其用途</label>
                <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="ghost" onClick={() => setRotating(null)} disabled={busy}>取消</button>
                  <button onClick={rotateCredential} disabled={busy}>{busy ? '處理中…' : '確認輪換'}</button>
                </div>
              </div>
            ) : (
              <div>
                <p>新憑證已產生，請立即複製並妥善保存，關閉後不再顯示。</p>
                <pre>{rotating.result}</pre>
                <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => setRotating(null)}>我已保存</button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
