import { useState } from 'react';
import {
  Badge,
  Card,
  DataState,
  Empty,
  PageTitle,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';

interface BackupInfo {
  version: string;
  release: string | null;
  databaseBytes: number;
  counts: Array<{ name: string; total: number }>;
  lastBackup: {
    kind?: string;
    location?: string;
    note?: string;
    at?: string;
  } | null;
  guidance: string;
}

function bytesLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return String(bytes) + ' B';
}

export function BackupAdmin() {
  const { request } = useApp();
  const query = useData<BackupInfo>('/api/admin/backup');
  const [kind, setKind] = useState<'full' | 'incremental'>('full');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const info = query.data;

  async function registerBackup() {
    if (location.trim() === '') {
      setError('請填寫備份存放位置。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request('/api/admin/backup/register', 'POST', {
        kind,
        location: location.trim(),
        note: note.trim(),
      });
      setLocation('');
      setNote('');
      setNotice('已登記本次離線備份，記錄寫入操作審計。');
      query.refresh();
    } catch (e: any) {
      setError(e?.message || '登記失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageTitle
        title="備份和版本管理"
        description="查看目前版本、資料庫規模與最近一次已登記的離線備份。本頁不執行備份本身；備份請使用離線加密備份腳本，完成後在此登記。"
      />
      {error !== '' ? (
        <div className="alert error" style={{ marginTop: 12 }}>
          {error}
        </div>
      ) : null}
      {notice !== '' ? (
        <div className="alert success" style={{ marginTop: 12 }}>
          {notice}
        </div>
      ) : null}
      <DataState
        error={query.error || ''}
        loading={!query.data}
        onRetry={query.refresh}
      />
      {info ? (
        <div>
          <div
            className="grid"
            style={{
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              gap: 16,
            }}
          >
            <Card title="應用版本">
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>
                {info.version}
              </div>
              <div className="muted" style={{ marginTop: 8 }}>
                發布：{info.release || '未設定'}
              </div>
            </Card>
            <Card title="資料庫大小">
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>
                {bytesLabel(info.databaseBytes)}
              </div>
              <div className="muted" style={{ marginTop: 8 }}>
                含使用者、節點、訂閱權杖與審計記錄
              </div>
            </Card>
            <Card title="最近已登記備份">
              <div style={{ marginTop: 8 }}>
                {info.lastBackup === null ? (
                  <Badge tone="warning">尚未登記備份</Badge>
                ) : (
                  <div>
                    <Badge tone="success">
                      {info.lastBackup.kind === 'full'
                        ? '完整備份'
                        : '增量備份'}
                    </Badge>
                    <div className="muted" style={{ marginTop: 8 }}>
                      {info.lastBackup.at
                        ? info.lastBackup.at.slice(0, 19).replace('T', ' ')
                        : ''}
                    </div>
                    <div className="muted">
                      {info.lastBackup.location || ''}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>
          <Card title="資料表筆數">
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              {info.counts.map((row) => (
                <span key={row.name}>
                  <strong>{row.total}</strong>{' '}
                  <span className="muted">{row.name}</span>
                </span>
              ))}
            </div>
            <p className="muted" style={{ marginTop: 12 }}>
              備份指引：{info.guidance}
              。備份檔案請存放於加密的離線位置，並定期演練還原流程；任何還原操作皆須另行授權。
            </p>
          </Card>
          <Card title="登記離線備份">
            <p className="muted">
              完成離線加密備份後，請登記備份類型、存放位置與備註，作為備份履歷與審計依據。
            </p>
            <label>備份類型</label>
            <select
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as 'full' | 'incremental')
              }
            >
              <option value="full">完整備份</option>
              <option value="incremental">增量備份</option>
            </select>
            <label style={{ marginTop: 12 }}>存放位置</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="例如：加密磁碟 / 離線儲存區編號"
            />
            <label style={{ marginTop: 12 }}>備註</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：備份範圍、驗證結果"
            />
            <div
              className="row"
              style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}
            >
              <button onClick={registerBackup} disabled={busy}>
                {busy ? '處理中…' : '登記備份'}
              </button>
            </div>
          </Card>
        </div>
      ) : null}
      {query.data === undefined && query.error === null ? null : null}
      {query.data !== undefined && info === null ? (
        <Empty title="無備份資訊" description="目前無法取得備份資訊。" />
      ) : null}
    </div>
  );
}
