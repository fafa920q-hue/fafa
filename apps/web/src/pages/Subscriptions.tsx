import { useEffect, useState } from 'react';
import { Globe2, Plus, Copy, RefreshCw, Link2 } from 'lucide-react';
import {
  Card,
  PageTitle,
  useData,
  useApp,
  FormDialog,
  ConfirmDialog,
  Dialog,
  Empty,
  Badge,
  DataState,
  type Row,
  type Field,
} from '../../../../packages/ui/src/core';
import QRCode from 'qrcode';
import { NodeManager } from '../components/NodeManager';
import { flag } from './Dashboard';
const fields: Field[] = [
  { name: 'name', label: '源名称', required: true },
  {
    name: 'kind',
    label: '源类型',
    options: [
      { label: '第三方授权订阅', value: 'REMOTE_SUBSCRIPTION' },
      { label: '自有节点配置', value: 'OWNED_NODE' },
    ],
  },
  {
    name: 'url',
    label: '第三方订阅 URL',
    type: 'password',
    placeholder: 'https://…',
    help: '仅接受 HTTPS / 443，服务端加密保存；自有节点留空。',
  },
  {
    name: 'content',
    label: '自有节点配置',
    type: 'textarea',
    placeholder: 'vless://… 或 Mihomo YAML / sing-box JSON',
    help: '第三方订阅留空。支持矩阵请见文档。',
  },
  { name: 'country', label: '国家 / 地区', value: '未标注' },
  { name: 'provider', label: '供应商（可选）' },
  { name: 'group', label: '分组（可选）' },
  { name: 'authorizationReference', label: '聚合与再分发授权依据（可选）' },
  { name: 'redistributionAuthorized', label: '我已获得向授权用户再分发的许可', type: 'checkbox' },
  {
    name: 'expiresAt',
    label: '有效期（ISO 时间，可选）',
    placeholder: '2027-01-01T00:00:00Z',
  },
  {
    name: 'authorized',
    label: '我有权使用并聚合该资源',
    type: 'checkbox',
    required: true,
  },
];
export function Subscriptions() {
  const { request, toast, session } = useApp();
  const data = useData<Row[]>('/api/node_sources');
  const shared = useData<Row[]>('/api/shared-sources');
  const runs = useData<Row[]>('/api/sync-runs');
  const [tab, setTab] = useState('ALL');
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('ALL');
  const [edit, setEdit] = useState<Row | null | undefined>();
  const [remove, setRemove] = useState<Row>();
  const [url, setUrl] = useState('');
  const [qr, setQr] = useState('');
  const [format, setFormat] = useState('mihomo');
  const [rotate, setRotate] = useState(false);
  const [history, setHistory] = useState(false);
  useEffect(() => {
    if (url)
      QRCode.toDataURL(url + '?format=' + format, {
        width: 240,
        margin: 2,
        errorCorrectionLevel: 'M',
      }).then(setQr);
    else setQr('');
  }, [url, format]);
  const writable = session.user.role !== 'Viewer';
  const filtered = [...(data.data || []), ...(shared.data || [])].filter(
    (r) =>
      (tab === 'ALL' || r.kind === tab || (tab === 'REMOTE_SUBSCRIPTION' && r.kind === 'THIRD_PARTY_NODE')) &&
      (country === 'ALL' || r.country === country) &&
      (r.name + r.country).toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        title="节点订阅"
        description="你的节点，你的订阅。上游凭据始终留在安全边界内。"
        action={
          writable && (
            <button className="primary" onClick={() => setEdit(null)}>
              <Plus size={16} />
              添加订阅源
            </button>
          )
        }
      />
      <div className="stack">
        <NodeManager onChanged={data.refresh} />
        <Card
          title="统一订阅"
          description="汇集个人源与获授权共享源 · 独立令牌，可轮换与撤销"
          icon={Link2}
        >
          <div className="toolbar">
            <select
              aria-label="订阅输出格式"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              <option value="mihomo">Mihomo YAML</option>
              <option value="sing-box">sing-box JSON</option>
              <option value="uri">URI 列表（小火箭等）</option>
              <option value="base64">Base64（v2rayN 等）</option>
            </select>
            <button
              className="primary"
              disabled={!writable}
              onClick={() => setRotate(true)}
            >
              <RefreshCw size={15} />
              生成 / 轮换链接
            </button>
            <button
              disabled={!writable}
              onClick={() =>
                request('/api/subscription', 'DELETE')
                  .then(() => {
                    setUrl('');
                    toast('所有订阅链接已撤销');
                  })
                  .catch(() => {})
              }
            >
              撤销链接
            </button>
            <button onClick={() => setHistory(true)}>同步历史</button>
          </div>
          {url ? (
            <>
              <div className="link-box">{url + '?format=' + format}</div>
              {qr && (
                <img
                  src={qr}
                  width={180}
                  height={180}
                  alt="敏感订阅链接二维码，请勿分享给他人"
                  style={{
                    display: 'block',
                    borderRadius: 12,
                    margin: '12px 0',
                  }}
                />
              )}
              <button
                onClick={() =>
                  navigator.clipboard
                    .writeText(url + '?format=' + format)
                    .then(() => toast('订阅链接已复制'))
                    .catch(() => toast('浏览器未允许复制，请手动复制链接'))
                }
              >
                <Copy size={15} />
                复制敏感链接
              </button>
            </>
          ) : (
            <p className="callout">
              订阅链接属于敏感凭据，只在生成时显示一次。小火箭：复制 URI
              格式链接，在客户端订阅管理中添加并更新。客户端实机导入仍需验收。
            </p>
          )}
          <p className="location-notice">
            流量：数据不可用 · 延迟：尚未真实探测 · 不展示随机测量值
          </p>
        </Card>
        <Card
          title="我的订阅源"
          description="刷新由后台队列执行，失败保留最后成功版本"
          icon={Globe2}
        >
          <div className="tabs">
            {[
              ['ALL', '统一订阅'],
              ['OWNED_NODE', '自有节点'],
              ['REMOTE_SUBSCRIPTION', '第三方节点'],
            ].map(([value, label]) => (
              <button
                className={tab === value ? 'active' : ''}
                key={value}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <input
              aria-label="搜索订阅源"
              placeholder="搜索名称或地区…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select
              aria-label="筛选国家"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            >
              <option value="ALL">全部地区</option>
              {[...new Set(data.data?.map((r) => r.country) || [])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <button aria-label="重新加载订阅源" onClick={data.refresh}>
              <RefreshCw size={16} />
            </button>
          </div>
          <DataState
            error={data.error}
            loading={!data.data}
            onRetry={data.refresh}
          />
          <div className="resource-grid">
            {filtered?.map((row) => (
              <article className="resource-card" key={row.id}>
                <div className="resource-top">
                  <div>
                    <span className="flag">{flag(row.country)}</span>
                    <h3>{row.name}</h3>
                  </div>
                  <Badge tone={row.status === 'ERROR' ? 'danger' : 'neutral'}>
                    {row.demo
                      ? '演示 · 未探测'
                      : row.status === 'READY'
                        ? '配置就绪'
                        : row.status === 'ERROR'
                          ? '同步失败'
                          : '等待同步'}
                  </Badge>
                </div>
                <div className="resource-meta">
                  <span>
                    {row.kind === 'OWNED_NODE' ? '自有节点' : '第三方订阅'} ·{' '}
                    {row.country} · {row.nodeCount || 0} 个节点
                  </span>
                  <span>
                    最近成功：
                    {row.lastSuccess
                      ? new Date(row.lastSuccess).toLocaleString('zh-CN')
                      : '尚未同步'}
                  </span>
                  <span>
                    有效期：
                    {row.expiresAt
                      ? new Date(row.expiresAt).toLocaleString('zh-CN')
                      : '未提供'}{' '}
                    · 流量：数据不可用
                  </span>
                  <span>{row.error || '上游链接与节点凭据不会在此显示'}</span>
                </div>
                {writable && !row.shared && (
                  <div className="actions">
                    <button
                      onClick={() =>
                        request(
                          `/api/node_sources/${row.id}/enabled`,
                          'PATCH',
                          { enabled: !row.enabled },
                        )
                          .then(data.refresh)
                          .catch(() => {})
                      }
                    >
                      {row.enabled ? '停用' : '启用'}
                    </button>
                    <button onClick={() => setEdit(row)}>编辑</button>
                    <button
                      disabled={row.demo || row.kind !== 'REMOTE_SUBSCRIPTION'}
                      onClick={() =>
                        request(`/api/node_sources/${row.id}/refresh`, 'POST')
                          .then(() => toast('刷新任务已入队'))
                          .catch(() => {})
                      }
                    >
                      刷新
                    </button>
                    <button className="danger" onClick={() => setRemove(row)}>
                      删除
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
          {filtered?.length === 0 && (
            <Empty
              title="暂无匹配的订阅源"
              description="添加自有节点或有授权的第三方订阅，开始统一管理。"
            />
          )}
        </Card>
      </div>
      <FormDialog
        open={edit !== undefined}
        onClose={() => setEdit(undefined)}
        title={edit ? '编辑订阅源' : '添加订阅源'}
        fields={fields.map((f) => ({
          ...f,
          value: edit?.[f.name] === undefined ? f.value : String(edit[f.name]),
        }))}
        notice="保存编辑时请重新提供源凭据；演示源可删除后添加真实配置。"
        onSubmit={async (d) => {
          await request(
            `/api/node_sources${edit ? '/' + edit.id : ''}`,
            edit ? 'PUT' : 'POST',
            d,
          );
          data.refresh();
          toast('订阅源已保存');
        }}
      />
      <ConfirmDialog
        open={!!remove}
        title="删除订阅源？"
        description="此源将从你的导出中移除，历史审计仍保留。"
        onClose={() => setRemove(undefined)}
        onConfirm={async () => {
          await request(`/api/node_sources/${remove!.id}`, 'DELETE');
          data.refresh();
        }}
      />
      <ConfirmDialog
        open={rotate}
        title="生成新订阅链接？"
        description="旧链接会立即失效，需要在所有客户端更新。新链接只显示一次。"
        onClose={() => setRotate(false)}
        onConfirm={async () => {
          const r = await request('/api/subscription/rotate', 'POST');
          setUrl(r.url);
        }}
      />
      <Dialog
        open={history}
        onClose={() => setHistory(false)}
        title="订阅同步历史"
      >
        <DataState
          error={runs.error}
          loading={!runs.data}
          onRetry={runs.refresh}
        />
        {runs.data?.length ? (
          runs.data.map((r) => (
            <div className="list-item" key={r.id}>
              <div>
                <strong>
                  {r.data.status === 'COMPLETED' ? '刷新完成' : '刷新失败'}
                </strong>
                <small>{new Date(r.created_at).toLocaleString('zh-CN')}</small>
              </div>
              <Badge>
                {r.data.diff
                  ? `新增 ${r.data.diff.added ?? 0} / 移除 ${r.data.diff.removed ?? 0}`
                  : '已安排重试'}
              </Badge>
            </div>
          ))
        ) : (
          <Empty title="暂无同步记录" />
        )}
      </Dialog>
    </>
  );
}
