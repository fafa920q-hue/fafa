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
} from './core';
import QRCode from 'qrcode';
import { NodeManager, type ImportMode } from './nodes';
const countryFlags: Record<string, string> = {
  日本: '🇯🇵',
  美国: '🇺🇸',
  新加坡: '🇸🇬',
  香港: '🇭🇰',
  英国: '🇬🇧',
  德国: '🇩🇪',
};
const flag = (country: string) => countryFlags[country] || '🌐';
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
  {
    name: 'authorizationReference',
    label: '聚合与再分发授权依据',
    help: '第三方资源必须填写提供商条款或授权说明，不要填写连接凭据。',
  },
  {
    name: 'redistributionAuthorized',
    label: '我已获得向授权用户再分发的许可',
    type: 'checkbox',
  },
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
export function SubscriptionWorkspace({
  admin = false,
  onChanged,
}: {
  admin?: boolean;
  onChanged?: () => void;
}) {
  const { request, toast, session } = useApp();
  const data = useData<Row[]>('/api/node_sources');
  const shared = useData<Row[]>('/api/shared-sources');
  const runs = useData<Row[]>('/api/sync-runs');
  const [tab, setTab] = useState('ALL');
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('ALL');
  const [edit, setEdit] = useState<Row | null | undefined>();
  const [credentials, setCredentials] = useState<Row>();
  const [importMode, setImportMode] = useState<ImportMode>();
  const [nodeVersion, setNodeVersion] = useState(0);
  const [remove, setRemove] = useState<Row>();
  const [url, setUrl] = useState('');
  const [qr, setQr] = useState('');
  const [format, setFormat] = useState('mihomo');
  const [rotate, setRotate] = useState(false);
  const [history, setHistory] = useState(false);
  const reloadSources = () => {
    data.refresh();
    shared.refresh();
    runs.refresh();
    setNodeVersion((value) => value + 1);
    onChanged?.();
  };
  const pendingSources = (data.data || [])
    .filter(
      (row) =>
        row.kind === 'REMOTE_SUBSCRIPTION' &&
        ['PENDING', 'QUEUED', 'SYNCING'].includes(row.status),
    )
    .map((row) => row.id)
    .join(',');
  useEffect(() => {
    if (!pendingSources) return;
    const timer = window.setInterval(() => {
      data.refresh();
      runs.refresh();
      setNodeVersion((value) => value + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pendingSources]);
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
      (tab === 'ALL' ||
        r.kind === tab ||
        (tab === 'REMOTE_SUBSCRIPTION' && r.kind === 'THIRD_PARTY_NODE')) &&
      (country === 'ALL' || r.country === country) &&
      (r.name + r.country).toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        title={admin ? '节点源与订阅分配' : '节点订阅'}
        description="你的节点，你的订阅。上游凭据始终留在安全边界内。"
        action={
          writable && (
            <div className="toolbar source-create-actions">
              <button
                className="primary"
                onClick={() => setImportMode('single')}
              >
                <Plus size={16} />
                新增节点
              </button>
              <button onClick={() => setImportMode('batch')}>批量导入</button>
              <button onClick={() => setEdit(null)}>新增订阅源</button>
              <button aria-label="刷新节点与订阅源" onClick={reloadSources}><RefreshCw size={16} />刷新</button>
            </div>
          )
        }
      />
      <div className="stack">
        <NodeManager
          onChanged={reloadSources}
          importMode={importMode}
          onImportModeChange={setImportMode}
          refreshVersion={nodeVersion}
        />
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
            <button
              onClick={() => {
                runs.refresh();
                setHistory(true);
              }}
            >
              同步历史
            </button>
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
              {[
                ...new Set(
                  [...(data.data || []), ...(shared.data || [])].map(
                    (r) => r.country,
                  ),
                ),
              ].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <button aria-label="重新加载订阅源" onClick={reloadSources}>
              <RefreshCw size={16} />
            </button>
          </div>
          <DataState
            error={data.error || shared.error}
            loading={!data.data}
            onRetry={reloadSources}
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
                    {row.enabled === false
                      ? '已停用'
                      : row.demo
                        ? '演示 · 未探测'
                        : row.status === 'READY'
                          ? '已解析 · 待实测'
                          : row.status === 'ERROR'
                            ? '同步失败'
                            : '等待同步'}
                  </Badge>
                </div>
                <div className="resource-meta">
                  <span>
                    {row.kind === 'OWNED_NODE'
                      ? '自有节点'
                      : row.kind === 'THIRD_PARTY_NODE'
                        ? '第三方授权节点'
                        : '第三方订阅'}{' '}
                    · {row.country} · {row.nodeCount || 0} 个节点
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
                  <span>
                    {row.status === 'ERROR'
                      ? '同步失败；上次成功配置已保留，请查看同步历史。'
                      : '上游链接与节点凭据不会在此显示'}
                  </span>
                  <span>
                    {row.shared ? '获授权 · 只读' : '本人拥有 · 可管理'} ·{' '}
                    {row.group || '未分组'}
                  </span>
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
                          .then(reloadSources)
                          .catch(() => {})
                      }
                    >
                      {row.enabled ? '停用' : '启用'}
                    </button>
                    <button onClick={() => setEdit(row)}>编辑</button>
                    <button onClick={() => setCredentials(row)}>
                      更新连接配置
                    </button>
                    <button
                      disabled={
                        row.demo ||
                        row.enabled === false ||
                        row.kind !== 'REMOTE_SUBSCRIPTION'
                      }
                      onClick={() =>
                        request(`/api/node_sources/${row.id}/refresh`, 'POST')
                          .then(() => {
                            reloadSources();
                            toast('刷新任务已入队；失败时保留最后成功版本');
                          })
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
          {!data.error && data.data && filtered.length === 0 && (
            <Empty
              title="暂无匹配的订阅源"
              description="添加自有节点或有授权的第三方订阅，开始统一管理。"
              action={
                writable && (
                  <button
                    className="primary"
                    aria-label="从空状态新增订阅源"
                    onClick={() => setEdit(null)}
                  >
                    新增订阅源
                  </button>
                )
              }
            />
          )}
        </Card>
      </div>
      <FormDialog
        open={edit !== undefined}
        onClose={() => setEdit(undefined)}
        title={edit ? '编辑订阅源' : '新增订阅源'}
        fields={(edit
          ? fields.filter(
              (field) => !['kind', 'url', 'content'].includes(field.name),
            )
          : fields
        ).map((f) => ({
          ...f,
          value: edit?.[f.name] === undefined ? f.value : String(edit[f.name]),
        }))}
        notice={
          edit
            ? '这里只更新名称、分组、地区及授权策略；连接凭据保持不变。更换 URL 或节点配置请使用“更新连接配置”。'
            : '第三方资源必须已有使用、聚合及再分发授权。订阅 URL 只通过 HTTPS 发送并加密保存，后台刷新失败将保留最后成功版本。'
        }
        onSubmit={async (d) => {
          const body = edit
            ? {
                ...d,
                group: d.group || '',
                provider: d.provider || '',
                authorizationReference: d.authorizationReference || '',
                expiresAt: d.expiresAt || null,
              }
            : d;
          await request(
            `/api/node_sources${edit ? '/' + edit.id : ''}`,
            edit ? 'PATCH' : 'POST',
            body,
          );
          reloadSources();
          toast('订阅源已保存');
        }}
      />
      <FormDialog
        open={!!credentials}
        onClose={() => setCredentials(undefined)}
        title="更新订阅源连接"
        fields={fields
          .filter((field) => field.name !== 'kind')
          .map((field) => ({
            ...field,
            required:
              field.name === 'url'
                ? credentials?.kind === 'REMOTE_SUBSCRIPTION'
                : field.name === 'content'
                  ? credentials?.kind !== 'REMOTE_SUBSCRIPTION'
                  : field.required,
            value: ['url', 'content'].includes(field.name)
              ? undefined
              : credentials?.[field.name] === undefined
                ? field.value
                : String(credentials[field.name]),
          }))}
        notice="仅在需要轮换连接凭据时使用。已保存的 URL、密码与 UUID 不会回显；更新失败不会覆盖最后成功的节点版本。"
        onSubmit={async (data) => {
          await request('/api/node_sources/' + credentials!.id, 'PUT', {
            ...data,
            kind: credentials!.kind,
            enabled: credentials!.enabled,
          });
          reloadSources();
          toast('订阅源连接已更新');
        }}
      />
      <ConfirmDialog
        open={!!remove}
        title="删除订阅源？"
        description="此源将从你的导出中移除，历史审计仍保留。"
        onClose={() => setRemove(undefined)}
        onConfirm={async () => {
          await request(`/api/node_sources/${remove!.id}`, 'DELETE');
          reloadSources();
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
