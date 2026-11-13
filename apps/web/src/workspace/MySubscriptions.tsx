import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Link2, ShieldCheck } from 'lucide-react';
import {
  Card,
  DataState,
  PageTitle,
  useApp,
  useData,
} from '../../../../packages/ui/src/core';
import './workspace.css';
function SubscriptionControls() {
  const { request } = useApp();
  const catalog = useData<any>('/api/catalog/nodes');
  const [selected, setSelected] = useState<string[]>([]),
    [format, setFormat] = useState('base64'),
    [url, setUrl] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const available = (catalog.data?.nodes || []).filter(
    (n: any) => n.canSubscribe,
  );
  async function generate() {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const ids = selected.filter((id) =>
        available.some((n: any) => n.id === id),
      );
      if (!ids.length) throw Error('请至少选择一个已获授权的节点');
      await request('/api/subscription/profile', 'PUT', {
        country: '',
        protocol: '',
        group: '',
        nodeIds: ids,
      });
      const result = await request<any>('/api/subscription/rotate', 'POST', {});
      setUrl(result.url);
      setMessage(
        '独立链接已生成，原有链接已撤销。链接只显示一次，请妥善保存。',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法生成订阅，请重试');
    } finally {
      setBusy(false);
    }
  }
  const formatted = url ? url + '?format=' + format : '';
  return (
    <>
      <DataState
        loading={!catalog.data && !catalog.error}
        error={catalog.error}
        onRetry={catalog.refresh}
      />
      <Card
        title="选择已授权节点"
        description="订阅只包含你有权使用的节点；管理员撤销权限后链接立即受限。"
        icon={ShieldCheck}
      >
        {available.length ? (
          <div className="v3-sub-selection">
            {available.map((node: any) => (
              <label key={node.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(node.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, node.id]
                        : selected.filter((id) => id !== node.id),
                    )
                  }
                />
                <span>
                  {node.name}
                  <small>
                    {node.country} · {node.protocol.toUpperCase()}
                  </small>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="v3-feature-copy">尚未分配可订阅节点，请联系管理员。</p>
        )}
        <button
          className="primary"
          disabled={busy || !selected.length}
          onClick={() => void generate()}
        >
          {busy ? '正在生成…' : '生成独立订阅链接'}
        </button>
      </Card>
      <Card
        title="我的独立订阅"
        description="支持 Shadowrocket、v2rayN、Mihomo 与 sing-box 对应格式。"
        icon={Link2}
      >
        <label>
          客户端格式
          <select
            aria-label="订阅格式"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="base64">Shadowrocket / v2rayN（Base64）</option>
            <option value="uri">通用 URI</option>
            <option value="mihomo">Mihomo / Clash Meta</option>
            <option value="sing-box">sing-box</option>
          </select>
        </label>
        {formatted && (
          <>
            <label>
              你的独立订阅链接
              <input
                aria-label="你的独立订阅链接"
                value={formatted}
                readOnly
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(formatted)
                  .then(() => setMessage('已复制订阅链接'))
                  .catch(() => setError('无法访问剪贴板，请手动选中链接复制'))
              }
            >
              <Copy size={15} />
              复制链接
            </button>
          </>
        )}
        <button
          disabled={busy}
          onClick={() => {
            if (!window.confirm('撤销后，当前全部订阅链接立即失效。确定继续？'))
              return;
            setBusy(true);
            void request('/api/subscription', 'DELETE')
              .then(() => {
                setUrl('');
                setMessage('订阅链接已撤销');
              })
              .catch((e) =>
                setError(e instanceof Error ? e.message : '撤销失败'),
              )
              .finally(() => setBusy(false));
          }}
        >
          撤销现有订阅链接
        </button>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
      </Card>
    </>
  );
}
export function MySubscriptions() {
  const workspace = useData<any>('/api/workspace');
  const w = workspace.data;
  return (
    <section className="v3-workspace">
      <PageTitle
        title="我的订阅"
        description="独立链接、明确范围，权限由管理员统一管理。"
        eyebrow="FAFA ONE / SUBSCRIPTIONS"
      />
      <DataState
        loading={!w && !workspace.error}
        error={workspace.error}
        onRetry={workspace.refresh}
      />
      {w &&
        (w.capabilities.subscribe ? (
          <div className="v3-bento">
            <SubscriptionControls />
          </div>
        ) : (
          <Card
            title="订阅权限尚未开放"
            description="可以先查看管理员公开展示的节点。"
            icon={ShieldCheck}
          >
            <p className="v3-feature-copy">
              当前账户未获订阅授权或授权已到期，无法生成或使用节点订阅。请联系管理员调整权限。
            </p>
            <Link className="button" to="/subscriptions">
              查看开放节点
            </Link>
          </Card>
        ))}
    </section>
  );
}
