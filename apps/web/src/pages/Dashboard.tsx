import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  CreditCard,
  Globe2,
  MessageSquare,
  Users,
  Zap,
} from 'lucide-react';
import {
  DataState,
  Empty,
  useApp,
  useData,
  type Row,
} from '../../../../packages/ui/src/core';
import { dollars, type PlatformService } from './PlatformGpt';
import { MemberWorkbench } from '../workspace/MemberWorkbench';

export const flag = (country: string) =>
  ({
    日本: '🇯🇵',
    美国: '🇺🇸',
    新加坡: '🇸🇬',
    香港: '🇭🇰',
    英国: '🇬🇧',
    德国: '🇩🇪',
  })[country] || '🌐';

const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
};

const statusOf = (node: Row) =>
  node.authorized === true
    ? { cls: 'ok', text: '可用' }
    : node.canSubscribe === true
      ? { cls: 'sub', text: '可订阅' }
      : { cls: 'off', text: '未授权' };

function LegacyDashboard() {
  const { session } = useApp();
  const summary = useData<any>('/api/summary');
  const gpt = useData<PlatformService>('/api/ai/platform');
  const catalog = useData<{ nodes: Row[]; serverTime: string }>(
    '/api/catalog/nodes',
  );
  const usage = useData<Row[]>('/api/ai/platform/usage');
  const workspace = useData<any>('/api/workspace');
  const [region, setRegion] = useState('全部地区');
  const [q, setQ] = useState('');
  const s = summary.data;
  const nodes = catalog.data?.nodes ?? [];
  const availableNodes = nodes.filter((n) => n.canSubscribe === true).length;
  const regions = useMemo(
    () => [
      '全部地区',
      ...Array.from(
        new Set(
          nodes.map((n) => String(n.country ?? '未标注')).filter(Boolean),
        ),
      ),
    ],
    [nodes],
  );
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return nodes.filter(
      (n) =>
        (region === '全部地区' || String(n.country ?? '未标注') === region) &&
        (!needle ||
          `${n.name ?? ''} ${n.country ?? ''} ${n.region ?? ''}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [nodes, region, q]);
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthUsage = (usage.data ?? []).filter((u) =>
    String(u.created_at ?? '').startsWith(monthKey),
  );
  const monthTokens = monthUsage.reduce(
    (sum, u) =>
      sum + Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0),
    0,
  );
  const defaultModel =
    gpt.data?.catalog?.find((m) => m.default)?.label ??
    gpt.data?.catalog?.[0]?.label ??
    '未配置';
  const isAdminView = ['Owner', 'Admin'].includes(session.user.role);
  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  const stats = [
    {
      icon: Globe2,
      label: '可用节点',
      value: s?.nodes ?? '未检测',
      hint: s?.nodes != null ? `当前账号可见 ${s.nodes} 个节点` : '暂无数据',
    },
    {
      icon: Users,
      label: '在线用户',
      value: '未检测',
      hint: '尚未接入在线统计',
    },
    {
      icon: CreditCard,
      label: '订阅用户',
      value: isAdminView ? (s?.seats ?? '未检测') : '未检测',
      hint: isAdminView ? '注册用户总数' : '仅管理员可见',
    },
    {
      icon: MessageSquare,
      label: 'GPT 使用量',
      value: usage.error ? '未检测' : `${monthUsage.length} 次`,
      hint: usage.error
        ? '用量接口暂不可用'
        : `本月 ${monthTokens.toLocaleString('zh-CN')} tokens · 已用 ${
            gpt.data?.quota ? dollars(gpt.data.quota.charged) : '—'
          }`,
    },
    {
      icon: Activity,
      label: '系统运行',
      value: '未检测',
      hint: '尚未接入运行监控',
    },
  ];
  const history: Row[] = workspace.data?.history ?? [];
  return (
    <>
      <section className="pro-banner" aria-label="欢迎">
        <svg
          className="pro-banner-art"
          viewBox="0 0 800 220"
          preserveAspectRatio="xMidYMax slice"
          aria-hidden="true"
        >
          <circle cx="640" cy="58" r="42" fill="#f5d0fe" opacity="0.85" />
          <circle cx="640" cy="58" r="58" fill="#f5d0fe" opacity="0.18" />
          <path
            d="M0 190 L140 90 L260 170 L400 70 L540 180 L660 110 L800 180 L800 220 L0 220 Z"
            fill="#2e1065"
            opacity="0.55"
          />
          <path
            d="M0 220 L120 150 L260 205 L430 140 L600 210 L720 170 L800 210 L800 220 L0 220 Z"
            fill="#1e0a44"
            opacity="0.7"
          />
        </svg>
        <div className="pro-banner-body">
          <span className="pro-banner-eyebrow">
            FAFA ONE 2.0 PRO · YOUR WORKSPACE
          </span>
          <h1 className="pro-banner-title">欢迎回来，{session.user.name}</h1>
          <p className="pro-banner-sub">{today} · 节点、GPT 与位置，一站管理</p>
        </div>
        <div className="pro-banner-actions">
          <Link className="primary-action" to="/ai/chat">
            打开 GPT 对话
          </Link>
        </div>
      </section>
      <DataState
        error={summary.error ?? catalog.error}
        loading={false}
        onRetry={() => {
          summary.refresh();
          catalog.refresh();
        }}
      />
      <div className="pro-stats">
        {stats.map((item) => (
          <article key={item.label} className="pro-stat">
            <span className="pro-stat-icon">
              <item.icon size={20} />
            </span>
            <span className="pro-stat-label">{item.label}</span>
            <span className="pro-stat-value">{item.value}</span>
            <span className="pro-stat-hint">{item.hint}</span>
          </article>
        ))}
      </div>
      <div className="pro-layout">
        <section className="card pro-card" aria-label="节点列表">
          <div className="pro-card-head">
            <h2>节点列表</h2>
            <Link to="/subscriptions">管理订阅源</Link>
          </div>
          <div className="pro-tabs" role="tablist" aria-label="节点视图">
            <button className="pro-tab" role="tab" aria-selected="true">
              节点列表
            </button>
            <button
              className="pro-tab"
              role="tab"
              aria-selected="false"
              disabled
              title="即将推出"
            >
              节点地图
            </button>
            <button
              className="pro-tab"
              role="tab"
              aria-selected="false"
              disabled
              title="即将推出"
            >
              节点测速记录
            </button>
          </div>
          <div className="pro-filter">
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              aria-label="按地区筛选"
            >
              {regions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索节点名称或地区"
              aria-label="搜索节点名称或地区"
            />
          </div>
          {catalog.error ? (
            <Empty
              title="节点列表暂不可用"
              description="请稍后重试，或检查订阅源配置。"
            />
          ) : filtered.length === 0 ? (
            <Empty
              title="暂无匹配节点"
              description={
                nodes.length === 0
                  ? '尚无可用节点，请先添加授权订阅源。'
                  : '当前筛选条件下没有节点。'
              }
            />
          ) : (
            <>
              <div className="pro-table-wrap">
                <table className="pro-table">
                  <thead>
                    <tr>
                      <th>节点名称</th>
                      <th>地区</th>
                      <th className="numeric">延迟</th>
                      <th className="numeric">下载速度</th>
                      <th className="numeric">上传速度</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 50).map((n) => {
                      const status = statusOf(n);
                      return (
                        <tr key={String(n.id)}>
                          <td>
                            <span className="pro-node-name">
                              {String(n.name ?? '未命名节点')}
                            </span>
                          </td>
                          <td>
                            {flag(String(n.country ?? ''))}{' '}
                            {String(n.country ?? '未标注')}
                          </td>
                          <td className="numeric">未探测</td>
                          <td className="numeric">未探测</td>
                          <td className="numeric">未探测</td>
                          <td>
                            <span className={`pro-status ${status.cls}`}>
                              {status.text}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="pro-table-more">
                共 {filtered.length} 个节点
                {filtered.length > 50 ? '，仅显示前 50 个' : ''}·
                延迟与速度尚未接入探测
              </p>
            </>
          )}
        </section>
        <div className="pro-side-stack">
          <section className="card pro-card" aria-label="我的订阅">
            <div className="pro-card-head">
              <h2>我的订阅</h2>
              <Link to="/my-subscriptions">前往管理</Link>
            </div>
            <dl className="pro-kv">
              <dt>可用节点</dt>
              <dd>{availableNodes} 个</dd>
              <dt>独立订阅链接</dt>
              <dd>在我的订阅页查看或生成</dd>
            </dl>
            <p className="pro-card-note">
              套餐、到期与流量统计尚未接入，不作展示。独立订阅链接只在生成后显示一次，请妥善保存。
            </p>
            <div className="pro-card-actions">
              <Link className="primary-action" to="/my-subscriptions">
                前往我的订阅
              </Link>
            </div>
          </section>
          <section className="card pro-card" aria-label="GPT 工作台">
            <div className="pro-card-head">
              <h2>GPT 工作台</h2>
              <Link to="/ai/chat">打开对话</Link>
            </div>
            <dl className="pro-kv">
              <dt>当前默认模型</dt>
              <dd>{defaultModel}</dd>
              <dt>计费方式</dt>
              <dd>按 GPT 用量计费</dd>
            </dl>
            <p className="pro-card-note">
              {(gpt.data?.catalog?.length ?? 0) > 0
                ? '已配置服务账户，模型已通过真实 API 验证。'
                : 'GPT 平台尚未配置，请联系管理员开通。'}
              对话按用量计费，达到额度后自动停止。
            </p>
            <div className="pro-card-actions">
              <Link className="primary-action" to="/ai/chat">
                开始对话
              </Link>
              <Link className="button" to="/ai/quota">
                我的额度
              </Link>
            </div>
          </section>
        </div>
      </div>
      <div className="pro-layout pro-bottom">
        <section className="card pro-card" aria-label="快捷操作">
          <div className="pro-card-head">
            <h2>快捷操作</h2>
          </div>
          <div className="pro-quick">
            <Link className="pro-quick-link" to="/ai/chat">
              <MessageSquare size={18} />
              开始对话
            </Link>
            <Link className="pro-quick-link" to="/ai/quota">
              <CreditCard size={18} />
              我的额度
            </Link>
            <Link className="pro-quick-link" to="/my-subscriptions">
              <Globe2 size={18} />
              我的订阅
            </Link>
            <Link className="pro-quick-link" to="/locations">
              <Zap size={18} />
              位置中心
            </Link>
          </div>
        </section>
        <section className="card pro-card" aria-label="系统动态">
          <div className="pro-card-head">
            <h2>系统动态</h2>
          </div>
          {workspace.error || history.length === 0 ? (
            <Empty
              title="暂无系统动态"
              description="最近的操作记录会在这里显示。"
            />
          ) : (
            <ul className="pro-activity">
              {history.slice(0, 8).map((h) => (
                <li key={String(h.id)}>
                  <span className="pro-activity-dot" aria-hidden="true" />
                  <span className="pro-activity-action">
                    {String(h.action)}
                  </span>
                  <span className="pro-activity-time">
                    {formatTime(String(h.created_at))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

export function Dashboard() {
  const { session } = useApp();
  return session.user.role === 'Member' ? (
    <MemberWorkbench />
  ) : (
    <LegacyDashboard />
  );
}
