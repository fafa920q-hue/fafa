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

interface AiAccount {
  id: string;
  projectId: string;
  serviceAccountId: string;
  name: string;
  note?: string;
  models?: string[];
  limits?: any;
  daily_micros?: number | string;
  monthly_micros?: number | string;
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

// 從帳號資料取上限：優先用後端回傳的 limits {daily, monthly}，
// 沒有時退回資料庫原始欄位 daily_micros/monthly_micros。2026-11-14
// 回歸：舊版 GET 不回 limits，toggleEnabled 送出 limits: {}，PATCH
// 的 Zod 報 limits.daily/monthly expected number 而啟用永遠失敗。
// 兩個來源都沒有有效數字時回傳 0，呼叫方不得把 0 或空物件送出。
function accountLimits(account: AiAccount) {
  const daily = Number(account.limits?.daily);
  const monthly = Number(account.limits?.monthly);
  if (
    Number.isFinite(daily) &&
    daily > 0 &&
    Number.isFinite(monthly) &&
    monthly > 0
  )
    return { daily, monthly };
  return {
    daily: Number(account.daily_micros) || 0,
    monthly: Number(account.monthly_micros) || 0,
  };
}

export function ApiKeysAdmin() {
  const { request } = useApp();
  const query = useData<AiPlatform>('/api/admin/ai-platform');
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<Rotating | null>(null);
  const [editing, setEditing] = useState<AiAccount | null>(null);
  const [editForm, setEditForm] = useState({
    name: '',
    note: '',
    models: '',
    dailyMicros: '',
    monthlyMicros: '',
    concurrency: '1',
    priority: '100',
  });
  const [form, setForm] = useState({
    projectId: '',
    serviceAccountId: '',
    name: '',
    note: '',
    apiKey: '',
    models: '',
    dailyMicros: '',
    monthlyMicros: '',
    confirm: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const accounts = query.data?.accounts || [];

  // 与后端 accountSchema / apiKey 校验一致：OpenAI Admin API 返回的服务
  // 账户编号以 user- 开头（文档示例 svc_acct_ 只是占位写法），两种前缀
  // 都接受。把后端 400 附带的字段级 issues 拼进提示，指出具体是哪个
  // 字段不符合要求，而不是只有一句笼统的“输入内容不符合要求”。
  const formatError = (e: any, fallback: string) => {
    const issues = Array.isArray(e?.issues) ? e.issues : [];
    const message = e?.message || fallback;
    if (issues.length === 0) return message;
    return (
      message +
      '：' +
      issues.map((i: any) => `${i.path}：${i.message}`).join('；')
    );
  };

  async function toggleEnabled(account: AiAccount, enabled: boolean) {
    const limits = accountLimits(account);
    if (limits.daily < 1 || limits.monthly < 1) {
      // 絕不送出 limits: {}（後端 Zod 會報 limits.daily/monthly 缺失）。
      // 上限缺失代表該帳號資料不完整，請先用「編輯」補上限再啟用。
      setError('此帳號尚未設定每日／每月上限，請先點「編輯」設定上限再啟用。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request('/api/admin/ai-platform/accounts/' + account.id, 'PATCH', {
        name: account.name,
        note: account.note || '',
        models: account.models || [],
        limits,
        enabled,
        concurrency: account.concurrency || 1,
        priority: account.priority ?? 100,
        allowedUsers: account.allowedUsers ?? null,
      });
      setNotice(
        enabled ? '帳號已啟用。' : '帳號已停用：此帳號的上游金鑰不再可用。',
      );
      query.refresh();
    } catch (e: any) {
      setError(formatError(e, '更新失敗'));
    } finally {
      setBusy(false);
    }
  }

  // 編輯既有帳號：預填名稱、備註、模型、上限、併發與優先級，不改
  // projectId/serviceAccountId，也不用重填 API Key（PATCH 端點本來就
  // 不收 apiKey）。2026-11-14 前列表只有「輪換憑證／啟用」，上限填錯
  // 或缺失時無法修正。
  function openEdit(account: AiAccount) {
    const limits = accountLimits(account);
    setEditing(account);
    setEditForm({
      name: account.name,
      note: account.note || '',
      models: (account.models || []).join(', '),
      dailyMicros: limits.daily > 0 ? String(limits.daily) : '',
      monthlyMicros: limits.monthly > 0 ? String(limits.monthly) : '',
      concurrency: String(account.concurrency || 1),
      priority: String(account.priority ?? 100),
    });
    setError('');
  }

  async function saveEdit() {
    if (editing === null) return;
    const models = editForm.models
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m !== '');
    const dailyMicros = Number(editForm.dailyMicros) || 0;
    const monthlyMicros = Number(editForm.monthlyMicros) || 0;
    const concurrency = Number(editForm.concurrency) || 1;
    const priority = Number(editForm.priority) || 100;
    if (editForm.name.trim() === '') {
      setError('請填寫名稱。');
      return;
    }
    if (models.length === 0) {
      setError('模型：至少填寫一個模型。');
      return;
    }
    if (dailyMicros < 1 || monthlyMicros < 1) {
      setError('每日上限與每月上限須大於 0（微單位）。');
      return;
    }
    if (dailyMicros > monthlyMicros) {
      setError('每日上限不能大於每月上限。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request('/api/admin/ai-platform/accounts/' + editing.id, 'PATCH', {
        name: editForm.name.trim(),
        note: editForm.note,
        models,
        limits: { daily: dailyMicros, monthly: monthlyMicros },
        enabled: editing.enabled ?? false,
        concurrency,
        priority,
        allowedUsers: editing.allowedUsers ?? null,
      });
      setEditing(null);
      setNotice('服務帳號已更新。');
      query.refresh();
    } catch (e: any) {
      setError(formatError(e, '更新失敗'));
    } finally {
      setBusy(false);
    }
  }

  async function createAccount() {
    // 提交前先 trim 再按后端规则逐项校验，报错直接指出是哪个字段，
    // 不必等后端 400 再猜。注意 limits 的键名须是 daily/monthly（后
    // 端 limits schema 的字段名），之前误写成 dailyMicros/monthlyMicros
    // 会被 Zod 去掉未知键，导致 limits 缺 daily/monthly 而 400。
    const projectId = form.projectId.trim();
    const serviceAccountId = form.serviceAccountId.trim();
    const apiKey = form.apiKey.trim();
    const models = form.models
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m !== '');
    const dailyMicros = Number(form.dailyMicros) || 0;
    const monthlyMicros = Number(form.monthlyMicros) || 0;
    if (
      projectId === '' ||
      serviceAccountId === '' ||
      form.name === '' ||
      apiKey === ''
    ) {
      setError('請填寫專案編號、服務帳號編號、名稱與 API Key。');
      return;
    }
    if (!/^proj_[A-Za-z0-9_-]+$/.test(projectId)) {
      setError('專案編號格式不正確：須以 proj_ 開頭。');
      return;
    }
    if (!/^(?:svc_acct_|user-)[A-Za-z0-9_-]+$/.test(serviceAccountId)) {
      setError('服務帳號編號格式不正確：須以 svc_acct_ 或 user- 開頭。');
      return;
    }
    if (!/^sk-(?!admin-)[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
      setError(
        'API Key 格式不正確：須以 sk- 開頭、至少 16 位，且不能是 sk-admin- 管理員金鑰。',
      );
      return;
    }
    if (models.length === 0) {
      setError('模型：至少填寫一個模型。');
      return;
    }
    if (dailyMicros < 1 || monthlyMicros < 1) {
      setError('每日上限與每月上限須大於 0（微單位）。');
      return;
    }
    if (dailyMicros > monthlyMicros) {
      setError('每日上限不能大於每月上限。');
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
        projectId,
        serviceAccountId,
        name: form.name,
        note: form.note,
        apiKey,
        models,
        limits: {
          daily: dailyMicros,
          monthly: monthlyMicros,
        },
        enabled: true,
        concurrency: 1,
        priority: 100,
        allowedUsers: null,
        confirmServiceAccount: true,
      });
      setCreating(false);
      setForm({
        projectId: '',
        serviceAccountId: '',
        name: '',
        note: '',
        apiKey: '',
        models: '',
        dailyMicros: '',
        monthlyMicros: '',
        confirm: false,
      });
      setNotice('服務帳號已建立，金鑰已加密儲存。');
      query.refresh();
    } catch (e: any) {
      setError(formatError(e, '建立帳號失敗'));
    } finally {
      setBusy(false);
    }
  }

  async function rotateCredential() {
    if (rotating === null) return;
    const apiKey = rotating.apiKey.trim();
    if (apiKey === '') {
      setError('請輸入新的 API Key。');
      return;
    }
    if (!/^sk-(?!admin-)[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
      setError(
        'API Key 格式不正確：須以 sk- 開頭、至少 16 位，且不能是 sk-admin- 管理員金鑰。',
      );
      return;
    }
    if (rotating.confirm === false) {
      setError('請勾選確認此為本平台專用的服務帳號金鑰。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result: any = await request(
        '/api/admin/ai-platform/accounts/' +
          rotating.account.id +
          '/credential',
        'POST',
        {
          action: 'rotate',
          apiKey,
          confirmServiceAccount: true,
        },
      );
      const shown = result?.credential || result?.apiKey || result?.key || '';
      setRotating({ ...rotating, result: shown });
      setNotice('憑證已輪換。舊金鑰即刻失效。');
      query.refresh();
    } catch (e: any) {
      setError(formatError(e, '輪換失敗'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageTitle
        title="API Key 管理"
        description="管理平台 AI 的上游服務帳號金鑰。金鑰一律加密儲存，頁面永不顯示完整金鑰；輪換後舊金鑰即刻失效。"
      />
      <Card title="服務帳號">
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <strong>{accounts.length}</strong>
            <span className="muted"> 個服務帳號</span>
          </div>
          <button
            onClick={() => {
              setCreating(true);
              setError('');
            }}
          >
            新增服務帳號
          </button>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          僅 Owner
          可以新增、輪換或停用服務帳號。輪換後請即時更新上游端設定；停用帳號不會刪除其歷史用量記錄。
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
        error={query.error || ''}
        loading={!query.data}
        onRetry={query.refresh}
      />
      {query.data !== undefined && accounts.length === 0 ? (
        <Empty
          title="尚無服務帳號"
          description="尚未建立任何上游服務帳號，請新增服務帳號以啟用 AI 模型。"
        />
      ) : null}
      {accounts.length > 0 ? (
        <Card title="服務帳號列表">
          <table className="table">
            <thead>
              <tr>
                <th>名稱</th>
                <th>專案編號</th>
                <th>服務帳號編號</th>
                <th>模型</th>
                <th>狀態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    <strong>{account.name}</strong>
                    <div className="muted">{account.note || ''}</div>
                  </td>
                  <td>{account.projectId}</td>
                  <td>{account.serviceAccountId}</td>
                  <td>{(account.models || []).join(', ') || '-'}</td>
                  <td>
                    {account.enabled === false ? (
                      <Badge tone="danger">已停用</Badge>
                    ) : (
                      <Badge tone="success">啟用中</Badge>
                    )}
                    {account.health ? (
                      <span className="muted"> {account.health}</span>
                    ) : null}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => openEdit(account)} disabled={busy}>
                        編輯
                      </button>
                      <button
                        onClick={() =>
                          setRotating({
                            account,
                            apiKey: '',
                            confirm: false,
                            result: '',
                          })
                        }
                        disabled={busy}
                      >
                        輪換憑證
                      </button>
                      {account.enabled === false ? (
                        <button
                          onClick={() => toggleEnabled(account, true)}
                          disabled={busy}
                        >
                          啟用
                        </button>
                      ) : (
                        <button
                          className="danger"
                          onClick={() => toggleEnabled(account, false)}
                          disabled={busy}
                        >
                          停用
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <Dialog
        open={creating}
        title="新增服務帳號"
        onClose={() => setCreating(false)}
      >
        <div>
          <label>專案編號（proj_…）</label>
          <input
            value={form.projectId}
            onChange={(e) => setForm({ ...form, projectId: e.target.value })}
            placeholder="proj_xxx"
          />
          <label style={{ marginTop: 12 }}>
            服務帳號編號（svc_acct_… 或 user-…）
          </label>
          <input
            value={form.serviceAccountId}
            onChange={(e) =>
              setForm({ ...form, serviceAccountId: e.target.value })
            }
            placeholder="svc_acct_xxx 或 user-xxx"
          />
          <label style={{ marginTop: 12 }}>名稱</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <label style={{ marginTop: 12 }}>備註</label>
          <input
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <label style={{ marginTop: 12 }}>
            API Key（sk-…，建立後僅顯示一次概念；本頁不回顯）
          </label>
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
          <label style={{ marginTop: 12 }}>模型（以逗號分隔）</label>
          <input
            value={form.models}
            onChange={(e) => setForm({ ...form, models: e.target.value })}
            placeholder="codex-mini-latest"
          />
          <div className="row" style={{ gap: 12, marginTop: 12 }}>
            <div>
              <label>每日上限（微單位）</label>
              <input
                type="number"
                value={form.dailyMicros}
                onChange={(e) =>
                  setForm({ ...form, dailyMicros: e.target.value })
                }
              />
            </div>
            <div>
              <label>每月上限（微單位）</label>
              <input
                type="number"
                value={form.monthlyMicros}
                onChange={(e) =>
                  setForm({ ...form, monthlyMicros: e.target.value })
                }
              />
            </div>
          </div>
          <label style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.checked })}
            />{' '}
            此為本平台專用的服務帳號金鑰，我確認其用途
          </label>
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
            <button onClick={createAccount} disabled={busy}>
              {busy ? '處理中…' : '建立帳號'}
            </button>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={editing !== null}
        title={editing === null ? '' : '編輯服務帳號：' + editing.name}
        onClose={() => setEditing(null)}
      >
        {editing !== null ? (
          <div>
            <p className="muted">
              專案編號與服務帳號編號不可修改；API Key
              亦不需重填，僅更新以下欄位。
            </p>
            <label>名稱</label>
            <input
              value={editForm.name}
              onChange={(e) =>
                setEditForm({ ...editForm, name: e.target.value })
              }
            />
            <label style={{ marginTop: 12 }}>備註</label>
            <input
              value={editForm.note}
              onChange={(e) =>
                setEditForm({ ...editForm, note: e.target.value })
              }
            />
            <label style={{ marginTop: 12 }}>模型（以逗號分隔）</label>
            <input
              value={editForm.models}
              onChange={(e) =>
                setEditForm({ ...editForm, models: e.target.value })
              }
            />
            <div className="row" style={{ gap: 12, marginTop: 12 }}>
              <div>
                <label>每日上限（微單位）</label>
                <input
                  type="number"
                  value={editForm.dailyMicros}
                  onChange={(e) =>
                    setEditForm({ ...editForm, dailyMicros: e.target.value })
                  }
                />
              </div>
              <div>
                <label>每月上限（微單位）</label>
                <input
                  type="number"
                  value={editForm.monthlyMicros}
                  onChange={(e) =>
                    setEditForm({ ...editForm, monthlyMicros: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="row" style={{ gap: 12, marginTop: 12 }}>
              <div>
                <label>併發數</label>
                <input
                  type="number"
                  value={editForm.concurrency}
                  onChange={(e) =>
                    setEditForm({ ...editForm, concurrency: e.target.value })
                  }
                />
              </div>
              <div>
                <label>優先級</label>
                <input
                  type="number"
                  value={editForm.priority}
                  onChange={(e) =>
                    setEditForm({ ...editForm, priority: e.target.value })
                  }
                />
              </div>
            </div>
            <div
              className="row"
              style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}
            >
              <button
                className="ghost"
                onClick={() => setEditing(null)}
                disabled={busy}
              >
                取消
              </button>
              <button onClick={saveEdit} disabled={busy}>
                {busy ? '處理中…' : '儲存修改'}
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={rotating !== null}
        title={rotating === null ? '' : '輪換憑證：' + rotating.account.name}
        onClose={() => setRotating(null)}
      >
        {rotating !== null ? (
          <div>
            {rotating.result === '' ? (
              <div>
                <p>
                  輪換後舊金鑰即刻失效，請同步更新上游端設定。新金鑰僅於此次回應顯示，請妥善保存。
                </p>
                <label>新的 API Key</label>
                <input
                  type="password"
                  value={rotating.apiKey}
                  onChange={(e) =>
                    setRotating({ ...rotating, apiKey: e.target.value })
                  }
                />
                <label style={{ marginTop: 12 }}>
                  <input
                    type="checkbox"
                    checked={rotating.confirm}
                    onChange={(e) =>
                      setRotating({ ...rotating, confirm: e.target.checked })
                    }
                  />{' '}
                  此為本平台專用的服務帳號金鑰，我確認其用途
                </label>
                <div
                  className="row"
                  style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}
                >
                  <button
                    className="ghost"
                    onClick={() => setRotating(null)}
                    disabled={busy}
                  >
                    取消
                  </button>
                  <button onClick={rotateCredential} disabled={busy}>
                    {busy ? '處理中…' : '確認輪換'}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p>新憑證已產生，請立即複製並妥善保存，關閉後不再顯示。</p>
                <pre>{rotating.result}</pre>
                <div
                  className="row"
                  style={{ gap: 8, justifyContent: 'flex-end' }}
                >
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
