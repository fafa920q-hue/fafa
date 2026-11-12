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

interface Monitoring {
  api: { ok: boolean };
  database: { ok: boolean; bytes: number };
  counts: Array<{ name: string; total: number }>;
  jobsByStatus: Array<{ status: string; total: number }>;
  tasksByStatus: Array<{ status: string; total: number }>;
  latestHealth: Array<{ id: string; data: any; createdAt: string }>;
}

interface JobRow {
  id: string;
  data?: any;
  created_at?: string;
}

function bytesLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return String(bytes) + ' B';
}

export function MonitoringAdmin() {
  const { request } = useApp();
  const monitoring = useData<Monitoring>('/api/admin/monitoring');
  const jobs = useData<JobRow[]>('/api/admin/jobs');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const data = monitoring.data;
  const jobList = jobs.data || [];

  async function retryJob(id: string) {
    setBusy(true);
    setError('');
    try {
      await request('/api/admin/jobs/' + id + '/retry', 'POST');
      setNotice('任務已重新排入佇列。');
      jobs.refresh();
      monitoring.refresh();
    } catch (e: any) {
      setError(e?.message || '重試失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageTitle
        title="系統監控"
        description="即時查看 API、資料庫、任務佇列與節點健康狀態。失敗任務可手動重試；所有操作皆寫入操作審計。"
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
        error={monitoring.error || ''}
        loading={!monitoring.data}
        onRetry={monitoring.refresh}
      />
      {data !== undefined && data !== null ? (
        <div>
          <div
            className="grid"
            style={{
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gap: 16,
            }}
          >
            <Card title="API 服務">
              <div style={{ marginTop: 8 }}>
                {data.api.ok ? (
                  <Badge tone="success">正常</Badge>
                ) : (
                  <Badge tone="danger">異常</Badge>
                )}
              </div>
            </Card>
            <Card title="資料庫">
              <div style={{ marginTop: 8 }}>
                {data.database.ok ? (
                  <Badge tone="success">連線正常</Badge>
                ) : (
                  <Badge tone="danger">連線異常</Badge>
                )}
              </div>
              <div className="muted" style={{ marginTop: 8 }}>
                {bytesLabel(data.database.bytes)}
              </div>
            </Card>
            {data.counts.map((count) => (
              <Card key={count.name} title={count.name}>
                <div style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>
                  {count.total}
                </div>
              </Card>
            ))}
          </div>
          <Card title="任務狀態統計">
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              {data.jobsByStatus.length === 0 ? (
                <span className="muted">尚無背景任務記錄</span>
              ) : null}
              {data.jobsByStatus.map((row) => (
                <span key={row.status}>
                  <Badge
                    tone={
                      row.status === 'FAILED'
                        ? 'danger'
                        : row.status === 'QUEUED'
                          ? 'warning'
                          : 'success'
                    }
                  >
                    {row.status}
                  </Badge>{' '}
                  {row.total}
                </span>
              ))}
            </div>
            <h3 style={{ marginTop: 16 }}>AI 任務狀態統計</h3>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
              {data.tasksByStatus.length === 0 ? (
                <span className="muted">尚無 AI 任務記錄</span>
              ) : null}
              {data.tasksByStatus.map((row) => (
                <span key={row.status}>
                  <Badge tone={row.status === 'ERROR' ? 'danger' : 'success'}>
                    {row.status}
                  </Badge>{' '}
                  {row.total}
                </span>
              ))}
            </div>
          </Card>
          <Card title="最近節點健康檢查">
            {data.latestHealth.length === 0 ? (
              <p className="muted">尚無健康檢查記錄。</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>檢查編號</th>
                    <th>結果</th>
                    <th>時間</th>
                  </tr>
                </thead>
                <tbody>
                  {data.latestHealth.map((row) => (
                    <tr key={row.id}>
                      <td>{row.id.slice(0, 8)}</td>
                      <td>
                        {row.data?.ok === false ? (
                          <Badge tone="danger">異常</Badge>
                        ) : (
                          <Badge tone="success">正常</Badge>
                        )}
                      </td>
                      <td>
                        {row.createdAt
                          ? row.createdAt.slice(0, 19).replace('T', ' ')
                          : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      ) : null}
      <DataState
        error={jobs.error || ''}
        loading={!jobs.data}
        onRetry={jobs.refresh}
      />
      {jobList.length > 0 ? (
        <Card title="背景任務佇列">
          <table className="table">
            <thead>
              <tr>
                <th>任務</th>
                <th>狀態</th>
                <th>建立時間</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {jobList.map((job) => (
                <tr key={job.id}>
                  <td>
                    {job.data?.kind || job.data?.type || job.id.slice(0, 8)}
                  </td>
                  <td>
                    {job.data?.status === 'FAILED' ? (
                      <Badge tone="danger">失敗</Badge>
                    ) : (
                      <Badge>{job.data?.status || '未知'}</Badge>
                    )}
                  </td>
                  <td>
                    {job.created_at
                      ? job.created_at.slice(0, 19).replace('T', ' ')
                      : '-'}
                  </td>
                  <td>
                    {job.data?.status === 'FAILED' ? (
                      <button onClick={() => retryJob(job.id)} disabled={busy}>
                        重試
                      </button>
                    ) : (
                      '-'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      {jobs.data !== undefined && jobList.length === 0 ? (
        <Empty title="尚無背景任務" description="目前沒有任何背景任務記錄。" />
      ) : null}
    </div>
  );
}
